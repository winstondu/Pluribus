import type { ConversationSnapshot, DirectiveId, RequirementId, SectionView } from '@committee/protocol'
import type { PlannedRevision } from '../../src/ports'
import { engineModule } from '../../src/engine'
import { answer, noUnits, type ScriptStep, type TestBackendOverrides } from '..'
import { scenario, type Scenario } from './engine'
import { recoveryModule } from '../../src/recovery/module'

/** A conversation on a backend with the engine and the recovery slice, routed by the scripted router. */
export async function recoveryScenario(overrides: TestBackendOverrides = {}): Promise<Scenario> {
  return scenario({ modules: [engineModule, recoveryModule], ...overrides })
}

export interface RevisionSpec {
  readonly scope?: 'work' | 'shared-requirement'
  /** Labels of the directives corrected. */
  readonly targets?: readonly string[]
  readonly requirementIds?: readonly RequirementId[]
  /** Consumer label → pre-selected. */
  readonly affected?: { readonly [label: string]: boolean }
}

/** Submits `text` routed as a revision (a plan with no units), and settles. */
export async function revise(s: Scenario, text: string, spec: RevisionSpec = {}): Promise<void> {
  const ids = (labels: readonly string[]): DirectiveId[] => labels.map((l) => s.id(l))
  const revision: PlannedRevision = {
    scope: spec.scope ?? 'work',
    correction: text,
    fragment: null,
    targetDirectiveIds: ids(spec.targets ?? []),
    targetRequirementIds: spec.requirementIds ?? [],
    affected: Object.entries(spec.affected ?? {}).map(([label, preselected]) => ({ directiveId: s.id(label), preselected })),
  }
  s.t.router.when(text, (input) => noUnits(input, { revisions: [revision] }))
  await s.t.submit(s.c, text)
}

export const BRIEF = 'Trip brief: Kyoto, five days, November, moderate budget'
export const A_TEXT = 'Suggest neighborhoods to stay in'
export const B_TEXT = 'Suggest rainy-day activities'
export const J_TEXT = 'Use those recommendations to make a five-day itinerary'

/**
 * The running example of 06 and 08: the brief, then A (neighborhoods) and B
 * (activities) as forks of one sibling group, and J (itinerary) on their
 * full join-back.
 */
export async function trip(
  s: Scenario,
  scripts: { readonly a?: readonly ScriptStep[]; readonly b?: readonly ScriptStep[]; readonly j?: readonly ScriptStep[]; readonly withJ?: boolean } = {},
): Promise<void> {
  await s.ask(BRIEF, { label: 'brief' }, answer('Noted: Kyoto, five days.', 10, 20))
  await s.t.advance(50)
  await s.ask(A_TEXT, { label: 'neighborhoods', placement: s.on('brief') }, scripts.a ?? answer('Gion and Higashiyama.', 100, 1_000))
  await s.ask(B_TEXT, { label: 'activities', placement: s.onHeadOf('brief') }, scripts.b ?? answer('Museums and tea houses.', 100, 1_000))
  if (scripts.withJ !== false) {
    await s.ask(
      J_TEXT,
      { label: 'itinerary', placement: s.onGroupOf('neighborhoods'), prerequisites: [s.needsGroupOf('neighborhoods')] },
      scripts.j ?? answer('Day 1: Gion. Day 2: museums.', 100, 1_000),
    )
  }
}

/** The section a directive currently answers in, from a snapshot. */
export function sectionOf(snap: ConversationSnapshot, s: Scenario, label: string): SectionView {
  const id = s.d(label).sectionId
  const view = id ? snap.transcript.sections[id] : undefined
  if (!view) throw new Error(`"${label}" has no section in the transcript`)
  return view
}

/** The model input of a directive's attempt, as text. */
export function inputOf(s: Scenario, label: string, attempt = -1): string[] {
  const d = s.d(label)
  const id = d.attemptIds.at(attempt)
  return s.state().attempts[id ?? '']?.context.messages.map((m) => m.content) ?? []
}

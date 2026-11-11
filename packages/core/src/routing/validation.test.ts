import { describe, expect, test } from 'vitest'
import { asId, type DirectiveId, type FragmentId } from '@committee/protocol'
import { NEVER_CANCELLED, type PlannedUnit, type RoutingPlan } from '../ports'
import { ROUTING_CORPUS, corpusInput, oracleDecisionProvider, referenceDecomposer, scene, sceneIds } from './corpus'
import type { CorpusExample } from './corpus'
import { topological, validatePlan } from './derive'
import { createRouter } from './pipeline'

/**
 * Deterministic validation (11 · "Routing", stage 3) and the edge cases of
 * 02, 04 and 05 that it decides: acyclic dependencies, no subset bypass of a
 * full join-back, topological split order, only supplied candidates.
 */

const tripRunning = scene()
  .chain('trip', 'root', 'trip')
  .add('brief', { chain: 'trip', on: null, label: 'brief', request: 'Trip brief', answer: 'Noted.' })
  .chain('A', 'fork', 'neighborhoods')
  .add('A', { chain: 'A', on: 'brief', label: 'neighborhoods', request: 'Suggest neighborhoods', state: 'running' })
  .chain('B', 'fork', 'activities')
  .add('B', { chain: 'B', on: 'brief', label: 'activities', request: 'Suggest activities', state: 'running' })
  .chain('D', 'fork', 'day trips')
  .add('D', { chain: 'D', on: 'brief', label: 'day trips', request: 'Suggest day trips', state: 'running' })
  .group('G', { base: 'trip', start: 'brief', members: ['A', 'B', 'D'], open: true })
  .build()

const example = (text: string, expect: CorpusExample['expect'], extra: Partial<CorpusExample> = {}): CorpusExample => ({
  id: 'test',
  covers: ['dependencies'],
  note: 'test',
  scene: tripRunning,
  text,
  expect,
  ...extra,
})

function unit(id: string, extra: Partial<PlannedUnit> = {}): PlannedUnit {
  return {
    directiveId: asId('directive', `dir_${id}`),
    fragment: null,
    instruction: id,
    label: id,
    labelIsProvisional: false,
    requirements: [],
    relation: 'new',
    targets: [],
    placement: { kind: 'new-chain' },
    prerequisites: [],
    ...extra,
  }
}

function plan(units: readonly PlannedUnit[], extra: Partial<RoutingPlan> = {}): RoutingPlan {
  return {
    decision: { source: 'decision-model', model: null, composition: { value: 'composite', confidence: null }, units: [], thresholds: {}, explanation: '', questions: [] },
    composition: 'sequential-composite',
    units,
    barrier: null,
    outputOrder: null,
    sessionRequirements: [],
    withdrawnSessionRequirementIds: [],
    clarifications: [],
    revisions: [],
    answersElicitationId: null,
    decompositionModel: null,
    ...extra,
  }
}

const input = corpusInput(example('x', {}))
const dir = (h: string): DirectiveId => sceneIds.directive(h)

describe('validation', () => {
  test('validation · two or more members of one sibling group become the whole group, never a subset (Q30)', () => {
    const result = validatePlan(input, plan([unit('J', { prerequisites: [{ kind: 'directive', directiveId: dir('A') }, { kind: 'directive', directiveId: dir('B') }] })], { composition: 'atomic' }))
    expect(result.ok && result.plan.units[0]?.prerequisites).toEqual([{ kind: 'sibling-group', groupId: sceneIds.group('G') }])
  })

  test('validation · a sibling-group point on an open group gains the prerequisite on it (C9, C15)', () => {
    const result = validatePlan(input, plan([unit('J', { placement: { kind: 'continue', buildsOn: { kind: 'sibling-group', groupId: sceneIds.group('G') } } })], { composition: 'atomic' }))
    expect(result.ok && result.plan.units[0]?.prerequisites).toEqual([{ kind: 'sibling-group', groupId: sceneIds.group('G') }])
  })

  test('validation · anything that is not a supplied candidate refuses the plan', () => {
    const unknownTarget = validatePlan(input, plan([unit('J', { targets: [asId('section', 'sec_nope')] })]))
    expect(unknownTarget.ok).toBe(false)
    const unknownNode = validatePlan(input, plan([unit('J', { placement: { kind: 'continue', buildsOn: { kind: 'node', nodeId: asId('node', 'nod_nope') } } })]))
    expect(unknownNode.ok).toBe(false)
    const unknownWork = validatePlan(input, plan([unit('J', { prerequisites: [{ kind: 'directive', directiveId: dir('nope') }] })]))
    expect(unknownWork.ok).toBe(false)
    const reused = validatePlan(input, plan([unit('A')]))
    expect(reused.ok).toBe(false)
    const notOpen = validatePlan(input, plan([], { answersElicitationId: asId('elicitation', 'eli_nope') }))
    expect(notOpen.ok).toBe(false)
  })

  test('validation · dependencies are acyclic: a cycle between parts refuses the plan', () => {
    const a = unit('P', { prerequisites: [{ kind: 'directive', directiveId: dir('Q') }] })
    const b = unit('Q', { prerequisites: [{ kind: 'directive', directiveId: dir('P') }] })
    expect(topological([a, b])).toBeNull()
    expect(validatePlan(input, plan([a, b])).ok).toBe(false)
  })

  test('validation · split messages are ordered topologically, ties in original text order (Q53)', () => {
    const span = (start: number) => ({ fragmentId: asId('fragment', `frg_${start}`) as FragmentId, sourceSpans: [{ start, end: start + 1 }], rewrittenText: 'x' })
    const j = unit('J', { fragment: span(0), prerequisites: [{ kind: 'directive', directiveId: dir('B2') }, { kind: 'directive', directiveId: dir('C2') }] })
    const b = unit('B2', { fragment: span(10) })
    const c = unit('C2', { fragment: span(5) })
    const result = validatePlan(input, plan([j, b, c]))
    expect(result.ok && result.plan.units.map((u) => u.label)).toEqual(['C2', 'B2', 'J'])
  })

  test('validation · undo split needs one atomic request', () => {
    const forced = { ...input, forcedComposition: 'atomic' as const }
    expect(validatePlan(forced, plan([unit('X'), unit('Y')])).ok).toBe(false)
  })

  test('04 edge case · D sent while A and B run: work needing A and B waits for D too', async () => {
    const e = example('Compare the neighborhoods and the activities', {
      parts: [{ kind: 'unit', relation: 'result-dependent', targets: ['A', 'B'], placement: { continue: 'group:G' }, prerequisites: ['group:G'] }],
    })
    const i = corpusInput(e)
    const outcome = await createRouter({ decisionProvider: oracleDecisionProvider(e, i), decomposer: referenceDecomposer(e) }).route(i, NEVER_CANCELLED)
    expect(outcome.kind === 'plan' && outcome.plan.units[0]?.prerequisites).toEqual([{ kind: 'sibling-group', groupId: sceneIds.group('G') }])
  })

  test('decomposition · spans outside the message, unknown fragments or unknown candidates are malformed, never repaired', async () => {
    const base = ROUTING_CORPUS.find((e) => e.id === 'split-independent')
    if (!base) throw new Error('missing example')
    const i = corpusInput(base)
    const oracle = oracleDecisionProvider(base, i)
    const bad = [
      { key: 'a', sourceSpans: [{ start: 0, end: 999 }], instruction: 'x', label: 'x', requirements: [], dependsOnFragments: [], dependsOnCandidates: [] },
      { key: 'b', sourceSpans: [{ start: 0, end: 3 }], instruction: 'y', label: 'y', requirements: [], dependsOnFragments: [], dependsOnCandidates: [] },
    ]
    const cases = [
      bad,
      [bad[1], { ...bad[1], key: 'c', dependsOnFragments: ['zzz'] }],
      [bad[1], { ...bad[1], key: 'c', dependsOnCandidates: ['dir_unknown'] }],
      [bad[1], { ...bad[1], key: 'b' }],
    ]
    for (const fragments of cases) {
      const router = createRouter({
        decisionProvider: oracle,
        decomposer: { decompose: async () => ({ ok: true, decomposition: { fragments: fragments as never, barrier: null, outputOrder: null } }) },
      })
      const outcome = await router.route(i, NEVER_CANCELLED)
      expect(outcome.kind === 'failed' && outcome.error.code).toBe('malformed-response')
    }
  })

  test('decomposition · fewer than two fragments is atomic after all: splitting is conservative (Q4)', async () => {
    const e = example('Explain caching and indexes for beginners', { composition: 'independent-composite' }, { scene: scene().build() })
    const i = corpusInput(e)
    const router = createRouter({ decisionProvider: oracleDecisionProvider(e, i), decomposer: referenceDecomposer(e) })
    const outcome = await router.route(i, NEVER_CANCELLED)
    expect(outcome.kind === 'plan' && outcome.plan.composition).toBe('atomic')
    expect(outcome.kind === 'plan' && outcome.plan.units[0]?.instruction).toBe('Explain caching and indexes for beginners')
  })

  test('gate · the first message of an empty conversation asks only about the message itself', async () => {
    const e = ROUTING_CORPUS.find((x) => x.id === 'placement-first-message')
    if (!e) throw new Error('missing example')
    const i = corpusInput(e)
    const asked: string[] = []
    const oracle = oracleDecisionProvider(e, i)
    await createRouter({
      decisionProvider: { decide: (r, s) => (asked.push(...Object.keys(r.questions)), oracle.decide(r, s)) },
      decomposer: referenceDecomposer(e),
    }).route(i, NEVER_CANCELLED)
    expect(asked.sort()).toEqual(['composite', 'm_clarify', 'm_why', 'sessionwide'])
  })

  test('gate · after Undo split the message is routed as one request: no composite question, no decomposition', async () => {
    const e = ROUTING_CORPUS.find((x) => x.id === 'split-sequential')
    if (!e) throw new Error('missing example')
    const i = { ...corpusInput(e), forcedComposition: 'atomic' as const }
    const asked: string[] = []
    let decomposed = 0
    const oracle = oracleDecisionProvider(e, i)
    const outcome = await createRouter({
      decisionProvider: { decide: (r, s) => (asked.push(...Object.keys(r.questions)), oracle.decide(r, s)) },
      decomposer: { decompose: async () => ((decomposed += 1), { ok: false, error: { code: 'network', class: 'transient', message: 'no', httpStatus: null, retryAfterMs: null } }) },
    }).route(i, NEVER_CANCELLED)
    expect(asked).not.toContain('composite')
    expect(decomposed).toBe(0)
    expect(outcome.kind === 'plan' && outcome.plan.composition).toBe('atomic')
    expect(outcome.kind === 'plan' && outcome.plan.units).toHaveLength(1)
  })

  test('gate · a reply whose one plausible section is below the target-choice threshold is elicited unless its line is chosen with confidence', async () => {
    const e = ROUTING_CORPUS.find((x) => x.id === 'target-single-recent')
    if (!e) throw new Error('missing example')
    const route = (chainConfidence: number) =>
      createRouter({
        decisionProvider: {
          async decide(r) {
            const answers: Record<string, unknown> = {}
            for (const [id, q] of Object.entries(r.questions)) {
              answers[id] =
                q.type === 'choice'
                  ? { type: 'choice', choice: id.endsWith('relation') ? 'addition' : Object.keys(q.options)[0], confidence: id.endsWith('chain') ? chainConfidence : 0.8, probabilities: {} }
                  : { type: 'noul', probability: id === 'm_s1' ? 0.5 : 0.05 }
            }
            return { ok: true, model: 'm', answers: answers as never, usage: null }
          },
        },
        decomposer: referenceDecomposer(e),
      }).route(corpusInput(e), NEVER_CANCELLED)
    // 11 · "Below the target-choice confidence threshold, Committee elicits the target" (Q20, Q74):
    // with no confident line the unit would start a new chain and silently lose its referent.
    const unsure = await route(0.3)
    expect(unsure.kind).toBe('target-ambiguity')
    expect(unsure.kind === 'target-ambiguity' && unsure.candidates.map((c) => c.confidence)).toEqual([0.5])
    // With its line chosen at the threshold, it continues that line, which holds the section.
    const placed = await route(0.8)
    expect(placed.kind).toBe('plan')
    expect(placed.kind === 'plan' && placed.plan.units[0]?.placement.kind).toBe('continue')
  })
})

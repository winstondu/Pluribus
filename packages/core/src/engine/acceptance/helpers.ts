import {
  type ConversationEvent,
  type ConversationId,
  type ConversationSnapshot,
  type DirectiveId,
  type Placement,
  type PrerequisiteRef,
  type SectionView,
} from '@committee/protocol'
import { expect } from 'vitest'
import type { RoutingInput, RoutingOutcome } from '../../ports'
import { atomic, createTestBackend, type ScriptStep, type TestBackend, type TestBackendOverrides, type UnitSpec } from '../../testing'
import { engineModule } from '../engine-module'
import { fold } from '../reducers'
import { rebuildSnapshot } from '../projections'
import { emptyConversationState, type ConversationState, type DirectiveRow } from '../state'

/**
 * A conversation on a test backend with the engine alone, and lookups by
 * label so a test reads like the scenario it states.
 */
export interface Scenario {
  readonly t: TestBackend
  readonly c: ConversationId
  state(): ConversationState
  snap(): Promise<ConversationSnapshot>
  /** The directive with this label. */
  d(label: string): DirectiveRow
  id(label: string): DirectiveId
  /** Its current section, as the transcript shows it. */
  section(label: string): Promise<SectionView>
  /** Routes `text` with `spec` (an atomic plan) and scripts the model for it; submits; settles. */
  ask(text: string, spec: UnitSpec | ((input: RoutingInput) => RoutingOutcome), script?: readonly ScriptStep[]): Promise<void>
  /** Stored events of the conversation. */
  events(): Promise<ConversationEvent[]>
  /** Placement on a directive's current node. */
  on(label: string): Placement
  /** Placement on the settled head of the chain that handles `label`. */
  onHeadOf(label: string): Placement
  /** Placement on the sibling group `label` is a member of. */
  onGroupOf(label: string): Placement
  needs(label: string): PrerequisiteRef
  needsGroupOf(label: string): PrerequisiteRef
}

export async function scenario(overrides: TestBackendOverrides = {}): Promise<Scenario> {
  const t = await createTestBackend({ modules: [engineModule], ...overrides })
  const c = await t.createConversation()
  const state = (): ConversationState => t.state(c)
  const d = (label: string): DirectiveRow => {
    const s = state()
    const found = s.directiveOrder.map((id) => s.directives[id]).find((x) => x?.label === label)
    if (!found) throw new Error(`No directive labelled "${label}"`)
    return found
  }
  const groupOf = (label: string): string => {
    const directive = d(label)
    const group = Object.values(state().groups).find((g) => g.members.some((m) => m.directiveId === directive.id))
    if (!group) throw new Error(`"${label}" is in no sibling group`)
    return group.id
  }
  const s: Scenario = {
    t,
    c,
    state,
    snap: () => t.snapshot(c),
    d,
    id: (label) => d(label).id,
    async section(label) {
      const directive = d(label)
      const snapshot = await t.snapshot(c)
      const view = directive.sectionId ? snapshot.transcript.sections[directive.sectionId] : undefined
      if (!view) throw new Error(`"${label}" has no section in the transcript`)
      return view
    },
    async ask(text, spec, script) {
      if (script) t.model.script(text, script)
      t.router.when(text, typeof spec === 'function' ? spec : (input) => atomic(input, { label: spec.label ?? text, ...spec }))
      await t.submit(c, text)
    },
    async events() {
      const result = await t.backend.snapshot({ kind: 'events', conversationId: c, afterSeq: 0 })
      if (!result.ok) throw new Error(result.error.message)
      return [...result.value.events]
    },
    on: (label) => ({ kind: 'continue', buildsOn: { kind: 'node', nodeId: d(label).nodeId } }),
    onHeadOf(label) {
      const chainId = d(label).chainId
      const head = state().chains[chainId]
      if (!head) throw new Error('no chain')
      // The settled head, as a router would read it from the candidates.
      const ids = [...head.nodeIds].reverse()
      for (const nodeId of ids) {
        const node = state().nodes[nodeId]
        const owner = node?.directiveId ? state().directives[node.directiveId] : undefined
        if (node && node.replacedByNodeId === null && (!owner || !['running', 'dependency-queued', 'ready', 'retrying'].includes(owner.state))) {
          return { kind: 'continue', buildsOn: { kind: 'node', nodeId } }
        }
      }
      throw new Error('no settled head')
    },
    onGroupOf: (label) => ({ kind: 'continue', buildsOn: { kind: 'sibling-group', groupId: groupOf(label) as never } }),
    needs: (label) => ({ kind: 'directive', directiveId: d(label).id }),
    needsGroupOf: (label) => ({ kind: 'sibling-group', groupId: groupOf(label) as never }),
  }
  return s
}

/** The incremental projections equal a rebuild from the stored log, and so does the state. */
export async function expectRebuildable(s: Scenario): Promise<void> {
  const events = await s.events()
  const rebuilt = fold(emptyConversationState(s.c), events)
  expect(rebuilt).toEqual(s.state())
  expect(rebuildSnapshot(rebuilt)).toEqual(await s.snap())
}

/** Sequence number of the first stored event matching. */
export function seqOf(events: readonly ConversationEvent[], match: (e: ConversationEvent) => boolean): number {
  const found = events.find(match)
  if (!found) throw new Error('No such event')
  return found.seq
}

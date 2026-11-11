import {
  IN_FLIGHT_STATES,
  asId,
  type ChainId,
  type ChainKind,
  type DirectiveId,
  type DirectiveState,
  type ElicitationId,
  type MessageId,
  type NodeId,
  type Requirement,
  type SectionId,
  type SectionState,
  type SiblingGroupId,
} from '@committee/protocol'
import type { CandidateChain, CandidateGroup, CandidateSection, CandidateWork, RoutingCandidates } from '../../ports'

/**
 * A conversation as the router sees it, written by hand for the corpus.
 * Every entity is named by a short handle, and its ID is derived from it
 * (`sec_A`, `dir_A`, `nod_A`, `chn_trip`, `sib_G`, `req_R1`), so examples
 * and their labels read by name.
 */
export interface Scene {
  readonly candidates: RoutingCandidates
  readonly sessionRequirements: readonly Requirement[]
  /** Handle of every ID the scene contains, for reading a plan back. */
  readonly handles: ReadonlyMap<string, string>
}

export const ids = {
  section: (h: string): SectionId => asId('section', `sec_${h}`),
  directive: (h: string): DirectiveId => asId('directive', `dir_${h}`),
  node: (h: string): NodeId => asId('node', `nod_${h}`),
  chain: (h: string): ChainId => asId('chain', `chn_${h}`),
  group: (h: string): SiblingGroupId => asId('siblingGroup', `sib_${h}`),
  message: (h: string): MessageId => asId('message', `msg_${h}`),
  elicitation: (h: string): ElicitationId => asId('elicitation', `eli_${h}`),
  requirement: (h: string) => asId('requirement', `req_${h}`),
}

interface WorkSpec {
  readonly chain: string
  /** The node this work builds on. Null for a root. */
  readonly on: string | null
  readonly label: string
  readonly request: string
  readonly answer?: string
  readonly state?: DirectiveState
  readonly group?: string
  /** Handles of the directives its latest attempt consumed. */
  readonly consumed?: readonly string[]
  /** The user message it answers; defaults to its own handle. */
  readonly message?: string
}

const SECTION_STATE: { readonly [S in DirectiveState]?: SectionState } = {
  completed: 'completed',
  failed: 'failed',
  stopped: 'stopped',
  interrupted: 'interrupted',
  cancelled: 'cancelled',
}

export class SceneBuilder {
  private readonly chains: { handle: string; kind: ChainKind; label: string; nodes: string[] }[] = []
  private readonly work: (WorkSpec & { handle: string })[] = []
  private readonly groups: { handle: string; base: string; start: string; members: string[]; open: boolean }[] = []
  private readonly joinBacks = new Set<string>()
  private readonly questions: { handle: string; blocks: string; text: string }[] = []
  private readonly requirements: Requirement[] = []

  chain(handle: string, kind: ChainKind, label: string): this {
    this.chains.push({ handle, kind, label, nodes: [] })
    return this
  }

  /** An exchange: a directive with its node, and its section unless it has not started. */
  add(handle: string, spec: WorkSpec): this {
    this.work.push({ handle, ...spec })
    this.chainOf(spec.chain).nodes.push(handle)
    return this
  }

  /** A sibling group; with `open: false` its join-back node `jb_<handle>` is on the base chain. */
  group(handle: string, spec: { readonly base: string; readonly start: string; readonly members: readonly string[]; readonly open: boolean }): this {
    this.groups.push({ handle, base: spec.base, start: spec.start, members: [...spec.members], open: spec.open })
    if (!spec.open) {
      this.joinBacks.add(handle)
      this.chainOf(spec.base).nodes.push(`jb_${handle}`)
    }
    return this
  }

  /** An open clarification question that blocks `blocks` (which then has no section). */
  question(handle: string, blocks: string, text: string): this {
    this.questions.push({ handle, blocks, text })
    return this
  }

  sessionRequirement(handle: string, text: string): this {
    this.requirements.push({
      id: ids.requirement(handle),
      text,
      scope: 'session-wide',
      shared: false,
      provenance: { messageId: ids.message(handle), span: null },
    })
    return this
  }

  private chainOf(handle: string): { handle: string; kind: ChainKind; label: string; nodes: string[] } {
    const chain = this.chains.find((c) => c.handle === handle)
    if (!chain) throw new Error(`Unknown chain ${handle}`)
    return chain
  }

  build(): Scene {
    const handles = new Map<string, string>()
    const state = (h: string): DirectiveState => this.work.find((w) => w.handle === h)?.state ?? 'completed'
    const inFlight = (nodeHandle: string): boolean => {
      const w = this.work.find((x) => x.handle === nodeHandle)
      return w !== undefined && IN_FLIGHT_STATES.includes(state(w.handle))
    }
    const heldBy = new Set(this.questions.map((q) => q.blocks))
    const sections: CandidateSection[] = []
    const work: CandidateWork[] = []
    for (const w of this.work) {
      const s = state(w.handle)
      const groupOf = this.groups.find((g) => g.members.includes(w.handle))
      handles.set(ids.directive(w.handle), w.handle)
      handles.set(ids.node(w.handle), w.handle)
      const hasSection = !heldBy.has(w.handle)
      if (hasSection) {
        handles.set(ids.section(w.handle), w.handle)
        sections.push({
          sectionId: ids.section(w.handle),
          directiveId: ids.directive(w.handle),
          messageId: ids.message(w.message ?? w.handle),
          title: w.label,
          request: w.request,
          excerpt: w.answer ?? '',
          state: SECTION_STATE[s] ?? (s === 'running' && w.answer ? 'streaming' : 'pending'),
          chainId: ids.chain(w.chain),
          nodeId: ids.node(w.handle),
          asksElicitationId: null,
        })
      }
      work.push({
        directiveId: ids.directive(w.handle),
        label: w.label,
        instruction: w.request,
        state: heldBy.has(w.handle) ? 'awaiting-elicitation' : s,
        sectionId: hasSection ? ids.section(w.handle) : null,
        nodeId: ids.node(w.handle),
        chainId: ids.chain(w.chain),
        startNodeId: w.on ? this.nodeId(w.on) : null,
        groupId: groupOf ? ids.group(groupOf.handle) : null,
        consumed: (w.consumed ?? []).map(ids.directive),
        consumedRequirements: [],
      })
    }
    for (const q of this.questions) {
      const blocked = this.work.find((w) => w.handle === q.blocks)
      if (!blocked) throw new Error(`Unknown blocked work ${q.blocks}`)
      handles.set(ids.section(q.handle), q.handle)
      handles.set(ids.elicitation(q.handle), q.handle)
      sections.push({
        sectionId: ids.section(q.handle),
        directiveId: ids.directive(q.handle),
        messageId: ids.message(blocked.message ?? blocked.handle),
        title: 'Question',
        request: `Ask the user what is missing for: ${blocked.request}`,
        excerpt: q.text,
        state: 'completed',
        chainId: ids.chain(blocked.chain),
        nodeId: ids.node(blocked.handle),
        asksElicitationId: ids.elicitation(q.handle),
      })
    }
    const chains: CandidateChain[] = this.chains.map((c) => {
      handles.set(ids.chain(c.handle), c.handle)
      const tip = c.nodes[c.nodes.length - 1]
      if (!tip) throw new Error(`Chain ${c.handle} has no node`)
      const head = [...c.nodes].reverse().find((n) => !inFlight(n)) ?? null
      return {
        chainId: ids.chain(c.handle),
        kind: c.kind,
        label: c.label,
        headNodeId: head ? this.nodeId(head) : null,
        tipNodeId: this.nodeId(tip),
        busy: this.work.some((w) => w.chain === c.handle && IN_FLIGHT_STATES.includes(state(w.handle))),
      }
    })
    const groups: CandidateGroup[] = this.groups.map((g) => {
      handles.set(ids.group(g.handle), `group:${g.handle}`)
      if (this.joinBacks.has(g.handle)) handles.set(ids.node(`jb_${g.handle}`), `group:${g.handle}`)
      return {
        groupId: ids.group(g.handle),
        open: g.open,
        baseChainId: ids.chain(g.base),
        startNodeId: ids.node(g.start),
        memberDirectiveIds: g.members.map(ids.directive),
        label: g.members.map((m) => this.work.find((w) => w.handle === m)?.label ?? m).join(' + '),
      }
    })
    for (const r of this.requirements) handles.set(r.id, r.id.slice(4))
    return { candidates: { sections, chains, work, groups }, sessionRequirements: this.requirements, handles }
  }

  private nodeId(handle: string): NodeId {
    return ids.node(handle)
  }
}

export function scene(): SceneBuilder {
  return new SceneBuilder()
}

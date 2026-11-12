import type { ConversationId, DecisionBudget, ProviderError, SectionId, SiblingGroupId } from '@committee/protocol'
import type { CandidateGroup, CandidateSection } from './router'
import type { ReferentSection, ReferentUnit } from './referent-strategy'

/**
 * The operations a referent search is written against (11 · "Dependency
 * attachment"; docs/build/dependency-decisioning.md · "The model and the
 * operations").
 *
 * The genealogy is read as a graph of answer sections and join-backs. The
 * context of a node is the node and its ancestors. For a unit there is a
 * hidden set of relevant nodes, and dependency selection returns the
 * deepest of them: every relevant node that has no relevant descendant. A
 * search finds them with the operations below and nothing else, so a
 * strategy is only policy: which probes next, where to split, when to stop.
 *
 * Decision-backed, counted against the decision budget:
 * - **Point**: does the unit refer to this one node, asked about by itself.
 *   The decision model is shown some of the node's ancestry as context.
 * - **Group**: does it build on a sibling group as a whole (the join-back).
 * - **Segment**: does it refer to anything in this contiguous part of an
 *   unbranched run. The first nodes of the run are shown as context; the
 *   question is about the part only. It directs a search and confirms
 *   nothing.
 * - **Several**: does it refer to more than one section.
 * Only a Point or a Group can make a node a referent (DA3). The one
 * exception is the last section of an unbranched run, taken without a
 * search when hop between branch points is on.
 *
 * Free:
 * - **Estimate**: a cheap prior. Never confirms anything.
 * - **Structure**: the tree types below; the helpers that read them are
 *   pure functions over state (`routing/referents/tree.ts`).
 * - **Describe**: how a node is shown in a question.
 * - **Cost**: the size of a probe, and whether a round fits what is left of
 *   the budget. The probes of one round are one decision request.
 */
export interface ReferentOperations {
  /** The latest answer to a probe, as a probability of yes: from the routing request or from a round. Null when it was not asked. */
  known(probe: Probe): number | null
  /**
   * One round: every probe in one decision request. A probe that is already
   * known is asked again. Never rejects; a round the budget does not allow
   * is refused and nothing is sent.
   */
  ask(round: readonly Probe[]): Promise<ProbeRoundResult>
  /** Whether the routing request, which is sent anyway, can carry the probe: everything it names is listed there. */
  rides(probe: Probe): boolean
  /** Estimate: a prior between 0 and 1 that the unit refers to something among the nodes, or null when there is none. */
  estimate(unit: ReferentUnit, nodes: readonly ReferentNode[]): number | null
  /** Describe: what a question shows for the node. */
  describe(node: ReferentNode): string
  /** Cost: what a probe adds to a round, in estimated input tokens. Deterministic. */
  size(probe: Probe): number
  /**
   * Cost: the first limit of the decision budget that sending `round`, and
   * `reserve` as a round after it, would pass; null when both fit. An empty
   * round costs nothing.
   */
  fits(round: readonly Probe[], reserve?: readonly Probe[]): keyof DecisionBudget | null
  /** Cost: what the budget still allows. */
  remaining(): DecisionBudget
}

export type ProbeRoundResult =
  | { readonly kind: 'answered' }
  /** The round would exceed the budget. Nothing was sent. */
  | { readonly kind: 'refused'; readonly limit: keyof DecisionBudget }
  | { readonly kind: 'failed'; readonly error: ProviderError }

export type Probe = PointProbe | GroupProbe | SegmentProbe | SeveralProbe

export interface PointProbe {
  readonly kind: 'point'
  readonly unit: ReferentUnit
  readonly node: SectionNode
}

export interface GroupProbe {
  readonly kind: 'group'
  readonly unit: ReferentUnit
  readonly node: GroupNode
}

export interface SegmentProbe {
  readonly kind: 'segment'
  readonly unit: ReferentUnit
  /** Sections of one unbranched run, in the run's order. Old single answers that nothing was built on count as one run. */
  readonly nodes: readonly SectionNode[]
}

export interface SeveralProbe {
  readonly kind: 'several'
  readonly unit: ReferentUnit
}

// ───────────────────────────── structure ─────────────────────────────

/**
 * A node of the context tree a search reads (01 · "Context ancestry"): an
 * answer section, or a sibling group's join-back as an artificial node.
 */
export type ReferentNode = SectionNode | GroupNode

interface NodeBase {
  /** `s:<sectionId>` or `g:<groupId>`. */
  readonly key: string
  parent: ReferentNode | null
  readonly children: ReferentNode[]
}

export interface SectionNode extends NodeBase {
  readonly kind: 'section'
  /** Its number in every state text of the routing: `S<n>`. */
  readonly n: number
  readonly entry: ReferentSection
}

export interface GroupNode extends NodeBase {
  readonly kind: 'group'
  /** Its number in question IDs: 1-based position among the supplied groups. */
  readonly index: number
  readonly group: CandidateGroup
  /** Members that have answer sections, in submission order. Two or more. Every member is an ancestor of the node. */
  readonly members: SectionNode[]
}

export interface ReferentTree {
  readonly roots: readonly ReferentNode[]
  /** Every node, parents before children, sections in `n` order. */
  readonly nodes: readonly ReferentNode[]
  readonly bySection: ReadonlyMap<SectionId, SectionNode>
  readonly byGroup: ReadonlyMap<SiblingGroupId, GroupNode>
}

// ───────────────────────────── candidates ─────────────────────────────

export interface CandidateQuery {
  /** The conversation the sections belong to: a source that keeps an index keeps one for each. */
  readonly conversationId: ConversationId
  readonly unit: ReferentUnit
  /** The text of the unit: the message, or the instruction of one part. */
  readonly text: string
  /** Every answer section of the conversation, oldest first. Only these may be returned (invariant 9). */
  readonly sections: readonly CandidateSection[]
  /** The whole answer text of one of `sections` so far; its `excerpt` is only the opening. */
  answerText(section: CandidateSection): string
  /**
   * The first-pass sections. Every routing asks about each of them by
   * itself in the routing request, whatever a source returns, so a source
   * gains nothing by naming one.
   */
  readonly firstPass: readonly SectionId[]
}

/** One candidate section. */
export interface CandidateHit {
  readonly sectionId: SectionId
  /** The source's own score, higher is closer, or null when it has none. Recorded with the routing decision; routing never reads it. */
  readonly score: number | null
}

/**
 * Where a tree walk may start besides the roots: sections that something
 * outside routing suggests the unit refers to, for example the hits of a
 * retrieval over the conversation. A candidate is a seed hint, a place to
 * look, and never a referent: it is asked about like any other node. With
 * no source the walk starts at the roots alone. Never rejects.
 */
export interface CandidateSource {
  /** Recorded with the routing decision as the source that ran. */
  readonly name: string
  /** Best first. */
  candidates(query: CandidateQuery): Promise<readonly CandidateHit[]>
}

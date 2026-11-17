import type { SectionId, SiblingGroupId } from '@pluribus/protocol'
import type { CandidateGroup } from './router'
import type { ReferentSection, ReferentUnit } from './referent-strategy'

/**
 * The operations a referent search is written against (11 · "Dependency
 * attachment").
 *
 * The genealogy is read as a graph of answer sections and join-backs. The
 * context of a node is the node and its ancestors. For a unit there is a
 * hidden set of relevant nodes, and dependency selection returns the
 * deepest of them: every relevant node that has no relevant descendant. A
 * search finds them with the operations below and nothing else, so a
 * strategy is only policy: which probes next, where to split, when to stop.
 *
 * Decision-backed:
 * - **Point**: does the unit refer to this one node, asked about by itself.
 * - **Group**: does it build on a sibling group as a whole (the join-back).
 * - **Several**: does it refer to more than one section.
 * Only a Point or a Group can make a node a referent (DA3).
 *
 * Free:
 * - **Structure**: the tree types below; the helpers that read them are
 *   pure functions over state (`routing/referents/tree.ts`).
 */
export interface ReferentOperations {
  /** The latest answer to a probe, as a probability of yes: from the routing request or from a round. Null when it was not asked. */
  known(probe: Probe): number | null
  /** Whether the routing request, which is sent anyway, can carry the probe: everything it names is listed there. */
  rides(probe: Probe): boolean
}

export type Probe = PointProbe | GroupProbe | SeveralProbe

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

import type { ProviderError, TreeWalkSettings } from '@pluribus/protocol'
import type { GroupProbe, PointProbe, Probe, ReferentOperations, ReferentResult, ReferentStrategy, ReferentUnit, RunEndTaken, SegmentProbe, SeveralProbe, UnitReferents } from '../../ports'
import { createDecisionOperations, type OperationsFactory } from './operations'
import { referentsFromScores } from './shared'
import { buildTree, type GroupNode, type ReferentTree, type SectionNode, type TreeNode } from './tree'

/**
 * A referent search as policy over the operations.
 *
 * The search looks for the deepest relevant nodes of each unit: every
 * relevant node that has no relevant descendant. A policy decides which
 * probes to send next, where to split and when to stop, and nothing else:
 * it holds no question text, no question ID
 * and no decision-provider type. Whatever implements `ReferentOperations`
 * can drive it: the decision provider, or an oracle over
 * a labelled set of relevant nodes in a test.
 *
 * Only a Point or a Group confirms a node. The one exception is a `RunEnd`:
 * with hop between branch points on, the tree walk takes the last section
 * of an unbranched run the unit refers to without asking about it by
 * itself (DA3).
 */
export interface ReferentPolicy {
  readonly name: ReferentStrategy['name']
  /** The probes the policy wants answered in the routing request, which is sent anyway. Asked before anything is known. */
  opening(input: SearchInput, ops: ReferentOperations): readonly Probe[]
  /** The search. Its findings are the answers the operations hold. Never rejects. */
  search(input: SearchInput, ops: ReferentOperations): Promise<SearchOutcome>
}

export interface SearchInput {
  readonly tree: ReferentTree
  readonly units: readonly ReferentUnit[]
  readonly relevance: {
    /** At or above this a Point or a Group confirms its node: the target-choice threshold. */
    readonly clear: number
    /** At or above this a node or a part of a run is plausible: worth looking into. */
    readonly floor: number
  }
  readonly settings: TreeWalkSettings
  /** Where a walk starts for a unit besides the roots. */
  starts(unit: ReferentUnit): readonly TreeNode[]
  /**
   * Whether the unit corrects earlier work. A correction needs the relevant
   * nodes themselves and not only the deepest: it may name work its
   * descendants only consumed (06). False while the routing request is
   * being put together.
   */
  corrective(unit: ReferentUnit): boolean
  /**
   * Whether a run that continues from the section fits what a run may read.
   * Left out: every section does. False for a section means false for
   * every section below it on its line.
   */
  continuable?(node: SectionNode): boolean
}

/**
 * What a walk with hop between branch points on holds about one unbranched
 * run: the section a unit that refers to the run is placed on, and every
 * probe that says whether it does. The section takes the highest of their
 * answers as its score (`unitReferents`).
 */
export interface RunEnd {
  readonly unit: ReferentUnit
  /** The section taken: the last of the run, or the deepest one a run can continue from. */
  readonly node: SectionNode
  /** The sections of the run, first to last. */
  readonly run: readonly SectionNode[]
  /** Points on sections of the run at or above `node`, and Segments over parts of it. Unanswered ones count for nothing. */
  readonly evidence: readonly (PointProbe | SegmentProbe)[]
}

export type SearchOutcome =
  | {
      readonly ok: true
      /** The runs whose last section was taken without a search inside them. Left out when there are none. */
      readonly runEnds?: readonly RunEnd[]
    }
  | { readonly ok: false; readonly error: ProviderError }

export const probe = {
  point: (unit: ReferentUnit, node: SectionNode): PointProbe => ({ kind: 'point', unit, node }),
  group: (unit: ReferentUnit, node: GroupNode): GroupProbe => ({ kind: 'group', unit, node }),
  segment: (unit: ReferentUnit, nodes: readonly SectionNode[]): SegmentProbe => ({ kind: 'segment', unit, nodes }),
  several: (unit: ReferentUnit): SeveralProbe => ({ kind: 'several', unit }),
  /** The probe that asks about a node by itself: the only kind that can confirm it (DA3). */
  of: (unit: ReferentUnit, node: TreeNode): PointProbe | GroupProbe => (node.kind === 'section' ? probe.point(unit, node) : probe.group(unit, node)),
}

/**
 * What a search found for one unit, read from the operations: a node that
 * was asked about by itself has that score, and the section taken for a
 * run (`RunEnd`) has the highest score among the questions about the run,
 * when that is at least plausible. Ancestors of a confirmed node are
 * dropped (not for a correction) and a confirmed group stands for all its
 * members (`referentsFromScores`).
 */
export function unitReferents(input: SearchInput, ops: ReferentOperations, unit: ReferentUnit, runEnds: readonly RunEnd[] = []): UnitReferents {
  const taken = new Map<TreeNode, { readonly end: RunEnd; readonly value: number; readonly by: PointProbe | SegmentProbe }>()
  for (const end of runEnds) {
    if (end.unit !== unit) continue
    let best: { readonly value: number; readonly by: PointProbe | SegmentProbe } | null = null
    for (const by of end.evidence) {
      const value = ops.known(by)
      if (value !== null && (best === null || value > best.value)) best = { value, by }
    }
    if (best && best.value >= input.relevance.floor) taken.set(end.node, { end, ...best })
  }
  const own = (node: TreeNode): number | null => ops.known(probe.of(unit, node))
  const score = (node: TreeNode): number | null => {
    const asked = own(node)
    const run = taken.get(node)?.value ?? null
    return run === null ? asked : asked === null ? run : Math.max(asked, run)
  }
  const corrective = input.corrective(unit)
  const sections = referentsFromScores(input.tree, score, { corrective, clear: input.relevance.clear })
  const kept = new Set(sections.map((s) => s.sectionId))
  const id = (node: SectionNode): RunEndTaken['sectionId'] => node.entry.section.sectionId
  const span = (nodes: readonly SectionNode[]): RunEndTaken['run'] | null => {
    const first = nodes[0]
    const last = nodes[nodes.length - 1]
    return first && last ? { firstSectionId: id(first), lastSectionId: id(last), sections: nodes.length } : null
  }
  // Reported: the sections that are referents because their run is, not because they were asked about by themselves.
  const ends: RunEndTaken[] = []
  for (const [node, { end, value, by }] of taken) {
    const run = span(end.run)
    const evidence = span(by.kind === 'point' ? [by.node] : by.nodes)
    if (!run || !evidence || !kept.has(id(end.node)) || (own(node) ?? -1) >= value) continue
    ends.push({ sectionId: id(end.node), confidence: value, run, evidence, limitedByContext: end.node !== end.run[end.run.length - 1] })
  }
  return {
    sections,
    several: ops.known(probe.several(unit)),
    ...(ends.length > 0 ? { runEnds: ends } : {}),
  }
}

/**
 * A policy as the referent strategy the pipeline is handed. The operations
 * are the decision-backed ones unless another factory is given.
 */
export function strategyFromPolicy(policy: ReferentPolicy, operations: OperationsFactory = createDecisionOperations): ReferentStrategy {
  return {
    name: policy.name,
    questions(request) {
      const tree = buildTree(request)
      const ops = operations({ request, tree, gate: null, ask: null })
      const input: SearchInput = {
        tree,
        units: request.units,
        relevance: request.relevance,
        settings: request.treeWalk,
        starts: () => [],
        corrective: () => false,
      }
      return ops.questions(policy.opening(input, ops))
    },
    async resolve(request, gate, ask): Promise<ReferentResult> {
      const tree = buildTree(request)
      const ops = operations({ request, tree, gate, ask })
      const input: SearchInput = {
        tree,
        units: request.units,
        relevance: request.relevance,
        settings: request.treeWalk,
        starts: () => [],
        corrective: (unit) => gate.corrective.has(unit.key),
        ...(request.runContextFits ? { continuable: (node: SectionNode) => request.runContextFits?.(node.entry.section) ?? true } : {}),
      }
      const outcome = await policy.search(input, ops)
      if (!outcome.ok) return outcome
      const units: { [key: string]: UnitReferents } = {}
      for (const unit of request.units) units[unit.key] = unitReferents(input, ops, unit, outcome.runEnds)
      return { ok: true, units }
    },
  }
}

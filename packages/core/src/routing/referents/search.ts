import type { DecisionBudget, ProviderError, SectionId, TreeWalkSettings } from '@committee/protocol'
import type { GroupProbe, PointProbe, Probe, ReferentOperations, ReferentResult, ReferentStrategy, ReferentUnit, SegmentProbe, SeveralProbe, UnitReferents } from '../../ports'
import { createDecisionOperations, type OperationsFactory } from './operations'
import { bestNodeFound, referentsFromScores } from './shared'
import { buildTree, type GroupNode, type ReferentTree, type SectionNode, type TreeNode } from './tree'

/**
 * A referent search as policy over the operations
 * (docs/build/dependency-decisioning.md · "The model and the operations").
 *
 * The search looks for the deepest relevant nodes of each unit: every
 * relevant node that has no relevant descendant. A policy decides which
 * probes to send next, where to split and when to stop, and nothing else:
 * it holds no question text, no question ID, no arithmetic on the budget
 * and no decision-provider type. Whatever implements `ReferentOperations`
 * can drive it: the decision provider behind the guard, or an oracle over
 * a labelled set of relevant nodes in a test.
 *
 * Exact and best effort are the same search. With no budget it runs to its
 * end. With one, a round that does not fit is not sent: the search stops
 * and what was confirmed by a Point or a Group so far stands.
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
}

export type SearchOutcome =
  | {
      readonly ok: true
      /** Set when the decision budget stopped the search: the limit, and whether the listed sections not yet asked about were still asked about in one round. */
      readonly stop: { readonly limit: keyof DecisionBudget; readonly to: 'one-pass' | 'partial' } | null
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
 * What a search found for one unit, read from the operations: only a node
 * that was asked about by itself has a score. Ancestors of a confirmed node
 * are dropped (not for a correction) and a confirmed group stands for all
 * its members (`referentsFromScores`). After a stop, the best node found so
 * far is reported with them.
 */
export function unitReferents(input: SearchInput, ops: ReferentOperations, unit: ReferentUnit, stopped: boolean): UnitReferents {
  const score = (node: TreeNode): number | null => ops.known(probe.of(unit, node))
  const corrective = input.corrective(unit)
  return {
    sections: referentsFromScores(input.tree, score, { corrective, clear: input.relevance.clear }),
    several: ops.known(probe.several(unit)),
    ...(stopped ? { best: bestNodeFound(input.tree, score, { corrective, floor: input.relevance.floor }) } : {}),
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
        starts: (unit) => startNodes(tree, request.startCandidates[unit.key]),
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
        starts: (unit) => startNodes(tree, request.startCandidates[unit.key]),
        corrective: (unit) => gate.corrective.has(unit.key),
      }
      const outcome = await policy.search(input, ops)
      if (!outcome.ok) return outcome
      const units: { [key: string]: UnitReferents } = {}
      for (const unit of request.units) units[unit.key] = unitReferents(input, ops, unit, outcome.stop !== null)
      return { ok: true, units, fallback: outcome.stop }
    },
  }
}

function startNodes(tree: ReferentTree, ids: readonly SectionId[] | undefined): TreeNode[] {
  return (ids ?? []).flatMap((id) => {
    const node = tree.bySection.get(id)
    return node ? [node] : []
  })
}

import type { ProviderError } from '@pluribus/protocol'
import type { GroupProbe, PointProbe, Probe, ReferentOperations, ReferentResult, ReferentStrategy, ReferentUnit, SeveralProbe, UnitReferents } from '../../ports'
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
 * Only a Point or a Group confirms a node (DA3).
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
  /**
   * Whether the unit corrects earlier work. A correction needs the relevant
   * nodes themselves and not only the deepest: it may name work its
   * descendants only consumed (06). False while the routing request is
   * being put together.
   */
  corrective(unit: ReferentUnit): boolean
}

export type SearchOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: ProviderError }

export const probe = {
  point: (unit: ReferentUnit, node: SectionNode): PointProbe => ({ kind: 'point', unit, node }),
  group: (unit: ReferentUnit, node: GroupNode): GroupProbe => ({ kind: 'group', unit, node }),
  several: (unit: ReferentUnit): SeveralProbe => ({ kind: 'several', unit }),
  /** The probe that asks about a node by itself: the only kind that can confirm it (DA3). */
  of: (unit: ReferentUnit, node: TreeNode): PointProbe | GroupProbe => (node.kind === 'section' ? probe.point(unit, node) : probe.group(unit, node)),
}

/**
 * What a search found for one unit, read from the operations: a node that
 * was asked about by itself has that score. Ancestors of a confirmed node are
 * dropped (not for a correction) and a confirmed group stands for all its
 * members (`referentsFromScores`).
 */
export function unitReferents(input: SearchInput, ops: ReferentOperations, unit: ReferentUnit): UnitReferents {
  const own = (node: TreeNode): number | null => ops.known(probe.of(unit, node))
  const corrective = input.corrective(unit)
  const sections = referentsFromScores(input.tree, own, { corrective, clear: input.relevance.clear })
  return {
    sections,
    several: ops.known(probe.several(unit)),
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
      const ops = operations({ request, tree, gate: null })
      const input: SearchInput = {
        tree,
        units: request.units,
        relevance: request.relevance,
        corrective: () => false,
      }
      return ops.questions(policy.opening(input, ops))
    },
    async resolve(request, gate): Promise<ReferentResult> {
      const tree = buildTree(request)
      const ops = operations({ request, tree, gate })
      const input: SearchInput = {
        tree,
        units: request.units,
        relevance: request.relevance,
        corrective: (unit) => gate.corrective.has(unit.key),
      }
      const outcome = await policy.search(input, ops)
      if (!outcome.ok) return outcome
      const units: { [key: string]: UnitReferents } = {}
      for (const unit of request.units) units[unit.key] = unitReferents(input, ops, unit)
      return { ok: true, units }
    },
  }
}

import type { ReferentStrategyName } from '@committee/protocol'
import type { ReferentStrategy } from '../../ports'
import { onePassStrategy } from './one-pass'
import { treeWalkStrategy } from './tree-walk'

/**
 * Referent strategies (docs/build/dependency-decisioning.md): how routing
 * decides which earlier work a message refers to and depends on. Both sit
 * behind `ReferentStrategy`; the pipeline takes the one settings name, or
 * the one injected as `CoreDependencies.referentStrategy`. Each is a policy
 * (`ReferentPolicy`) over the operations (`ReferentOperations`): the
 * decision-backed ones here, an oracle in tests.
 */
export const REFERENT_STRATEGIES: { readonly [N in ReferentStrategyName]: ReferentStrategy } = {
  'one-pass': onePassStrategy,
  'tree-walk': treeWalkStrategy,
}

export function referentStrategyFor(name: ReferentStrategyName): ReferentStrategy {
  return REFERENT_STRATEGIES[name] ?? onePassStrategy
}

export { onePassPolicy, onePassProbes, onePassStrategy } from './one-pass'
export { treeWalkPolicy, treeWalkStrategy, startSet, MIN_SKIPPED, SEARCH_FANOUT, type StartSet } from './tree-walk'
export { probe, strategyFromPolicy, unitReferents, type ReferentPolicy, type SearchInput, type SearchOutcome } from './search'
export { createDecisionOperations, POINT_ANCESTRY, SEGMENT_LEAD, type DecisionOperations, type OperationsContext, type OperationsFactory } from './operations'
export { createOracleOperations, type OracleOperations, type OracleOptions } from './oracle'
export {
  createReferentAsk,
  decisionAllowance,
  estimateDecisionTokens,
  estimateRequestTokens,
  routingTokenBudget,
  ANSWERS_TO_GO_BY,
  SHORTEST_ANSWER_TOKENS,
  type ReferentSpend,
  type RoutedWork,
  type RoutingLimit,
  type RoutingTokenBudget,
} from './ask'
export { buildTree, branchingDepth, ancestorsOf, ancestorsOfAll, joinBacksOf, reduceToNonAncestors, segmentFrom, stretchOf, type ReferentTree, type TreeNode } from './tree'
export { bestNodeFound, referentsFromScores, questionId as referentQuestionId } from './shared'
export { FIRST_PASS_SECTIONS, firstPassQuestions, firstPassSectionIds } from './first-pass'

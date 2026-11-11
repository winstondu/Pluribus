import type { ReferentStrategyName } from '@committee/protocol'
import type { ReferentStrategy } from '../../ports'
import { onePassStrategy } from './one-pass'
import { treeWalkStrategy } from './tree-walk'

/**
 * Referent strategies (docs/build/dependency-decisioning.md): how routing
 * decides which earlier work a message refers to and depends on. Both sit
 * behind `ReferentStrategy`; the pipeline takes the one settings name, or
 * the one injected as `CoreDependencies.referentStrategy`.
 */
export const REFERENT_STRATEGIES: { readonly [N in ReferentStrategyName]: ReferentStrategy } = {
  'one-pass': onePassStrategy,
  'tree-walk': treeWalkStrategy,
}

export function referentStrategyFor(name: ReferentStrategyName): ReferentStrategy {
  return REFERENT_STRATEGIES[name] ?? onePassStrategy
}

export { onePassStrategy } from './one-pass'
export { treeWalkStrategy } from './tree-walk'
export { createReferentAsk, decisionAllowance, estimateDecisionTokens, estimateRequestTokens, ANSWERS_TO_GO_BY, type ReferentSpend } from './ask'
export { buildTree, branchingDepth, ancestorsOf, segmentFrom, type ReferentTree, type TreeNode } from './tree'
export { referentsFromScores, questionId as referentQuestionId } from './shared'

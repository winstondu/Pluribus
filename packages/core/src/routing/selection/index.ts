import type { RoutingSettings, StrategyChoice, StrategySelectionMode, StrategySelectionRecord, TreeWalkSettings } from '@pluribus/protocol'
import type { ReferentRequest, ReferentStrategy, SelectorAsk, StrategySelector } from '../../ports'
import { referentStrategyFor } from '../referents'
import { createDecisionSelector } from './decision'
import { rulesSelector } from './rules'
import { describeShape, genealogyShape, shapeSignature } from './shape'

/**
 * Strategy selection (docs/build/dependency-decisioning.md · "Strategy selection"; working name
 * "decision-inception"): the optional layer that chooses a routing's
 * referent strategy and tree-walk settings from the shape of the
 * genealogy. With no selector, the settings are used as they are. Hop
 * between branch points is never part of a choice: it is used as the user
 * set it, whoever chose the rest.
 */

/** A run is never searched above this size: how a choice turns the search of long runs off. */
export const NEVER_SEARCH_RUNS = 1_000_000_000

const decisionSelector = createDecisionSelector()

/** The selector a mode names, or null when selection is off. */
export function strategySelectorFor(mode: StrategySelectionMode): StrategySelector | null {
  return mode === 'rules' ? rulesSelector : mode === 'decision-model' ? decisionSelector : null
}

/** What the settings name, as a choice. */
export function configuredChoice(routing: Pick<RoutingSettings, 'referentStrategy' | 'treeWalk'>): StrategyChoice {
  if (routing.referentStrategy === 'one-pass') return { strategy: 'one-pass' }
  const { startAtTrunkBase, searchRunsOverTokens } = routing.treeWalk
  return { strategy: 'tree-walk', startAtTrunkBase, searchLongRuns: searchRunsOverTokens < NEVER_SEARCH_RUNS }
}

/** A choice as the pipeline uses it: a strategy, and the tree-walk settings handed to it. The run size that is searched and hop between branch points stay the configured ones. */
export function applyChoice(choice: StrategyChoice, configured: TreeWalkSettings): { readonly strategy: ReferentStrategy; readonly treeWalk: TreeWalkSettings } {
  if (choice.strategy === 'one-pass') return { strategy: referentStrategyFor('one-pass'), treeWalk: configured }
  return {
    strategy: referentStrategyFor('tree-walk'),
    treeWalk: {
      startAtTrunkBase: choice.startAtTrunkBase,
      hopBetweenBranchPoints: configured.hopBetweenBranchPoints,
      searchRunsOverTokens: choice.searchLongRuns ? Math.min(configured.searchRunsOverTokens, NEVER_SEARCH_RUNS - 1) : NEVER_SEARCH_RUNS,
    },
  }
}

export interface StrategySelectionInput {
  readonly selector: StrategySelector
  readonly routing: Pick<RoutingSettings, 'referentStrategy' | 'treeWalk'>
  /** The answer sections and candidates the strategy will read: the shape is taken from the same tree. */
  readonly sections: ReferentRequest['sections']
  readonly candidates: ReferentRequest['candidates']
  readonly message: string
  /** The decision model's confidence at or above which its choice stands. */
  readonly confidence: number
  /** Decision input tokens the routing may use in all. */
  readonly tokenBudget: number
  /** The most recent selection recorded in the conversation, for reuse. */
  readonly onRecord: StrategySelectionRecord | null
  readonly ask: SelectorAsk
}

/**
 * Runs the selector for one routing. A choice on record for the same shape
 * signature, made by a selector whose choices are reusable and not a
 * fallback, is taken as it is: nothing is asked.
 */
export async function selectStrategy(input: StrategySelectionInput): Promise<StrategySelectionRecord> {
  const shape = genealogyShape(input)
  const signature = shapeSignature(shape, input.tokenBudget)
  const held = input.onRecord
  if (input.selector.reusable && held && held.signature === signature && held.selector !== 'rules' && held.fallback === null) {
    return { ...held, reused: true }
  }
  const selection = await input.selector.select(
    { shape, description: describeShape(shape, input.tokenBudget), configured: configuredChoice(input.routing), tokenBudget: input.tokenBudget, message: input.message, confidence: input.confidence },
    input.ask,
  )
  return { ...selection, signature, reused: false }
}

/** The choice in a few words, for the routing decision's explanation. */
export function choiceText(choice: StrategyChoice): string {
  if (choice.strategy === 'one-pass') return 'one pass'
  const parts = [choice.searchLongRuns ? 'long runs searched' : 'runs listed', ...(choice.startAtTrunkBase ? ['starting at the trunk base'] : [])]
  return `the tree walk (${parts.join(', ')})`
}

export { rulesSelector, chooseByRules, TRUNK_SKIP, FURTHER_REQUEST_ROOM } from './rules'
export { createDecisionSelector } from './decision'
export { genealogyShape, shapeSignature, describeShape } from './shape'

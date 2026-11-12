import type { StrategyChoice, StrategySelectionFallback } from '@pluribus/protocol'
import type { SelectorQuestions, StrategySelection, StrategySelector } from '../../ports'
import { FURTHER_REQUEST_ROOM, TRUNK_SKIP, chooseByRules } from './rules'

/**
 * The decision-model strategy selector: one small request about the shape
 * of the genealogy, three typed questions (a `choice` and two `noul`),
 * never free text. Hop between branch points is not asked about: it is the
 * user's setting (`./rules`). The rules stand in when the request fails, when the
 * model's confidence in the strategy is below the threshold, and when the
 * routing's token budget does not allow the request.
 *
 * `includeMessage` adds the new message to what the model is shown. It is
 * off: measured live it did not improve the choice
 * (docs/build/dependency-decisioning.md · "Strategy selection"), and a choice made from the shape
 * alone can be reused for every routing of the same shape.
 */
export function createDecisionSelector(options: { readonly includeMessage?: boolean } = {}): StrategySelector {
  const includeMessage = options.includeMessage === true
  return {
    name: includeMessage ? 'decision-model (with the message)' : 'decision-model',
    reusable: !includeMessage,
    async select(request, ask): Promise<StrategySelection> {
      const byRules = (fallback: StrategySelectionFallback, why: string): StrategySelection => {
        const rules = chooseByRules(request.shape, request.tokenBudget)
        return { selector: 'rules', choice: rules.choice, reason: `${why} By the rules: ${rules.reason}`, scores: null, fallback }
      }
      const state = includeMessage ? `${request.description}\n\nNew message: ${JSON.stringify(request.message)}` : request.description
      const result = await ask(state, selectorQuestions(includeMessage))
      if (result.kind === 'refused') return byRules('no-budget', 'The routing\'s token budget had no room to ask the decision model about the shape.')
      if (result.kind === 'failed') return byRules('failed', 'The decision model could not be asked about the shape.')
      const strategy = result.choice(QUESTION.strategy)
      if (!strategy || (strategy.choice !== 'one-pass' && strategy.choice !== 'tree-walk')) return byRules('failed', 'The decision model did not choose a strategy.')
      const scores: { [name: string]: number } = { strategy: strategy.confidence }
      if (strategy.confidence < request.confidence) {
        return { ...byRules('low-confidence', `The decision model chose ${strategy.choice} with confidence ${strategy.confidence.toFixed(2)}, below ${request.confidence.toFixed(2)}.`), scores }
      }
      if (strategy.choice === 'one-pass') {
        return { selector: 'decision-model', choice: { strategy: 'one-pass' }, reason: `The decision model chose one pass for this shape (confidence ${strategy.confidence.toFixed(2)}).`, scores, fallback: null }
      }
      const trunk = result.noul(QUESTION.trunk) ?? 0
      const search = result.noul(QUESTION.search) ?? 1
      Object.assign(scores, { startAtTrunkBase: trunk, searchLongRuns: search })
      // A switch is turned on only on a confident yes. The search is the default and is turned off only on a confident no:
      // off, a run too long to list is out of reach.
      const choice: StrategyChoice = {
        strategy: 'tree-walk',
        startAtTrunkBase: trunk >= request.confidence,
        searchLongRuns: search > 1 - request.confidence,
      }
      const on = [choice.searchLongRuns ? 'long runs searched' : 'runs listed', ...(choice.startAtTrunkBase ? ['starting at the trunk base'] : [])]
      return { selector: 'decision-model', choice, reason: `The decision model chose the tree walk for this shape (confidence ${strategy.confidence.toFixed(2)}): ${on.join(', ')}.`, scores, fallback: null }
    },
  }
}

const QUESTION = { strategy: 'sel_strategy', trunk: 'sel_trunk', search: 'sel_search' } as const

function selectorQuestions(includeMessage: boolean): SelectorQuestions {
  const subject = includeMessage ? 'the new message refers to' : 'a new message refers to'
  return {
    [QUESTION.strategy]: {
      type: 'choice',
      instructions: `Which way of finding the earlier answers ${subject} fits a conversation of this shape?`,
      options: {
        'one-pass': `Ask about every listed answer in the one routing request and nothing more. It reaches no answer older than the listed ones. Right when none is older, or when routing may use fewer than ${FURTHER_REQUEST_ROOM.toLocaleString('en-US')} decision tokens for this message, too few for a further request${includeMessage ? ', or when the message is plainly about the latest answers or about nothing earlier' : ''}.`,
        'tree-walk': `Follow the lines of work level by level, with a further request for each split that is relevant, and search long runs. Right when answers are older than the listed ones${includeMessage ? ' and the message may refer to one of them' : ''}: only this reaches them.`,
      },
    },
    [QUESTION.trunk]: {
      type: 'noul',
      instructions: `Does the longest trunk end where the line splits and have ${TRUNK_SKIP} or more listed answers before its last answer? Then asking only about its last answer and searching the rest saves questions.`,
    },
    [QUESTION.search]: {
      type: 'noul',
      instructions: 'Are more than a dozen answers of one trunk or run, or more than a dozen single old answers, older than the listed ones? Then they are too many to ask about one by one and have to be searched in chunks.',
    },
  }
}

import { describe, expect, test } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '@pluribus/protocol'
import { CONVERSATION_CORPUS, combineReports, corpusInput, efficiencyOf, evaluateCorpus, formatSplitReport, oracleDecisionProvider, spendOf, type CorpusReport } from '@pluribus/core/testing'
import { createOpenRouterDecisionProvider } from '@pluribus/providers'
import { DECISION_INPUT_PRICE_PER_TOKEN, FITTED_CALIBRATION, createDecisionsApiMock } from '../testing/openrouter/decisions-api-mock'

/**
 * What finding referents costs on the conversation corpus, with decisions
 * as labelled: a spend budget per referent configuration. Deterministic:
 * the real decision provider is driven through the token-counting
 * Decisions mock (`testing/openrouter/decisions-api-mock.ts`), whose input
 * tokens are the tokenizer's count under `FITTED_CALIBRATION`, the fit to
 * what the live decision model reports (docs/build/dependency-decisioning.md
 * · "Measuring tokens"). One mock per case, as `corpusThroughMock` does for
 * the routing corpus.
 *
 * The budget is a ceiling with a small margin on the mean requests,
 * questions and input tokens per routing, and a wider one on the most any
 * one routing spends: a change to a strategy that spends more fails here
 * loudly, one that spends less passes. The figures are printed for the
 * build record.
 */

const getKey = async (): Promise<string> => 'sk-or-v1-mock'

/** The configurations the conversation corpus is routed in (`conversations.test.ts`): each strategy with no candidate source, and the defaults as they ship. */
const CONFIGURATIONS = {
  'one pass': { strategySelection: 'off', referentStrategy: 'one-pass', candidateSource: 'none' },
  'tree walk': { strategySelection: 'off', referentStrategy: 'tree-walk', candidateSource: 'none' },
  'the strategy the rules select': { strategySelection: 'rules', referentStrategy: 'one-pass', candidateSource: 'none' },
  'the default settings': {},
} as const
type Configuration = keyof typeof CONFIGURATIONS

interface Budget {
  /** Per routing, mean. */
  readonly requests: number
  readonly questions: number
  readonly inputTokens: number
  /** The most any one routing may spend. */
  readonly worstRequests: number
  readonly worstQuestions: number
  readonly worstInputTokens: number
}

/**
 * Measured 2026-11-26 on 162 cases, mean per routing and (worst routing): one pass, the rules and the defaults 1.14 (2)
 * requests, 15.9 (46) questions, 1,722 (5,466) calibrated input tokens; tree walk 1.19 (3), 15.8 (46), 1,743 (5,316).
 * The means' ceilings are about 10% above, the worst routing's one request and about 15% above.
 *
 * The ceilings follow the corpus, and were measured again when it grew from 85 cases to 162: the 77 added cases sit
 * in longer conversations and split more often (18.5 questions and 2,105 tokens per routing, against 13.5 and 1,368
 * for the first 85). The first 85 alone cost what they cost before, to the request and the question, under the same
 * strategies: the mean is of the cases, so a ceiling moves when the mix of cases does, and only then.
 */
const ONE_PASS: Budget = { requests: 1.27, questions: 17.5, inputTokens: 1_900, worstRequests: 3, worstQuestions: 53, worstInputTokens: 6_300 }
const BUDGETS: { readonly [C in Configuration]: Budget } = {
  'one pass': ONE_PASS,
  'tree walk': { requests: 1.3, questions: 17.5, inputTokens: 1_920, worstRequests: 4, worstQuestions: 53, worstInputTokens: 6_300 },
  'the strategy the rules select': ONE_PASS,
  'the default settings': ONE_PASS,
}

function settingsFor(name: Configuration): Settings {
  return { ...DEFAULT_SETTINGS, routing: { ...DEFAULT_SETTINGS.routing, ...CONFIGURATIONS[name] } }
}

/** The conversation corpus routed with decisions as labelled, through the Decisions mock, one mock per case. */
async function throughMock(settings: Settings): Promise<CorpusReport> {
  const reports: CorpusReport[] = []
  for (const example of CONVERSATION_CORPUS) {
    const api = createDecisionsApiMock({ answerer: oracleDecisionProvider(example, corpusInput(example, settings)), calibration: FITTED_CALIBRATION })
    const report = await evaluateCorpus({ decisionProvider: createOpenRouterDecisionProvider({ getKey, fetch: api.fetch }), settings, examples: [example] })
    // What the provider read back from `usage` is what the mock counted.
    expect(report.decisions.inputTokens, example.id).toBe(api.totals().inputTokens)
    reports.push(report)
  }
  return combineReports(reports)
}

const configurations = Object.keys(CONFIGURATIONS) as Configuration[]

describe('conversation corpus spend, decisions as labelled, measured over the Decisions mock', () => {
  test.each(configurations)('spend · the conversation corpus with referents by %s stays within its decision budget', { timeout: 240_000 }, async (name) => {
    const report = await throughMock(settingsFor(name))
    const spend = spendOf(report.results)
    const efficiency = efficiencyOf(report)
    const dollars = report.decisions.inputTokens * DECISION_INPUT_PRICE_PER_TOKEN
    console.log(
      [
        `── ${name}: ${report.total} routings, ${report.decisions.requests} requests, ${report.decisions.questions} questions, ${report.decisions.inputTokens} calibrated input tokens ($${dollars.toFixed(5)}, $${((dollars / report.total) * 1000).toFixed(4)} per 1,000 routings)`,
        formatSplitReport(report, CONVERSATION_CORPUS),
      ].join('\n'),
    )
    const budget = BUDGETS[name]
    expect(report.total).toBe(CONVERSATION_CORPUS.length)
    expect(efficiency).not.toBeNull()
    expect(spend.mean.requests).toBeLessThanOrEqual(budget.requests)
    expect(spend.mean.questions).toBeLessThanOrEqual(budget.questions)
    expect(spend.mean.inputTokens).toBeLessThanOrEqual(budget.inputTokens)
    expect(spend.worst.requests).toBeLessThanOrEqual(budget.worstRequests)
    expect(spend.worst.questions).toBeLessThanOrEqual(budget.worstQuestions)
    expect(spend.worst.inputTokens).toBeLessThanOrEqual(budget.worstInputTokens)
  })
})

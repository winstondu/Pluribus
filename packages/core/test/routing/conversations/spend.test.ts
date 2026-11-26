import { describe, expect, test } from 'vitest'
import type { DecisionProvider } from '../../../src/ports'
import { CONVERSATION_CORPUS } from '../../../testing/routing/conversations/cases'
import { SPLIT_AXES, combineReports, efficiencyOf, formatSplitReport, spendBySplit, spendOf, type SplitAxis } from '../../../testing/routing/conversations/splits'
import { corpusInput, evaluateCorpus, oracleDecisionProvider, type CorpusReport } from '../../../testing/routing/corpus/evaluate'

/**
 * Reading what a corpus result cost (`testing/routing/conversations/splits.ts`):
 * decision requests, questions and input tokens per routing, by split, and
 * the figure of merit. The budget the corpus is held to is measured over the
 * token-counting Decisions mock in `packages/providers/test/conversation-spend.test.ts`;
 * here the oracle stands in, with a fixed number of tokens per question so
 * that the sums can be checked by hand.
 */

const cases = CONVERSATION_CORPUS
/** Tokens the stand-in reports for each question of a request, and for the request itself. */
const PER_QUESTION = 10
const PER_REQUEST = 100

/** The oracle for each case, reporting usage as the stand-in counts it. */
async function routed(withUsage: boolean): Promise<CorpusReport> {
  const reports: CorpusReport[] = []
  for (const c of cases) {
    const oracle = oracleDecisionProvider(c, corpusInput(c))
    const counted: DecisionProvider = {
      async decide(request, signal) {
        const result = await oracle.decide(request, signal)
        return result.ok && withUsage ? { ...result, usage: { inputTokens: PER_REQUEST + PER_QUESTION * Object.keys(request.questions).length, outputTokens: 0 } } : result
      },
    }
    reports.push(await evaluateCorpus({ decisionProvider: counted, examples: [c] }))
  }
  return combineReports(reports)
}

describe('conversation corpus · reading what a result cost', () => {
  test('spend · reports combined one case at a time are the corpus routed at once', async () => {
    const one = await routed(false)
    const first = cases[0]
    if (!first) throw new Error('empty corpus')
    const single = await evaluateCorpus({ decisionProvider: oracleDecisionProvider(first, corpusInput(first)), examples: [first] })
    expect(combineReports([single])).toEqual(single)
    expect(one.total).toBe(cases.length)
    expect(one.results.map((r) => r.id)).toEqual(cases.map((c) => c.id))
    expect(one.decisions.requests).toBe(one.results.reduce((s, r) => s + r.decisions.requests, 0))
    expect(one.passed).toBe(one.results.filter((r) => r.passed).length)
  })

  test('spend · the mean and the worst routing, per split, each split accounting for every routing once, and the sums as counted', async () => {
    const report = await routed(true)
    const spend = spendOf(report.results)
    expect(spend.routings).toBe(cases.length)
    expect(spend.mean.requests * cases.length).toBeCloseTo(report.decisions.requests)
    expect(report.decisions.inputTokens).toBe(PER_REQUEST * report.decisions.requests + PER_QUESTION * report.decisions.questions)
    expect(spend.worst.requests).toBe(Math.max(...report.results.map((r) => r.decisions.requests)))
    expect(spend.worst.inputTokens).toBe(Math.max(...report.results.map((r) => r.decisions.inputTokens)))
    const by = spendBySplit(report, cases)
    for (const axis of Object.keys(SPLIT_AXES) as SplitAxis[]) {
      const values = Object.values(by[axis])
      expect(values.reduce((s, v) => s + v.routings, 0), axis).toBe(cases.length)
      expect(values.reduce((s, v) => s + v.mean.inputTokens * v.routings, 0), axis).toBeCloseTo(report.decisions.inputTokens)
      expect(Math.max(...values.map((v) => v.worst.questions)), axis).toBe(spend.worst.questions)
      expect(Object.keys(by[axis]).every((v) => (SPLIT_AXES[axis] as readonly string[]).includes(v)), axis).toBe(true)
    }
  })

  test('spend · the figure of merit is tokens per routing right, and none is given when no tokens were reported', async () => {
    const counted = await routed(true)
    const efficiency = efficiencyOf(counted)
    expect(efficiency?.tokensPerRight).toBeCloseTo(counted.decisions.inputTokens / counted.passed)
    expect(efficiency?.rightPerThousandTokens).toBeCloseTo((1000 * counted.passed) / counted.decisions.inputTokens)
    expect(efficiencyOf({ passed: 0, decisions: { requests: 1, questions: 1, inputTokens: 10 } })).toEqual({ rightPerThousandTokens: 0, tokensPerRight: null })
    const uncounted = await routed(false)
    expect(efficiencyOf(uncounted)).toBeNull()
    const text = formatSplitReport(counted, cases)
    expect(text).toContain('Decision spend per routing, mean (worst): ')
    for (const axis of Object.keys(SPLIT_AXES)) expect(text).toContain(`  by ${axis}:\n`)
    expect(text).toMatch(/Efficiency: \d+\/\d+ right for [\d,]+ input tokens: [\d,]+ tokens per routing right, [\d.]+ right per 1,000 tokens/)
    expect(formatSplitReport(uncounted, cases)).toContain('no input tokens reported')
  })
})

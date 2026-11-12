import { describe, expect, test } from 'vitest'
import { DEFAULT_SETTINGS } from '@committee/protocol'
import { COST_GRID_MESSAGE, COST_GRID_SIZES, ROUTING_CORPUS, costGridRows, decisionDollars, estimateRequestTokens, type CostGridChannel, type CostGridRow } from '@committee/core'
import { NEVER_CANCELLED, type DecisionProvider } from '@committee/core/ports'
import { createOpenRouterDecisionProvider } from './index'
import { MEASURED_CONFIGURATIONS, corpusThroughMock, settingsFor, type MeasuredConfiguration, type MeasuredExample } from './openrouter/test-support/corpus-through-mock'
import {
  DECISION_INPUT_PRICE_PER_TOKEN,
  FITTED_CALIBRATION,
  RAW_COUNT,
  calibratedTokens,
  createDecisionsApiMock,
  tokenize,
  toPortRequest,
  type MeasuredCall,
} from './openrouter/test-support/decisions-api-mock'

/**
 * Token measurement over the Decisions mock (docs/build/dependency-decisioning.md
 * · "Measuring tokens"). Deterministic: the real decision provider is driven
 * through an injected `fetch` that counts every body with a tokenizer
 * (`o200k_base`, a proxy for the decision model's own, which is not public).
 * "Calibrated" adds the template and tokenizer factor fitted to the live
 * model's reported counts (`FITTED_CALIBRATION`, from
 * `decision-tokens.smoke.test.ts`).
 *
 * The figures are recorded: a change to what routing sends shows here as a
 * changed number. Update them deliberately, with the reason in the commit.
 */

const estimate = (c: MeasuredCall): number => {
  const r = toPortRequest(c.body)
  return estimateRequestTokens(r.state, r.questions)
}

interface Totals {
  readonly passed: number
  readonly requests: number
  readonly questions: number
  readonly characters: number
  /** Tokenizer tokens of the text sent. */
  readonly tokenizer: number
  /** The same, calibrated to what the live model reports. */
  readonly calibrated: number
  /** The guard's estimate of the same requests. */
  readonly estimate: number
}

function totals(examples: readonly MeasuredExample[]): Totals {
  const calls = examples.flatMap((e) => e.calls)
  return {
    passed: examples.filter((e) => e.passed).length,
    requests: calls.length,
    questions: calls.reduce((s, c) => s + c.questionCount, 0),
    characters: calls.reduce((s, c) => s + c.contentCharacters, 0),
    tokenizer: calls.reduce((s, c) => s + c.contentTokens, 0),
    calibrated: calls.reduce((s, c) => s + calibratedTokens(FITTED_CALIBRATION, c.questionCount, c.contentTokens), 0),
    estimate: calls.reduce((s, c) => s + estimate(c), 0),
  }
}

/** Recorded 2026-11-12 with decisions as labelled. The live figures (input tokens the provider reported, live answers) are in the comments. */
const RECORDED: { readonly [N in MeasuredConfiguration]: Totals } = {
  // Live: 74 requests, 92,592 tokens reported. Calibrated is 0.8% above it; the estimate 7.2% below.
  'one pass': { passed: 59, requests: 74, questions: 922, characters: 261_560, tokenizer: 60_559, calibrated: 93_352, estimate: 85_896 },
  // Live: 84 requests, 108,935 tokens reported. Calibrated is 0.1% above it with one request fewer; the estimate 8.7% below.
  'tree walk, long runs searched': { passed: 59, requests: 83, questions: 971, characters: 308_482, tokenizer: 72_243, calibrated: 109_090, estimate: 99_468 },
  // Live: 83 requests, 110,263 tokens reported. Calibrated is 0.3% above it with one request fewer; the estimate 8.5% below.
  'selected by rules (the default)': { passed: 61, requests: 82, questions: 1_010, characters: 314_261, tokenizer: 73_662, calibrated: 110_610, estimate: 100_907 },
}

const configurations = Object.keys(MEASURED_CONFIGURATIONS) as MeasuredConfiguration[]

describe('decision tokens, measured with a tokenizer over the Decisions mock', () => {
  test('tokens · the mock parses the body the provider sends, answers it, and reports usage in the live shape', async () => {
    const api = createDecisionsApiMock({
      answerer: {
        decide: async (request) => ({
          ok: true,
          model: request.model,
          answers: { isGreeting: { type: 'noul', probability: 0.99 }, kind: { type: 'choice', choice: 'greet', confidence: 1, probabilities: { greet: 1, ask: 0 } } } as never,
          usage: null,
        }),
      },
      calibration: FITTED_CALIBRATION,
    })
    const provider = createOpenRouterDecisionProvider({ getKey: async () => 'sk-or-v1-mock', fetch: api.fetch })
    const result = await provider.decide(
      {
        model: 'typesafe/jev-1.13',
        state: 'Hi there!',
        questions: {
          isGreeting: { type: 'noul', instructions: 'Is this message a greeting?' },
          kind: { type: 'choice', instructions: 'What kind of message is it?', options: { greet: 'a greeting', ask: 'a question' } },
        },
      },
      NEVER_CANCELLED,
    )
    expect(api.calls).toHaveLength(1)
    const call = api.calls[0]
    expect(call?.body.questions['kind']).toEqual({ type: 'choice', instructions: 'What kind of message is it?', criteria: { greet: 'a greeting', ask: 'a question' } })
    // The text counted: the state, each ID, the instructions, the options and their descriptions.
    const pieces = ['Hi there!', 'isGreeting', 'Is this message a greeting?', 'kind', 'What kind of message is it?', 'greet', 'a greeting', 'ask', 'a question']
    expect(call?.contentCharacters).toBe(pieces.join('').length)
    expect(call?.contentTokens).toBe(pieces.reduce((s, p) => s + tokenize(p), 0))
    expect(result.ok && result.answers.isGreeting.probability).toBe(0.99)
    expect(result.ok && result.usage).toEqual({ inputTokens: calibratedTokens(FITTED_CALIBRATION, 2, call?.contentTokens ?? 0), outputTokens: expect.any(Number) })
    // A body in the wrong shape is refused as the live API refuses it.
    const refused = await api.fetch('https://openrouter.ai/api/alpha/decisions', { method: 'POST', body: JSON.stringify({ model: 'm', state: 's', questions: [] }) })
    expect(refused.status).toBe(400)
    expect(await refused.json()).toEqual({ error: { message: 'questions must be a record keyed by question ID', code: 400 } })
  })

  test.each(configurations)('tokens · the corpus with referents by %s: requests and tokenizer-counted input tokens as recorded', { timeout: 120_000 }, async (name) => {
    const measured = totals(await corpusThroughMock(settingsFor(name)))
    expect(measured).toEqual(RECORDED[name])
  })

  test('tokens · the provider reads the mock’s usage back: the corpus’s reported tokens are the tokenizer’s', { timeout: 120_000 }, async () => {
    const raw = await corpusThroughMock(settingsFor('selected by rules (the default)'), RAW_COUNT)
    for (const e of raw) expect(e.reportedInputTokens, e.id).toBe(e.calls.reduce((s, c) => s + c.contentTokens, 0))
  })

  test('tokens · tokenizer ÷ (characters ÷ 4) over every corpus request', { timeout: 120_000 }, async () => {
    const calls = (await Promise.all(configurations.map((n) => corpusThroughMock(settingsFor(n))))).flat().flatMap((e) => e.calls)
    const ratios = calls.map((c) => c.contentTokens / (c.contentCharacters / 4))
    const all = { min: Math.min(...ratios), mean: ratios.reduce((s, r) => s + r, 0) / ratios.length, max: Math.max(...ratios) }
    const total = calls.reduce((s, c) => s + c.contentTokens, 0) / (calls.reduce((s, c) => s + c.contentCharacters, 0) / 4)
    const versusEstimate = calls.map((c) => calibratedTokens(FITTED_CALIBRATION, c.questionCount, c.contentTokens) / estimate(c))
    const est = { min: Math.min(...versusEstimate), mean: versusEstimate.reduce((s, r) => s + r, 0) / versusEstimate.length, max: Math.max(...versusEstimate) }
    const round = (x: number): number => Math.round(x * 1000) / 1000
    // The three configurations' requests: the tokenizer counts 79% to 103% of characters ÷ 4, 93% over all of them.
    expect({ requests: calls.length, min: round(all.min), mean: round(all.mean), max: round(all.max), total: round(total) }).toEqual({ requests: 239, min: 0.793, mean: 0.896, max: 1.028, total: 0.934 })
    // Calibrated against the guard's estimate of the same requests: never below it by more than 0.6%, up to 21% above it.
    expect({ min: round(est.min), mean: round(est.mean), max: round(est.max) }).toEqual({ min: 0.994, mean: 1.065, max: 1.206 })
  })
})

/** Characters per token of answer prose by the tokenizer: the corpus's answer openings. */
function proseCharactersPerToken(): number {
  const texts = [...new Set(ROUTING_CORPUS.flatMap((e) => e.scene.candidates.sections.map((s) => s.excerpt)).filter((t) => t.length > 0))]
  return texts.reduce((s, t) => s + t.length, 0) / texts.reduce((s, t) => s + tokenize(t), 0)
}

describe('decision cost grid, measured with a tokenizer', () => {
  /**
   * Recorded, not asserted as a bound: under tokenizer counts the price guard's 2× bound does not hold. The guard sizes
   * requests with its estimate, which runs low on the grid's text (calibrated tokens are 1.2 to 1.4 times the estimate;
   * the live model reported 1.30 times the estimate for the worst cell's request). The guard is left as it is: see
   * docs/build/dependency-decisioning.md · "Measuring tokens".
   */
  test('tokens · every guarded cell recomputed with tokenizer counts on both sides: the worst cell is 2.79×, and 208 of 360 cells are over 2× (recorded)', { timeout: 600_000 }, async () => {
    const guard = DEFAULT_SETTINGS.routing.costGuard
    const prose = proseCharactersPerToken()
    // The answer as the grid prices it (the message in, an answer of 85% of an exchange out), counted by the tokenizer.
    const answerDollars = (exchange: number): number => (tokenize(COST_GRID_MESSAGE) * guard.answerInputPrice + ((exchange * 0.85 * 4) / prose) * guard.answerOutputPrice) / 1e6
    const through = (worstCase: DecisionProvider): CostGridChannel => {
      const api = createDecisionsApiMock({ answerer: worstCase, calibration: FITTED_CALIBRATION })
      return { provider: createOpenRouterDecisionProvider({ getKey: async () => 'sk-or-v1-mock', fetch: api.fetch }), inputTokens: () => api.totals().inputTokens }
    }
    const rows: CostGridRow[] = []
    for (const [sections, exchange] of COST_GRID_SIZES) rows.push(...(await costGridRows(sections, exchange, { unguarded: false, through })))
    const byEstimate = (r: CostGridRow): number => decisionDollars(r.guarded.tokens) / r.answer
    const byTokenizer = (r: CostGridRow): number => ((r.guarded.measured ?? 0) * DECISION_INPUT_PRICE_PER_TOKEN) / answerDollars(r.exchange)
    const worst = (f: (r: CostGridRow) => number): CostGridRow => rows.reduce((w, r) => (f(r) > f(w) ? r : w))
    const we = worst(byEstimate)
    const wt = worst(byTokenizer)
    const over = rows.filter((r) => byTokenizer(r) > guard.maxAnswerCostRatio)
    const perSize = COST_GRID_SIZES.map(([n, x]) => {
      const cells = rows.filter((r) => r.sections === n && r.exchange === x)
      return `  ${n} × ${x}: worst by estimate ${Math.max(...cells.map(byEstimate)).toFixed(3)}×, by tokenizer ${Math.max(...cells.map(byTokenizer)).toFixed(3)}×, ${cells.filter((r) => byTokenizer(r) > guard.maxAnswerCostRatio).length} of ${cells.length} over`
    })
    const line = (r: CostGridRow): string => `${r.sections} × ${r.exchange}, ${r.shape}, ${r.strategy}: estimate ${r.guarded.tokens} tokens ${byEstimate(r).toFixed(3)}×, tokenizer ${r.guarded.measured} tokens ${byTokenizer(r).toFixed(3)}×`
    console.log([`prose: ${prose.toFixed(3)} characters per token`, `worst by estimate: ${line(we)}`, `worst by tokenizer: ${line(wt)}`, `over ${guard.maxAnswerCostRatio}× by tokenizer: ${over.length} of ${rows.length}`, ...perSize].join('\n'))
    expect(rows.every((r) => r.guarded.measured !== null)).toBe(true)
    const round = (x: number): number => Math.round(x * 1000) / 1000
    expect(round(prose)).toBe(4.119)
    // By the guard's own estimate the bound holds, as `core`'s cost-grid test asserts.
    expect({ at: `${we.sections} × ${we.exchange}, ${we.shape}, ${we.strategy}`, estimate: we.guarded.tokens, ratio: round(byEstimate(we)), measured: we.guarded.measured, byTokenizer: round(byTokenizer(we)) }).toEqual({
      at: '8000 × 120, early split, tree walk, runs listed',
      estimate: 2_481,
      ratio: 1.992,
      measured: 3_298,
      byTokenizer: 2.736,
    })
    // By the tokenizer it does not: every cell of 120-token exchanges, and most of 300-token ones, are over 2×.
    expect({ at: `${wt.sections} × ${wt.exchange}, ${wt.shape}, ${wt.strategy}`, estimate: wt.guarded.tokens, measured: wt.guarded.measured, byTokenizer: round(byTokenizer(wt)) }).toEqual({
      at: '8000 × 120, bushy, tree walk, runs listed',
      estimate: 2_419,
      measured: 3_362,
      byTokenizer: 2.789,
    })
    expect(over.length).toBe(208)
  })
})

import { describe, expect, test } from 'vitest'
import { CHARACTERS_PER_TOKEN, DEFAULT_SETTINGS } from '@pluribus/protocol'
import { estimateRequestTokens, SHORTEST_ANSWER_TOKENS } from '@pluribus/core'
import { NEVER_CANCELLED, type DecisionProvider } from '@pluribus/core/ports'
import { COST_GRID_MESSAGE, COST_GRID_SIZES, ROUTING_CORPUS, costGridRows, decisionDollars, type CostGridChannel, type CostGridRow } from '@pluribus/core/testing'
import { createOpenRouterDecisionProvider } from '@pluribus/providers'
import { MEASURED_CONFIGURATIONS, corpusThroughMock, settingsFor, type MeasuredConfiguration, type MeasuredExample } from '../testing/openrouter/corpus-through-mock'
import {
  DECISION_INPUT_PRICE_PER_TOKEN,
  FITTED_CALIBRATION,
  RAW_COUNT,
  calibratedTokens,
  createDecisionsApiMock,
  tokenize,
  toPortRequest,
  type MeasuredCall,
} from '../testing/openrouter/decisions-api-mock'

/**
 * Token measurement over the Decisions mock (docs/build/dependency-decisioning.md
 * · "Measuring tokens"). Deterministic: the real decision provider is driven
 * through an injected `fetch` that counts every body with a tokenizer
 * (`o200k_base`, a proxy for the decision model's own, which is not public).
 * "Calibrated" adds the template and tokenizer factor fitted to the live
 * model's reported counts (`FITTED_CALIBRATION`, from
 * `decision-tokens.smoke.test.ts`).
 *
 * Every token figure is asserted as a ceiling, never as an exact count: a
 * change to what routing sends may move the figures freely below the
 * ceilings. The figures themselves are printed for the build record.
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

/**
 * Ceilings on the corpus's requests, per configuration, as means per request so that adding corpus examples does not
 * move them. On 2026-11-15 the means were 907 (one pass), 924 (tree walk) and 968 (rules) tokenizer tokens, and 1,365,
 * 1,377 and 1,430 calibrated; live, the default's 84 requests reported 118,592 tokens (1,412 a request).
 */
const MEAN_TOKENIZER_CEILING = 1_200
const MEAN_CALIBRATED_CEILING = 1_800
/** The tokenizer counts at most this many tokens per four characters of any one request (1.052 on 2026-11-15). */
const TOKENIZER_PER_FOUR_CHARACTERS_CEILING = 1.15

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

  test.each(configurations)('tokens · the corpus with referents by %s: tokenizer-counted input tokens per request stay below the ceilings', { timeout: 120_000 }, async (name) => {
    const measured = totals(await corpusThroughMock(settingsFor(name)))
    console.log(`${name}: ${JSON.stringify(measured)}`)
    expect(measured.requests).toBeGreaterThan(0)
    expect(measured.tokenizer / measured.requests).toBeLessThanOrEqual(MEAN_TOKENIZER_CEILING)
    expect(measured.calibrated / measured.requests).toBeLessThanOrEqual(MEAN_CALIBRATED_CEILING)
    // The guard's estimate never counts fewer tokens than the calibrated count of the same requests.
    expect(measured.calibrated).toBeLessThanOrEqual(measured.estimate)
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
    console.log(`tokenizer ÷ (characters ÷ 4): ${calls.length} requests, ${all.min.toFixed(3)} to ${all.max.toFixed(3)}, mean ${all.mean.toFixed(3)}, ${total.toFixed(3)} over all; calibrated ÷ estimate ${est.min.toFixed(3)} to ${est.max.toFixed(3)}, mean ${est.mean.toFixed(3)}`)
    expect(all.max).toBeLessThanOrEqual(TOKENIZER_PER_FOUR_CHARACTERS_CEILING)
    // Calibrated against the guard's estimate of the same requests: never above it, request by request.
    expect(est.max).toBeLessThanOrEqual(1)
  })
})

/** Characters per token of answer prose by the tokenizer: the corpus's answer openings. */
function proseCharactersPerToken(): number {
  const texts = [...new Set(ROUTING_CORPUS.flatMap((e) => e.scene.candidates.sections.map((s) => s.excerpt)).filter((t) => t.length > 0))]
  return texts.reduce((s, t) => s + t.length, 0) / texts.reduce((s, t) => s + tokenize(t), 0)
}

describe('decision cost grid, measured with a tokenizer', () => {
  const guard = DEFAULT_SETTINGS.routing.costGuard
  const prose = proseCharactersPerToken()
  // The answer as the grid prices it (the message in, an answer of 85% of an exchange out), counted by the tokenizer.
  const answerDollars = (exchange: number): number => (tokenize(COST_GRID_MESSAGE) * guard.answerInputPrice + ((exchange * 0.85 * 4) / prose) * guard.answerOutputPrice) / 1e6
  const through = (worstCase: DecisionProvider): CostGridChannel => {
    const api = createDecisionsApiMock({ answerer: worstCase, calibration: FITTED_CALIBRATION })
    return { provider: createOpenRouterDecisionProvider({ getKey: async () => 'sk-or-v1-mock', fetch: api.fetch }), inputTokens: () => api.totals().inputTokens }
  }
  const byEstimate = (r: CostGridRow): number => decisionDollars(r.guarded.tokens) / r.answer
  const byTokenizer = (r: CostGridRow): number => ((r.guarded.measured ?? 0) * DECISION_INPUT_PRICE_PER_TOKEN) / answerDollars(r.exchange)
  /** Tokens of the answer the guard prices a cell's routing against: the median answer, as the guard reads it. */
  const answerTokens = (exchange: number): number => Math.ceil((exchange * 0.85 * 4) / CHARACTERS_PER_TOKEN)
  const round = (x: number): number => Math.round(x * 1000) / 1000
  const at = (r: CostGridRow): string => `${r.sections} × ${r.exchange}, ${r.shape}, ${r.strategy}`

  /**
   * The bound is held under the tokenizer-calibrated count (the live model's count, within a few percent) for every
   * cell whose answers are at least `SHORTEST_ANSWER_TOKENS` long, the floor below which the guard does not claim it. At
   * the floor of 100 that is every cell: the shortest answers of the grid are 102 tokens.
   */
  test('tokens · with the guard on, no cell at or above the shortest answer the guard is held to costs more than twice its answer by tokenizer counts on both sides', { timeout: 600_000 }, async () => {
    const rows: CostGridRow[] = []
    for (const [sections, exchange] of COST_GRID_SIZES) rows.push(...(await costGridRows(sections, exchange, { unguarded: false, through })))
    expect(rows.every((r) => r.guarded.measured !== null)).toBe(true)
    const covered = rows.filter((r) => answerTokens(r.exchange) >= SHORTEST_ANSWER_TOKENS)
    const below = rows.filter((r) => answerTokens(r.exchange) < SHORTEST_ANSWER_TOKENS)
    for (const r of covered) {
      expect(byTokenizer(r), at(r)).toBeLessThanOrEqual(guard.maxAnswerCostRatio)
      expect(byEstimate(r), at(r)).toBeLessThanOrEqual(guard.maxAnswerCostRatio)
    }
    // The floor of 100 covers every cell.
    expect(below.map(at)).toEqual([])
    expect(covered).toHaveLength(360)
    const worst = (f: (r: CostGridRow) => number): CostGridRow => rows.reduce((w, r) => (f(r) > f(w) ? r : w))
    const we = worst(byEstimate)
    const wt = worst(byTokenizer)
    const perSize = COST_GRID_SIZES.map(([n, x]) => {
      const cells = rows.filter((r) => r.sections === n && r.exchange === x)
      return `  ${n} × ${x}: worst by estimate ${Math.max(...cells.map(byEstimate)).toFixed(3)}×, by tokenizer ${Math.max(...cells.map(byTokenizer)).toFixed(3)}×`
    })
    console.log([`prose: ${prose.toFixed(3)} characters per token`, `worst by estimate: ${at(we)}, ${we.guarded.tokens} estimated, ${we.guarded.measured} calibrated`, `worst by tokenizer: ${at(wt)}, ${wt.guarded.tokens} estimated, ${wt.guarded.measured} calibrated`, ...perSize].join('\n'))
  })

  /**
   * What a higher floor would do (the floor is not changed: raising it is the user's decision). A floor of F prices the
   * routing of a conversation of shorter answers as if they were F tokens long, so the guard allows more and the cells
   * below F are no longer held to the bound. Emulated on the 120-token cells (answers of 102 tokens) by scaling the
   * guard's ratio by what an F-token answer costs against a 102-token one. The ceiling is that raised ratio: no cell
   * costs more than twice an answer of F tokens.
   */
  test.each([135, 155])('tokens · with the shortest answer the guard is held to at %i tokens, the cells below it stay within twice an answer of that length', { timeout: 600_000 }, async (floor) => {
    const price = (output: number): number => Math.ceil(COST_GRID_MESSAGE.length / CHARACTERS_PER_TOKEN) * guard.answerInputPrice + output * guard.answerOutputPrice
    const rows: CostGridRow[] = []
    let ceiling = 0
    for (const [sections, exchange] of COST_GRID_SIZES.filter(([, x]) => answerTokens(x) < floor)) {
      const costGuard = { ...guard, maxAnswerCostRatio: (guard.maxAnswerCostRatio * price(floor)) / price(answerTokens(exchange)) }
      ceiling = Math.max(ceiling, costGuard.maxAnswerCostRatio)
      rows.push(...(await costGridRows(sections, exchange, { unguarded: false, through, routing: { costGuard } })))
    }
    const worst = rows.reduce((w, r) => (byTokenizer(r) > byTokenizer(w) ? r : w))
    const over = rows.filter((r) => byTokenizer(r) > guard.maxAnswerCostRatio)
    console.log(`floor ${floor}: ${rows.length} cells below it; worst ${at(worst)} ${round(byTokenizer(worst))}× by tokenizer, ${round(byEstimate(worst))}× by estimate; ${over.length} over 2× by tokenizer`)
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(byTokenizer(r), at(r)).toBeLessThanOrEqual(ceiling)
      expect(byEstimate(r), at(r)).toBeLessThanOrEqual(ceiling)
    }
  })
})

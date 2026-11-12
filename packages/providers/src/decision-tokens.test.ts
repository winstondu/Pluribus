import { describe, expect, test } from 'vitest'
import { CHARACTERS_PER_TOKEN, DEFAULT_SETTINGS } from '@committee/protocol'
import { COST_GRID_MESSAGE, COST_GRID_SIZES, ROUTING_CORPUS, costGridRows, decisionDollars, estimateRequestTokens, SHORTEST_ANSWER_TOKENS, type CostGridChannel, type CostGridRow } from '@committee/core'
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

/**
 * Recorded 2026-11-12 with decisions as labelled. The live figures (input tokens the provider reported, live answers)
 * are in the comments. Recorded again the same day when the lexical candidate source became the default
 * (`settings.routing.candidateSource`): the tree walk now starts at the sections the word index names as well, so with
 * decisions as labelled it routes all 62 examples, and so does the strategy the rules select. One pass does not walk
 * and is unchanged. Before, with no source: tree walk 59 passed, 83 requests, 971 questions, 308,482 characters,
 * 72,243 tokenizer, 109,090 calibrated, 99,468 estimate (live 84 requests, 108,935); rules 61 passed, 82, 1,010,
 * 314,261, 73,662, 110,610, 100,907 (live 83 requests, 110,263).
 *
 * Recorded again when the guard's estimate was refitted (`estimateRequestTokens`, 2026-11-12: 300 + 0.35 per character
 * of state + 7 + 0.32 per character of question text, from 265 + 0.2 + 7 + 0.24). No score and no request count
 * changed. Four examples are routed with smaller search parts (the parts are sized by the estimate against
 * `searchRunsOverTokens`), the same sections found: `long-chain-old-section`, `long-chain-latest-section`,
 * `long-chain-unrelated`, `long-roots-old-section`, 21 more questions in all. With the earlier estimate: tree walk 956
 * questions, 308,442 characters, 72,306 tokenizer, 109,913 calibrated, 100,067 estimate; rules 978, 308,393, 72,259,
 * 108,866, 99,304; one pass the same but its estimate, 85,896.
 *
 * Recorded again when the decision gate began asking whether a message sets one combined total output limit (Q102,
 * `combinedlimit`, one question in every gate request), and the corpus's combined-limit example became two atomic ones:
 * no request count changed, 48 questions and about 3,000 tokenizer tokens more in each configuration. Before it: one
 * pass 59 passed, 922 questions, 261,560 characters, 60,559 tokenizer, 93,352 calibrated, 115,370 estimate; tree walk
 * 62, 977, 311,501, 72,991, 110,797, 135,719; rules 62, 999, 311,452, 72,944, 109,750, 134,559. The live figures in the
 * comments are from before it.
 */
const RECORDED: { readonly [N in MeasuredConfiguration]: Totals } = {
  // Live: 74 requests, 92,592 tokens reported. Calibrated is 0.8% above it; the estimate 24.6% above.
  'one pass': { passed: 60, requests: 74, questions: 970, characters: 274_744, tokenizer: 63_494, calibrated: 96_883, estimate: 119_955 },
  // Live: 85 requests, 109,128 tokens reported (108,412 with the earlier estimate). Calibrated is 1.5% above it; the estimate 24.4% above.
  'tree walk, long runs searched': { passed: 63, requests: 86, questions: 1025, characters: 324_685, tokenizer: 75_926, calibrated: 114_326, estimate: 140_304 },
  // Live: 82 requests, 108,557 tokens reported (107,841 with the earlier estimate). Calibrated is 1.1% above it; the estimate 24.0% above.
  'selected by rules (the default)': { passed: 63, requests: 82, questions: 1047, characters: 324_636, tokenizer: 75_879, calibrated: 113_280, estimate: 139_144 },
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
    // The three configurations' requests: the tokenizer counts 79% to 104% of characters ÷ 4, 93% over all of them.
    expect({ requests: calls.length, min: round(all.min), mean: round(all.mean), max: round(all.max), total: round(total) }).toEqual({ requests: 242, min: 0.817, mean: 0.9, max: 1.035, total: 0.932 })
    // Calibrated against the guard's estimate of the same requests: always below it, at 78% to 89% of it (it was 0.994 to
    // 1.223 with the estimate before 2026-11-12's refit; 0.78, 0.812, 0.885 before the gate's combined-limit question).
    expect({ min: round(est.min), mean: round(est.mean), max: round(est.max) }).toEqual({ min: 0.779, mean: 0.81, max: 0.885 })
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
    // Recorded: the cells below the floor (none at 100), and the worst cells both ways.
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
    expect(round(prose)).toBe(4.119)
    expect({ at: at(we), estimate: we.guarded.tokens, ratio: round(byEstimate(we)), measured: we.guarded.measured, byTokenizer: round(byTokenizer(we)) }).toEqual(RECORDED_WORST.byEstimate)
    expect({ at: at(wt), estimate: wt.guarded.tokens, ratio: round(byEstimate(wt)), measured: wt.guarded.measured, byTokenizer: round(byTokenizer(wt)) }).toEqual(RECORDED_WORST.byTokenizer)
  })

  /**
   * What a higher floor would do (the floor is not changed: raising it is the user's decision). A floor of F prices the
   * routing of a conversation of shorter answers as if they were F tokens long, so the guard allows more and the cells
   * below F are no longer held to the bound. Emulated on the 120-token cells (answers of 102 tokens) by scaling the
   * guard's ratio by what an F-token answer costs against a 102-token one; recorded, not asserted as a bound.
   */
  test.each([135, 155])('tokens · with the shortest answer the guard is held to at %i tokens, what the cells below it would cost (recorded)', { timeout: 600_000 }, async (floor) => {
    const price = (output: number): number => Math.ceil(COST_GRID_MESSAGE.length / CHARACTERS_PER_TOKEN) * guard.answerInputPrice + output * guard.answerOutputPrice
    const rows: CostGridRow[] = []
    for (const [sections, exchange] of COST_GRID_SIZES.filter(([, x]) => answerTokens(x) < floor)) {
      const costGuard = { ...guard, maxAnswerCostRatio: (guard.maxAnswerCostRatio * price(floor)) / price(answerTokens(exchange)) }
      rows.push(...(await costGridRows(sections, exchange, { unguarded: false, through, routing: { costGuard } })))
    }
    const worst = rows.reduce((w, r) => (byTokenizer(r) > byTokenizer(w) ? r : w))
    const over = rows.filter((r) => byTokenizer(r) > guard.maxAnswerCostRatio)
    console.log(`floor ${floor}: ${rows.length} cells below it; worst ${at(worst)} ${round(byTokenizer(worst))}× by tokenizer, ${round(byEstimate(worst))}× by estimate; ${over.length} over 2× by tokenizer`)
    expect({ cells: rows.length, over: over.length, worst: at(worst), byTokenizer: round(byTokenizer(worst)), byEstimate: round(byEstimate(worst)) }).toEqual(RECORDED_FLOOR[floor])
  })
})

/** Recorded 2026-11-12 with the refitted estimate. Before it, the worst cell was 1.99× by estimate and 2.79× by tokenizer, and 208 of 360 cells were over 2× by tokenizer. */
const RECORDED_WORST = {
  // With the gate's combined-limit question (Q102); before it: 50 × 300, nested forks, tree walk, runs listed, 6,123 estimated, 1.997, 5,184 calibrated, 1.743.
  byEstimate: { at: '3300 × 300, nested forks, one pass', estimate: 6_114, ratio: 1.994, measured: 5_407, byTokenizer: 1.818 },
  // Before it: 8000 × 120, bushy, tree walk, runs listed, 2,486 estimated, 1.996, 2,170 calibrated, 1.8.
  byTokenizer: { at: '3300 × 300, nested forks, one pass', estimate: 6_114, ratio: 1.994, measured: 5_407, byTokenizer: 1.818 },
}

const RECORDED_FLOOR: { readonly [floor: number]: { cells: number; over: number; worst: string; byTokenizer: number; byEstimate: number } } = {
  // Every 120-token cell is below the floor and over 2× its own answer; against an answer of 135 tokens they are within it.
  // With the gate's combined-limit question (Q102). Before it: 135, nested forks, tree walk, runs listed, 2.393 and 2.627; 155, nested forks, one pass, 2.723 and 2.976.
  135: { cells: 120, over: 120, worst: '8000 × 120, bushy, one pass', byTokenizer: 2.357, byEstimate: 2.606 },
  155: { cells: 120, over: 120, worst: '8000 × 120, bushy, tree walk, runs listed', byTokenizer: 2.725, byEstimate: 2.975 },
}

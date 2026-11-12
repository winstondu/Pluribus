import { countTokens } from 'gpt-tokenizer/encoding/o200k_base'
import { NEVER_CANCELLED, type ChoiceAnswer, type DecisionProvider, type NoulAnswer, type ScoreAnswer, type DecisionQuestion, type DecisionQuestions, type DecisionRequest } from '@pluribus/core/ports'
import type { FetchLike } from '../../src/openrouter/http'

/**
 * Test-only: a mock of `POST /api/alpha/decisions` that counts input tokens
 * with a real tokenizer. Not exported from the package (the tokenizer is a
 * devDependency and must never reach the app bundle).
 *
 * The real decision provider is driven through it with an injected `fetch`:
 * the mock parses the exact JSON body the provider sends (`model`, `state`,
 * the `questions` record), counts what is in it, answers from a scripted
 * {@link DecisionProvider} (the corpus oracle, the cost grid's worst case),
 * and returns the documented response shape with `usage`.
 *
 * **The tokenizer is a proxy.** The decision model's own tokenizer and its
 * prompt template are not public. Tokens here are `o200k_base` (via
 * `gpt-tokenizer`) over the text the model is asked about: the state, and
 * each question's ID, instructions, choice options and descriptions, and
 * score criteria, each piece counted on its own. The model wraps that text
 * in a template of its own, which is not sent and cannot be counted, and
 * its tokenizer splits text differently; {@link TokenCalibration} stands in
 * for both, at figures fitted to the provider's reported counts in the
 * smoke suite (`decision-tokens.smoke.test.ts`). With {@link RAW_COUNT} the
 * mock reports the tokenizer's count of the text alone.
 */

/** The live price of decision input tokens: $0.042 per million; output tokens are not charged (measured 2026-11-11). */
export const DECISION_INPUT_PRICE_PER_TOKEN = 0.042 / 1e6

/**
 * How the provider's reported input tokens relate to the tokenizer's count
 * of a body's text: a fixed part (its template), a part per question, and a
 * factor on the text tokens (the two tokenizers differ).
 * Reported ≈ perRequest + perQuestion × questions + perTextToken × text tokens.
 */
export interface TokenCalibration {
  readonly perRequest: number
  readonly perQuestion: number
  readonly perTextToken: number
}

/** The tokenizer's count of the text alone: nothing for the template. */
export const RAW_COUNT: TokenCalibration = { perRequest: 0, perQuestion: 0, perTextToken: 1 }

/**
 * Fitted by least squares to the input tokens the live decision model
 * reported (`decision-tokens.smoke.test.ts`, 2026-11-12: eight bodies, 1 to
 * 33 questions and 136 to 14,814 characters of text; every one within 8%
 * of the fit, within 1% from 1,000 tokens up): reported ≈ 282 + 6.1 × questions + 1.104 × tokenizer tokens.
 */
export const FITTED_CALIBRATION: TokenCalibration = { perRequest: 282, perQuestion: 6.1, perTextToken: 1.104 }

/** The input tokens a calibration counts a body of `questions` questions and `textTokens` tokenizer tokens as. */
export function calibratedTokens(calibration: TokenCalibration, questions: number, textTokens: number): number {
  return Math.round(calibration.perRequest + calibration.perQuestion * questions + calibration.perTextToken * textTokens)
}

export type WireQuestion =
  | { readonly type: 'noul'; readonly instructions: string }
  | { readonly type: 'choice'; readonly instructions: string; readonly criteria: { readonly [option: string]: string } }
  | { readonly type: 'score'; readonly instructions: string; readonly criteria: readonly string[] }

export interface WireDecisionBody {
  readonly model: string
  readonly state: string
  readonly questions: { readonly [id: string]: WireQuestion }
}

/** One request the mock received, and what it counted. */
export interface MeasuredCall {
  readonly body: WireDecisionBody
  readonly questionCount: number
  /** Characters of the counted text: the state, and each question's ID, instructions, options and criteria. */
  readonly contentCharacters: number
  /** Tokenizer tokens of the same text. */
  readonly contentTokens: number
  /** What `usage.input_tokens` reported: the content tokens under the mock's calibration. */
  readonly inputTokens: number
}

export interface DecisionsApiMock {
  readonly fetch: FetchLike
  readonly calls: readonly MeasuredCall[]
  /** Sums over every call so far. */
  totals(): { readonly requests: number; readonly questions: number; readonly contentCharacters: number; readonly contentTokens: number; readonly inputTokens: number }
}

/** The pieces of text of a body the decision model reads, in order. */
export function contentPieces(body: WireDecisionBody): string[] {
  const pieces = [body.state]
  for (const [id, question] of Object.entries(body.questions)) {
    pieces.push(id, question.instructions)
    if (question.type === 'choice') for (const [option, text] of Object.entries(question.criteria)) pieces.push(option, text)
    if (question.type === 'score') pieces.push(...question.criteria)
  }
  return pieces
}

/** Tokenizer tokens of a text (`o200k_base`, a proxy for the decision model's tokenizer). */
export const tokenize = (text: string): number => (text === '' ? 0 : countTokens(text))

export function contentTokens(body: WireDecisionBody): number {
  return contentPieces(body).reduce((sum, piece) => sum + tokenize(piece), 0)
}

export function contentCharacters(body: WireDecisionBody): number {
  return contentPieces(body).reduce((sum, piece) => sum + piece.length, 0)
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Reads a body in the live shape, or says what is wrong with it. */
export function readWireBody(value: unknown): WireDecisionBody | string {
  if (!isRecord(value)) return 'The body is not an object'
  const { model, state, questions } = value
  if (typeof model !== 'string' || model === '') return 'model is required'
  if (typeof state !== 'string') return 'state is required'
  if (!isRecord(questions)) return 'questions must be a record keyed by question ID'
  if (Object.keys(questions).length === 0) return 'questions is empty'
  for (const [id, q] of Object.entries(questions)) {
    if (!isRecord(q) || typeof q['instructions'] !== 'string') return `question ${id} needs instructions`
    if (q['type'] === 'noul') continue
    if (q['type'] === 'choice' && isRecord(q['criteria']) && Object.values(q['criteria']).every((v) => typeof v === 'string')) continue
    if (q['type'] === 'score' && Array.isArray(q['criteria']) && q['criteria'].every((v) => typeof v === 'string')) continue
    return `question ${id} is not a noul, choice or score question in the live shape`
  }
  return value as unknown as WireDecisionBody
}

/** The port's request for a wire body: what the scripted answerer is asked. */
export function toPortRequest(body: WireDecisionBody): DecisionRequest<DecisionQuestions> {
  const questions: { [id: string]: DecisionQuestion } = {}
  for (const [id, q] of Object.entries(body.questions)) {
    questions[id] =
      q.type === 'noul'
        ? { type: 'noul', instructions: q.instructions }
        : q.type === 'choice'
          ? { type: 'choice', instructions: q.instructions, options: { ...q.criteria } }
          : { type: 'score', instructions: q.instructions, criteria: [...q.criteria] }
  }
  return { model: body.model, state: body.state, questions }
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/**
 * A `fetch` for the real decision provider. `answerer` answers each request
 * (its answers are put in the wire shape); `usage.input_tokens` is the
 * tokenizer count under `calibration` (default {@link RAW_COUNT}).
 */
export function createDecisionsApiMock(options: { readonly answerer: DecisionProvider; readonly calibration?: TokenCalibration }): DecisionsApiMock {
  const calibration = options.calibration ?? RAW_COUNT
  const calls: MeasuredCall[] = []
  const fetch: FetchLike = async (input, init) => {
    if (!input.endsWith('/api/alpha/decisions') || init.method !== 'POST') return json(404, { error: { message: `No route ${init.method ?? 'GET'} ${input}`, code: 404 } })
    let parsed: unknown
    try {
      parsed = JSON.parse(typeof init.body === 'string' ? init.body : '')
    } catch {
      return json(400, { error: { message: 'The body is not JSON', code: 400 } })
    }
    const body = readWireBody(parsed)
    if (typeof body === 'string') return json(400, { error: { message: body, code: 400 } })
    const result = await options.answerer.decide(toPortRequest(body), NEVER_CANCELLED)
    if (!result.ok) return json(result.error.httpStatus ?? 500, { error: { message: result.error.message, code: result.error.httpStatus ?? 500 } })
    const answers: Record<string, unknown> = {}
    for (const [id, answer] of Object.entries(result.answers) as [string, NoulAnswer | ChoiceAnswer | ScoreAnswer][]) {
      answers[id] = answer.type === 'noul' ? { type: 'noul', noul: answer.probability } : answer
    }
    const questionCount = Object.keys(body.questions).length
    const counted = contentTokens(body)
    const inputTokens = calibratedTokens(calibration, questionCount, counted)
    calls.push({ body, questionCount, contentCharacters: contentCharacters(body), contentTokens: counted, inputTokens })
    return json(200, {
      model: `${body.model}-mock`,
      answers,
      // Output is not charged; its count is the tokens of the answers as sent.
      usage: { input_tokens: inputTokens, output_tokens: tokenize(JSON.stringify(answers)), cost: inputTokens * DECISION_INPUT_PRICE_PER_TOKEN },
    })
  }
  return {
    fetch,
    calls,
    totals: () =>
      calls.reduce(
        (sum, c) => ({
          requests: sum.requests + 1,
          questions: sum.questions + c.questionCount,
          contentCharacters: sum.contentCharacters + c.contentCharacters,
          contentTokens: sum.contentTokens + c.contentTokens,
          inputTokens: sum.inputTokens + c.inputTokens,
        }),
        { requests: 0, questions: 0, contentCharacters: 0, contentTokens: 0, inputTokens: 0 },
      ),
  }
}

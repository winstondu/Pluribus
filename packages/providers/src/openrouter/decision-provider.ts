import { providerError, type ProviderError, type TokenUsage } from '@committee/protocol'
import type {
  CancelSignal,
  ChoiceAnswer,
  DecisionProvider,
  DecisionQuestion,
  DecisionQuestions,
  DecisionRequest,
  DecisionResult,
  NoulAnswer,
  ScoreAnswer,
} from '@committee/core/ports'
import { isRecord, postJson, resolveOptions, type OpenRouterOptions } from './http'

/**
 * Bounded routing questions over `POST /api/alpha/decisions` (Q68), in the
 * shape verified live on 2026-11-11 (CLAUDE.md, not the spec's appendix).
 * One `decide` is one HTTP call carrying every question.
 */
export function createOpenRouterDecisionProvider(options: OpenRouterOptions): DecisionProvider {
  const resolved = resolveOptions(options)
  return {
    async decide<Q extends DecisionQuestions>(request: DecisionRequest<Q>, signal: CancelSignal): Promise<DecisionResult<Q>> {
      const invalid = checkQuestions(request.questions)
      if (invalid !== null) return { ok: false, error: invalid }
      const result = await postJson(resolved, '/api/alpha/decisions', toWireRequest(request), signal)
      if (!result.ok) return result
      return parseDecisionResponse(request, result.body)
    },
  }
}

const MAX_CHOICE_OPTIONS = 255

function checkQuestions(questions: DecisionQuestions): ProviderError | null {
  const ids = Object.keys(questions)
  if (ids.length === 0) return providerError('invalid-request', 'A decision request needs at least one question')
  for (const id of ids) {
    const question = questions[id]
    if (question === undefined) continue
    if (question.type === 'choice') {
      const count = Object.keys(question.options).length
      if (count < 1 || count > MAX_CHOICE_OPTIONS) {
        return providerError('invalid-request', `Choice question "${id}" needs 1 to ${MAX_CHOICE_OPTIONS} options, not ${count}`)
      }
    }
    if (question.type === 'score' && question.criteria.length === 0) {
      return providerError('invalid-request', `Score question "${id}" needs at least one criterion`)
    }
  }
  return null
}

type WireQuestion =
  | { readonly type: 'noul'; readonly instructions: string }
  | { readonly type: 'choice'; readonly instructions: string; readonly criteria: { readonly [option: string]: string } }
  | { readonly type: 'score'; readonly instructions: string; readonly criteria: readonly string[] }

function toWireQuestion(question: DecisionQuestion): WireQuestion {
  switch (question.type) {
    case 'noul':
      return { type: 'noul', instructions: question.instructions }
    case 'choice':
      return { type: 'choice', instructions: question.instructions, criteria: { ...question.options } }
    case 'score':
      return { type: 'score', instructions: question.instructions, criteria: [...question.criteria] }
  }
}

/** The request body exactly as the live API takes it. */
export function toWireRequest(request: DecisionRequest<DecisionQuestions>): {
  model: string
  state: string
  questions: Record<string, WireQuestion>
} {
  const questions: Record<string, WireQuestion> = {}
  for (const [id, question] of Object.entries(request.questions)) questions[id] = toWireQuestion(question)
  return { model: request.model, state: request.state, questions }
}

function malformed(message: string): { readonly ok: false; readonly error: ProviderError } {
  return { ok: false, error: providerError('malformed-response', message, { httpStatus: 200 }) }
}

function probability(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null
}

type AnyAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer

function parseAnswer(id: string, question: DecisionQuestion, raw: unknown): AnyAnswer | string {
  if (!isRecord(raw)) return `No answer for question "${id}"`
  if (raw['type'] !== question.type) return `Answer for "${id}" has type ${String(raw['type'])}, expected ${question.type}`
  switch (question.type) {
    case 'noul': {
      const p = probability(raw['noul'])
      if (p === null) return `Answer for "${id}" has no probability`
      return { type: 'noul', probability: p }
    }
    case 'choice': {
      const choice = raw['choice']
      if (typeof choice !== 'string' || !Object.hasOwn(question.options, choice)) {
        return `Answer for "${id}" chose ${JSON.stringify(choice)}, which is not one of the supplied options`
      }
      const rawProbabilities = isRecord(raw['probabilities']) ? raw['probabilities'] : {}
      const probabilities: Record<string, number> = {}
      for (const option of Object.keys(question.options)) probabilities[option] = probability(rawProbabilities[option]) ?? 0
      const confidence = probability(raw['confidence']) ?? probabilities[choice] ?? null
      if (confidence === null) return `Answer for "${id}" has no confidence`
      return { type: 'choice', choice, confidence, probabilities }
    }
    case 'score': {
      const score = probability(raw['score'])
      if (score === null) return `Answer for "${id}" has no score`
      let confidence = probability(raw['confidence'])
      if (confidence === null && isRecord(raw['probabilities'])) {
        const values = Object.values(raw['probabilities']).map(probability).filter((v): v is number => v !== null)
        if (values.length > 0) confidence = Math.max(...values)
      }
      if (confidence === null) return `Answer for "${id}" has no confidence`
      return { type: 'score', score, confidence }
    }
  }
}

function readUsage(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null
  const input = value['input_tokens']
  const output = value['output_tokens']
  if (typeof input !== 'number' || typeof output !== 'number') return null
  return { inputTokens: input, outputTokens: output }
}

/** Parses a 200 body against the questions that were asked. Exported for tests. */
export function parseDecisionResponse<Q extends DecisionQuestions>(request: DecisionRequest<Q>, body: unknown): DecisionResult<Q> {
  if (!isRecord(body) || !isRecord(body['answers'])) return malformed('The decision response has no answers')
  const rawAnswers = body['answers']
  const answers: Record<string, AnyAnswer> = {}
  for (const [id, question] of Object.entries(request.questions)) {
    const parsed = parseAnswer(id, question, rawAnswers[id])
    if (typeof parsed === 'string') return malformed(parsed)
    answers[id] = parsed
  }
  return {
    ok: true,
    model: typeof body['model'] === 'string' ? body['model'] : request.model,
    // Each answer was checked against its own question's type above.
    answers: answers as unknown as Extract<DecisionResult<Q>, { readonly ok: true }>['answers'],
    usage: readUsage(body['usage']),
  }
}

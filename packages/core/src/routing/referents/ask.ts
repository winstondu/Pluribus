import type { DecisionBudget, DecisionCostGuard, ProviderError } from '@committee/protocol'
import type { CancelSignal, DecisionProvider, DecisionQuestions, ReferentAsk, ReferentAskResult, ReferentQuestions } from '../../ports'
import { Batch, ask as askBatch, type Answers } from '../batch'

/**
 * The input tokens a decision request is counted as. An estimate from its
 * size, so the guard is deterministic and decided before anything is sent.
 * Fitted to the live usage of `typesafe/jev-1.13` on 2026-11-11 (nine
 * requests, 303 to 4,508 input tokens, every estimate within 3% and none
 * below the measured count): 262 tokens per request, 0.193 per character of
 * state, 7 per question and 0.233 per character of its ID and
 * instructions. The constants here are rounded up.
 */
export function estimateDecisionTokens(stateText: string, questions: ReferentQuestions): number {
  let tokens = 265 + Math.ceil(stateText.length * 0.2)
  for (const [id, question] of Object.entries(questions)) tokens += 7 + Math.ceil((id.length + question.instructions.length) * 0.24)
  return tokens
}

/** The same estimate for any decision request: a choice's options and a score's criteria count as question text. */
export function estimateRequestTokens(stateText: string, questions: DecisionQuestions): number {
  let tokens = 265 + Math.ceil(stateText.length * 0.2)
  for (const [id, question] of Object.entries(questions)) {
    let characters = id.length + question.instructions.length
    if (question.type === 'choice') for (const [option, text] of Object.entries(question.options)) characters += option.length + String(text).length
    if (question.type === 'score') for (const criterion of question.criteria) characters += criterion.length
    tokens += 7 + Math.ceil(characters * 0.24)
  }
  return tokens
}

/**
 * The price guard (`settings.routing.costGuard`): the decision input tokens
 * that routing `units` pieces of work may cost in all, so that the decision
 * requests cost at most `maxAnswerCostRatio` times the answers they route.
 * An answer is priced at its least input, the message itself, and its
 * expected output: the median length of the conversation's completed
 * answers once there are `ANSWERS_TO_GO_BY`, the setting's figure before.
 * The median is not taken below `SHORTEST_ANSWER_TOKENS`: under that the
 * pipeline's own request already costs more than twice the answer, and
 * cutting the strategy to nothing would only lose referents.
 * Infinity when the guard is off.
 */
export function decisionAllowance(guard: DecisionCostGuard, run: { readonly messageLength: number; readonly answerLengths: readonly number[]; readonly units: number }): number {
  if (!(guard.maxAnswerCostRatio > 0) || !(guard.decisionInputPrice > 0)) return Number.POSITIVE_INFINITY
  const lengths = [...run.answerLengths].sort((a, b) => a - b)
  const median = lengths[Math.floor((lengths.length - 1) / 2)] ?? 0
  const output = lengths.length >= ANSWERS_TO_GO_BY ? Math.max(SHORTEST_ANSWER_TOKENS, Math.ceil(median / CHARACTERS_PER_TOKEN)) : guard.expectedOutputTokens
  const input = Math.ceil(run.messageLength / CHARACTERS_PER_TOKEN)
  const answer = input * guard.answerInputPrice + output * guard.answerOutputPrice
  return Math.floor((guard.maxAnswerCostRatio * Math.max(1, run.units) * answer) / guard.decisionInputPrice)
}

export const ANSWERS_TO_GO_BY = 5
/** The shortest answer the price guard is held to: the answer of a 300-token exchange. */
export const SHORTEST_ANSWER_TOKENS = 250
const CHARACTERS_PER_TOKEN = 4

export interface ReferentSpend {
  readonly requests: number
  readonly questions: number
  readonly inputTokens: number
}

/**
 * The hard guard on a referent strategy's further decision work. Every
 * request a strategy makes goes through here; one that would take the
 * routing past its budget is refused and never sent, whatever the strategy
 * does. A strategy that wants to finish well checks `remaining()` first.
 */
export function createReferentAsk(options: {
  readonly provider: DecisionProvider
  readonly model: string
  readonly budget: DecisionBudget
  readonly signal: CancelSignal
  /** Every answered request, for the routing decision record. */
  readonly onAnswers: (answers: Answers) => void
}): ReferentAsk & { spent(): ReferentSpend } {
  const { budget } = options
  let requests = 0
  let questionCount = 0
  let inputTokens = 0
  const remaining = (): DecisionBudget => ({
    requests: Math.max(0, budget.requests - requests),
    questions: Math.max(0, budget.questions - questionCount),
    inputTokens: Math.max(0, budget.inputTokens - inputTokens),
  })
  const send = async (stateText: string, questions: ReferentQuestions): Promise<ReferentAskResult> => {
    const count = Object.keys(questions).length
    if (count === 0) return { kind: 'answered', probability: () => null }
    const tokens = estimateDecisionTokens(stateText, questions)
    const left = remaining()
    if (left.requests < 1) return { kind: 'refused', limit: 'requests' }
    if (left.questions < count) return { kind: 'refused', limit: 'questions' }
    if (left.inputTokens < tokens) return { kind: 'refused', limit: 'inputTokens' }
    requests += 1
    questionCount += count
    inputTokens += tokens
    const batch = new Batch()
    for (const [id, question] of Object.entries(questions)) batch.noul(id, question.instructions)
    const result: { readonly ok: true; readonly answers: Answers } | { readonly ok: false; readonly error: ProviderError } = await askBatch(
      options.provider,
      options.model,
      stateText,
      batch,
      options.signal,
    )
    if (!result.ok) return { kind: 'failed', error: result.error }
    options.onAnswers(result.answers)
    return { kind: 'answered', probability: (id) => result.answers.noul(id) }
  }
  return Object.assign(send, { remaining, estimate: estimateDecisionTokens, spent: (): ReferentSpend => ({ requests, questions: questionCount, inputTokens }) })
}

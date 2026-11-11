import type { DecisionBudget, ProviderError } from '@committee/protocol'
import type { CancelSignal, DecisionProvider, ReferentAsk, ReferentAskResult, ReferentQuestions } from '../../ports'
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

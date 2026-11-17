import type { ProviderError } from '@pluribus/protocol'
import type { CancelSignal, DecisionProvider, ReferentAsk, ReferentAskResult, ReferentQuestions } from '../../ports'
import { Batch, ask as askBatch, type Answers } from '../batch'

/**
 * The input tokens a decision request is counted as. An estimate from its
 * size, so it is deterministic and decided before anything is sent.
 *
 * Fitted on 2026-11-12 to the input tokens `typesafe/jev-1.13` reported for
 * 70 live requests (the CLAUDE.md sample, corpus requests and cost-grid
 * requests of every size: 333 to 16,139 tokens) so that it is never below
 * the reported count: 300 per request, 0.35 per character of state, 7 per
 * question and 0.32 per character of its text. It counts 1.01 to 1.30
 * times what was reported, about 1.23 times on corpus requests. Before, it
 * was 265 + 0.2 per character of state + 7 + 0.24 per character of
 * question text, fitted to nine requests on 2026-11-11; on the same 70 it
 * counted 0.63 to 1.04 times what was reported.
 */
export function estimateDecisionTokens(stateText: string, questions: ReferentQuestions): number {
  let tokens = REQUEST_TOKENS + Math.ceil(stateText.length * STATE_TOKENS_PER_CHARACTER)
  for (const [id, question] of Object.entries(questions)) tokens += QUESTION_TOKENS + Math.ceil((id.length + question.instructions.length) * QUESTION_TOKENS_PER_CHARACTER)
  return tokens
}

/** Tokens a decision request is counted as before its state and questions. */
export const REQUEST_TOKENS = 300
/** Tokens a decision request is counted as per character of its state text. */
export const STATE_TOKENS_PER_CHARACTER = 0.35
/** Tokens counted per question, before its text. */
export const QUESTION_TOKENS = 7
/** Tokens counted per character of a question's ID, instructions, options and criteria. */
export const QUESTION_TOKENS_PER_CHARACTER = 0.32

export interface ReferentSpend {
  readonly requests: number
  readonly questions: number
  readonly inputTokens: number
}

/**
 * A referent strategy's further decision work. Every request a strategy
 * makes goes through here.
 */
export function createReferentAsk(options: {
  readonly provider: DecisionProvider
  readonly model: string
  readonly signal: CancelSignal
  /** Every answered request, for the routing decision record. */
  readonly onAnswers: (answers: Answers) => void
}): ReferentAsk & { spent(): ReferentSpend } {
  let requests = 0
  let questionCount = 0
  let inputTokens = 0
  const send = async (stateText: string, questions: ReferentQuestions): Promise<ReferentAskResult> => {
    const count = Object.keys(questions).length
    if (count === 0) return { kind: 'answered', probability: () => null }
    const tokens = estimateDecisionTokens(stateText, questions)
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
  return Object.assign(send, { spent: (): ReferentSpend => ({ requests, questions: questionCount, inputTokens }) })
}

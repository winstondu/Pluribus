import { CHARACTERS_PER_TOKEN, resolveTokenBudget, textTokens, type DecisionBudget, type DecisionCostGuard, type ProviderError, type RoutingSettings } from '@committee/protocol'
import type { CancelSignal, DecisionProvider, DecisionQuestions, ReferentAsk, ReferentAskResult, ReferentQuestions, ShownSubjects } from '../../ports'
import { Batch, ask as askBatch, type Answers } from '../batch'

/**
 * The input tokens a decision request is counted as. An estimate from its
 * size, so the guard is deterministic and decided before anything is sent.
 *
 * Fitted on 2026-11-12 to the input tokens `typesafe/jev-1.13` reported for
 * 70 live requests (the CLAUDE.md sample, corpus requests and cost-grid
 * requests of every size: 333 to 16,139 tokens; recorded in
 * `packages/providers/testing/openrouter/estimate-fixture.data.ts`,
 * re-sent by `decision-estimate.smoke.test.ts`) so that it is never below
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

/** The same estimate for any decision request: a choice's options and a score's criteria count as question text. */
export function estimateRequestTokens(stateText: string, questions: DecisionQuestions): number {
  let tokens = REQUEST_TOKENS + Math.ceil(stateText.length * STATE_TOKENS_PER_CHARACTER)
  for (const [id, question] of Object.entries(questions)) {
    let characters = id.length + question.instructions.length
    if (question.type === 'choice') for (const [option, text] of Object.entries(question.options)) characters += option.length + String(text).length
    if (question.type === 'score') for (const criterion of question.criteria) characters += criterion.length
    tokens += QUESTION_TOKENS + Math.ceil(characters * QUESTION_TOKENS_PER_CHARACTER)
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
 * The median is not taken below `SHORTEST_ANSWER_TOKENS`: the smallest
 * request that still routes a message (the pipeline's, cut to its smallest
 * window, and one level of a walk) costs about twice an answer of that
 * length, so under it the bound cannot hold and the allowance stays what
 * that length buys. Infinity when the guard is off.
 */
export function decisionAllowance(guard: DecisionCostGuard, run: RoutedWork): number {
  if (!(guard.maxAnswerCostRatio > 0) || !(guard.decisionInputPrice > 0)) return Number.POSITIVE_INFINITY
  const lengths = [...run.answerLengths].sort((a, b) => a - b)
  const median = lengths[Math.floor((lengths.length - 1) / 2)] ?? 0
  const output = lengths.length >= ANSWERS_TO_GO_BY ? Math.max(SHORTEST_ANSWER_TOKENS, Math.ceil(median / CHARACTERS_PER_TOKEN)) : guard.expectedOutputTokens
  const input = textTokens(run.messageLength)
  const answer = input * guard.answerInputPrice + output * guard.answerOutputPrice
  return Math.floor((guard.maxAnswerCostRatio * Math.max(1, run.units) * answer) / guard.decisionInputPrice)
}

export interface RoutedWork {
  /** Characters of the message being routed. */
  readonly messageLength: number
  /** Characters of every completed answer of the conversation. */
  readonly answerLengths: readonly number[]
  /** Pieces of work the message is routed as: one, or the parts of a composite. */
  readonly units: number
}

export const ANSWERS_TO_GO_BY = 5
/** The shortest answer the price guard is held to. */
export const SHORTEST_ANSWER_TOKENS = 100
/** Which of the two limits is the smaller for a routing: the token budget, or the price guard's allowance. */
export type RoutingLimit = 'token-budget' | 'price-guard'

export interface RoutingTokenBudget {
  /** Estimated decision input tokens every decision request of the routing may use in all. */
  readonly total: number
  readonly limitedBy: RoutingLimit
}

/**
 * What one routing may use in decision input tokens: the smaller of the
 * token budget (`settings.routing.tokenBudget`, absolute or relative to the
 * conversation's log) and the price guard's allowance. The pipeline's own
 * requests, the strategy selector's and the referent strategy's all draw
 * from it. Deterministic: read from settings and the routing input.
 */
export function routingTokenBudget(
  settings: Pick<RoutingSettings, 'tokenBudget' | 'costGuard'>,
  run: RoutedWork & { readonly sessionLogTokens: number },
): RoutingTokenBudget {
  const budget = resolveTokenBudget(settings.tokenBudget, run.sessionLogTokens)
  const allowance = decisionAllowance(settings.costGuard, run)
  return allowance < budget ? { total: Math.max(0, allowance), limitedBy: 'price-guard' } : { total: Math.max(0, budget), limitedBy: 'token-budget' }
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
}): ReferentAsk & { spent(): ReferentSpend; refused(): keyof DecisionBudget | null } {
  const { budget } = options
  let requests = 0
  let questionCount = 0
  let inputTokens = 0
  /** The limit behind the first request that was refused. */
  let refusedBy: keyof DecisionBudget | null = null
  const refuse = (limit: keyof DecisionBudget): ReferentAskResult => {
    refusedBy ??= limit
    return { kind: 'refused', limit }
  }
  const remaining = (): DecisionBudget => ({
    requests: Math.max(0, budget.requests - requests),
    questions: Math.max(0, budget.questions - questionCount),
    inputTokens: Math.max(0, budget.inputTokens - inputTokens),
  })
  const send = async (stateText: string, questions: ReferentQuestions, shown: ShownSubjects = {}): Promise<ReferentAskResult> => {
    const count = Object.keys(questions).length
    if (count === 0) return { kind: 'answered', probability: () => null }
    const tokens = estimateDecisionTokens(stateText, questions)
    const left = remaining()
    if (left.requests < 1) return refuse('requests')
    if (left.questions < count) return refuse('questions')
    if (left.inputTokens < tokens) return refuse('inputTokens')
    requests += 1
    questionCount += count
    inputTokens += tokens
    const batch = new Batch()
    for (const [id, question] of Object.entries(questions)) {
      batch.noul(id, question.instructions)
      batch.show(id, shown[id] ?? [])
    }
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
  return Object.assign(send, { remaining, estimate: estimateDecisionTokens, spent: (): ReferentSpend => ({ requests, questions: questionCount, inputTokens }), refused: () => refusedBy })
}

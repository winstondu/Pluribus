import { RETRY_POLICIES, type AttemptId, type RetryPlan } from '@committee/protocol'
import type { ConversationState, RetryPlanner } from '../engine'

/**
 * The three retry policies (08 · "Retries", Q47, Q54), with the parameters
 * of `RETRY_POLICIES` (PLAN §7 "Backoff"):
 *
 * - Non-retryable errors (refusals, invalid requests, credits, context
 *   length) go straight to failed under every policy.
 * - Manual: no automatic retry; every failure and every interruption goes
 *   to the Retry action.
 * - Standard and Persistent: transient failures retry after an exact
 *   backoff on the injected clock; a rate limit (429) waits as the provider
 *   says (`Retry-After`, or the policy's default) and shows "Waiting for
 *   capacity", a 503 honours `Retry-After` as "Retrying…"; a wait longer
 *   than the policy accepts fails the directive instead of waiting. An
 *   interrupted attempt retries as soon as something can execute it.
 *   Interruptions and rate-limit waits count against the same limit; when
 *   it is used up the directive is failed and offers Retry.
 */
export const policyRetryPlanner: RetryPlanner = (state, directiveId, cause, now, settings): RetryPlan => {
  if (cause.kind === 'failed' && cause.error.class === 'non-retryable') return { kind: 'none', reason: 'non-retryable' }
  const policy = RETRY_POLICIES[settings.retryPolicy]
  if (policy.maxAutomaticRetries === 0) return { kind: 'none', reason: 'manual-policy' }
  const used = automaticRetriesUsed(state, directiveId)
  if (used >= policy.maxAutomaticRetries) return { kind: 'none', reason: 'exhausted' }
  const retryNumber = used + 1
  if (cause.kind === 'interrupted') return { kind: 'scheduled', at: now, wait: 'backoff', retryNumber }
  const error = cause.error
  if (error.code === 'rate-limited' || error.code === 'service-unavailable') {
    const wait = error.retryAfterMs ?? policy.defaultRetryAfterMs
    if (wait > policy.maxRetryAfterMs) return { kind: 'none', reason: 'exhausted' }
    return { kind: 'scheduled', at: now + wait, wait: error.code === 'rate-limited' ? 'rate-limit' : 'backoff', retryNumber }
  }
  const backoff = policy.backoffMs[Math.min(used, policy.backoffMs.length - 1)] ?? 0
  return { kind: 'scheduled', at: now + backoff, wait: 'backoff', retryNumber }
}

/**
 * Automatic retries already used by the directive's current section: the
 * automatic attempts at the end of its list, so a user's Retry, a revision
 * or a redo starts a fresh count.
 */
export function automaticRetriesUsed(state: ConversationState, directiveId: string): number {
  const d = state.directives[directiveId]
  const section = d?.sectionId ? state.sections[d.sectionId] : undefined
  if (!section) return 0
  let used = 0
  for (let i = section.attemptIds.length - 1; i >= 0; i--) {
    const attempt = state.attempts[section.attemptIds[i] as AttemptId]
    if (!attempt) break
    if (attempt.origin !== 'automatic-retry' && attempt.origin !== 'interruption-recovery') break
    used += 1
  }
  return used
}

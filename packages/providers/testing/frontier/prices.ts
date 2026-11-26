import { DEFAULT_SETTINGS } from '@pluribus/protocol'
import { MAX_SECTIONS } from '@pluribus/core'

/**
 * Test-only: the project's own accounting, as the frontier counts it.
 * Decisions are charged on input tokens only, at the price guard's
 * `decisionInputPrice` ($0.042 per million, measured 2026-11-11); output is
 * not charged (docs/build/dependency-decisioning.md · "Measured rates").
 */

/** Answer sections the routing request lists at most; a conversation with more is a long one. */
export const MAX_SECTIONS_LISTED = MAX_SECTIONS

export const decisionDollarsPerToken = (): number => DEFAULT_SETTINGS.routing.costGuard.decisionInputPrice / 1e6

/**
 * The answer a message gets on the cheapest answer model, the price guard's
 * yardstick: the message in, `outputTokens` out, at the guard's prices.
 */
export function cheapestAnswerDollars(messageCharacters: number, outputTokens: number): number {
  const guard = DEFAULT_SETTINGS.routing.costGuard
  return (Math.ceil(messageCharacters / 4) * guard.answerInputPrice + outputTokens * guard.answerOutputPrice) / 1e6
}

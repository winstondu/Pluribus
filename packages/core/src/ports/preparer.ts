import type { ClarificationReason, ProviderError, TokenUsage } from '@pluribus/protocol'
import type { CancelSignal } from './cancel'
import type { ModelMessage } from './model-provider'

/**
 * The preparation step (07 · "Clarification", 11 · "Pipeline" stage 4,
 * Q103): one structured call that establishes a directive's typed readiness
 * result when the routing and decomposition findings do not. Core runs it
 * only for a directive that waited for results, once they have arrived and
 * before its answer run (Q105); see `engine/readiness.ts` for when.
 *
 * It reads the exact input the answer run would read and writes no answer
 * text. Its result is recorded as `directive-readiness-established`, so a
 * replay never calls it.
 */

export interface PreparationRequest {
  /** The decomposition role's model, which the compatibility list tests for structured preparation (Q107). */
  readonly model: string
  /** The exact input of the answer run this prepares, in order. */
  readonly messages: readonly ModelMessage[]
}

/** What the preparation step found. A question is always written out: it is shown to the user as it is. */
export type PreparedReadiness =
  | { readonly kind: 'ready' }
  | { readonly kind: 'clarification-needed'; readonly reason: ClarificationReason; readonly question: string }

export type PreparationResult =
  | {
      readonly ok: true
      readonly readiness: PreparedReadiness
      /** The model that answered, as the provider returned it. */
      readonly model: string
      readonly usage: TokenUsage | null
    }
  | { readonly ok: false; readonly error: ProviderError }

export interface Preparer {
  /**
   * Establishes readiness for one answer run. Never rejects: a provider
   * failure, or a response that is not the typed result, is `ok: false`
   * with a typed error (`malformed-response` for the latter). It does not
   * retry; core applies the retry setting to the directive.
   */
  prepare(request: PreparationRequest, signal: CancelSignal): Promise<PreparationResult>
}

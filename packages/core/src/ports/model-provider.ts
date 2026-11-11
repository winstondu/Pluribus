import type { ProviderError, TokenUsage } from '@committee/protocol'
import type { CancelSignal } from './cancel'

/**
 * Answer runs. One call is one model run: the backend assembles the whole
 * input itself and the provider keeps no conversation state (Q57).
 */

export interface ModelMessage {
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: string
}

export interface ModelRequest {
  /** OpenRouter model ID, from the per-role settings (Q65). */
  readonly model: string
  /** The exact input, in order. Core records the same messages on the attempt (invariant 2). */
  readonly messages: readonly ModelMessage[]
}

export type ModelStreamEvent =
  /** A piece of answer text. Never empty. Status and keep-alive lines are not text and are never yielded. */
  | { readonly type: 'text'; readonly text: string }
  /** The run finished successfully. */
  | { readonly type: 'completed'; readonly finishReason: 'stop' | 'length'; readonly usage: TokenUsage | null }
  /** The run ended in an error, mapped per 11 · "OpenRouter error mapping". */
  | { readonly type: 'failed'; readonly error: ProviderError }
  /** The signal was cancelled and the request was aborted (Q75). */
  | { readonly type: 'cancelled' }

export type ModelStreamTerminal = Exclude<ModelStreamEvent, { readonly type: 'text' }>

/** Tokens counted before a run (Q67). */
export interface TokenCount {
  readonly inputTokens: number
  /** The model's context limit in tokens, or null when it is not known. */
  readonly contextLimit: number | null
  /** False when `inputTokens` is an estimate. */
  readonly exact: boolean
}

export interface ModelProvider {
  /**
   * Streams one run.
   *
   * Contract:
   * - Yields zero or more `text` events, then exactly one terminal event
   *   (`completed`, `failed` or `cancelled`), then ends.
   * - Never throws and never rejects: every failure is a `failed` event with
   *   a typed error. Text yielded before a failure stands as partial output.
   * - Error mapping: 408, 429, 502, 503, other 5xx, network failures, an
   *   empty 200 and a mid-stream error chunk (`finish_reason: "error"`) are
   *   transient; 400, 401, 402, 403 and `context_length_exceeded` are
   *   non-retryable. `Retry-After` on 429 and 503 is passed on as
   *   `retryAfterMs`. A 200 that yields no text at all is `empty-response`.
   * - It does not retry. The retry setting is applied by core.
   * - When `signal` is cancelled it aborts the HTTP request and yields
   *   `cancelled` promptly, without further `text`.
   * - With no key configured it yields `failed` with code `no-key`.
   */
  stream(request: ModelRequest, signal: CancelSignal): AsyncIterable<ModelStreamEvent>

  /**
   * Counts the input tokens of a request and reports the model's context
   * limit. Never rejects: when an exact count is not available it estimates
   * (`exact: false`), and an unknown limit is null. Core warns near the
   * limit and fails the directive as non-retryable over it; context is never
   * truncated (Q67, Q82).
   */
  countTokens(request: ModelRequest): Promise<TokenCount>
}

import Anthropic from '@anthropic-ai/sdk'
import { WORDING, providerError, type ProviderError } from '@committee/protocol'
import type { CancelSignal } from '@committee/core/ports'
import { CANCELLED_ERROR, abortControllerFor, parseRetryAfter, redact, type FetchLike } from '../openrouter/http'

/**
 * The layer shared by the Claude API providers: the SDK client, key lookup,
 * cancellation, and the error mapping of 11 · "Claude API error mapping".
 *
 * Calls go through the official SDK (`@anthropic-ai/sdk`) with `fetch`
 * injected, so unit tests never touch the network and the same code runs in
 * a browser Web Worker and in Node.
 *
 * Browser access. The embedded backend calls `api.anthropic.com` straight
 * from the user's browser with the user's own key. The Claude API accepts
 * such a cross-origin request only when it carries
 * `anthropic-dangerous-direct-browser-access: true`, which the SDK sends
 * when `dangerouslyAllowBrowser` is set. It is set on every client here, on
 * purpose: the key is the user's own, lives in the local secrets store and
 * is sent only to Anthropic. An organization with zero data retention or
 * the Compliance API enabled cannot call the API from a browser at all; it
 * gets a 401 whose message says so, which is passed on as it is.
 */

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com'

export interface AnthropicOptions {
  /** The only way a provider sees the key. Null or empty means no key is configured. */
  readonly getKey: () => Promise<string | null>
  /** Defaults to the global `fetch`, called unbound so a Worker never throws "Illegal invocation". */
  readonly fetch?: FetchLike
  /** Defaults to {@link ANTHROPIC_BASE_URL}. */
  readonly baseUrl?: string
  /** Wall-clock time in ms, used only to read an HTTP-date `Retry-After`. Defaults to `Date.now`. */
  readonly now?: () => number
}

export interface ResolvedAnthropicOptions {
  readonly getKey: () => Promise<string | null>
  readonly fetch: FetchLike
  readonly baseUrl: string
  readonly now: () => number
}

export function resolveAnthropicOptions(options: AnthropicOptions): ResolvedAnthropicOptions {
  return {
    getKey: options.getKey,
    fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    baseUrl: (options.baseUrl ?? ANTHROPIC_BASE_URL).replace(/\/+$/, ''),
    now: options.now ?? (() => Date.now()),
  }
}

/** Reads the key; a throwing secrets store counts as no key. */
export async function readAnthropicKey(options: ResolvedAnthropicOptions): Promise<string | null> {
  try {
    const key = await options.getKey()
    return typeof key === 'string' && key.trim() !== '' ? key.trim() : null
  } catch {
    return null
  }
}

export const NO_ANTHROPIC_KEY_ERROR: ProviderError = providerError('no-key', 'No Anthropic key is configured')

/**
 * A client for one call. Built per call because the key is read per call.
 * It does not retry (core applies the retry setting), reads no credentials
 * from the environment, and logs nothing: an SDK log line could carry a
 * request header.
 */
export function createClient(options: ResolvedAnthropicOptions, key: string): Anthropic {
  return new Anthropic({
    apiKey: key,
    authToken: null,
    baseURL: options.baseUrl,
    fetch: (input, init) => options.fetch(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url, init ?? {}),
    maxRetries: 0,
    logLevel: 'off',
    openTelemetry: false,
    dangerouslyAllowBrowser: true,
  })
}

// ───────────────────────────── error mapping ─────────────────────────────

/**
 * The API has no error code for an input over the context limit: it is a
 * 400 `invalid_request_error` whose message says so. This is the one place
 * a message is read, because the difference decides what the user is told.
 */
const CONTEXT_LENGTH_PATTERN = /prompt is too long|context window|context length|too many tokens|maximum context/i

/** The message of a 401 for an organization that may not call the API from a browser. */
const BROWSER_BLOCKED_PREFIX = 'CORS requests are not allowed'

/** True when a 401 means "this organization cannot call the API from a browser", not "the key is wrong". */
export function isBrowserBlocked(error: unknown): boolean {
  return error instanceof Anthropic.AuthenticationError && (error.apiMessage ?? '').startsWith(BROWSER_BLOCKED_PREFIX)
}

/** True when the provider refused for lack of credit or at a spend limit. */
export function isOutOfCredit(error: unknown): boolean {
  if (!(error instanceof Anthropic.APIError)) return false
  // 402 `billing_error`; the monthly spend cap is a 429 with a stable code and no `retry-after`.
  return error.status === 402 || error.type === 'billing_error' || error.errorCode === 'enforced_spend_limit_reached'
}

function messageOf(error: InstanceType<typeof Anthropic.APIError>, fallback: string, key: string | null): string {
  return redact(error.apiMessage ?? fallback, key)
}

/**
 * Maps anything a Claude API call threw into a typed error per 11 · "Claude
 * API error mapping". Never throws. Cancellation is the caller's to
 * recognise first (the signal says so); this maps an abort to `network`.
 */
export function mapAnthropicError(error: unknown, key: string | null, now: number): ProviderError {
  if (error instanceof Anthropic.APIConnectionTimeoutError) return providerError('timeout', 'The request to Anthropic timed out')
  if (error instanceof Anthropic.APIUserAbortError) return CANCELLED_ERROR
  if (error instanceof Anthropic.APIConnectionError) {
    const cause = error.cause instanceof Error && error.cause.message !== '' ? `: ${error.cause.message}` : ''
    return providerError('network', redact(`The connection to Anthropic failed${cause}`, key))
  }
  if (!(error instanceof Anthropic.APIError)) {
    const detail = error instanceof Error && error.message !== '' ? `: ${error.message}` : ''
    return providerError('network', redact(`The connection to Anthropic failed${detail}`, key))
  }
  const status = error.status
  if (status === undefined) {
    // An `error` event inside a stream that began with HTTP 200.
    return providerError('mid-stream-error', messageOf(error, 'Anthropic reported an error mid-stream', key), { httpStatus: 200 })
  }
  if (isOutOfCredit(error)) return providerError('out-of-credits', WORDING.outOfAnthropicCredits, { httpStatus: status })
  const retryAfterMs = parseRetryAfter(error.headers?.get('retry-after') ?? null, now)
  if (error.type === 'timeout_error' || status === 408 || status === 504) {
    return providerError('timeout', messageOf(error, 'The request to Anthropic timed out', key), { httpStatus: status })
  }
  if (error.type === 'overloaded_error' || status === 529 || status === 503) {
    return providerError('service-unavailable', messageOf(error, 'Anthropic is overloaded', key), { httpStatus: status, retryAfterMs })
  }
  switch (status) {
    case 401:
      return providerError('unauthorized', messageOf(error, 'The Anthropic key was not accepted', key), { httpStatus: status })
    case 403:
      return providerError('unauthorized', messageOf(error, 'The Anthropic key may not use this resource', key), { httpStatus: status })
    case 413:
      return providerError('context-length-exceeded', messageOf(error, 'The input is over the request size limit', key), { httpStatus: status })
    case 429:
      return providerError('rate-limited', messageOf(error, 'Anthropic is rate limiting this key', key), { httpStatus: status, retryAfterMs })
    case 502:
      return providerError('bad-gateway', messageOf(error, 'Anthropic returned a bad gateway', key), { httpStatus: status })
    default:
      break
  }
  if (status >= 500) return providerError('provider-error', messageOf(error, `Anthropic returned HTTP ${status}`, key), { httpStatus: status })
  if (CONTEXT_LENGTH_PATTERN.test(error.apiMessage ?? '')) {
    return providerError('context-length-exceeded', messageOf(error, 'The input is over the model context limit', key), { httpStatus: status })
  }
  return providerError('invalid-request', messageOf(error, status === 404 ? 'The model was not found' : 'The request was invalid', key), { httpStatus: status })
}

// ───────────────────────────── non-streaming calls ─────────────────────────────

export type AnthropicCallResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ProviderError }

/**
 * Runs one non-streaming call with the key, cancellation and error mapping
 * done. Never throws. The non-streaming result types have no cancelled case,
 * so a cancelled call is `network` "The request was cancelled", as with
 * OpenRouter.
 */
export async function callAnthropic<T>(
  options: ResolvedAnthropicOptions,
  signal: CancelSignal,
  run: (client: Anthropic, request: { readonly signal: AbortSignal }) => Promise<T>,
): Promise<AnthropicCallResult<T>> {
  if (signal.cancelled) return { ok: false, error: CANCELLED_ERROR }
  const key = await readAnthropicKey(options)
  if (key === null) return { ok: false, error: NO_ANTHROPIC_KEY_ERROR }
  if (signal.cancelled) return { ok: false, error: CANCELLED_ERROR }
  const { controller, release } = abortControllerFor(signal)
  try {
    return { ok: true, value: await run(createClient(options, key), { signal: controller.signal }) }
  } catch (error) {
    if (signal.cancelled) return { ok: false, error: CANCELLED_ERROR }
    return { ok: false, error: mapAnthropicError(error, key, options.now()) }
  } finally {
    release()
  }
}

/** The text of a message: its text blocks, joined. Thinking and tool blocks are not text. */
export function textOf(message: { readonly content: readonly { readonly type: string }[] }): string {
  let text = ''
  for (const block of message.content) {
    if (block.type === 'text' && 'text' in block && typeof block.text === 'string') text += block.text
  }
  return text
}

/** Input tokens as billed: uncached, cache-written and cache-read together. */
export function inputTokensOf(usage: {
  readonly input_tokens: number
  readonly cache_creation_input_tokens?: number | null
  readonly cache_read_input_tokens?: number | null
}): number {
  return usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
}

/**
 * The Messages API takes the system prompt apart from the turns. Every
 * `system` message of a run's input goes to `system`, in order; the turns
 * keep their order. Core puts its system messages first (the preamble, then
 * session-wide requirements), so nothing moves.
 */
export function splitSystem(messages: readonly { readonly role: 'system' | 'user' | 'assistant'; readonly content: string }[]): {
  readonly system: string
  readonly turns: Anthropic.MessageParam[]
} {
  const system: string[] = []
  const turns: Anthropic.MessageParam[] = []
  for (const message of messages) {
    if (message.role === 'system') system.push(message.content)
    else turns.push({ role: message.role, content: message.content })
  }
  return { system: system.join('\n\n'), turns }
}

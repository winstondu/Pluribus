import { WORDING, providerError, providerErrorCodeForStatus, type ProviderError } from '@pluribus/protocol'
import type { CancelSignal } from '@pluribus/core/ports'

/**
 * The HTTP layer shared by the three OpenRouter providers: key lookup,
 * cancellation, and the error mapping of 11 · "OpenRouter error mapping".
 *
 * Only `fetch`, `AbortController`, `TextDecoder` and `Headers` are used, so
 * this runs unchanged in a browser Web Worker and in Node.
 */

export const OPENROUTER_BASE_URL = 'https://openrouter.ai'

/** The subset of `fetch` the providers use. Injected so unit tests never touch the network. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

export interface OpenRouterOptions {
  /** The only way a provider sees the key. Null or empty means no key is configured. */
  readonly getKey: () => Promise<string | null>
  /** Defaults to the global `fetch`, called unbound so a Worker never throws "Illegal invocation". */
  readonly fetch?: FetchLike
  /** Defaults to {@link OPENROUTER_BASE_URL}. */
  readonly baseUrl?: string
  /** Wall-clock time in ms, used only to read an HTTP-date `Retry-After`. Defaults to `Date.now`. */
  readonly now?: () => number
}

export interface ResolvedOptions {
  readonly getKey: () => Promise<string | null>
  readonly fetch: FetchLike
  readonly baseUrl: string
  readonly now: () => number
}

export function resolveOptions(options: OpenRouterOptions): ResolvedOptions {
  return {
    getKey: options.getKey,
    fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    baseUrl: (options.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/+$/, ''),
    now: options.now ?? (() => Date.now()),
  }
}

/** Reads the key; a throwing secrets store counts as no key. */
export async function readKey(options: ResolvedOptions): Promise<string | null> {
  try {
    const key = await options.getKey()
    return typeof key === 'string' && key.trim() !== '' ? key.trim() : null
  } catch {
    return null
  }
}

export const NO_KEY_ERROR: ProviderError = providerError('no-key', 'No OpenRouter key is configured')

/** Returned by the non-streaming providers when the caller cancelled; their result types have no cancelled case. */
export const CANCELLED_ERROR: ProviderError = providerError('network', 'The request was cancelled')

/** An `AbortController` that follows a {@link CancelSignal}. `release()` detaches it. */
export function abortControllerFor(signal: CancelSignal): { controller: AbortController; release: () => void } {
  const controller = new AbortController()
  const off = signal.onCancel(() => controller.abort())
  return { controller, release: off }
}

/** Removes the key from any text before it can reach a message, an event or a log. */
export function redact(text: string, key: string | null): string {
  if (key === null || key === '') return text
  return text.split(key).join('[redacted]')
}

export function jsonHeaders(key: string): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    'X-Title': 'Pluribus',
  }
}

// ───────────────────────────── error mapping ─────────────────────────────

/** OpenRouter's error body: `{ "error": { "message", "code", "metadata"? } }`. */
export interface OpenRouterErrorBody {
  readonly message: string | null
  /** Numeric HTTP-like code or a string code such as `context_length_exceeded`. */
  readonly code: number | string | null
  /** Moderation reasons, when the body carries them (403). */
  readonly reasons: readonly string[]
  /** Raw metadata text, for recognising `context_length_exceeded` inside a provider's raw error. */
  readonly rawMetadata: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reads `{ error: {...} }` from a parsed JSON value; null when it is not an error body. */
export function readErrorBody(value: unknown): OpenRouterErrorBody | null {
  if (!isRecord(value)) return null
  const error = value['error']
  if (typeof error === 'string') return { message: error, code: null, reasons: [], rawMetadata: '' }
  if (!isRecord(error)) return null
  const message = typeof error['message'] === 'string' ? error['message'] : null
  const rawCode = error['code']
  const code = typeof rawCode === 'number' || typeof rawCode === 'string' ? rawCode : null
  const metadata = error['metadata']
  const reasons: string[] = []
  let rawMetadata = ''
  if (isRecord(metadata)) {
    const list = metadata['reasons']
    if (Array.isArray(list)) for (const reason of list) if (typeof reason === 'string') reasons.push(reason)
    try {
      rawMetadata = JSON.stringify(metadata)
    } catch {
      rawMetadata = ''
    }
  }
  return { message, code, reasons, rawMetadata }
}

const CONTEXT_LENGTH_PATTERN =
  /context_length_exceeded|maximum context length|context length (?:is|of|exceeded)|context window|prompt is too long|too many tokens/i

/** True when an error body says the input is over the model's context limit. */
export function isContextLengthError(body: OpenRouterErrorBody): boolean {
  if (body.code === 'context_length_exceeded') return true
  return CONTEXT_LENGTH_PATTERN.test(body.message ?? '') || CONTEXT_LENGTH_PATTERN.test(body.rawMetadata)
}

/**
 * Parses `Retry-After`: delay-seconds or an HTTP-date. Returns ms, or null
 * when absent or unreadable. A date in the past is 0.
 */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null) return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000)
  const date = Date.parse(trimmed)
  if (Number.isNaN(date)) return null
  return Math.max(0, date - now)
}

const GENERIC_MESSAGES: { readonly [status: number]: string } = {
  400: 'The request was invalid',
  401: 'The OpenRouter key was not accepted',
  403: 'The request was refused by moderation',
  408: 'The request timed out',
  429: 'The provider is rate limited',
  502: 'The provider returned a bad gateway',
  503: 'The provider is unavailable',
}

/** Maps an error status and its parsed body per 11 · "OpenRouter error mapping". */
export function errorForStatus(
  status: number,
  body: OpenRouterErrorBody | null,
  retryAfterHeader: string | null,
  key: string | null,
  now: number,
): ProviderError {
  if (body !== null && isContextLengthError(body)) {
    return providerError('context-length-exceeded', redact(body.message ?? 'The input is over the model context limit', key), {
      httpStatus: status,
    })
  }
  const code = providerErrorCodeForStatus(status)
  if (code === 'out-of-credits') return providerError(code, WORDING.outOfCredits, { httpStatus: status })
  const base = body?.message ?? GENERIC_MESSAGES[status] ?? `OpenRouter returned HTTP ${status}`
  const withReasons = code === 'moderation' && body !== null && body.reasons.length > 0 ? `${base}: ${body.reasons.join(', ')}` : base
  const retryAfterMs = code === 'rate-limited' || code === 'service-unavailable' ? parseRetryAfter(retryAfterHeader, now) : null
  return providerError(code, redact(withReasons, key), { httpStatus: status, retryAfterMs })
}

/** Reads a non-2xx response into a typed error. Never throws. */
export async function errorFromResponse(response: Response, key: string | null, now: number): Promise<ProviderError> {
  let body: OpenRouterErrorBody | null = null
  try {
    const text = await response.text()
    try {
      body = readErrorBody(JSON.parse(text))
    } catch {
      body = text.trim() === '' ? null : { message: text.trim().slice(0, 500), code: null, reasons: [], rawMetadata: '' }
    }
  } catch {
    body = null
  }
  return errorForStatus(response.status, body, response.headers.get('retry-after'), key, now)
}

/** Maps an error object found inside a 200 body or an SSE chunk. */
export function errorForInBandBody(body: OpenRouterErrorBody, key: string | null): ProviderError {
  if (isContextLengthError(body)) {
    return providerError('context-length-exceeded', redact(body.message ?? 'The input is over the model context limit', key), {
      httpStatus: 200,
    })
  }
  if (typeof body.code === 'number' && body.code === 402) {
    return providerError('out-of-credits', WORDING.outOfCredits, { httpStatus: 200 })
  }
  return providerError('mid-stream-error', redact(body.message ?? 'The provider reported an error mid-stream', key), {
    httpStatus: 200,
  })
}

// ───────────────────────────── JSON calls ─────────────────────────────

export type JsonCallResult =
  | { readonly ok: true; readonly body: unknown; readonly key: string }
  | { readonly ok: false; readonly error: ProviderError }

/**
 * POSTs JSON and reads a JSON body. Never throws. A 2xx body that is an
 * OpenRouter error object is mapped like an error status; a 2xx with no body
 * is `empty-response`.
 */
export async function postJson(
  options: ResolvedOptions,
  path: string,
  payload: unknown,
  signal: CancelSignal,
): Promise<JsonCallResult> {
  if (signal.cancelled) return { ok: false, error: CANCELLED_ERROR }
  const key = await readKey(options)
  if (key === null) return { ok: false, error: NO_KEY_ERROR }
  if (signal.cancelled) return { ok: false, error: CANCELLED_ERROR }
  const { controller, release } = abortControllerFor(signal)
  try {
    let response: Response
    try {
      response = await options.fetch(`${options.baseUrl}${path}`, {
        method: 'POST',
        headers: jsonHeaders(key),
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
    } catch (error) {
      if (signal.cancelled) return { ok: false, error: CANCELLED_ERROR }
      return { ok: false, error: networkError(error, key) }
    }
    if (!response.ok) return { ok: false, error: await errorFromResponse(response, key, options.now()) }
    let text: string
    try {
      text = await response.text()
    } catch (error) {
      if (signal.cancelled) return { ok: false, error: CANCELLED_ERROR }
      return { ok: false, error: networkError(error, key) }
    }
    if (text.trim() === '') {
      return { ok: false, error: providerError('empty-response', 'OpenRouter returned an empty response', { httpStatus: response.status }) }
    }
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      return {
        ok: false,
        error: providerError('malformed-response', 'OpenRouter returned a body that is not JSON', { httpStatus: response.status }),
      }
    }
    const inBand = readErrorBody(body)
    if (inBand !== null) {
      const status = typeof inBand.code === 'number' && inBand.code >= 400 ? inBand.code : null
      const error =
        status !== null ? errorForStatus(status, inBand, null, key, options.now()) : errorForInBandBody(inBand, key)
      return { ok: false, error }
    }
    return { ok: true, body, key }
  } finally {
    release()
  }
}

export function networkError(error: unknown, key: string | null): ProviderError {
  const detail = error instanceof Error && error.message !== '' ? `: ${error.message}` : ''
  return providerError('network', redact(`The connection to OpenRouter failed${detail}`, key))
}

export { isRecord }

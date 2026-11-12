import type { KeyCheck } from '@pluribus/protocol'
import { OPENROUTER_BASE_URL, type FetchLike } from './http'

/**
 * Checking an OpenRouter key before it is saved: `GET /api/v1/key`, which is
 * free and reports what is left on the key when it has a spending limit.
 *
 * The key passed in is used for this one request and nothing else: it is
 * never stored, logged or put in a result or an error by this module.
 */
export async function checkOpenRouterKey(
  key: string,
  signal: AbortSignal,
  options: { readonly fetch?: FetchLike; readonly baseUrl?: string } = {},
): Promise<KeyCheck> {
  const fetchFn: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  let response: Response
  try {
    response = await fetchFn(`${(options.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/+$/, '')}/api/v1/key`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key.trim()}` },
      signal,
    })
  } catch (error) {
    if (signal.aborted) throw error
    return { status: 'offline' }
  }
  if (response.status === 401 || response.status === 403) return { status: 'invalid' }
  if (!response.ok) return { status: 'unverified', httpStatus: response.status }
  try {
    const body = (await response.json()) as { data?: { label?: unknown; limit_remaining?: unknown } }
    const label = typeof body.data?.label === 'string' ? body.data.label : null
    const remaining = body.data?.limit_remaining
    return {
      status: 'valid',
      label,
      credit: typeof remaining === 'number' && Number.isFinite(remaining) ? { kind: 'remaining', dollars: remaining } : { kind: 'unlimited' },
    }
  } catch {
    return { status: 'valid', label: null, credit: { kind: 'unlimited' } }
  }
}

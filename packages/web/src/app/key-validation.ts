/**
 * Checking an OpenRouter key before it is saved: a format check that needs
 * no network, and a live check against `GET /api/v1/key`.
 *
 * The key passed in here comes straight from the key prompt's input and is
 * never stored, logged or put in an error message by this module.
 */

export const OPENROUTER_KEYS_URL = 'https://openrouter.ai/settings/keys'
const KEY_ENDPOINT = 'https://openrouter.ai/api/v1/key'

export type KeyCheck =
  /** OpenRouter recognizes the key. `remaining` is in US dollars; null when the key has no spending limit. */
  | { readonly status: 'valid'; readonly label: string | null; readonly remaining: number | null }
  /** OpenRouter rejected the key (401). */
  | { readonly status: 'invalid' }
  /** The request never reached OpenRouter. The key can still be saved; it is checked on first use. */
  | { readonly status: 'offline' }
  /** OpenRouter answered with something other than a verdict (429, 5xx). */
  | { readonly status: 'unverified'; readonly httpStatus: number }

export type KeyValidator = (key: string, signal: AbortSignal) => Promise<KeyCheck>

/** A message for a key that cannot be an OpenRouter key, or null when its shape is plausible. */
export function keyFormatProblem(raw: string): string | null {
  const key = raw.trim()
  if (key === '') return null
  if (/\s/.test(key)) return 'A key has no spaces or line breaks. Paste it again.'
  if (!key.startsWith('sk-or-')) return 'OpenRouter keys start with “sk-or-”.'
  if (key.length < 24) return 'That looks too short. Paste the whole key.'
  return null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** The live check. `fetchFn` is injected so tests never touch the network. */
export function createKeyValidator(fetchFn: typeof fetch = (input, init) => fetch(input, init)): KeyValidator {
  return async (key, signal) => {
    let response: Response
    try {
      response = await fetchFn(KEY_ENDPOINT, {
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
      return { status: 'valid', label, remaining: numberOrNull(body.data?.limit_remaining) }
    } catch {
      return { status: 'valid', label: null, remaining: null }
    }
  }
}

/**
 * The validator used with the fixture backend, where nothing may reach the
 * network: a key containing "invalid" is rejected, one containing "offline"
 * cannot be checked, anything else is valid with some credit left.
 */
export const scriptedKeyValidator: KeyValidator = (key, signal) =>
  new Promise<KeyCheck>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (key.includes('invalid')) resolve({ status: 'invalid' })
      else if (key.includes('offline')) resolve({ status: 'offline' })
      else resolve({ status: 'valid', label: 'sk-or-v1-fix…ure', remaining: 12.4 })
    }, 700)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    })
  })

/** "$12.40", or "$0.58" for small amounts. */
export function formatCredit(dollars: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(
    Math.max(0, dollars),
  )
}

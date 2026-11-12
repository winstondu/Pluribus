import type { KeyProviderName } from '@committee/protocol'

/**
 * What the key prompt knows about a provider's keys without asking anyone:
 * where to create one, what one looks like, and a format check that needs
 * no network. The live check is the deployment's (`KeyProvision.check`).
 *
 * A key passed in here comes straight from the key prompt's input and is
 * never stored, logged or put in a message by this module.
 */

export const OPENROUTER_KEYS_URL = 'https://openrouter.ai/settings/keys'
export const ANTHROPIC_KEYS_URL = 'https://platform.claude.com/settings/keys'

export const KEY_FORMATS: {
  readonly [P in KeyProviderName]: { readonly name: string; readonly prefix: string; readonly placeholder: string; readonly keysUrl: string; readonly site: string }
} = {
  openrouter: { name: 'OpenRouter', prefix: 'sk-or-', placeholder: 'sk-or-v1-…', keysUrl: OPENROUTER_KEYS_URL, site: 'openrouter.ai' },
  anthropic: { name: 'Anthropic', prefix: 'sk-ant-', placeholder: 'sk-ant-…', keysUrl: ANTHROPIC_KEYS_URL, site: 'platform.claude.com' },
}

/** A message for a key that cannot be this provider's, or null when its shape is plausible. */
export function keyFormatProblem(raw: string, provider: KeyProviderName = 'openrouter'): string | null {
  const key = raw.trim()
  if (key === '') return null
  const format = KEY_FORMATS[provider]
  if (/\s/.test(key)) return 'A key has no spaces or line breaks. Paste it again.'
  if (!key.startsWith(format.prefix)) return `${format.name} keys start with “${format.prefix}”.`
  if (key.length < 24) return 'That looks too short. Paste the whole key.'
  return null
}

/** "$12.40", or "$0.58" for small amounts. */
export function formatCredit(dollars: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(
    Math.max(0, dollars),
  )
}

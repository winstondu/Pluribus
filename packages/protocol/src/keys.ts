import type { ModelProviderName } from './model'

/**
 * Provider keys as a client and a deployment talk about them (11 · "Key
 * handling"). A key's value is never part of the protocol: no command, event,
 * projection or snapshot carries one. What is shared here is the vocabulary
 * for which key is meant and for the result of checking one.
 */

/** A provider that takes a key. */
export type KeyProviderName = ModelProviderName

export const KEY_PROVIDER_LABELS: { readonly [P in KeyProviderName]: string } = {
  openrouter: 'OpenRouter',
}

/** What is known about the credit behind a key. */
export type KeyCredit =
  /** The provider reported what is left on the key, in US dollars. */
  | { readonly kind: 'remaining'; readonly dollars: number }
  /** The key has no spending limit of its own. */
  | { readonly kind: 'unlimited' }
  /** A minimal request went through, so there is credit; how much cannot be read. */
  | { readonly kind: 'available' }
  /** The provider refused a minimal request for lack of credit, or at a spend limit. */
  | { readonly kind: 'exhausted' }
  /** The key works but the credit could not be determined. */
  | { readonly kind: 'unknown' }

export type KeyCheck =
  /** The provider recognizes the key. */
  | { readonly status: 'valid'; readonly label: string | null; readonly credit: KeyCredit }
  /** The provider rejected the key. */
  | { readonly status: 'invalid' }
  /** The key is recognized but cannot be used from this deployment; `reason` is the provider's. */
  | { readonly status: 'blocked'; readonly reason: string }
  /** The request never reached the provider. The key can still be saved; it is checked on first use. */
  | { readonly status: 'offline' }
  /** The provider answered with something other than a verdict (429, 5xx). */
  | { readonly status: 'unverified'; readonly httpStatus: number }

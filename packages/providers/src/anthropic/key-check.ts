import Anthropic from '@anthropic-ai/sdk'
import type { KeyCheck, KeyCredit } from '@committee/protocol'
import { createClient, isBrowserBlocked, isOutOfCredit, resolveAnthropicOptions } from './client'
import type { FetchLike } from '../openrouter/http'

/**
 * Checking an Anthropic key before it is saved.
 *
 * What an ordinary API key can and cannot tell. The Claude API has no
 * endpoint that lets a standard key read its credit balance (usage and cost
 * reports need an Admin key, which this app never asks for). So the check
 * is two requests:
 *
 * 1. `GET /v1/models?limit=1`, free: is the key recognized at all.
 * 2. One Messages request of a single output token on the cheapest current
 *    model: is a request paid for. The API answers 402 `billing_error` for
 *    a billing problem, 429 with `enforced_spend_limit_reached` at the
 *    monthly spend cap, and 400 with a message that starts "You have reached
 *    your specified" at a spend limit the organization set itself.
 *
 * The second request costs about ten input tokens and one output token:
 * roughly a millionth of a dollar. The result is "there is credit" or
 * "there is none", never an amount; when the probe is rate limited or the
 * API is overloaded the credit is reported as unknown, not guessed.
 *
 * The key passed in is used for these two requests and nothing else: it is
 * never stored, logged or put in a result or an error by this module.
 */

/** The cheapest current model, for the one-token probe. */
export const ANTHROPIC_PROBE_MODEL = 'claude-haiku-5-5'

/** The documented start of the 400 an organization gets at a spend limit it set itself. */
const OWN_SPEND_LIMIT_PREFIX = 'You have reached your specified'

export interface KeyCheckOptions {
  readonly fetch?: FetchLike
  readonly baseUrl?: string
}

export async function checkAnthropicKey(key: string, signal: AbortSignal, options: KeyCheckOptions = {}): Promise<KeyCheck> {
  const client = createClient(resolveAnthropicOptions({ getKey: () => Promise.resolve(key), ...options }), key.trim())
  try {
    await client.models.list({ limit: 1 }, { signal })
  } catch (error) {
    if (signal.aborted) throw error
    return verdictFor(error)
  }
  return { status: 'valid', label: null, credit: await probeCredit(client, signal) }
}

function verdictFor(error: unknown): KeyCheck {
  if (isBrowserBlocked(error)) return { status: 'blocked', reason: 'This Anthropic organization does not allow requests from a browser.' }
  if (error instanceof Anthropic.AuthenticationError) return { status: 'invalid' }
  if (error instanceof Anthropic.APIConnectionError) return { status: 'offline' }
  if (error instanceof Anthropic.APIError && error.status !== undefined) return { status: 'unverified', httpStatus: error.status }
  return { status: 'offline' }
}

async function probeCredit(client: Anthropic, signal: AbortSignal): Promise<KeyCredit> {
  try {
    await client.messages.create({ model: ANTHROPIC_PROBE_MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] }, { signal })
    return { kind: 'available' }
  } catch (error) {
    if (signal.aborted) throw error
    if (isOutOfCredit(error)) return { kind: 'exhausted' }
    if (error instanceof Anthropic.BadRequestError && (error.apiMessage ?? '').startsWith(OWN_SPEND_LIMIT_PREFIX)) return { kind: 'exhausted' }
    return { kind: 'unknown' }
  }
}

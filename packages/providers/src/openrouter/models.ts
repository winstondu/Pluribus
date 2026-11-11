import type { ModelMessage } from '@committee/core/ports'
import { isRecord, readKey, type ResolvedOptions } from './http'

/**
 * Model context limits from `GET /api/v1/models`, and the token estimate
 * behind `countTokens` (Q67, Q82).
 */

export interface ModelCatalog {
  /** The model's context length in tokens, or null when it is not known or the catalog cannot be read. Never rejects. */
  contextLimit(model: string): Promise<number | null>
}

/**
 * Reads the catalog once and caches it for the provider's lifetime. A failed
 * read is not cached: the next call tries again.
 */
export function createModelCatalog(options: ResolvedOptions): ModelCatalog {
  let cached: ReadonlyMap<string, number> | null = null
  let inflight: Promise<ReadonlyMap<string, number> | null> | null = null

  async function load(): Promise<ReadonlyMap<string, number> | null> {
    try {
      const key = await readKey(options)
      const headers: Record<string, string> = key === null ? {} : { Authorization: `Bearer ${key}` }
      const response = await options.fetch(`${options.baseUrl}/api/v1/models`, { method: 'GET', headers })
      if (!response.ok) return null
      return parseModelList(await response.json())
    } catch {
      return null
    }
  }

  return {
    async contextLimit(model) {
      if (cached === null) {
        inflight ??= load().finally(() => {
          inflight = null
        })
        const loaded = await inflight
        if (loaded !== null) cached = loaded
      }
      return cached?.get(model) ?? null
    },
  }
}

/** `{ data: [{ id, context_length, top_provider: { context_length } }] }` → id → limit. */
export function parseModelList(body: unknown): ReadonlyMap<string, number> | null {
  if (!isRecord(body) || !Array.isArray(body['data'])) return null
  const limits = new Map<string, number>()
  for (const entry of body['data']) {
    if (!isRecord(entry) || typeof entry['id'] !== 'string') continue
    const top = entry['top_provider']
    const topLimit = isRecord(top) ? positive(top['context_length']) : null
    const limit = positive(entry['context_length']) ?? topLimit
    if (limit !== null) limits.set(entry['id'], limit)
  }
  return limits
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/** Tokens added per message for role and separators, and once per request for the reply primer. */
const PER_MESSAGE_OVERHEAD = 4
const PER_REQUEST_OVERHEAD = 3

/**
 * Estimates input tokens without a tokenizer. ASCII text is counted at one
 * token per 3.5 characters (real tokenizers average about 4 for English);
 * CJK, kana and hangul at one token per character; other scripts (Cyrillic,
 * Greek, accented Latin, …) at one token per 2.5 characters. The estimate
 * leans a little high so the near-limit warning comes early. It is reported
 * with `exact: false`, and core never fails a run on an estimate: a request
 * that really is over the limit is caught by the provider's
 * `context_length_exceeded`, which is non-retryable.
 */
export function estimateTokens(messages: readonly ModelMessage[]): number {
  let total = PER_REQUEST_OVERHEAD
  for (const message of messages) {
    total += PER_MESSAGE_OVERHEAD + estimateTextTokens(message.content)
  }
  return total
}

export function estimateTextTokens(text: string): number {
  let ascii = 0
  let wide = 0
  let other = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x80) ascii += 1
    else if (isWide(code)) wide += 1
    else other += 1
  }
  return Math.ceil(ascii / 3.5 + other / 2.5) + wide
}

/** CJK ideographs and punctuation, kana, hangul, fullwidth forms, and the supplementary ideograph planes. */
function isWide(code: number): boolean {
  return (code >= 0x2e80 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef) || code >= 0x20000
}

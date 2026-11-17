import { createClient, readAnthropicKey, type ResolvedAnthropicOptions } from './client'

/**
 * Model limits from the Claude API's `GET /v1/models`: the context window
 * (`max_input_tokens`) and the output cap (`max_tokens`) of each model the
 * key can use.
 */

export interface AnthropicModelLimits {
  /** The context window in tokens, or null when the API does not say. */
  readonly contextLimit: number | null
  /** The largest `max_tokens` the model accepts, or null when the API does not say. */
  readonly maxOutputTokens: number | null
}

export interface AnthropicModelCatalog {
  /** The model's limits, or null when it is not known or the catalog cannot be read. Never rejects. */
  limits(model: string): Promise<AnthropicModelLimits | null>
}

/**
 * Reads the catalog once and caches it for the provider's lifetime. A failed
 * read (no key yet, a network error) is not cached: the next call tries again.
 */
export function createAnthropicModelCatalog(options: ResolvedAnthropicOptions): AnthropicModelCatalog {
  let cached: ReadonlyMap<string, AnthropicModelLimits> | null = null
  let inflight: Promise<ReadonlyMap<string, AnthropicModelLimits> | null> | null = null

  async function load(): Promise<ReadonlyMap<string, AnthropicModelLimits> | null> {
    try {
      const key = await readAnthropicKey(options)
      if (key === null) return null
      const limits = new Map<string, AnthropicModelLimits>()
      for await (const model of createClient(options, key).models.list({ limit: 1000 })) {
        limits.set(model.id, { contextLimit: positive(model.max_input_tokens), maxOutputTokens: positive(model.max_tokens) })
      }
      return limits
    } catch {
      return null
    }
  }

  return {
    async limits(model) {
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

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

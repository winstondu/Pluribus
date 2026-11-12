import type { ModelProviderName } from '@committee/protocol'
import type { Decomposer, ModelProvider, Preparer } from '@committee/core/ports'

/**
 * The per-role provider choice, carried out. Core passes each request's
 * provider through from the settings (`request.provider`) and never
 * branches on it; these three wrap one adapter per provider and hand each
 * request to the adapter it names. So one conversation can answer through
 * the Claude API and decompose through OpenRouter.
 *
 * A request without a provider goes to OpenRouter, as before providers were
 * a setting.
 */

export type ByProvider<T> = { readonly [P in ModelProviderName]: T }

function pick<T>(adapters: ByProvider<T>, provider: ModelProviderName | undefined): T {
  return adapters[provider ?? 'openrouter']
}

export function createRoutedModelProvider(adapters: ByProvider<ModelProvider>): ModelProvider {
  return {
    stream: (request, signal) => pick(adapters, request.provider).stream(request, signal),
    countTokens: (request) => pick(adapters, request.provider).countTokens(request),
  }
}

export function createRoutedDecomposer(adapters: ByProvider<Decomposer>): Decomposer {
  return {
    decompose: (request, signal) => pick(adapters, request.provider).decompose(request, signal),
    async label(request, signal) {
      const adapter = pick(adapters, request.provider)
      if (!adapter.label) return { ok: false, error: { code: 'invalid-request', class: 'non-retryable', message: 'This provider does not label requests', httpStatus: null, retryAfterMs: null } }
      return adapter.label(request, signal)
    },
  }
}

export function createRoutedPreparer(adapters: ByProvider<Preparer>): Preparer {
  return { prepare: (request, signal) => pick(adapters, request.provider).prepare(request, signal) }
}

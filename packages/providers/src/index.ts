/**
 * OpenRouter and Claude API implementations of core's provider ports, and
 * the wrappers that hand each request to the provider its role is set to. Every factory takes
 * `{ getKey, fetch? }`: `getKey` is the only way a provider sees the key, and
 * `fetch` is injectable so tests never touch the network. Only web-platform
 * APIs are used, so all three run in a browser Web Worker and in Node.
 */
export { createOpenRouterModelProvider } from './openrouter/model-provider'
export { createOpenRouterPreparer } from './openrouter/preparer'
export { createOpenRouterDecisionProvider } from './openrouter/decision-provider'
export { createOpenRouterDecomposer } from './openrouter/decomposer'
export { OPENROUTER_BASE_URL } from './openrouter/http'
export type { FetchLike, OpenRouterOptions } from './openrouter/http'
export { checkOpenRouterKey } from './openrouter/key-check'

/** The Claude API, with the user's own Anthropic key. Decisions have no Claude API form. */
export { createAnthropicModelProvider } from './anthropic/model-provider'
export { createAnthropicDecomposer } from './anthropic/decomposer'
export { createAnthropicPreparer } from './anthropic/preparer'
export { checkAnthropicKey, ANTHROPIC_PROBE_MODEL } from './anthropic/key-check'
export { ANTHROPIC_BASE_URL } from './anthropic/client'
export type { AnthropicOptions } from './anthropic/client'

export { createRoutedDecomposer, createRoutedModelProvider, createRoutedPreparer, type ByProvider } from './routed'

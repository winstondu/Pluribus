/**
 * OpenRouter implementations of core's provider ports. Every factory takes
 * `{ getKey, fetch? }`: `getKey` is the only way a provider sees the key, and
 * `fetch` is injectable so tests never touch the network. Only web-platform
 * APIs are used, so all three run in a browser Web Worker and in Node.
 */
export { createOpenRouterModelProvider } from './openrouter/model-provider'
export { createOpenRouterDecisionProvider } from './openrouter/decision-provider'
export { createOpenRouterDecomposer } from './openrouter/decomposer'
export { OPENROUTER_BASE_URL } from './openrouter/http'
export type { FetchLike, OpenRouterOptions } from './openrouter/http'
export { checkOpenRouterKey } from './openrouter/key-check'

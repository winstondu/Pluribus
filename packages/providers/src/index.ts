/**
 * OpenRouter implementations of core's provider ports. Every factory takes
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

/**
 * The scripted fakes (fake clock, scripted model provider, decision provider,
 * decomposer and router, memory stores), so a consumer of the providers can
 * swap a live provider for a scripted one without a second import. Never
 * used by the app itself.
 */
export * from '@committee/core/testing'

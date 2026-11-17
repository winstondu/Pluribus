import type { ContextSummariser, ContextSummaryProvider } from '../ports'

/**
 * The context summary provider and summariser the backend uses until real
 * ones exist (docs/build/context-summaries.md).
 */

/**
 * Returns the node's context chain as the engine assembles it, unchanged,
 * marked `full-chain`. No model call and no storage: with it, turning
 * `useSummaryIfAvailable` on changes nothing a strategy asks.
 */
export const fullChainContextProvider: ContextSummaryProvider = {
  contextFor: (request) => ({ kind: 'full-chain', nodeId: request.nodeId, chain: request.chain() }),
}

/** Produces no summary. It makes `backgroundSummaries` a real setting end to end before summarisation exists. */
export const noContextSummariser: ContextSummariser = {
  consider: async () => ({ kind: 'skipped', reason: 'Summaries are not generated yet.' }),
}

import type { ConsumedMessage, ConversationId, DirectiveId, NodeId } from '@pluribus/protocol'

/**
 * Context summaries for decisions (11 · "Context summaries for decisions";
 * build record in docs/build/context-summaries.md).
 *
 * The decision model can be shown, for a genealogy node, a stored summary
 * of the node's context ancestry up to an **anchor** node, followed by the
 * content specific to the node: everything the node's context holds after
 * the anchor. A child of a summarised node is shown the same summary and
 * its own content, so one summary links a whole line of work below its
 * anchor.
 *
 * This concerns decisions only. What a run consumes is assembled
 * mechanically from the genealogy and recorded exactly (04 · "Context for
 * a run", invariant 2); nothing here reads or writes that record.
 *
 * Core stays deterministic: a provider is asked synchronously and answers
 * from what it was given and what it holds. Producing summaries is a
 * separate port (`ContextSummariser`).
 */

/** The context a run that continues from a node reads before its own request, as the engine assembles it. */
export interface ContextChain {
  readonly nodeId: NodeId
  /** In model-input order, root first: exactly the messages of the engine's context assembly. */
  readonly messages: readonly ConsumedMessage[]
  /** Every genealogy node whose content is in `messages`, root first. */
  readonly nodeIds: readonly NodeId[]
}

/** Where a summary came from, for the run inspector. */
export interface ContextSummaryProvenance {
  readonly summaryId: string
  /** The model that wrote it. */
  readonly model: string
  /** The genealogy nodes whose content the summary replaces, root first, the anchor last. */
  readonly coveredNodeIds: readonly NodeId[]
  /** The sequence number of the event that recorded it. */
  readonly recordedSeq: number
}

export interface ContextSummary {
  /** The node whose context the summary stands for: everything up to and including it. */
  readonly anchorNodeId: NodeId
  readonly text: string
  /** Its size in tokens, as counted when it was recorded. */
  readonly tokens: number
  readonly provenance: ContextSummaryProvenance
}

/** What the decision model is shown for one node. The kind says which it saw. */
export type DecisionContext =
  /** The node's whole context chain, unchanged. */
  | { readonly kind: 'full-chain'; readonly nodeId: NodeId; readonly chain: ContextChain }
  /**
   * A summary of the context up to `summary.anchorNodeId`, then the content
   * specific to the node: the messages of its chain after the anchor. Empty
   * when the node is the anchor itself.
   */
  | { readonly kind: 'summary'; readonly nodeId: NodeId; readonly summary: ContextSummary; readonly own: readonly ConsumedMessage[] }

export interface DecisionContextRequest {
  readonly nodeId: NodeId
  /** The node's context chain from the engine's own context assembly. Computed when called. */
  chain(): ContextChain
}

export interface ContextSummaryProvider {
  /**
   * The context to show the decision model for a node, or null when the
   * provider has nothing for it. Synchronous and free of I/O; never throws.
   */
  contextFor(request: DecisionContextRequest): DecisionContext | null
}

/** Why the backend offers a node to the summariser. */
export type SummariseReason = 'run-completed' | 'join-back-formed' | 'idle'

export interface SummariseRequest {
  readonly conversationId: ConversationId
  /** The node that would be the anchor. */
  readonly nodeId: NodeId
  /** The directive whose work is on the node, when there is one. */
  readonly directiveId: DirectiveId | null
  readonly reason: SummariseReason
  /** The node's context chain from the engine's own context assembly. */
  chain(): ContextChain
}

/** What a summariser hands back to be recorded. The backend, not the summariser, writes the event. */
export interface ContextSummaryDraft {
  readonly anchorNodeId: NodeId
  readonly text: string
  readonly tokens: number
  readonly model: string
  readonly coveredNodeIds: readonly NodeId[]
}

export type SummariseOutcome =
  | { readonly kind: 'summarised'; readonly draft: ContextSummaryDraft }
  /** Nothing to record: the policy passed the node over, or the summariser does not produce summaries. */
  | { readonly kind: 'skipped'; readonly reason: string }

/**
 * Decides what to summarise and writes the summary. Offered finished work
 * in the background while `settings.routing.backgroundSummaries` is on.
 * Never rejects. It may take as long as it likes: nothing waits for it.
 */
export interface ContextSummariser {
  consider(request: SummariseRequest): Promise<SummariseOutcome>
}

import type {
  AttemptId,
  ChainId,
  ConversationId,
  DirectiveId,
  ElicitationId,
  FragmentId,
  JoinBackId,
  MessageId,
  NodeId,
  OperationId,
  QueueItemId,
  ResponseId,
  SectionId,
  SiblingGroupId,
} from './ids'
import type { ChainKind, NodeReason, ResponseReason } from './events'
import type {
  AttemptOrigin,
  AttemptResultStatus,
  AttemptState,
  ConsumedContext,
  DirectiveKind,
  DirectiveState,
  JoinBackMember,
  ModelRole,
  PauseCause,
  PauseReason,
  ReadinessRecord,
  PrerequisiteRef,
  ModelProviderName,
  ProviderError,
  RedoOption,
  Requirement,
  RoutingDecision,
  SectionState,
  ShownAnswerForm,
  SupersededInput,
  TextSpan,
  UnitRoutingDecision,
  WholeRequestBarrier,
} from './model'
import type { ModelRoleChoice } from './model-choices'
import type { KeyStatus, Settings } from './settings'

/**
 * The projections the client reads (10 · "What the client reads", Q58). All
 * are derived from the event log by the backend, kept current by the stream,
 * and available in full as a snapshot.
 *
 * The client never decides placement, ordering, dependencies or context. It
 * renders these structures as they are. Anything a view needs that would
 * otherwise require the client to reason about the domain (which controls to
 * offer, what a queue item says, which messages a Focus highlights) is
 * already computed here.
 *
 * The three relationships stay in three structures (invariant 1):
 * - display placement: {@link TranscriptProjection} (`order`, `sectionIds`)
 * - context ancestry: {@link GenealogyProjection} (`parents`)
 * - result dependency: {@link OperationGraphProjection} (`dependsOn`)
 * None is derived from another, and no view may read one as another.
 */

/** A map from an ID to a record. Look-ups may miss, so indexing yields `T | undefined`. */
export type ById<T> = { readonly [id: string]: T }

// ═══════════════════════════ transcript ═══════════════════════════

/** One entry of the transcript: a user bubble or a reply. */
export type TranscriptItemRef =
  | { readonly kind: 'message'; readonly id: MessageId }
  | { readonly kind: 'response'; readonly id: ResponseId }

/**
 * Display placement, and everything shown in the chat.
 *
 * `order` is the single authority for where things appear. It is built by
 * one rule: items whose position is fixed, in the order they were fixed,
 * followed by the responding bubbles still pending, in request order. A user
 * message is fixed when submitted (Q13); a response when its first answer
 * text or failure notice appears (Q14, Q51). Fixed items never move
 * (invariant 6); pending bubbles are pushed down as replies take their
 * places (Q12).
 *
 * A message's initial response is in `order` from the moment the message is
 * submitted, before routing has settled: a responding bubble with no
 * sections whose `routing` field carries the status. That is where pending
 * status lives; nothing is ever drawn on the user message for it (P7).
 */
export interface TranscriptProjection {
  readonly order: readonly TranscriptItemRef[]
  readonly messages: ById<MessageView>
  readonly responses: ById<ResponseView>
  readonly sections: ById<SectionView>
  readonly attempts: ById<AttemptView>
  /** Chain association for margin rails and Focus, always available (Q87). */
  readonly chains: ById<ChainAssociation>
  /** Sets of split messages, keyed by the original message's ID (Q53). */
  readonly splits: ById<SplitView>
}

/** Where routing stands for a message. */
export type MessageRoutingState =
  /** The pipeline is working. The message is already in the transcript (Q16). */
  | 'routing'
  /** Not acted on until the user answers a target-ambiguity elicitation (Q10). */
  | 'awaiting-target'
  | 'routed'
  /** Routing failed; the provisional response says why and `actions.retry` is offered. */
  | 'failed'

/**
 * The status of a responding bubble whose message is not routed yet. It is
 * status text, not answer text: it fixes nothing, and the bubble stays in
 * the pending tail, a routing failure included.
 */
export interface RoutingStatusView {
  readonly state: Exclude<MessageRoutingState, 'routed'>
  /** Ready-to-show: "Routing…", "Waiting for your answer", or the failure message. */
  readonly text: string
  /** Set when `state` is `failed`. Retry is on the request (`MessageView.actions.retry`). */
  readonly failure: ProviderError | null
}

export interface MessageView {
  readonly id: MessageId
  /** `split`: one of the separate user messages shown for a sequential composite (Q53). */
  readonly kind: 'original' | 'split'
  /** For `original`, exactly as typed (Q3). For `split`, the fragment's source text. */
  readonly text: string
  readonly submittedAt: number
  /**
   * Where routing stands, for enabling controls. Never rendered as a badge
   * or status on the user bubble (Q81, P7): what the user sees of it is the
   * `routing` field of the message's provisional response.
   */
  readonly routing: MessageRoutingState
  /**
   * Handling chains of this message's directives, in fragment order without
   * repeats: the margin rail. More than one means a segmented mark with hard
   * boundaries, never a blend that reads as a third chain color (09 §2).
   * Empty until routed.
   *
   * A message that created no directive still has a rail: for a revision,
   * the chains of the directives it revised; for the answer to a
   * clarification, the chains of the directives it released. A message that
   * did both kinds of thing lists both, without repeats.
   */
  readonly chainIds: readonly ChainId[]
  /** The reply target shown on the bubble. Null for a message that addresses no section. */
  readonly replyingTo: ReplyingToView | null
  /** Set on a split message: its set and its place in it. */
  readonly split: { readonly originalMessageId: MessageId; readonly index: number; readonly count: number } | null
  /**
   * How an independent composite was decomposed, for the Compare inspector
   * (behind the `compareIndependent` debug toggle, Q94). Null for atomic
   * messages and for split messages, whose Compare data is on their
   * {@link SplitView}.
   */
  readonly decomposition: DecompositionView | null
  /** Replies to this message, initial response first. Positions are in `order`, not here. */
  readonly responseIds: readonly ResponseId[]
  /**
   * Request-level controls. There is never a status badge on a user message
   * and no up-arrow to pending work (Q81, P7): these are controls only.
   */
  readonly actions: {
    /** Stop all unfinished work for this request (Q22). */
    readonly stop: boolean
    /** Retry the request's unfinished sections (Q50), or route it again after a routing failure. */
    readonly retry: boolean
  }
}

export interface ReplyingToView {
  readonly targets: readonly { readonly sectionId: SectionId; readonly title: string }[]
  readonly mode: 'explicit' | 'inferred' | 'elicited'
  /** Fixed wording "Replying to the revised version" when a target on a superseded section was resolved to its replacement (Q43, T3). Null otherwise. */
  readonly note: string | null
}

/** The split messages of one sequential composite (Q53). */
export interface SplitView {
  readonly originalMessageId: MessageId
  /** The split messages in display order (topological; ties in original textual order). */
  readonly messageIds: readonly MessageId[]
  /** Undo split is offered only until any split message shows answer text or receives a reply (Q85, D4). */
  readonly undoAvailable: boolean
  /** Opened by the "split from one message" link. Always available (Q87, Q94). */
  readonly decomposition: DecompositionView
}

/** What the Compare inspector shows (09 §3): the exact original beside each fragment's rewrite and inherited requirements. */
export interface DecompositionView {
  readonly originalMessageId: MessageId
  /** The untouched source message. */
  readonly originalText: string
  readonly presentation: 'reply-group' | 'split-messages'
  readonly fragments: readonly FragmentView[]
  readonly barrier: WholeRequestBarrier | null
  /** The decomposition model that wrote the rewrites (never the decision model, invariant 9). */
  readonly model: string
}

export interface FragmentView {
  readonly fragmentId: FragmentId
  readonly index: number
  /** `revision`: the fragment corrects earlier work and created no directive; `directiveId` is the first directive it revised. */
  readonly kind: 'work' | 'revision'
  readonly label: string
  /** Exact spans in `originalText`. */
  readonly sourceSpans: readonly TextSpan[]
  /** The rewritten atomic instruction. */
  readonly rewrittenText: string
  /** Requirements this fragment carries, with provenance spans into the original (Q4, Q17). */
  readonly requirements: readonly Requirement[]
  readonly directiveId: DirectiveId
  /** Handling chain, for the fragment's color. */
  readonly chainId: ChainId
  /** The fragment's current answer section, if one is open. */
  readonly sectionId: SectionId | null
  /** Its split message, when the message was split. */
  readonly messageId: MessageId | null
}

/** Section tallies for a reply group header. */
export interface SectionCounts {
  readonly done: number
  readonly failed: number
  readonly stopped: number
  readonly interrupted: number
  readonly cancelled: number
  /** Pending or streaming. */
  readonly inProgress: number
}

/**
 * One reply at one transcript position: a single section for an atomic
 * request, or a reply group with a section per fragment (Q18).
 *
 * There is no overall failed or cancelled state here, and none may be
 * derived for display (invariant 5, Q50).
 */
export interface ResponseView {
  readonly id: ResponseId
  /** The user bubble it answers. */
  readonly messageId: MessageId
  /** Anything but `answer` is an additional response (Q23, Q38). */
  readonly reason: ResponseReason
  /** True for a reply group. */
  readonly grouped: boolean
  /** `pending`: a responding bubble in the pending tail. `fixed`: placed for good. */
  readonly placement: 'pending' | 'fixed'
  /**
   * Set while the response is the provisional bubble of a message that is
   * not routed yet; `sectionIds` is then empty and `placement` is
   * `pending`. Null once the plan has opened sections in it. A provisional
   * response whose plan opens none is removed from the projection.
   */
  readonly routing: RoutingStatusView | null
  /**
   * Sections in display order. Superseded sections dropped without a trace
   * are absent. Inside a group, placed sections come first in the order
   * they were placed, then pending ones; an explicit output order overrides
   * that (Q18, P8).
   */
  readonly sectionIds: readonly SectionId[]
  /** Group header. Null for an ungrouped response. */
  readonly header: {
    readonly counts: SectionCounts
    /** Compact count such as "2 done · 1 failed · 1 stopped", shown while results are mixed (Q50). Null otherwise. */
    readonly countText: string | null
  } | null
}

/** The status line of a section that is not showing answer text. Status text is not answer text and fixes nothing (03). */
export type SectionStatusKind =
  /** An attempt is in flight with no text yet. */
  | 'responding'
  /** "Retrying…" (Q47). */
  | 'retrying'
  /** "Waiting for capacity": a provider rate limit, never a dependency wait (Q47, Q60). */
  | 'waiting-for-capacity'
  /** Dependency-queued: names what it waits for. */
  | 'waiting-for-results'
  /** Paused: for the answer to a clarification question, or on a prerequisite that did not finish. `SectionView.pauseReason` says which. */
  | 'paused'
  /** "Waiting for a free slot": held only by the concurrency limit. */
  | 'waiting-for-slot'
  /** Held by a choice with default. */
  | 'awaiting-answer'

export interface SectionStatus {
  readonly kind: SectionStatusKind
  /** Ready-to-show text. */
  readonly text: string
}

export type SectionNote =
  /** Quiet note on completed work whose input was replaced, with Regenerate (Q40). Text like "Based on superseded neighborhood recommendations". */
  | { readonly kind: 'superseded-input'; readonly text: string; readonly inputs: readonly SupersededInput[] }
  /**
   * Small note at the bottom of redone work, like "Redid itinerary by
   * default" (Q45, Q95). Added when `elicitation-defaulted` arrives, to the
   * work that elicitation redid: sections that replaced one superseded for
   * it, and sections of directives it held.
   */
  | { readonly kind: 'redone-by-default'; readonly text: string; readonly elicitationId: ElicitationId }
  /** The chain is near the model's context limit (Q67, Q82). */
  | {
      readonly kind: 'context-near-limit'
      readonly text: string
      readonly inputTokens: number
      readonly tokenLimit: number
    }

/**
 * One answer section: the slot a directive's output occupies. Retries stream
 * into the same section (Q51, Q83); a replacement is always a new section in
 * a new response (P11).
 */
export interface SectionView {
  readonly id: SectionId
  readonly directiveId: DirectiveId
  readonly responseId: ResponseId
  readonly messageId: MessageId
  readonly kind: DirectiveKind
  /** Heading inside a reply group, and the name used when this section is a reply target. */
  readonly title: string
  /** One of the states a section can show (10). */
  readonly state: SectionState
  /** The directive's state behind it, for views that need the finer distinction. */
  readonly directiveState: DirectiveState
  /**
   * Set while the section's work is paused (glossary · "Paused"), with what
   * it waits for. For `awaiting-input` the section's `state` is `paused`,
   * its text is partial, and `questionSectionId` is the clarification
   * question to answer; the only way on is to answer it (Q98, Q106). For
   * `dependency-recovery` the recovery choice is on the queue item.
   */
  readonly pause: PauseView | null
  /** Whether its position inside its response is fixed. */
  readonly placement: 'pending' | 'fixed'
  /**
   * Status line. Set while `state` is `pending`, and also while a retry is
   * pending beneath earlier partial text. Null otherwise.
   */
  readonly status: SectionStatus | null
  /** Handling chain of the section's current work: its margin rail (09 §2). */
  readonly chainId: ChainId
  /**
   * Attempts shown in this bubble, oldest first. The last is the current
   * one. Earlier ones are failed, stopped or interrupted partial text kept
   * collapsed with their marks while a retry streams beneath (Q83, Q96).
   * Attempts that ended with no visible output are not listed.
   */
  readonly attemptIds: readonly AttemptId[]
  /** Failure of the current attempt when `state` is `failed`, for the failure notice. */
  readonly failure: ProviderError | null
  /**
   * Set when `state` is `superseded`. `markText` is "Superseded — revised
   * below" for partial text and "Superseded" for finished work; the link
   * goes to the replacement (Q38).
   */
  readonly superseded: {
    readonly markText: string
    readonly replacementSectionId: SectionId | null
    readonly replacementResponseId: ResponseId | null
    /**
     * Text of the link to the replacement, by what superseded the section:
     * "See the revision" for a revision (of this work or of an input it was
     * running on), "See the regenerated version" for Regenerate, "See the
     * redone version" for a redo, "See the restarted version" after Undo
     * split. Regenerate is never called a revision (glossary). Always set by
     * the backend; optional only so hand-written fixtures may leave it out
     * (the client then falls back to "See the revision").
     */
    readonly linkText?: string
  } | null
  /** The section this one replaces, for the back link. */
  readonly replacesSectionId: SectionId | null
  readonly notes: readonly SectionNote[]
  /** For a clarification question: the elicitation it asks. Replying to this section answers it (Q98). */
  readonly asksElicitationId: ElicitationId | null
  /** The operation-graph node for this section's work, so each view can link to the other (Q81). */
  readonly operationId: OperationId
  /**
   * Which controls to offer. The client shows exactly these.
   * - `reply`: "Reply to this". Offered on superseded sections too while
   *   they have a current version: the reply targets the replacement and
   *   says "Replying to the revised version" (Q43, T3; 06 · "The user
   *   replies to the superseded A afterwards"). False for a section with no
   *   current version (Undo split) and for a clarification question that is
   *   no longer open.
   * - `stop`: the section's work has started and has not settled: running,
   *   between automatic retries, or waiting for capacity (10: "each
   *   running section"). Work that has not started is stopped through its
   *   request, which cancels it (Q22, Q91).
   * - `retry`: failed, stopped, interrupted or cancelled, and not retrying on its own.
   * - `regenerate`: carries a superseded-input note (Q40).
   */
  readonly actions: {
    readonly reply: boolean
    readonly stop: boolean
    readonly retry: boolean
    readonly regenerate: boolean
  }
}

/** Why work is paused and what resumes it. */
export type PauseView =
  | {
      readonly reason: 'awaiting-input'
      readonly elicitationId: ElicitationId
      /** The clarification question's section, once it is open. */
      readonly questionSectionId: SectionId | null
    }
  | { readonly reason: 'dependency-recovery'; readonly elicitationId: ElicitationId; readonly cause: PauseCause }

/** One attempt as shown inside its section's bubble. */
export interface AttemptView {
  readonly id: AttemptId
  readonly sectionId: SectionId
  readonly directiveId: DirectiveId
  /** 1-based version across the directive's retries and revisions. */
  readonly number: number
  readonly origin: AttemptOrigin
  readonly state: AttemptState
  readonly resultStatus: AttemptResultStatus
  /** Answer text so far. Never includes status text. */
  readonly text: string
  /**
   * Label kept on text that did not complete: "Failed", "Stopped",
   * "Interrupted", "Superseded — revised below", or "Paused · partial" for
   * a run that stopped to ask (Q22, Q38, Q47, Q52, Q106).
   * Null for running, streaming and completed attempts.
   */
  readonly markText: string | null
  /** True when the text is shown collapsed: superseded partial text, or earlier partial text above a retry. */
  readonly collapsed: boolean
  /** The chain and node this attempt ran on. A retry after its group closed runs on the base chain (Q92). */
  readonly chainId: ChainId
  readonly nodeId: NodeId
  readonly model: string
  readonly startedAt: number
  readonly endedAt: number | null
  readonly failure: ProviderError | null
}

/**
 * What Focus highlights for one chain, as transcript items. Inheritance-aware
 * (09 §2): `own` is what the chain handled; `inherited` is every message and
 * section in the exact ancestry its runs consumed, taken from the attempts'
 * consumed-context records. Inherited items keep their own chain's color.
 * Items added to a source chain later, which this chain never consumed, are
 * in neither list even though they share a chain ID with consumed ones.
 */
export interface FocusSet {
  readonly own: { readonly messageIds: readonly MessageId[]; readonly sectionIds: readonly SectionId[] }
  readonly inherited: { readonly messageIds: readonly MessageId[]; readonly sectionIds: readonly SectionId[] }
}

/** A chain as the transcript needs it: its color and its Focus set. */
export interface ChainAssociation {
  readonly id: ChainId
  readonly kind: ChainKind
  /** Stable palette slot, assigned by the backend when the chain is created (01 · "Chain colors"). */
  readonly colorIndex: number
  readonly label: string
  readonly focus: FocusSet
}

// ═══════════════════════════ queue ═══════════════════════════

/** What a queue item waits for, ready to name. */
export interface WaitTargetView {
  readonly ref: PrerequisiteRef
  /** "neighborhoods", or "neighborhoods + activities" for a whole sibling group, including members admitted before it closes. */
  readonly label: string
  /** The directives still unfinished behind this target. */
  readonly directiveIds: readonly DirectiveId[]
}

/** The recovery choice on a paused queue item (Q48). No default; Pluribus waits. */
export interface RecoveryView {
  readonly elicitationId: ElicitationId
  readonly cause: PauseCause
  /** "Retry activities": send Retry for this section. A successful retry unpauses the request. */
  readonly retry: { readonly label: string; readonly sectionId: SectionId }
  /** "Continue without activities": send Continue without for the item's directive. */
  readonly continueWithout: { readonly label: string }
  /** "Cancel itinerary": send Cancel for the item's directive. */
  readonly cancel: { readonly label: string }
}

/**
 * The entry above the composer for a message that waits on in-flight work
 * (Q16). It clears when processing begins; the message stays in the
 * transcript. Work free to proceed never has one (P6).
 */
export interface QueueItemView {
  readonly id: QueueItemId
  readonly directiveId: DirectiveId
  /** The linked message in the transcript. */
  readonly messageId: MessageId
  /** The waiting part (Q19). */
  readonly label: string
  readonly state: 'waiting' | 'paused'
  /** Revised in place while queued (Q41). */
  readonly revised: boolean
  /** Waits only because of the whole-request barrier (Q19). */
  readonly heldByBarrier: boolean
  readonly waitingFor: readonly WaitTargetView[]
  /**
   * Ready-to-show wording: "Waiting for neighborhoods + activities",
   * "Revised · waiting for neighborhoods + activities" (Q41),
   * "Paused — activities failed" (Q48).
   */
  readonly text: string
  /** Set when paused. */
  readonly recovery: RecoveryView | null
}

/** Where each kind of elicitation appears (Q95). */
export const ELICITATION_SURFACE = {
  'target-ambiguity': 'modal',
  'choice-with-default': 'modal',
  clarification: 'transcript',
  'recovery-choice': 'queue-item',
} as const

export type ElicitationView =
  | {
      readonly kind: 'target-ambiguity'
      readonly id: ElicitationId
      readonly messageId: MessageId
      /** The reply that is not acted on until the user chooses. */
      readonly messageText: string
      /** Existing sections only (Q20). */
      readonly candidates: readonly {
        readonly sectionId: SectionId
        readonly title: string
        /** Opening of the section's answer, to tell candidates apart. */
        readonly excerpt: string
        readonly chainId: ChainId
      }[]
    }
  | {
      readonly kind: 'choice-with-default'
      readonly id: ElicitationId
      readonly revisionMessageId: MessageId
      /** The correction the user made to the shared requirement. */
      readonly correction: string
      readonly options: readonly (RedoOption & {
        /** Current selection: the pre-selection as last edited. Always true when locked. */
        readonly selected: boolean
      })[]
      /** Clock time (ms) at which the selection is carried out. Editable until then (Q45). */
      readonly deadlineAt: number
      /** The configured wait, for a countdown. */
      readonly waitMs: number
    }
  | {
      readonly kind: 'clarification'
      readonly id: ElicitationId
      /** The question, shown in the transcript as an additional response (Q23). */
      readonly questionSectionId: SectionId
      /** Labels of the work that waits for the answer. */
      readonly blockedLabels: readonly string[]
    }
  | {
      readonly kind: 'recovery-choice'
      readonly id: ElicitationId
      /** Shown on this queue item, whose `recovery` holds the choices. */
      readonly queueItemId: QueueItemId
    }

/** Composer queue items and elicitations awaiting an answer. */
export interface QueueProjection {
  /** In submission order of their messages. */
  readonly items: readonly QueueItemView[]
  /** Every unresolved elicitation, oldest first. The client shows modal ones one at a time, oldest first. */
  readonly elicitations: readonly ElicitationView[]
}

// ═══════════════════════════ genealogy ═══════════════════════════

/** A chain in the genealogy. */
export interface ChainView {
  readonly id: ChainId
  readonly kind: ChainKind
  readonly colorIndex: number
  readonly label: string
  /** The chain it forked or branched from. Null for roots and join chains. */
  readonly baseChainId: ChainId | null
  /** Its nodes in order along the chain. */
  readonly nodeIds: readonly NodeId[]
}

/** How a node's work stands, for marking it in the mini-map (history is retained and marked, never removed). */
export type NodeState =
  | 'pending'
  | 'running'
  /** Paused awaiting user input: the answer to its clarification question (Q106). */
  | 'paused'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'interrupted'
  | 'cancelled'
  | 'superseded'

export interface ExchangeNodeView {
  readonly kind: 'exchange'
  readonly id: NodeId
  readonly chainId: ChainId
  readonly directiveId: DirectiveId
  readonly label: string
  /**
   * Context ancestry: the nodes this exchange's run read from. Exact once an
   * attempt has started (`parentsExact`); before that, the placement as far
   * as it can be resolved. For a join chain these are the leaves it was
   * created from and never grow (Q5, Q86).
   */
  readonly parents: readonly NodeId[]
  readonly parentsExact: boolean
  /**
   * Sibling groups the node is planned on that have no join-back yet (the
   * group is still open), so `parents` cannot name a node. The mini-map
   * draws a dashed "planned" edge from the group's oval, never a new root
   * (09 §1). Always set by the backend; optional only for hand-written
   * fixtures.
   */
  readonly plannedGroupIds?: readonly SiblingGroupId[]
  readonly state: NodeState
  readonly reason: NodeReason
  /** The sibling group it is a member of, for the dotted oval (Q8). */
  readonly groupId: SiblingGroupId | null
  /** The node this one stands in for after a revision, and the reverse link (Q39). */
  readonly replacesNodeId: NodeId | null
  readonly replacedByNodeId: NodeId | null
  /** Where it shows in the transcript. */
  readonly messageId: MessageId
  readonly sectionId: SectionId | null
  /** Attempts that ran on this node, oldest first. */
  readonly attemptIds: readonly AttemptId[]
}

export interface JoinBackNodeView {
  readonly kind: 'join-back'
  readonly id: NodeId
  /** The base chain, which the join-back continues (Q78). */
  readonly chainId: ChainId
  readonly joinBackId: JoinBackId
  readonly groupId: SiblingGroupId
  /** Every member node in the record (Q28). */
  readonly parents: readonly NodeId[]
  /** The record, in submission order (C4). Bookkeeping, not a model call (C5). */
  readonly members: readonly (JoinBackMember & { readonly label: string })[]
  /**
   * The group's late-retry tail: nodes of retries started after the group
   * closed, in the order they were requested (Q92). Each is a child of
   * this node. A run that reads this join-back also reads the exchange of
   * every tail node that had completed when it started, after the record.
   */
  readonly lateRetryNodeIds: readonly NodeId[]
  /** Set when a later formation for the same group replaced this one after a member was revised. */
  readonly replacedByNodeId: NodeId | null
}

export type NodeView = ExchangeNodeView | JoinBackNodeView

export interface SiblingGroupView {
  readonly id: SiblingGroupId
  readonly startNodeId: NodeId
  readonly baseChainId: ChainId
  /**
   * Every node that has been a member, in submission order, so the dotted
   * oval keeps showing what ran in parallel (Q8). Never grows after the
   * group closes (C12).
   */
  readonly memberNodeIds: readonly NodeId[]
  /**
   * The subset of `memberNodeIds` withdrawn by Undo split. They stay
   * visible, marked superseded, but do not count for the closing rule, a
   * wait label or the join-back record.
   */
  readonly withdrawnNodeIds: readonly NodeId[]
  /** `dissolved`: every member was withdrawn; no join-back will form. */
  readonly state: 'open' | 'closed' | 'dissolved'
  /** The current join-back node, once formed. */
  readonly joinBackNodeId: NodeId | null
}

/**
 * Context ancestry: the trees of chains (01). Answers "what could this run
 * read?", not "what is running?". Feeds the mini-map; nothing about display
 * order or waiting may be inferred from it.
 */
export interface GenealogyProjection {
  readonly chains: ById<ChainView>
  /** Creation order. */
  readonly chainIds: readonly ChainId[]
  readonly nodes: ById<NodeView>
  /** Creation order. */
  readonly nodeIds: readonly NodeId[]
  readonly groups: ById<SiblingGroupView>
}

// ═══════════════════════════ operation graph ═══════════════════════════

/** Status names follow 08 (Q47–Q54). Waiting on prerequisites is distinct from waiting for capacity (Q60). */
export type OperationStatus =
  | 'waiting-for-results'
  | 'paused'
  | 'awaiting-answer'
  | 'waiting-for-slot'
  | 'waiting-for-capacity'
  | 'retrying'
  | 'running'
  | 'streaming'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'interrupted'
  | 'cancelled'
  | 'superseded'
  /** Join-back only: the group is still open. */
  | 'group-open'
  /** Join-back only: formed. */
  | 'formed'

/**
 * One node of the operation graph: the work for one answer section across
 * its attempts, or one sibling group's join-back.
 */
export interface OperationView {
  readonly id: OperationId
  /** `answer` and `synthesis` are model calls; `join-back` is bookkeeping and takes no concurrency slot. */
  readonly kind: 'answer' | 'synthesis' | 'join-back'
  readonly label: string
  readonly chainId: ChainId
  readonly status: OperationStatus
  /** Ready-to-show status, such as "Waiting for capacity" or "Paused — activities failed". */
  readonly statusText: string
  /** Set while `status` is `paused`: waiting for the user's input, or for a recovery choice. */
  readonly pauseReason: PauseReason | null
  /**
   * Result dependencies: the operations whose results this one needs,
   * whether or not they have finished. Edges of the DAG (invariant 1).
   */
  readonly dependsOn: readonly OperationId[]
  /** The subset of `dependsOn` not yet satisfied (run inspector item 4). */
  readonly waitingFor: readonly OperationId[]
  /**
   * True when the operation waits only because of the whole-request
   * barrier (Q19, D3): it needs nothing unavailable itself. Its status is
   * `waiting-for-results`.
   */
  readonly heldByBarrier: boolean
  /**
   * What the barrier makes it wait for: the unsatisfied prerequisites of
   * the blocked parts of the same request. Drawn as a different kind of
   * edge from `dependsOn`, which stays the true result dependencies; the
   * two are never merged. Empty unless `heldByBarrier`.
   */
  readonly barrierWaitingFor: readonly OperationId[]
  /**
   * Dependency depth among active operations: 0 for one that waits on no
   * active operation. Horizontal position means depth, not elapsed time
   * (09 §4).
   */
  readonly depth: number
  /** Set for `answer` and `synthesis`. */
  readonly directiveId: DirectiveId | null
  readonly sectionId: SectionId | null
  readonly messageId: MessageId | null
  /** The current or last attempt, and how many there have been. */
  readonly attemptId: AttemptId | null
  readonly attemptCount: number
  /** Set for `join-back`. */
  readonly groupId: SiblingGroupId | null
  readonly joinBackId: JoinBackId | null
  /** True once it has left the live graph. It stays inspectable (09 §4). */
  readonly retired: boolean
}

/**
 * Result dependencies and live work (09 §4). Operations leave `active` when
 * they complete, are cancelled or are superseded, and stay in `retired`.
 * Failed, stopped and interrupted operations stay active: they explain
 * paused dependents and can be retried.
 */
export interface OperationGraphProjection {
  readonly operations: ById<OperationView>
  /** Live operations in scheduling order: submission order, then split-message position (Q60). */
  readonly active: readonly OperationId[]
  /** Operations that left the graph, most recent last. */
  readonly retired: readonly OperationId[]
}

// ═══════════════════════════ run inspector ═══════════════════════════

/** One answer section as a decision request showed it, resolved for the run inspector. */
export interface ShownSectionView {
  readonly sectionId: SectionId
  readonly form: ShownAnswerForm
  /** The section's line of the request's state text, exactly as sent. */
  readonly text: string
}

/**
 * What the run inspector shows for one directive and one of its attempts
 * (09 §5). Fetched on demand with a `run` snapshot query, because the exact
 * model input can be large.
 */
export interface RunInspection {
  readonly directiveId: DirectiveId
  /** The attempt inspected. Null when the directive has not started. */
  readonly attemptId: AttemptId | null
  /** Item 1: the original user message and the source fragment. */
  readonly source: {
    readonly originalMessageId: MessageId
    readonly originalText: string
    readonly fragment: {
      readonly fragmentId: FragmentId
      readonly sourceSpans: readonly TextSpan[]
      readonly rewrittenText: string
    } | null
  }
  /** Item 2: the resolved instructions and applicable requirements, with provenance. */
  readonly instruction: string
  readonly requirements: readonly Requirement[]
  /**
   * Item 3: the exact model input, as recorded on `attempt-started`. Never a
   * recomputation: a retry shows rewound context without earlier partial
   * text; a completed run that consumed a since-superseded result still
   * shows the original (Q38, Q39, Q47). Null when not started.
   */
  readonly input: ConsumedContext | null
  /**
   * The directive's typed readiness result as last established, and by what
   * (Q103). Null for a clarification question, and for work in a log
   * written before readiness was recorded.
   */
  readonly readiness: ReadinessRecord | null
  /** Set while the directive is paused: why, which decides how it resumes. */
  readonly pauseReason: PauseReason | null
  /** Item 4: unfinished results it is waiting for. Dependency, shown separately from ancestry. */
  readonly waitingFor: readonly WaitTargetView[]
  /**
   * Also item 4. Set when the directive is held by the whole-request
   * barrier of its message: it waits for results it does not itself need.
   * Kept apart from `waitingFor`, which is its own dependencies only.
   */
  readonly barrier: {
    readonly barrier: WholeRequestBarrier
    /** What the blocked parts of the request still wait for. Empty once the barrier no longer holds. */
    readonly waitingFor: readonly WaitTargetView[]
  } | null
  /** Context ancestry of the attempt, root first: the nodes in `input.nodeIds`, with labels. */
  readonly ancestry: readonly { readonly nodeId: NodeId; readonly chainId: ChainId; readonly label: string }[]
  /**
   * Item 5: the routing decision and its explanation, with confidence where
   * available. Present it as what was decided, without implying it was
   * correct.
   */
  readonly routing: {
    readonly decision: RoutingDecision
    /** The entry of `decision.units` for this directive. */
    readonly unit: UnitRoutingDecision | null
    /**
     * What the decision model was shown for the sections each question is
     * about, by the question's position in `decision.questions`, resolved to
     * the exact text sent (`renderShownLine` over the recorded attempt
     * text). Null for a question that recorded none.
     */
    readonly shown: readonly (readonly ShownSectionView[] | null)[]
    /**
     * The state text of each decision request, exactly as sent, by the
     * request's position in `decision.requests` (`DecisionQuestionRecord.request`
     * names a question's). Empty for a decision recorded before it was kept.
     */
    readonly requests: readonly string[]
  } | null
  /** Item 6: the attempt version and whether its result is current. */
  readonly attempt: {
    readonly number: number
    readonly origin: AttemptOrigin
    readonly state: AttemptState
    readonly resultStatus: AttemptResultStatus
    readonly model: string
    /** The provider the run went to. */
    readonly provider: ModelProviderName
    readonly modelRole: Extract<ModelRole, 'answer' | 'synthesis'>
    readonly chainId: ChainId
    readonly nodeId: NodeId
    readonly startedAt: number
    readonly endedAt: number | null
    readonly failure: ProviderError | null
  } | null
  readonly directiveState: DirectiveState
  /** Every attempt of the directive, oldest first, to move between versions. */
  readonly attempts: readonly {
    readonly attemptId: AttemptId
    readonly number: number
    readonly resultStatus: AttemptResultStatus
    readonly sectionId: SectionId
  }[]
  /** Item 7: the visible answer section the result belongs to. */
  readonly section: {
    readonly sectionId: SectionId
    readonly responseId: ResponseId
    readonly title: string
  } | null
}

// ═══════════════════════════ app state and snapshots ═══════════════════════════

export interface ConversationSummary {
  readonly id: ConversationId
  /** From the first message; "New conversation" until then. */
  readonly title: string
  readonly createdAt: number
}

/** App-wide state: the conversation list, the settings, and whether a key is configured. */
export interface AppSnapshot {
  /** Newest first. */
  readonly conversations: readonly ConversationSummary[]
  readonly settings: Settings
  /** The OpenRouter key. */
  readonly key: KeyStatus
  /** The optional Anthropic key, for roles the user runs on the Claude API. */
  readonly anthropicKey: KeyStatus
  /**
   * What can be chosen for each role's model, as the backend decides it:
   * the providers, the models, and whether this client may change them at
   * all. The settings render this and nothing else.
   */
  readonly modelRoles: readonly ModelRoleChoice[]
}

/** The four projections of one conversation at one point of its log. */
export interface ConversationSnapshot {
  readonly conversationId: ConversationId
  /** Sequence number of the last event reflected. 0 for an empty conversation. */
  readonly throughSeq: number
  readonly transcript: TranscriptProjection
  readonly queue: QueueProjection
  readonly genealogy: GenealogyProjection
  readonly operationGraph: OperationGraphProjection
}

export const EMPTY_TRANSCRIPT: TranscriptProjection = {
  order: [],
  messages: {},
  responses: {},
  sections: {},
  attempts: {},
  chains: {},
  splits: {},
}

export const EMPTY_QUEUE: QueueProjection = { items: [], elicitations: [] }

export const EMPTY_GENEALOGY: GenealogyProjection = {
  chains: {},
  chainIds: [],
  nodes: {},
  nodeIds: [],
  groups: {},
}

export const EMPTY_OPERATION_GRAPH: OperationGraphProjection = { operations: {}, active: [], retired: [] }

export function emptyConversationSnapshot(conversationId: ConversationId): ConversationSnapshot {
  return {
    conversationId,
    throughSeq: 0,
    transcript: EMPTY_TRANSCRIPT,
    queue: EMPTY_QUEUE,
    genealogy: EMPTY_GENEALOGY,
    operationGraph: EMPTY_OPERATION_GRAPH,
  }
}

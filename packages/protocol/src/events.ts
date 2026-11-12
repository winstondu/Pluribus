import type {
  AttemptId,
  ChainId,
  ConversationId,
  DirectiveId,
  ElicitationId,
  EventId,
  FragmentId,
  JoinBackId,
  MessageId,
  NodeId,
  OperationId,
  QueueItemId,
  RequirementId,
  ResponseId,
  SectionId,
  SiblingGroupId,
} from './ids'
import type {
  AttemptOrigin,
  ConsumedContext,
  DirectiveKind,
  ElicitationAnswer,
  ElicitationRecord,
  FragmentRecord,
  JoinBackMember,
  ModelRole,
  PauseCause,
  PointRef,
  PrerequisiteRef,
  ProviderError,
  ReadinessRecord,
  ClarificationReason,
  ReplyRelation,
  Requirement,
  RetryPlan,
  RoutingDecision,
  SiblingMember,
  SplitMessageRecord,
  SupersededInput,
  SupersessionCause,
  TokenUsage,
  WholeRequestBarrier,
} from './model'
import type { Settings } from './settings'

/**
 * Domain events: the append-only source of truth (Q58, ADR-0006). Every view
 * is a projection of these and can be rebuilt from them.
 *
 * Rules for every event:
 * - It states a fact that happened, in the past tense. It is never edited or
 *   deleted (invariant 3); a correction is a later event.
 * - It carries a ULID, the sequence number of its log, a schema version and a
 *   timestamp (Q69). Sequence numbers start at 1 and have no gaps.
 * - It is plain JSON. No `undefined`, no class instances.
 * - It never contains the OpenRouter key (Q64, Q73).
 *
 * There is one log per conversation (Q69, Q70) and one app log for the
 * conversation list and the app-wide settings.
 */

/** Current schema version. Bump when an event's shape changes and add an upcaster; stored events are never rewritten (Q69). */
export const EVENT_SCHEMA_VERSION = 1

/** The app log's identifier. */
export const APP_LOG = 'app'
export type AppLogId = typeof APP_LOG

/** Identifies an event log: a conversation's, or the app's. */
export type LogId = ConversationId | AppLogId

interface Envelope<T extends string, L extends LogId> {
  readonly id: EventId
  /** The log this event belongs to. For conversation events this is the conversation's ID. */
  readonly log: L
  /** Position in its log: 1, 2, 3, … with no gaps (Q69). */
  readonly seq: number
  /** Schema version the event was written with. */
  readonly v: typeof EVENT_SCHEMA_VERSION
  /** Clock time in milliseconds since the epoch. */
  readonly at: number
  readonly type: T
}

type ConversationEnvelope<T extends string> = Envelope<T, ConversationId>
type AppEnvelope<T extends string> = Envelope<T, AppLogId>

// ═══════════════════════ submissions and routing ═══════════════════════

/**
 * The user submitted a message. Always the first event for that message, and
 * the original text is preserved exactly as typed (Q3). The message appears
 * in the transcript at once, in submission order (Q13, Q16).
 */
export interface MessageSubmitted extends ConversationEnvelope<'message-submitted'> {
  readonly messageId: MessageId
  readonly text: string
  /** Sections chosen with "Reply to this". Empty when the reply is untargeted. As sent: redirects are recorded in the routing decision. */
  readonly explicitTargets: readonly SectionId[]
  /**
   * The message's initial response, minted with the message. From this
   * event until routing settles the transcript shows it as a responding
   * bubble in the pending tail with a routing status, so pending status is
   * never on the user message (Q81, P7). `response-opened` with this ID
   * follows when the plan creates work answered in the initial response.
   * It goes away without a trace when no such work exists: the message was
   * split, only revises, or only answers a clarification.
   */
  readonly responseId: ResponseId
}

/**
 * The routing pipeline settled what the message refers to, what kind of work
 * it is, where it goes and what it waits for (run inspector item 5). Recorded
 * before any directive of the message is created, and appended in the same
 * step as every event that carries the plan out, so a log never holds a
 * decided message with half its work.
 *
 * A message has a second `routing-decided` after Undo split, when it was
 * routed again as one atomic request. The latest one is in force.
 */
export interface RoutingDecided extends ConversationEnvelope<'routing-decided'> {
  readonly messageId: MessageId
  readonly decision: RoutingDecision
}

/**
 * Routing could not be completed because the decision provider or the
 * decomposer failed. The message stays in the transcript; its provisional
 * responding bubble shows the failure, and Retry on the request routes it
 * again. Committee does not guess.
 */
export interface RoutingFailed extends ConversationEnvelope<'routing-failed'> {
  readonly messageId: MessageId
  readonly error: ProviderError
}

/**
 * The user used Retry on a request whose routing had failed. The message is
 * routed again and its responding bubble shows the routing status again.
 *
 * A message is waiting for a routing outcome from each of these events until
 * a `routing-decided`, a `routing-failed` or a target-ambiguity
 * `elicitation-raised` for it follows: `message-submitted`,
 * `routing-retried`, `split-undone`, and the `elicitation-answered` that
 * chose its targets. A message found still waiting when the backend starts
 * lost its routing with the executor and is routed again (invariant 8).
 */
export interface RoutingRetried extends ConversationEnvelope<'routing-retried'> {
  readonly messageId: MessageId
}

/**
 * A composite message was decomposed into fragments. Both the source spans
 * and the rewritten text are recorded (Q59).
 */
export interface MessageDecomposed extends ConversationEnvelope<'message-decomposed'> {
  readonly messageId: MessageId
  /**
   * - `reply-group`: independent parts. One user message, one reply group (Q9, Q18).
   * - `split-messages`: a later part needs an earlier part's result, so the
   *   message is shown as separate user messages (Q53).
   */
  readonly presentation: 'reply-group' | 'split-messages'
  /** Every fragment, in original text order: those that became directives and those that revise earlier work. */
  readonly fragments: readonly FragmentRecord[]
  /** Whole-request barrier, when the message relates its outputs to one another (Q19, Q25). */
  readonly barrier: WholeRequestBarrier | null
  /** Explicit output order requested by the user, which overrides first-output ordering inside the group (Q18). */
  readonly outputOrder: readonly FragmentId[] | null
  /**
   * Split messages in display order, which is topological with ties in
   * original textual order (Q53). Empty for `reply-group`. Their message IDs
   * are minted by the engine when it carries the plan out.
   */
  readonly splitMessages: readonly SplitMessageRecord[]
  /** The decomposition model used (Q65). */
  readonly model: string
}

/**
 * Undo split restored one atomic request (Q53, Q85). Only valid while no
 * split message shows answer text or has a reply (D4): no section of the
 * split shows text, and no later message targets, builds on or waits for
 * any of its directives.
 *
 * In the same step: running attempts are ended by `section-superseded`
 * (cause `undo-split`), which drops their status-only bubbles;
 * `siblings-withdrawn` takes the directives out of any sibling group; and
 * the split messages are replaced in the transcript by the original
 * message, at the position it was submitted at.
 *
 * The original message is then routed again with
 * `RoutingInput.forcedComposition: 'atomic'`. The directive that answers it
 * is created by that plan, like any other, after a further `routing-decided`.
 */
export interface SplitUndone extends ConversationEnvelope<'split-undone'> {
  readonly originalMessageId: MessageId
  readonly splitMessageIds: readonly MessageId[]
  /** Directives of the split, now `superseded`. */
  readonly withdrawnDirectiveIds: readonly DirectiveId[]
}

/**
 * The user explicitly made a requirement session-wide (Q17). It applies to
 * every run that starts after this event, on every chain of this
 * conversation, until it is replaced or withdrawn.
 */
export interface SessionRequirementRecorded extends ConversationEnvelope<'session-requirement-recorded'> {
  readonly requirement: Requirement
  /**
   * The session-wide requirement this one takes the place of ("actually,
   * make that 200 words"). The replaced one is no longer given to runs.
   */
  readonly replacesRequirementId: RequirementId | null
}

/** The user took a session-wide requirement back without replacing it. Runs that start later do not receive it. */
export interface SessionRequirementWithdrawn extends ConversationEnvelope<'session-requirement-withdrawn'> {
  readonly requirementId: RequirementId
  /** The message that withdrew it. */
  readonly messageId: MessageId
}

// ═══════════════════════════ genealogy ═══════════════════════════

/**
 * - `root`: a new chain for unrelated work.
 * - `fork`: one member of a sibling group (Q89).
 * - `branch`: work continuing one sibling on its own, at any time (Q30, Q89).
 * - `join`: a join chain (Q5).
 */
export type ChainKind = 'root' | 'fork' | 'branch' | 'join'

/**
 * A chain came into being. Each chain has one stable color (01 · "Chain
 * colors"): `colorIndex` is assigned here and never changes. Work continuing
 * from a join-back creates no chain: it is the base chain continuing (Q78).
 */
export interface ChainCreated extends ConversationEnvelope<'chain-created'> {
  readonly chainId: ChainId
  readonly kind: ChainKind
  /**
   * 0-based ordinal among the conversation's chains, in creation order. The
   * client maps it onto its palette; it never picks a color itself.
   */
  readonly colorIndex: number
  /** The chain this one forked or branched from. Null for `root` and `join`. */
  readonly baseChainId: ChainId | null
  /** Short name for legends and tooltips. */
  readonly label: string
  /**
   * The directive whose label `label` is. Once `directive-labeled` renames
   * that directive, the chain is shown under the new label, so a piece of
   * work has one name everywhere. Absent in logs written before it existed:
   * the chain then keeps `label`.
   */
  readonly labelDirectiveId?: DirectiveId | null
}

/** Why a genealogy node exists. */
export type NodeReason =
  | 'initial'
  /** Replacement exchange for a revised directive (Q35). */
  | 'revision'
  /** Restart of a dependent whose prerequisite was revised while it ran (Q36, R4). */
  | 'prerequisite-revised'
  /**
   * A retry started after its sibling group closed runs as a descendant of
   * the join-back (Q92): a child of the join-back node, on the base chain.
   * These nodes are the group's late-retry tail.
   */
  | 'retry-after-closure'
  | 'regenerate'
  | 'redo'

/**
 * An exchange node was added to the genealogy for a directive. A directive
 * gets a further node whenever its work is placed anew: a revision
 * replacement, a restart after its prerequisite was revised, a retry after
 * its group closed, a regenerate or a redo. Automatic and user retries
 * otherwise reuse the node. A clarification question gets no node: it runs
 * on the node of the first directive it blocks.
 *
 * `plannedParents` is the placement. The exact parents a run consumed are on
 * its `attempt-started` event; the two agree once the attempt has started.
 */
export interface NodeCreated extends ConversationEnvelope<'node-created'> {
  readonly nodeId: NodeId
  readonly chainId: ChainId
  readonly directiveId: DirectiveId
  readonly reason: NodeReason
  /**
   * Empty for a new root. One entry for a continuation. Two or more for the
   * first node of a join chain: each is a `node` reference to a leaf of its
   * chain at this moment (Q86, Q88), or a `sibling-group` point for a line
   * whose forks have not joined back, which resolves to that group's
   * join-back node when the attempt starts. A join chain's inheritance is
   * exact from then on and never grows.
   */
  readonly plannedParents: readonly PointRef[]
  /** The node this one stands in for in later context (Q39). */
  readonly replacesNodeId: NodeId | null
}

/** A node moved to another chain when a sibling group opened around it. */
export interface NodeRechaining {
  readonly nodeId: NodeId
  readonly fromChainId: ChainId
  readonly toChainId: ChainId
}

/**
 * A second request arrived from a starting context that already had work in
 * flight, so that work and the new request are forks of one sibling group
 * (Q32).
 *
 * This is the only moment a node changes chain: work that began as an
 * ordinary continuation of the base chain becomes a fork with a chain and
 * color of its own (Q89), together with anything already queued behind it.
 * The base chain's head returns to `startNodeId`, and the join-back will
 * continue the base chain (Q78). Chains named in `rechained` have their own
 * `chain-created` events earlier in the same step.
 *
 * Work that was already on a chain of its own, a branch from the starting
 * node, keeps that chain: it is a member, and `rechained` does not list it.
 */
export interface SiblingGroupOpened extends ConversationEnvelope<'sibling-group-opened'> {
  readonly groupId: SiblingGroupId
  /** The shared starting context: the node every member is a child of. */
  readonly startNodeId: NodeId
  /** The chain the members forked from, which the join-back resumes. */
  readonly baseChainId: ChainId
  /** At least two members, in submission order. */
  readonly members: readonly SiblingMember[]
  readonly rechained: readonly NodeRechaining[]
  /** The operation-graph node that stands for the group's join-back until and after it forms. */
  readonly joinBackOperationId: OperationId
}

/**
 * Another request from the same starting context joined an open group (C11).
 * Every dependent of the full join-back now waits for it too (C16). A closed
 * group is never enlarged (C12).
 */
export interface SiblingAdmitted extends ConversationEnvelope<'sibling-admitted'> {
  readonly groupId: SiblingGroupId
  readonly member: SiblingMember
}

/**
 * Members were taken out of a sibling group because Undo split withdrew
 * their directives (Q53, Q85). From here on they do not count for the
 * closing rule, are not named in wait labels, and are absent from every
 * join-back record. Their nodes stay in the genealogy, marked superseded.
 *
 * A group that keeps at least one member carries on, even with one member:
 * it closes by the usual rule and its join-back returns that member's
 * exchange to the base chain. A group left with none is dissolved: it never
 * forms a join-back, and the base chain continues from the starting node.
 */
export interface SiblingsWithdrawn extends ConversationEnvelope<'siblings-withdrawn'> {
  readonly groupId: SiblingGroupId
  readonly directiveIds: readonly DirectiveId[]
  /** True when no member is left. */
  readonly dissolved: boolean
}

/**
 * The group closed and its join-back formed: every member has completed, or
 * has failed, been stopped or been interrupted and is not retrying (Q49,
 * Q92). Bookkeeping only: no model call, no assistant message, nothing added
 * to the transcript (Q8, Q28, Q31, C5).
 *
 * The join-back is a child of every member and is on the base chain. It
 * does not claim any member saw another's result.
 *
 * When a member's result is replaced by a revision after the group closed, a
 * further `join-back-formed` for the same group records the new content and
 * names the one it replaces, once the replacement has settled (completed, or
 * ended without retrying). Members are never added. A retry that completes
 * after the group closed does not re-form the join-back: the record keeps
 * the member's marker and the retry's exchange is read after it (Q92).
 */
export interface JoinBackFormed extends ConversationEnvelope<'join-back-formed'> {
  readonly joinBackId: JoinBackId
  readonly nodeId: NodeId
  readonly groupId: SiblingGroupId
  /** The base chain (Q78). */
  readonly chainId: ChainId
  /** Submission order, whatever order the answers arrived in (C4). */
  readonly members: readonly JoinBackMember[]
  readonly replacesJoinBackId: JoinBackId | null
}

// ═══════════════════════════ directives ═══════════════════════════

/**
 * A unit of work was created: an atomic message, one fragment of a composite,
 * or a clarification question. Its first state follows in the same step as
 * `directive-waiting`, `directive-held` or `directive-ready`.
 */
export interface DirectiveCreated extends ConversationEnvelope<'directive-created'> {
  readonly directiveId: DirectiveId
  readonly kind: DirectiveKind
  /** The user bubble this directive answers: the original message, or its split message. */
  readonly messageId: MessageId
  /** The message as typed. Equal to `messageId` unless the message was split. */
  readonly originalMessageId: MessageId
  readonly fragmentId: FragmentId | null
  /** The resolved instruction given to the run: the message text, or the fragment's rewrite. */
  readonly instruction: string
  /** Short noun phrase naming the work, for queue items and notes ("neighborhoods"). */
  readonly label: string
  /** Applicable requirements with provenance; local unless explicitly session-wide (Q17). */
  readonly requirements: readonly Requirement[]
  /** Never `revision`: a revision creates no directive (see `revision-recorded`). */
  readonly relation: Exclude<ReplyRelation, 'revision'>
  /** Resolved reply targets. A target alone does not make the work a revision, a fork or a join (Q20). */
  readonly targets: readonly SectionId[]
  /**
   * The node created for it by the preceding `node-created`. A clarification
   * question has no node of its own: this is the node of the first directive
   * it blocks, and no `node-created` precedes it.
   */
  readonly nodeId: NodeId
  readonly chainId: ChainId
  /** Results it needs before it can start. Acyclic; no subset of a sibling group (Q30). */
  readonly prerequisites: readonly PrerequisiteRef[]
  /** For a clarification question: the elicitation it asks. */
  readonly asksElicitationId: ElicitationId | null
}

/**
 * The directive is dependency-queued, or the set it waits for changed (a
 * sibling was admitted, a prerequisite was replaced by a revision, a retry of
 * the prerequisite began after a pause).
 *
 * Emitted only for work that needs an unavailable result; work free to
 * proceed is never dependency-queued (P6). Carries the queue item shown above
 * the composer, which keeps one ID for as long as the directive waits.
 */
export interface DirectiveWaiting extends ConversationEnvelope<'directive-waiting'> {
  readonly directiveId: DirectiveId
  readonly queueItemId: QueueItemId
  /** The prerequisites still unsatisfied. For a full join-back, the whole group is named (03 · "Composer queue"). */
  readonly waitingFor: readonly PrerequisiteRef[]
  /**
   * True when the directive itself needs nothing unavailable and waits only
   * because of the whole-request barrier (Q19). `waitingFor` then names what
   * the blocked part waits for.
   */
  readonly heldByBarrier: boolean
  /** True once the request was revised in place while queued: the item reads "Revised · waiting for …" (Q41). */
  readonly revised: boolean
}

/**
 * A prerequisite failed, was stopped or was interrupted and is not retrying,
 * so the directive is paused with reason `dependency-recovery` and a
 * recovery choice is raised on its queue item (Q48). It never proceeds on a
 * subset of siblings (F5). No default.
 *
 * A pause for user input is recorded by `directive-held` with reason
 * `clarification`.
 */
export interface DirectivePaused extends ConversationEnvelope<'directive-paused'> {
  readonly directiveId: DirectiveId
  readonly queueItemId: QueueItemId
  readonly cause: PauseCause
  /** The recovery-choice elicitation, raised in the same step. */
  readonly elicitationId: ElicitationId
}

/**
 * The directive cannot go on until an elicitation is resolved.
 * - `clarification`: it is `paused` with reason `awaiting-input` until the
 *   question is answered (Q23, Q106). It may already have run: a run that
 *   stopped to ask is recorded by `attempt-paused` just before.
 * - `choice-with-default`: state `awaiting-elicitation` (Q44).
 */
export interface DirectiveHeld extends ConversationEnvelope<'directive-held'> {
  readonly directiveId: DirectiveId
  readonly elicitationId: ElicitationId
  readonly reason: 'clarification' | 'choice-with-default'
}

/**
 * Every prerequisite is satisfied and nothing holds the directive: it is
 * eligible to run. Dependents become ready on the prerequisite's success
 * event (Q60); streaming text never causes this (C13). The queue item, if
 * any, clears when the attempt starts.
 */
export interface DirectiveReady extends ConversationEnvelope<'directive-ready'> {
  readonly directiveId: DirectiveId
}

/**
 * Ready work the scheduler could not start because every slot of the
 * concurrency limit is taken (Q60). Until this event a ready directive is
 * only about to start (its input tokens are being counted), so its bubble
 * never claims "Waiting for a free slot" while nothing else is running. The
 * next `directive-ready` or `attempt-started` clears it.
 */
export interface DirectiveSlotHeld extends ConversationEnvelope<'directive-slot-held'> {
  readonly directiveId: DirectiveId
}

/**
 * The directive was cancelled before it started (Q91): queued work inside a
 * stopped request, a Stop aimed at one section that had not started, or the
 * Cancel recovery choice. A state of its own; there is never a cancelled
 * request (invariant 5).
 */
export interface DirectiveCancelled extends ConversationEnvelope<'directive-cancelled'> {
  readonly directiveId: DirectiveId
  readonly cause: 'request-stopped' | 'section-stopped' | 'recovery-cancel'
}

/**
 * The user stopped work that had started but had no attempt in flight at
 * that moment: it was between automatic retries (`retrying`) or held by a
 * rate limit (`waiting-for-capacity`). The scheduled retry is cancelled and
 * the directive is `stopped`, exactly as if its last attempt had been
 * stopped; that attempt keeps its own terminal state (invariant 3).
 * Work with a live attempt is stopped by `attempt-stopped` instead, and
 * work that never started is cancelled (Q22, Q91).
 */
export interface DirectiveStopped extends ConversationEnvelope<'directive-stopped'> {
  readonly directiveId: DirectiveId
  readonly sectionId: SectionId
  readonly scope: 'section' | 'request'
}

/**
 * A revision reached a directive that had not started: the request is
 * updated in place. Nothing is stopped or superseded and its dependencies
 * are unchanged (Q41, R6).
 */
export interface DirectiveRevisedInPlace extends ConversationEnvelope<'directive-revised-in-place'> {
  readonly directiveId: DirectiveId
  readonly revisionMessageId: MessageId
  /** The corrected instruction the eventual run reads. */
  readonly instruction: string
  readonly requirements: readonly Requirement[]
}

/** The directive's short label changed (for example a generated label replaced the provisional one). */
export interface DirectiveLabeled extends ConversationEnvelope<'directive-labeled'> {
  readonly directiveId: DirectiveId
  readonly label: string
}

/**
 * The directive's prerequisites were replaced. Not used for an ordinary
 * revision of a prerequisite, which a `directive` reference follows by
 * itself; used when the set itself changes, for example by Regenerate.
 */
export interface PrerequisitesChanged extends ConversationEnvelope<'prerequisites-changed'> {
  readonly directiveId: DirectiveId
  readonly prerequisites: readonly PrerequisiteRef[]
}

/**
 * "Continue without": the paused directive will run without the result of a
 * prerequisite that did not finish. For a join-back it still consumes the
 * full join-back, with that member recorded as failed, stopped or
 * interrupted (Q48).
 */
export interface PrerequisiteWaived extends ConversationEnvelope<'prerequisite-waived'> {
  readonly directiveId: DirectiveId
  /** The directive whose result is no longer waited for. */
  readonly waivedDirectiveId: DirectiveId
  readonly elicitationId: ElicitationId
}

/**
 * The directive's typed readiness result was established (Q103): `ready`,
 * or `clarification-needed`. An answer directive's run is sent to the model
 * only after a `ready` result, so no visible answer text precedes it (an
 * attempt that fails in the preparation step is recorded without one and
 * reads nothing). Recorded again whenever it is established anew: by the preparation step after the
 * results it waited for arrived (Q105), by the user's answer, or by a run
 * that stopped to ask (Q106). The latest one is in force. Replay reads this
 * event and never calls a model.
 */
export interface DirectiveReadinessEstablished extends ConversationEnvelope<'directive-readiness-established'>, ReadinessRecord {
  readonly directiveId: DirectiveId
}

/** The user asked for a new attempt (the Retry control). */
export interface RetryRequested extends ConversationEnvelope<'retry-requested'> {
  readonly directiveId: DirectiveId
  readonly sectionId: SectionId
  /** `request` when the retry was for the whole request: only unfinished sections are retried (Q50, F8). */
  readonly scope: 'section' | 'request'
  /**
   * `after-join-back` when the directive's sibling group had already closed:
   * the retry is not a member and a `node-created` with reason
   * `retry-after-closure` precedes its attempt (Q92, F6).
   */
  readonly placement: 'in-place' | 'after-join-back'
}

/**
 * The user used Stop. What it caused follows in the same step, one event
 * per directive in scope: `attempt-stopped` for a live attempt,
 * `directive-stopped` for started work with none, `directive-cancelled` for
 * work that had not started.
 */
export interface StopRequested extends ConversationEnvelope<'stop-requested'> {
  readonly target:
    | { readonly kind: 'section'; readonly sectionId: SectionId }
    | { readonly kind: 'request'; readonly messageId: MessageId }
}

// ═══════════════════════════ attempts ═══════════════════════════

/**
 * A run started. Carries exactly what it read (invariant 2): this record is
 * the only source for the run inspector's "exact model input" and for Focus,
 * and nothing ever rewrites it.
 */
export interface AttemptStarted extends ConversationEnvelope<'attempt-started'> {
  readonly attemptId: AttemptId
  readonly directiveId: DirectiveId
  /** The section whose bubble the output streams into. A retry reuses the section (Q51, Q83). */
  readonly sectionId: SectionId
  readonly nodeId: NodeId
  readonly chainId: ChainId
  readonly operationId: OperationId
  /** 1-based version of the directive's attempts, across retries and revisions (run inspector item 6). */
  readonly number: number
  readonly origin: AttemptOrigin
  /** `synthesis` on a join chain, `answer` otherwise (Q65, Q90). */
  readonly modelRole: Extract<ModelRole, 'answer' | 'synthesis'>
  /** The OpenRouter model ID used (Q65). */
  readonly model: string
  /**
   * The exact nodes this run's context descends from: its planned parents
   * with every `sibling-group` point resolved as it stood at start.
   */
  readonly parents: readonly NodeId[]
  /** Snapshot at start (Q29): a result that finishes during the run is not added. */
  readonly context: ConsumedContext
}

/**
 * A chunk of streamed answer text, grouped under its attempt (Q69): several
 * provider deltas coalesced, not one event per token.
 *
 * The first chunk of a section's first attempt is that reply's first visible
 * output and fixes its position (Q14). Status text is never recorded here.
 */
export interface AttemptOutput extends ConversationEnvelope<'attempt-output'> {
  readonly attemptId: AttemptId
  /** 0-based chunk index within the attempt. */
  readonly index: number
  /** Non-empty. */
  readonly text: string
}

/** The run finished successfully. Only this releases dependents (invariant 4). */
export interface AttemptCompleted extends ConversationEnvelope<'attempt-completed'> {
  readonly attemptId: AttemptId
  /** `length`: the provider stopped at its output limit; the answer is kept as complete. */
  readonly finishReason: 'stop' | 'length'
  readonly usage: TokenUsage | null
}

/**
 * The run ended in an execution error. `retry` says what follows: nothing
 * (the directive is failed and offers Retry), or an automatic retry at a
 * given time (the directive is retrying, or waiting-for-capacity for a rate
 * limit). A failure with no answer text is a failure notice and fixes the
 * reply's position (Q51).
 */
export interface AttemptFailed extends ConversationEnvelope<'attempt-failed'> {
  readonly attemptId: AttemptId
  readonly error: ProviderError
  readonly retry: RetryPlan
}

/**
 * The run discovered consequential missing information and stopped to ask
 * (Q106). Its text stays as labeled partial text. Not a success: nothing is
 * released (invariant 4). Not a failure: no retry applies. The readiness
 * result, the clarification elicitation, its question as an additional
 * response and the directive's pause follow in the same step.
 */
export interface AttemptPaused extends ConversationEnvelope<'attempt-paused'> {
  readonly attemptId: AttemptId
  readonly reason: ClarificationReason
  /** The question the run asked, exactly as it will be shown. */
  readonly question: string
  readonly usage: TokenUsage | null
}

/** The user stopped a run that was in flight. Visible text stays, marked partial and stopped (Q22). */
export interface AttemptStopped extends ConversationEnvelope<'attempt-stopped'> {
  readonly attemptId: AttemptId
  readonly scope: 'section' | 'request'
}

/**
 * The run was lost with its executor (Q52). Recorded when the backend next
 * starts and finds an attempt with no terminal event. Under Standard and
 * Persistent it retries automatically within the retry limit; under Manual
 * it waits with Retry (Q54). Only the one executor that holds the backend
 * lock may record this: a second tab must never mark the first tab's live
 * attempts interrupted.
 */
export interface AttemptInterrupted extends ConversationEnvelope<'attempt-interrupted'> {
  readonly attemptId: AttemptId
  readonly retry: RetryPlan
}

/** The run's input reached the warning share of the model's context limit (Q67, Q82). The run still proceeds. */
export interface ContextLimitWarned extends ConversationEnvelope<'context-limit-warned'> {
  readonly attemptId: AttemptId
  readonly directiveId: DirectiveId
  readonly chainId: ChainId
  readonly inputTokens: number
  readonly tokenLimit: number
}

// ═══════════════════ responses, sections and placement ═══════════════════

/** Why a response exists. Anything but `answer` is an additional response and is never inserted into an earlier one (Q23, Q38). */
export type ResponseReason =
  /** The initial response to a message. */
  | 'answer'
  | 'clarification-question'
  /** The answer a clarification unblocked (P9). */
  | 'clarified-answer'
  /** A revision's replacement (P11). */
  | 'revision-replacement'
  /** Restart of a dependent whose prerequisite was revised while it ran (Q36, R4). */
  | 'prerequisite-revised'
  /** Regenerate, or a redo from a choice with default. */
  | 'redo'

/**
 * A reply was opened for a message. It starts as a responding bubble at the
 * pending tail of the transcript and is pushed down as other replies take
 * their places (Q12).
 *
 * For a message's initial response, `responseId` is the one minted on
 * `message-submitted`: the provisional bubble shown during routing becomes
 * this response and keeps its place in the pending tail.
 */
export interface ResponseOpened extends ConversationEnvelope<'response-opened'> {
  readonly responseId: ResponseId
  /** The user bubble it answers. */
  readonly messageId: MessageId
  readonly reason: ResponseReason
  /** True for the reply group of an independent composite (Q18). */
  readonly grouped: boolean
  /**
   * How sections are ordered inside a group: by their own first output, or
   * in the explicit order the user asked for, which takes precedence (Q18, P8).
   */
  readonly sectionOrder: 'first-output' | 'explicit'
}

/**
 * An answer section was opened inside a response for a directive.
 *
 * It carries no note. "Redid {label} by default" is not known when a
 * section opens (running work is replaced when a choice with default is
 * raised, before the default can run), so the transcript projection adds
 * that note when `elicitation-defaulted` arrives (Q45, Q95).
 */
export interface SectionOpened extends ConversationEnvelope<'section-opened'> {
  readonly sectionId: SectionId
  readonly directiveId: DirectiveId
  readonly responseId: ResponseId
  /** Section heading inside a reply group; the directive's label. */
  readonly title: string
  /** The section this one replaces. The replacement is always in a new response (P11). */
  readonly replacesSectionId: SectionId | null
  /** The operation-graph node for this section's work. */
  readonly operationId: OperationId
  /** For an explicitly ordered group: 0-based position. Null otherwise. */
  readonly explicitPosition: number | null
}

/** What counts as first visible output. Status text never does (03 · "Order"). */
export type PlacementCause =
  /** First answer text (Q14). */
  | 'first-output'
  /** A failure before any answer text (Q51, P12). */
  | 'failure-notice'
  /** Stopped, interrupted or cancelled before any answer text: the mark is the visible output. */
  | 'ended-without-output'

/**
 * The response took its position in the transcript and never moves again
 * (Q14, invariant 6). It is placed after everything already fixed and above
 * every responding bubble still pending, so a quick reply overtakes a slow
 * one requested earlier (P1) and completion order changes nothing (P2).
 */
export interface ResponsePlaced extends ConversationEnvelope<'response-placed'> {
  readonly responseId: ResponseId
  readonly cause: PlacementCause
}

/** A section took its position inside its reply group, by the same rule (Q18). Not emitted for explicitly ordered groups. */
export interface SectionPlaced extends ConversationEnvelope<'section-placed'> {
  readonly sectionId: SectionId
  readonly cause: PlacementCause
}

/**
 * A section was replaced (Q35, Q38). What the transcript keeps:
 * - no visible output: the responding bubble is dropped without a trace;
 * - visible partial text: it stays in place, collapsed, marked
 *   "Superseded — revised below", linked to the replacement;
 * - finished: it stays, marked superseded, linked to the replacement.
 *
 * A running attempt ended here is superseded, not stopped: its dependents
 * follow the replacement and are not paused. The section is no longer a
 * reply target (Q43).
 */
export interface SectionSuperseded extends ConversationEnvelope<'section-superseded'> {
  readonly sectionId: SectionId
  readonly directiveId: DirectiveId
  /** The running attempt Committee ended, if one was in flight. Its state becomes `superseded`. */
  readonly endedAttemptId: AttemptId | null
  /** Whether any answer text or failure notice was visible. False means the bubble is dropped. */
  readonly hadVisibleOutput: boolean
  /** Whether the section had completed before it was replaced. */
  readonly wasFinished: boolean
  readonly cause: SupersessionCause
  /**
   * The section that replaces it, opened in the same step. Null only for
   * Undo split, where the work is withdrawn and the original message is
   * routed again.
   */
  readonly replacementSectionId: SectionId | null
}

/**
 * Completed work consumed a result that has since been replaced, so it gets
 * a quiet superseded-input note with Regenerate (Q40). The work itself is
 * left exactly as it was; nothing regenerates automatically (R5).
 */
export interface SupersededInputNoted extends ConversationEnvelope<'superseded-input-noted'> {
  readonly sectionId: SectionId
  /** The completed attempt whose input was replaced. */
  readonly attemptId: AttemptId
  /** Only inputs this attempt actually consumed (Q40). */
  readonly inputs: readonly SupersededInput[]
}

// ═══════════════════════════ revisions ═══════════════════════════

/**
 * The state of a revision's target when the revision arrived. The first
 * four are the rows of 06 · "Revising one piece of work".
 *
 * `ended-unfinished` is the build's fifth: the target had failed, been
 * stopped, been interrupted or been cancelled. It is replaced like running
 * work: a new section in a new response, with rewound context that never
 * includes its partial text (R2, invariant 7). What it leaves behind
 * follows `section-superseded.hadVisibleOutput`.
 */
export type RevisionTargetState =
  | 'not-started'
  | 'running-status-only'
  | 'running-with-text'
  | 'finished'
  | 'ended-unfinished'

/**
 * Routing concluded that a submitted message revises earlier work (Q37,
 * Q79). Revision is not a command. The consequences follow as their own
 * events: `directive-revised-in-place`, `section-superseded`, new sections
 * and attempts, `directive-waiting`, `superseded-input-noted`, or an
 * `elicitation-raised` for a shared requirement.
 */
export interface RevisionRecorded extends ConversationEnvelope<'revision-recorded'> {
  /** The message carrying the correction. It appears in submission order like any message. */
  readonly messageId: MessageId
  /**
   * - `work`: corrects one piece of work; local to it (Q17).
   * - `shared-requirement`: changes a brief several requests consumed, so
   *   the user is asked which finished work to redo (Q42).
   */
  readonly scope: 'work' | 'shared-requirement'
  /** The user's correction as given to later context (Q39). */
  readonly correction: string
  /** Set when the correction is one fragment of a composite message; the rest of the message is other work. */
  readonly fragmentId: FragmentId | null
  /** For `shared-requirement`: the directive that established the brief. */
  readonly targets: readonly {
    readonly directiveId: DirectiveId
    /** The target's current section. Null when it has none yet: a directive still blocked by a clarification. */
    readonly sectionId: SectionId | null
    readonly state: RevisionTargetState
  }[]
  /**
   * Session-wide requirements this message replaces or withdraws; the
   * `session-requirement-recorded` or `session-requirement-withdrawn`
   * events follow in the same step. Empty otherwise.
   */
  readonly requirementIds: readonly RequirementId[]
}

/**
 * The user used Regenerate on completed work with a superseded-input note
 * (Q40, Q79). Any of that work still in progress is cancelled first, then it
 * is redone against the new version of what it depends on (R8).
 */
export interface RegenerateRequested extends ConversationEnvelope<'regenerate-requested'> {
  readonly directiveId: DirectiveId
  readonly sectionId: SectionId
}

// ═══════════════════════════ elicitations ═══════════════════════════

/** Committee asked the user to decide something (07). */
export interface ElicitationRaised extends ConversationEnvelope<'elicitation-raised'> {
  readonly elicitation: ElicitationRecord
}

/** The user edited the selection of a choice with default without confirming it. The wait continues (Q45). */
export interface ElicitationEdited extends ConversationEnvelope<'elicitation-edited'> {
  readonly elicitationId: ElicitationId
  /** The finished work currently selected for redo. */
  readonly redo: readonly DirectiveId[]
}

/** How an elicitation was resolved by the user. */
export type ElicitationResolution =
  | ElicitationAnswer
  /** A message answered the clarification question (Q98). */
  | { readonly kind: 'clarification'; readonly answerMessageId: MessageId }
  /** The recovery choice was made with Retry, Continue without or Cancel. */
  | { readonly kind: 'recovery-choice'; readonly choice: 'retry-prerequisite' | 'continue-without' | 'cancel' }

export interface ElicitationAnswered extends ConversationEnvelope<'elicitation-answered'> {
  readonly elicitationId: ElicitationId
  readonly resolution: ElicitationResolution
}

/**
 * The default of a choice with default was carried out because the user sent
 * another message without answering, or the wait elapsed (Q45). Only a
 * choice with default can default (Q46).
 *
 * This event is what puts "Redid {label} by default" on the redone work:
 * the replacement of every section superseded with cause `redo` for this
 * elicitation, and the current section of every directive that was held for
 * it. Nothing else records that the default ran.
 */
export interface ElicitationDefaulted extends ConversationEnvelope<'elicitation-defaulted'> {
  readonly elicitationId: ElicitationId
  readonly trigger: 'wait-elapsed' | 'next-message'
  /** The finished work redone: the pre-selection, as last edited. */
  readonly redo: readonly DirectiveId[]
}

/** The elicitation no longer applies and was closed without an answer. */
export interface ElicitationWithdrawn extends ConversationEnvelope<'elicitation-withdrawn'> {
  readonly elicitationId: ElicitationId
  readonly reason:
    /** The paused directive's prerequisite is being retried, or completed. */
    | 'prerequisite-recovering'
    /** The work it concerned was superseded, stopped or cancelled. */
    | 'subject-ended'
}

// ═══════════════════════════ app log ═══════════════════════════

export interface ConversationCreated extends AppEnvelope<'conversation-created'> {
  readonly conversationId: ConversationId
  readonly title: string
}

/** The conversation's list title changed (derived from its first message). */
export interface ConversationTitled extends AppEnvelope<'conversation-titled'> {
  readonly conversationId: ConversationId
  readonly title: string
}

/** The conversation and its event log were deleted (Q70). */
export interface ConversationDeleted extends AppEnvelope<'conversation-deleted'> {
  readonly conversationId: ConversationId
}

/** App-wide settings changed (Q70). Never carries the key. */
export interface SettingsChanged extends AppEnvelope<'settings-changed'> {
  /** The whole settings after the change, so the stored event has every key and the last one is the truth. */
  readonly settings: Settings
}

/** A key was stored in, or removed from, the secrets store. Only its presence is recorded (Q64). */
export interface KeyStatusChanged extends AppEnvelope<'key-status-changed'> {
  readonly configured: boolean
}

// ═══════════════════════════ unions ═══════════════════════════

export type ConversationEvent =
  | MessageSubmitted
  | RoutingDecided
  | RoutingFailed
  | RoutingRetried
  | MessageDecomposed
  | SplitUndone
  | SessionRequirementRecorded
  | SessionRequirementWithdrawn
  | ChainCreated
  | NodeCreated
  | SiblingGroupOpened
  | SiblingAdmitted
  | SiblingsWithdrawn
  | JoinBackFormed
  | DirectiveCreated
  | DirectiveWaiting
  | DirectivePaused
  | DirectiveHeld
  | DirectiveReady
  | DirectiveSlotHeld
  | DirectiveCancelled
  | DirectiveStopped
  | DirectiveRevisedInPlace
  | DirectiveLabeled
  | PrerequisitesChanged
  | PrerequisiteWaived
  | RetryRequested
  | StopRequested
  | DirectiveReadinessEstablished
  | AttemptPaused
  | AttemptStarted
  | AttemptOutput
  | AttemptCompleted
  | AttemptFailed
  | AttemptStopped
  | AttemptInterrupted
  | ContextLimitWarned
  | ResponseOpened
  | SectionOpened
  | ResponsePlaced
  | SectionPlaced
  | SectionSuperseded
  | SupersededInputNoted
  | RevisionRecorded
  | RegenerateRequested
  | ElicitationRaised
  | ElicitationEdited
  | ElicitationAnswered
  | ElicitationDefaulted
  | ElicitationWithdrawn

export type AppEvent =
  | ConversationCreated
  | ConversationTitled
  | ConversationDeleted
  | SettingsChanged
  | KeyStatusChanged

export type DomainEvent = ConversationEvent | AppEvent

export type DomainEventType = DomainEvent['type']
export type ConversationEventType = ConversationEvent['type']
export type AppEventType = AppEvent['type']

/** The event with the given `type`. */
export type EventOfType<T extends DomainEventType> = Extract<DomainEvent, { readonly type: T }>

type EnvelopeKey = 'id' | 'log' | 'seq' | 'v' | 'at'
type Body<E> = E extends unknown ? Omit<E, EnvelopeKey> : never

/**
 * An event without its envelope: what a handler produces. The coordinator
 * stamps `id`, `log`, `seq`, `v` and `at` when it appends.
 */
export type ConversationEventBody = Body<ConversationEvent>
export type AppEventBody = Body<AppEvent>
export type EventBodyOfType<T extends DomainEventType> = Body<EventOfType<T>>

/** Every conversation event type, for exhaustive registries and tests. */
export const CONVERSATION_EVENT_TYPES = [
  'message-submitted',
  'routing-decided',
  'routing-failed',
  'routing-retried',
  'message-decomposed',
  'split-undone',
  'session-requirement-recorded',
  'session-requirement-withdrawn',
  'chain-created',
  'node-created',
  'sibling-group-opened',
  'sibling-admitted',
  'siblings-withdrawn',
  'join-back-formed',
  'directive-created',
  'directive-waiting',
  'directive-paused',
  'directive-held',
  'directive-ready',
  'directive-slot-held',
  'directive-cancelled',
  'directive-stopped',
  'directive-revised-in-place',
  'directive-labeled',
  'prerequisites-changed',
  'prerequisite-waived',
  'retry-requested',
  'stop-requested',
  'directive-readiness-established',
  'attempt-paused',
  'attempt-started',
  'attempt-output',
  'attempt-completed',
  'attempt-failed',
  'attempt-stopped',
  'attempt-interrupted',
  'context-limit-warned',
  'response-opened',
  'section-opened',
  'response-placed',
  'section-placed',
  'section-superseded',
  'superseded-input-noted',
  'revision-recorded',
  'regenerate-requested',
  'elicitation-raised',
  'elicitation-edited',
  'elicitation-answered',
  'elicitation-defaulted',
  'elicitation-withdrawn',
] as const satisfies readonly ConversationEventType[]

export const APP_EVENT_TYPES = [
  'conversation-created',
  'conversation-titled',
  'conversation-deleted',
  'settings-changed',
  'key-status-changed',
] as const satisfies readonly AppEventType[]

// Compile-time proof that the two lists above name every event type.
type Missing<All, Listed> = Exclude<All, Listed>
const exhaustive: [
  Missing<ConversationEventType, (typeof CONVERSATION_EVENT_TYPES)[number]>,
  Missing<AppEventType, (typeof APP_EVENT_TYPES)[number]>,
] extends [never, never]
  ? true
  : false = true
void exhaustive

export function isAppEvent(event: DomainEvent): event is AppEvent {
  return event.log === APP_LOG
}

export function isConversationEvent(event: DomainEvent): event is ConversationEvent {
  return event.log !== APP_LOG
}

/**
 * An event as read back from storage, at whatever schema version it was
 * written with. Stores treat events as opaque records keyed by `log` and
 * `seq`; only {@link upcastEvent} interprets the rest.
 */
export interface PersistedEvent {
  readonly id: string
  readonly log: string
  readonly seq: number
  readonly v: number
  readonly at: number
  readonly type: string
  readonly [field: string]: unknown
}

/**
 * Upcasts a stored event to the current schema on read (Q69). Stored events
 * are never rewritten. Version 1 is current, so this only checks the
 * envelope; add one step per version when the schema changes.
 */
export function upcastEvent(stored: PersistedEvent): DomainEvent {
  if (!Number.isInteger(stored.v) || stored.v < 1 || stored.v > EVENT_SCHEMA_VERSION) {
    throw new Error(`Event ${stored.id} has unsupported schema version ${String(stored.v)}`)
  }
  if (!Number.isInteger(stored.seq) || stored.seq < 1) {
    throw new Error(`Event ${stored.id} has an invalid sequence number`)
  }
  const known: readonly string[] = [...CONVERSATION_EVENT_TYPES, ...APP_EVENT_TYPES]
  if (!known.includes(stored.type)) {
    throw new Error(`Event ${stored.id} has unknown type "${stored.type}"`)
  }
  return stored as unknown as DomainEvent
}

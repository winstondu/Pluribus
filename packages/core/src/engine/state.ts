import type {
  AttemptId,
  AttemptOrigin,
  AttemptState,
  ChainId,
  ChainKind,
  ClarificationReason,
  ConsumedContext,
  ConversationId,
  DirectiveId,
  DirectiveKind,
  DirectiveState,
  ElicitationId,
  ElicitationRecord,
  ElicitationResolution,
  FragmentId,
  FragmentRecord,
  JoinBackId,
  JoinBackMember,
  MessageId,
  MessageRoutingState,
  ModelRole,
  NodeId,
  NodeReason,
  OperationId,
  PauseCause,
  PointRef,
  PrerequisiteRef,
  ProviderError,
  QueueItemId,
  ReadinessRecord,
  ReplyRelation,
  Requirement,
  RequirementId,
  ResponseId,
  ResponseReason,
  RetryPlan,
  RevisionTargetState,
  RoutingDecision,
  SectionId,
  SiblingGroupId,
  SiblingMember,
  SplitMessageRecord,
  SupersededInput,
  SupersessionCause,
  TokenUsage,
  TranscriptItemRef,
  UnfinishedOutcome,
  WholeRequestBarrier,
} from '@committee/protocol'

/**
 * The state of one conversation: a fold of its event log and nothing else.
 *
 * Plain JSON, so the projection cache can store it as it is. Rows are
 * replaced, never mutated: a reducer returns a new state in which every
 * table and row it did not touch is the same object as before. The
 * projections rely on that identity to recompute only what changed.
 *
 * Every field is derived from events. Nothing here is a decision: the
 * engine decides by reading this state and emitting events.
 */
export interface ConversationState {
  readonly stateVersion: typeof STATE_VERSION
  readonly conversationId: ConversationId
  /** Sequence number of the last event folded. */
  readonly throughSeq: number

  readonly messages: Table<MessageRow>
  /** Original messages, in submission order. Split messages hang off their original. */
  readonly messageOrder: readonly MessageId[]
  readonly responses: Table<ResponseRow>
  /** Every response in the order it was created: "request order" for the pending tail. */
  readonly responseOrder: readonly ResponseId[]
  /**
   * Transcript items in the order their position was fixed (Q13, Q14). A
   * message is fixed on submission, a response on `response-placed`. The
   * transcript projection expands a split message's original into its split
   * messages and appends the pending tail.
   */
  readonly fixedOrder: readonly TranscriptItemRef[]
  readonly sections: Table<SectionRow>
  readonly directives: Table<DirectiveRow>
  /** Creation order, which is submission order, then split-message position (Q60). */
  readonly directiveOrder: readonly DirectiveId[]
  readonly attempts: Table<AttemptRow>
  /**
   * Streamed answer text by attempt, apart from the attempt rows, so that a
   * chunk of text changes only this table and the one view that shows it.
   */
  readonly attemptText: Table<string>
  readonly chains: Table<ChainRow>
  readonly chainOrder: readonly ChainId[]
  readonly nodes: Table<NodeRow>
  readonly nodeOrder: readonly NodeId[]
  readonly groups: Table<GroupRow>
  readonly joinBacks: Table<JoinBackRow>
  readonly elicitations: Table<ElicitationRow>
  readonly elicitationOrder: readonly ElicitationId[]
  /** Decomposition records, keyed by the original message's ID. */
  readonly decompositions: Table<DecompositionRow>
  readonly sessionRequirements: Table<SessionRequirementRow>
  readonly sessionRequirementOrder: readonly RequirementId[]
  readonly revisions: readonly RevisionRow[]
  readonly operations: Table<OperationRow>
  readonly operationOrder: readonly OperationId[]
}

export const STATE_VERSION = 4

export type Table<T> = { readonly [id: string]: T }

export interface MessageRow {
  readonly id: MessageId
  readonly kind: 'original' | 'split'
  readonly text: string
  readonly submittedAt: number
  readonly explicitTargets: readonly SectionId[]
  /** The original message for a split message; itself otherwise. */
  readonly originalMessageId: MessageId
  /** For an original: the provisional response minted on submission. */
  readonly initialResponseId: ResponseId | null
  readonly routing: MessageRoutingState
  readonly routingFailure: ProviderError | null
  /** The routing decision in force: the latest `routing-decided` (Q59). */
  readonly decision: RoutingDecision | null
  /** True while the original is shown as split messages (Q53). */
  readonly splitActive: boolean
  /** For a split message: its place in the set. */
  readonly split: { readonly index: number; readonly count: number } | null
  /** For a split message: true after Undo split took it out of the transcript. */
  readonly withdrawn: boolean
  /** Directives answering this bubble, in creation order. */
  readonly directiveIds: readonly DirectiveId[]
  /** Responses to this bubble, in creation order. */
  readonly responseIds: readonly ResponseId[]
  /** Directives this message revised (`revision-recorded`). */
  readonly revisedDirectiveIds: readonly DirectiveId[]
  /** Directives this message released by answering a clarification. */
  readonly releasedDirectiveIds: readonly DirectiveId[]
}

export interface ResponseRow {
  readonly id: ResponseId
  readonly messageId: MessageId
  /** False for the provisional bubble of a message that is not routed yet, until `response-opened`. */
  readonly opened: boolean
  readonly reason: ResponseReason
  readonly grouped: boolean
  readonly sectionOrder: 'first-output' | 'explicit'
  readonly placed: boolean
  /** Sections in the order they were opened. */
  readonly sectionIds: readonly SectionId[]
  /** Sections in the order they were placed inside the group (Q18). */
  readonly placedSectionIds: readonly SectionId[]
}

export interface SectionSupersession {
  readonly cause: SupersessionCause
  readonly endedAttemptId: AttemptId | null
  readonly hadVisibleOutput: boolean
  readonly wasFinished: boolean
  readonly replacementSectionId: SectionId | null
}

export interface SectionRow {
  readonly id: SectionId
  readonly directiveId: DirectiveId
  readonly responseId: ResponseId
  readonly title: string
  readonly replacesSectionId: SectionId | null
  readonly operationId: OperationId
  readonly explicitPosition: number | null
  /** The chain of the directive when the section opened. */
  readonly openedOnChainId: ChainId
  /** Fixed inside its group by `section-placed`. */
  readonly placed: boolean
  /**
   * Answer text, a failure notice, or the mark of work that ended without
   * output has been shown. This is "visible output" for supersession (Q38)
   * and for Undo split (D4).
   */
  readonly visibleOutput: boolean
  /** True once an attempt of this section showed answer text. */
  readonly hasText: boolean
  readonly attemptIds: readonly AttemptId[]
  readonly supersession: SectionSupersession | null
  readonly supersededInputs: { readonly attemptId: AttemptId; readonly inputs: readonly SupersededInput[] } | null
  readonly contextWarning: { readonly attemptId: AttemptId; readonly inputTokens: number; readonly tokenLimit: number } | null
}

export interface Correction {
  readonly revisionMessageId: MessageId
  readonly text: string
  /** Sequence number of the `revision-recorded` event. */
  readonly seq: number
}

export interface DirectiveRow {
  readonly id: DirectiveId
  readonly kind: DirectiveKind
  readonly messageId: MessageId
  readonly originalMessageId: MessageId
  readonly fragmentId: FragmentId | null
  /** The instruction as created. A revision in place adds a correction and never rewrites this (Q39, Q41). */
  readonly instruction: string
  readonly requirements: readonly Requirement[]
  /** The instruction and requirements after the latest revision in place, for the run inspector. */
  readonly revisedInstruction: { readonly instruction: string; readonly requirements: readonly Requirement[] } | null
  readonly label: string
  readonly relation: Exclude<ReplyRelation, 'revision'>
  readonly targets: readonly SectionId[]
  /** Current node and chain: where its next attempt runs. */
  readonly nodeId: NodeId
  readonly chainId: ChainId
  readonly prerequisites: readonly PrerequisiteRef[]
  readonly asksElicitationId: ElicitationId | null
  readonly state: DirectiveState
  readonly createdAt: number
  /** Index in `directiveOrder`. */
  readonly order: number
  /** Current section, and every section it has had. */
  readonly sectionId: SectionId | null
  readonly sectionIds: readonly SectionId[]
  readonly attemptIds: readonly AttemptId[]
  /** The completed attempt of the current section: the directive's current result. */
  readonly resultAttemptId: AttemptId | null
  /** Queue item while dependency-queued or paused. */
  readonly queueItemId: QueueItemId | null
  readonly waitingFor: readonly PrerequisiteRef[]
  readonly heldByBarrier: boolean
  readonly revised: boolean
  /** Set while `paused`, by its reason (glossary · "Paused"). An `awaiting-input` pause has no queue item: its question is in the transcript. */
  readonly pause: DirectivePause | null
  /** The typed readiness result as last established (Q103); null until one is. */
  readonly readiness: ReadinessRecord | null
  readonly heldBy: { readonly elicitationId: ElicitationId; readonly reason: 'clarification' | 'choice-with-default' } | null
  /** Prerequisites waived by "Continue without", by the directive whose result is no longer waited for. */
  readonly waived: readonly DirectiveId[]
  readonly corrections: readonly Correction[]
  /** The origin of the next attempt. */
  readonly nextOrigin: AttemptOrigin
  /** A scheduled automatic retry. */
  readonly retry: { readonly at: number; readonly wait: 'backoff' | 'rate-limit'; readonly retryNumber: number } | null
  /** Set by the clarification that blocked it, once answered: read after the request (Q23). */
  readonly clarification: { readonly elicitationId: ElicitationId; readonly answerMessageId: MessageId } | null
  /**
   * While `ready`: the scheduler found every slot taken (`directive-slot-held`).
   * False while it is only about to start. Reset by `directive-ready`.
   */
  readonly slotHeld: boolean
}

export type DirectivePause =
  | { readonly reason: 'dependency-recovery'; readonly cause: PauseCause; readonly elicitationId: ElicitationId }
  | { readonly reason: 'awaiting-input'; readonly elicitationId: ElicitationId }

export interface AttemptRow {
  readonly id: AttemptId
  readonly directiveId: DirectiveId
  readonly sectionId: SectionId
  readonly nodeId: NodeId
  readonly chainId: ChainId
  readonly operationId: OperationId
  readonly number: number
  readonly origin: AttemptOrigin
  readonly modelRole: Extract<ModelRole, 'answer' | 'synthesis'>
  readonly model: string
  readonly parents: readonly NodeId[]
  readonly context: ConsumedContext
  readonly state: AttemptState
  readonly startedAt: number
  /** Sequence number of its `attempt-started`. */
  readonly startedSeq: number
  readonly endedAt: number | null
  readonly failure: ProviderError | null
  readonly retry: RetryPlan | null
  readonly chunks: number
  readonly finishReason: 'stop' | 'length' | null
  readonly usage: TokenUsage | null
  /** For a run that stopped to ask (`paused`): the question it asked (Q106). */
  readonly pausedFor: { readonly reason: ClarificationReason; readonly question: string } | null
}

export interface ChainRow {
  readonly id: ChainId
  readonly kind: ChainKind
  readonly colorIndex: number
  readonly baseChainId: ChainId | null
  /** The label it was created with; shown only when `labelDirectiveId` is null (`chainLabel`). */
  readonly label: string
  /** The directive it is named after: the chain follows that directive's label. */
  readonly labelDirectiveId: DirectiveId | null
  /** Its nodes in order along the chain. */
  readonly nodeIds: readonly NodeId[]
}

export interface NodeRow {
  readonly id: NodeId
  readonly kind: 'exchange' | 'join-back'
  readonly chainId: ChainId
  /** The exchange's directive; null for a join-back. */
  readonly directiveId: DirectiveId | null
  readonly reason: NodeReason | null
  /** The placement. A join-back's parents are its member nodes. */
  readonly plannedParents: readonly PointRef[]
  readonly replacesNodeId: NodeId | null
  readonly replacedByNodeId: NodeId | null
  /** The sibling group this exchange is a member of. */
  readonly groupId: SiblingGroupId | null
  /** For a join-back: its formation, and the group it joins. */
  readonly joinBackId: JoinBackId | null
  readonly joinGroupId: SiblingGroupId | null
  /** Attempts of the node's own directive that ran here, oldest first. */
  readonly attemptIds: readonly AttemptId[]
  /** Parents of the latest attempt that ran here: the exact ancestry once started. */
  readonly startedParents: readonly NodeId[] | null
}

export interface GroupRow {
  readonly id: SiblingGroupId
  readonly startNodeId: NodeId
  readonly baseChainId: ChainId
  /** Every member there has been, in submission order. */
  readonly members: readonly SiblingMember[]
  readonly withdrawn: readonly DirectiveId[]
  readonly state: 'open' | 'closed' | 'dissolved'
  /** Formations, oldest first. The last is current. */
  readonly joinBackIds: readonly JoinBackId[]
  readonly joinBackOperationId: OperationId
  /** Nodes of retries started after the group closed, in the order requested (Q92). */
  readonly lateRetryNodeIds: readonly NodeId[]
}

export interface JoinBackRow {
  readonly id: JoinBackId
  readonly nodeId: NodeId
  readonly groupId: SiblingGroupId
  readonly chainId: ChainId
  readonly members: readonly JoinBackMember[]
  readonly replacesJoinBackId: JoinBackId | null
  readonly replacedByJoinBackId: JoinBackId | null
}

export interface ElicitationRow {
  readonly id: ElicitationId
  readonly record: ElicitationRecord
  readonly raisedAt: number
  readonly status: 'open' | 'answered' | 'defaulted' | 'withdrawn'
  /** For a choice with default: finished work currently selected for redo. */
  readonly selected: readonly DirectiveId[]
  readonly resolution: ElicitationResolution | null
  readonly defaulted: { readonly trigger: 'wait-elapsed' | 'next-message'; readonly redo: readonly DirectiveId[] } | null
}

export interface DecompositionRow {
  readonly messageId: MessageId
  readonly presentation: 'reply-group' | 'split-messages'
  readonly fragments: readonly FragmentRecord[]
  readonly barrier: WholeRequestBarrier | null
  readonly outputOrder: readonly FragmentId[] | null
  readonly splitMessages: readonly SplitMessageRecord[]
  readonly model: string
  /** True after Undo split. */
  readonly undone: boolean
}

export interface SessionRequirementRow {
  readonly requirement: Requirement
  readonly replacesRequirementId: RequirementId | null
  /** The requirement that replaced this one, or the message that withdrew it. */
  readonly replacedBy: RequirementId | null
  readonly withdrawnByMessageId: MessageId | null
}

export interface RevisionRow {
  readonly messageId: MessageId
  readonly scope: 'work' | 'shared-requirement'
  readonly correction: string
  readonly fragmentId: FragmentId | null
  readonly targets: readonly {
    readonly directiveId: DirectiveId
    readonly sectionId: SectionId | null
    readonly state: RevisionTargetState
  }[]
  readonly requirementIds: readonly RequirementId[]
  readonly seq: number
}

export interface OperationRow {
  readonly id: OperationId
  readonly kind: 'section' | 'join-back'
  readonly sectionId: SectionId | null
  readonly groupId: SiblingGroupId | null
}

/** Directive outcomes that leave work unfinished, as a join-back or a marker records them. */
export type EndedState = Extract<DirectiveState, UnfinishedOutcome>

export function emptyConversationState(conversationId: ConversationId): ConversationState {
  return {
    stateVersion: STATE_VERSION,
    conversationId,
    throughSeq: 0,
    messages: {},
    messageOrder: [],
    responses: {},
    responseOrder: [],
    fixedOrder: [],
    sections: {},
    directives: {},
    directiveOrder: [],
    attempts: {},
    attemptText: {},
    chains: {},
    chainOrder: [],
    nodes: {},
    nodeOrder: [],
    groups: {},
    joinBacks: {},
    elicitations: {},
    elicitationOrder: [],
    decompositions: {},
    sessionRequirements: {},
    sessionRequirementOrder: [],
    revisions: [],
    operations: {},
    operationOrder: [],
  }
}

/** The table fields of the state, for the projection tracker. */
export const STATE_TABLES = [
  'messages',
  'responses',
  'sections',
  'directives',
  'attempts',
  'attemptText',
  'chains',
  'nodes',
  'groups',
  'joinBacks',
  'elicitations',
  'decompositions',
  'sessionRequirements',
  'operations',
] as const satisfies readonly (keyof ConversationState)[]

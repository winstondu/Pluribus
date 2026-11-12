import type { ConversationId, DirectiveId, ElicitationId, MessageId, SectionId } from './ids'
import type { ElicitationAnswer } from './model'
import type { ConversationSummary } from './projections'
import type { SettingsPatch } from './settings'

/**
 * Commands: the user's intentions, sent by the client. Exactly the set in
 * 10 · "Commands", as corrected by Q79.
 *
 * There is no Revise command. A revision is what routing concludes from the
 * wording of a submitted message (Q37, Q79).
 *
 * A command never says where work goes, what it waits for, or what it reads:
 * the backend decides all of that.
 */

/** A section, or a whole request (all work for one user message). */
export type WorkTarget =
  | { readonly kind: 'section'; readonly sectionId: SectionId }
  /** `messageId` is the user bubble: an original message, or one split message (Q53). */
  | { readonly kind: 'request'; readonly messageId: MessageId }

/** Submit message: text, and optionally explicit reply targets (05). */
export interface SubmitMessage {
  readonly type: 'submit-message'
  readonly conversationId: ConversationId
  /** Exactly as typed; preserved as the original message (Q3). */
  readonly text: string
  /**
   * Sections chosen with "Reply to this" (Q10, Q20). Omit or leave empty for
   * an untargeted message, whose target is inferred. A target on a
   * superseded section resolves to its replacement (Q43).
   */
  readonly targets?: readonly SectionId[]
}

/**
 * Stop: one running section, or all unfinished work for a request (Q22).
 * Visible text is kept as partial; queued work inside the scope is
 * cancelled; work outside it, including dependents, is untouched (Q48).
 */
export interface Stop {
  readonly type: 'stop'
  readonly conversationId: ConversationId
  readonly target: WorkTarget
}

/**
 * Retry: a new attempt for a failed, stopped or interrupted section; on a
 * request, only its unfinished sections (Q50). On a request whose routing
 * failed, routes it again.
 */
export interface Retry {
  readonly type: 'retry'
  readonly conversationId: ConversationId
  readonly target: WorkTarget
}

/**
 * Regenerate: redo completed work that carries a superseded-input note,
 * cancelling any of that work still in progress first (Q40, R8).
 */
export interface Regenerate {
  readonly type: 'regenerate'
  readonly conversationId: ConversationId
  /** The section carrying the note. */
  readonly sectionId: SectionId
}

/** Continue without: run a paused request without the prerequisite that did not finish (Q48). */
export interface ContinueWithout {
  readonly type: 'continue-without'
  readonly conversationId: ConversationId
  /** The paused directive, as named by its queue item. */
  readonly directiveId: DirectiveId
}

/** Cancel: cancel a paused request (Q48, Q91). */
export interface Cancel {
  readonly type: 'cancel'
  readonly conversationId: ConversationId
  /** The paused directive, as named by its queue item. */
  readonly directiveId: DirectiveId
}

/**
 * Answer elicitation: the user's choice for a target-ambiguity or
 * choice-with-default elicitation (Q95). A clarification is answered by
 * submitting a message (Q98); a recovery choice by Retry, Continue without
 * or Cancel.
 */
export interface AnswerElicitation {
  readonly type: 'answer-elicitation'
  readonly conversationId: ConversationId
  readonly elicitationId: ElicitationId
  readonly answer: ElicitationAnswer
}

/**
 * Undo split: restore one atomic request from a set of split messages. Only
 * accepted until any split message shows answer text or receives a reply
 * (Q85, D4).
 */
export interface UndoSplit {
  readonly type: 'undo-split'
  readonly conversationId: ConversationId
  /** Identifies the set: the original message the split messages came from. */
  readonly originalMessageId: MessageId
}

/** Change settings (10 · "User settings"). */
export interface ChangeSettings {
  readonly type: 'change-settings'
  /**
   * The settings to change. A key is never part of a command (Q64, Q73):
   * keys are provided by the deployment (the embedded backend's key
   * service, or a server's environment), and the backend reports only
   * whether each is configured.
   */
  readonly changes?: SettingsPatch
}

export interface CreateConversation {
  readonly type: 'create-conversation'
}

export interface ListConversations {
  readonly type: 'list-conversations'
}

/** Deletes the conversation and its event log (Q70). Running work in it is aborted. */
export interface DeleteConversation {
  readonly type: 'delete-conversation'
  readonly conversationId: ConversationId
}

export type Command =
  | SubmitMessage
  | Stop
  | Retry
  | Regenerate
  | ContinueWithout
  | Cancel
  | AnswerElicitation
  | UndoSplit
  | ChangeSettings
  | CreateConversation
  | ListConversations
  | DeleteConversation

export type CommandType = Command['type']
export type CommandOfType<T extends CommandType> = Extract<Command, { readonly type: T }>

export const COMMAND_TYPES = [
  'submit-message',
  'stop',
  'retry',
  'regenerate',
  'continue-without',
  'cancel',
  'answer-elicitation',
  'undo-split',
  'change-settings',
  'create-conversation',
  'list-conversations',
  'delete-conversation',
] as const satisfies readonly CommandType[]

/** What each command returns when it is accepted. Effects arrive on the stream, not here. */
export interface CommandOutputs {
  'submit-message': { readonly messageId: MessageId }
  stop: Record<never, never>
  retry: Record<never, never>
  regenerate: Record<never, never>
  'continue-without': Record<never, never>
  cancel: Record<never, never>
  'answer-elicitation': Record<never, never>
  'undo-split': Record<never, never>
  'change-settings': Record<never, never>
  'create-conversation': { readonly conversation: ConversationSummary }
  'list-conversations': { readonly conversations: readonly ConversationSummary[] }
  'delete-conversation': Record<never, never>
}

export type CommandErrorCode =
  /** The conversation does not exist. */
  | 'unknown-conversation'
  /** The section, message, directive or elicitation named does not exist. */
  | 'unknown-target'
  /**
   * The target is not in a state that allows the command: Undo split after
   * answer text or a reply, Regenerate without a superseded-input note,
   * Continue without on work that is not paused, an elicitation already
   * resolved, and so on.
   */
  | 'not-allowed'
  /** The command is malformed (empty text, an option that was not offered, an invalid setting). */
  | 'invalid'
  /** The backend failed while handling the command. */
  | 'internal'

export interface CommandError {
  readonly code: CommandErrorCode
  readonly message: string
}

/**
 * The backend's reply to a command. Accepting a command means it was
 * recorded; what it causes arrives on the stream.
 */
export type CommandResult<T extends CommandType = CommandType> =
  | { readonly ok: true; readonly output: CommandOutputs[T] }
  | { readonly ok: false; readonly error: CommandError }

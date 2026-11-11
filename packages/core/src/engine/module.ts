import type {
  AttemptId,
  CommandError,
  CommandOfType,
  CommandOutputs,
  ConversationEvent,
  ConversationEventBody,
  ConversationId,
  DirectiveId,
  IdFactory,
  MessageId,
  ProviderError,
  RetryPlan,
  SectionId,
  Settings,
} from '@committee/protocol'
import type { CoreDependencies, JsonValue, Router, RoutingOutcome, RoutingPlan } from '../ports'
import type { ConversationState } from './state'

/**
 * How a slice of core adds behaviour: by handling commands, reacting to
 * events, carrying out parts of a routing plan, handling routing outcomes,
 * planning retries, reacting on start, and handling its own timers. A slice
 * never edits the engine's reducers or projections; it emits events, and
 * the engine's reducers say what they mean.
 *
 * Order: `createBackend` takes modules engine first. Command handlers are
 * asked from the last module to the first, so a later slice overrides the
 * engine's default for a command and returns `null` to leave it to an
 * earlier one. Everything else runs in module order.
 */
export interface CoreModule {
  readonly name: string
  readonly commands?: CommandHandlers
  /** Run for every event of a step, in module order, until no reaction emits anything. */
  readonly reactions?: readonly Reaction[]
  /** Each carries out the parts of a plan it names; all run in one step, in module order. */
  readonly planAppliers?: readonly PlanApplier[]
  /** What to do with a routing outcome that is not a plan. `failed` is the engine's. The last module that has one wins. */
  readonly outcomeHandlers?: { readonly 'target-ambiguity'?: OutcomeHandler<'target-ambiguity'> }
  /** Decides what follows a failed or interrupted attempt. The last module that has one wins. */
  readonly retryPlanner?: RetryPlanner
  /** Run by `start()` for each conversation after its log is folded, in module order. */
  readonly startupReactions?: readonly StartupReaction[]
  /** Handlers for timers set with `ctx.setTimer(kind, …)`, by kind. */
  readonly timers?: { readonly [kind: string]: TimerHandler }
  /** Used when `deps.router` is absent. The last module that has one wins. */
  readonly createRouter?: (deps: CoreDependencies) => Router
}

/** Commands addressed to one conversation. App commands are the backend's own. */
export type ConversationCommandType =
  | 'submit-message'
  | 'stop'
  | 'retry'
  | 'regenerate'
  | 'continue-without'
  | 'cancel'
  | 'answer-elicitation'
  | 'undo-split'

export type CommandHandlers = { readonly [T in ConversationCommandType]?: CommandHandler<T> }

/**
 * Handles one command. Returns the events to append (and, for a command
 * with an output, the output), a `CommandError` to reject it, or `null` to
 * pass it to the next module. Events may also be emitted with `ctx.emit`,
 * which applies them at once; returned events follow those.
 */
export type CommandHandler<T extends ConversationCommandType> = (
  state: ConversationState,
  command: CommandOfType<T>,
  ctx: StepContext,
) => CommandHandlerResult<T>

export type CommandHandlerResult<T extends ConversationCommandType> =
  | readonly ConversationEventBody[]
  | { readonly events: readonly ConversationEventBody[]; readonly output: CommandOutputs[T] }
  | CommandError
  | null

export type Reaction = (state: ConversationState, event: ConversationEvent, ctx: StepContext) => readonly ConversationEventBody[] | void

/** The parts of a plan a module may carry out. The engine refuses a plan with a non-empty part no module carries out. */
export type PlanPart = 'units' | 'sessionRequirements' | 'clarifications' | 'revisions' | 'answersElicitationId'

export interface PlanApplier {
  readonly parts: readonly PlanPart[]
  apply(state: ConversationState, plan: RoutingPlan, target: PlanTarget, ctx: StepContext): readonly ConversationEventBody[] | void
}

/** The message a plan is for. */
export interface PlanTarget {
  readonly messageId: MessageId
}

export type OutcomeHandler<K extends Exclude<RoutingOutcome['kind'], 'plan' | 'failed'>> = (
  state: ConversationState,
  outcome: Extract<RoutingOutcome, { readonly kind: K }>,
  target: PlanTarget,
  ctx: StepContext,
) => readonly ConversationEventBody[] | void

export type RetryCause = { readonly kind: 'failed'; readonly error: ProviderError } | { readonly kind: 'interrupted' }

export type RetryPlanner = (
  state: ConversationState,
  directiveId: DirectiveId,
  cause: RetryCause,
  now: number,
  settings: Settings,
) => RetryPlan

export type StartupReaction = (state: ConversationState, ctx: StepContext) => readonly ConversationEventBody[] | void

export type TimerHandler = (state: ConversationState, payload: JsonValue, ctx: StepContext) => readonly ConversationEventBody[] | void

export interface RouteOptions {
  /** The sections the user chose in a target-ambiguity elicitation. */
  readonly chosenTargets?: readonly SectionId[]
  /** `atomic` after Undo split (Q53, Q85). */
  readonly forcedComposition?: 'atomic'
}

/**
 * What a handler may do besides returning events. Everything here is
 * deterministic: IDs come from the injected factory and time from the
 * injected clock. Effects (`route`, timers, cancellations, labels) start
 * after the step's events are appended.
 */
export interface StepContext {
  readonly conversationId: ConversationId
  /** Clock time of this step. */
  readonly now: number
  readonly settings: Settings
  readonly ids: IdFactory
  /** The state including every event emitted so far in this step. */
  readonly state: ConversationState
  /** Appends one event to the step and applies it at once. */
  emit(body: ConversationEventBody): ConversationEvent
  /** Routes a message (again) after this step. */
  route(messageId: MessageId, options?: RouteOptions): void
  /** Sets a timer that comes back as a step: `timers[kind]` of the module that has it is called with `payload`. A key replaces an earlier timer with the same key. */
  setTimer(kind: string, key: string, at: number, payload: JsonValue): void
  cancelTimer(key: string): void
  /** Asks the retry planner (the last module that has one). */
  retryPlan(directiveId: DirectiveId, cause: RetryCause): RetryPlan
  /** Aborts a live run after this step without recording anything for it; the caller records what happened. */
  abortAttempt(attemptId: AttemptId): void
  /**
   * Emits, now, any streamed text of a live attempt that is still held for
   * chunking. Call it before ending an attempt with an event of your own, so
   * the log holds every character that arrived (Q69).
   */
  flushOutput(attemptId: AttemptId): void
  /** Asks `Decomposer.label` for a directive's label in the background (no slot; failures ignored). */
  requestLabel(directiveId: DirectiveId): void
}

export function isCommandError(value: unknown): value is CommandError {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'code' in value && 'message' in value
}

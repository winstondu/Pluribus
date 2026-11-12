import type { AppEvent, ConversationEvent, ConversationEventType } from './events'
import type { AttemptId, ConversationId, DirectiveId, ElicitationId, MessageId } from './ids'
import type { ConsumedContext } from './model'
import type { ConversationSnapshot, ConversationSummary, RunInspection } from './projections'
import type { Settings } from './settings'

/**
 * The full log export of one conversation: everything needed to debug and
 * replay a run, produced by the backend (never assembled by the client).
 *
 * It travels as a {@link LogExportFile}: the document already serialized,
 * in string chunks, so the page can make a Blob from them without parsing
 * or stringifying anything on the UI thread. A server deployment answers
 * the same query with the same chunks, or serves the same text as a
 * download. `docs/build/log-export.md` describes how to read it.
 */

export const LOG_EXPORT_SCHEMA = 'pluribus.log-export'
export const LOG_EXPORT_VERSION = 1
export const LOG_EXPORT_MEDIA_TYPE = 'application/json'

/** The parsed document. Key order in the file is fixed: see `serializeLogExport` in core. */
export interface LogExportDocument {
  readonly schema: typeof LOG_EXPORT_SCHEMA
  readonly version: typeof LOG_EXPORT_VERSION
  /** Clock time of the export (the backend's injected clock), ISO 8601 and milliseconds. */
  readonly exportedAt: string
  readonly exportedAtMs: number
  readonly conversation: ConversationSummary
  readonly versions: {
    readonly protocol: number
    readonly eventSchema: number
    /** Core's folded-state version. */
    readonly state: number
  }
  /** The settings in force when the export was made. Every change to them is in `appEvents`. */
  readonly settings: Settings
  /** Whether an OpenRouter key was configured. The key itself is never exported. */
  readonly keyConfigured: boolean
  /**
   * The app log's events that concern this conversation: its creation,
   * titles, and every `settings-changed` and `key-status-changed`, in order.
   */
  readonly appEvents: readonly AppEvent[]
  /** The source of truth: every event of the conversation's log, in sequence order, as stored. */
  readonly events: readonly ConversationEvent[]
  /** Computed from `events` for convenience. Replaying `events` gives the same values. */
  readonly derived: LogExportDerived
}

export interface LogExportDerived {
  readonly note: string
  /** Sequence number of the last event the derived values reflect. */
  readonly throughSeq: number
  /** The four projections, as the client reads them. */
  readonly projections: ConversationSnapshot
  /** The run inspection of every directive (latest attempt), in directive creation order. */
  readonly runs: readonly LogExportRun[]
  /** Per message, in submission order: where its routing and run decisions are in `events`. */
  readonly routingDecisions: readonly RoutingDecisionIndexEntry[]
}

/**
 * A run inspection with the model input's messages left out: they are on
 * the `attempt-started` event named by `inputMessagesAt`, which is the
 * record the inspection itself reads them from.
 */
export type LogExportRun = Omit<RunInspection, 'input'> & {
  readonly input: (Omit<ConsumedContext, 'messages'> & { readonly inputMessagesAt: EventRef | null }) | null
}

/** Where an event is: its sequence number (`events[seq - 1]`) and type. */
export interface EventRef {
  readonly seq: number
  readonly type: ConversationEventType
}

export interface RoutingDecisionIndexEntry {
  readonly messageId: MessageId
  readonly submittedSeq: number
  /** The first 120 characters of the message as typed. */
  readonly text: string
  /** The latest `routing-decided` for the message, which is the one in force. */
  readonly routingInForce: EventRef | null
  /**
   * Each `elicitation-raised` of the message that carries the routing
   * decision behind a question about its reply target (`decision` on the
   * event): the questions put to the decision model and their answers.
   */
  readonly routingAsks: readonly EventRef[]
  /**
   * Every event about the message or its work, in order, except streamed
   * answer text: routing, decomposition, directives, waits, attempts and
   * their outcomes, revisions, elicitations and choices.
   */
  readonly events: readonly EventRef[]
  readonly directives: readonly {
    readonly directiveId: DirectiveId
    readonly label: string
    readonly attempts: readonly {
      readonly attemptId: AttemptId
      readonly number: number
      readonly model: string
      readonly startedSeq: number
      /** The attempt's terminal event, if any. */
      readonly ended: EventRef | null
      readonly outputChunks: number
    }[]
  }[]
  readonly elicitationIds: readonly ElicitationId[]
}

/**
 * The export as it crosses the backend interface. `chunks` joined are the
 * JSON text of a {@link LogExportDocument}. Strings are cheap to post
 * between threads; no part of the export is parsed on the page.
 */
export interface LogExportFile {
  readonly schema: typeof LOG_EXPORT_SCHEMA
  readonly version: typeof LOG_EXPORT_VERSION
  readonly conversationId: ConversationId
  readonly createdAt: number
  readonly filename: string
  readonly mediaType: typeof LOG_EXPORT_MEDIA_TYPE
  readonly chunks: readonly string[]
  /** Total length of `chunks` in UTF-16 code units, and the number of conversation events. */
  readonly length: number
  readonly eventCount: number
}

/** `pluribus-log-<conversation>-<timestamp>.json`, the timestamp in UTC as `YYYYMMDD-HHMMSS`. Pure. */
export function logExportFilename(conversationId: ConversationId, at: number): string {
  const iso = new Date(at).toISOString()
  const stamp = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`
  const safe = conversationId.replace(/[^A-Za-z0-9_-]/g, '_')
  return `pluribus-log-${safe}-${stamp}.json`
}

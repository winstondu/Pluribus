import type { DomainEvent, LogId, PersistedEvent } from '@committee/protocol'

/**
 * Storage ports. The event store is the source of truth; the projection
 * cache is a disposable speed-up; the secrets store is separate from both
 * (Q58, Q63, Q64). Adapters: IndexedDB for the embedded backend, in-memory
 * for tests.
 *
 * Storage failures reject the returned promise. A rejection is exceptional
 * (quota, a broken database), not a domain outcome.
 */

/** Rejection of {@link EventStore.append} when the events do not continue the log. */
export class EventStoreConflictError extends Error {
  readonly log: string
  readonly expectedSeq: number
  readonly receivedSeq: number

  constructor(log: string, expectedSeq: number, receivedSeq: number) {
    super(`Event log ${log} expected sequence ${expectedSeq}, received ${receivedSeq}`)
    this.name = 'EventStoreConflictError'
    this.log = log
    this.expectedSeq = expectedSeq
    this.receivedSeq = receivedSeq
  }
}

/**
 * Append-only event logs: one per conversation, plus the app log (Q69, Q70).
 * The store treats events as opaque records keyed by log and sequence number
 * and never rewrites one.
 */
export interface EventStore {
  /**
   * Appends events to one log, atomically: all are stored or none.
   *
   * Every event's `log` must equal `log`, and their `seq` must continue the
   * log without a gap: the first is `lastSeq(log) + 1`. Otherwise the call
   * rejects with {@link EventStoreConflictError} and stores nothing.
   * Appends to one log are applied in the order they were called.
   */
  append(log: LogId, events: readonly DomainEvent[]): Promise<void>

  /**
   * Reads a log in sequence order, as stored, at whatever schema version
   * each event was written with. Pass the result through `upcastEvent`.
   *
   * @param afterSeq return only events with a greater sequence number (default 0: the whole log)
   */
  read(log: LogId, afterSeq?: number): Promise<readonly PersistedEvent[]>

  /** Sequence number of the last event in the log; 0 when it is empty or does not exist. */
  lastSeq(log: LogId): Promise<number>

  /** Deletes a whole log: the one exception to append-only, for deleting a conversation (Q70). */
  deleteLog(log: LogId): Promise<void>
}

/** JSON data, as a projection cache stores it. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue }

export interface CachedState {
  /** Sequence number of the last event the state reflects. */
  readonly throughSeq: number
  /** Version of the cached state's shape, chosen by core. A mismatch means the cache is ignored and rebuilt. */
  readonly stateVersion: number
  /** Core's serialized state for the log. Opaque to the store. */
  readonly state: JsonValue
}

/**
 * Cached projection state per log, so a conversation opens without replaying
 * its whole log (Q58). Losing it loses nothing: core rebuilds from the event
 * store whenever the cache is missing, stale or of another version.
 */
export interface ProjectionCache {
  load(log: LogId): Promise<CachedState | null>
  /** Replaces what is cached for the log. */
  save(log: LogId, cached: CachedState): Promise<void>
  delete(log: LogId): Promise<void>
}

export type SecretName = 'openrouter-key'

/**
 * Local secrets, kept apart from the event log and the projection cache
 * (Q64, Q73). A secret is never written to an event, a projection, a log
 * line or an error message.
 */
export interface SecretsStore {
  get(name: SecretName): Promise<string | null>
  set(name: SecretName, value: string): Promise<void>
  delete(name: SecretName): Promise<void>
}

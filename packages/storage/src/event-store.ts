import { EventStoreConflictError, type EventStore } from '@committee/core/ports'
import type { DomainEvent, LogId, PersistedEvent } from '@committee/protocol'
import type { DatabaseSchema, StorageAdapter, WriteTransaction } from './adapter'

/** Object stores of the `committee-events` database. */
export const EVENT_STORES = {
  /** `[log, seq]` → the event exactly as appended, at the schema version it was written with. */
  events: 'events',
  /** `[log, attemptId, index]` → `seq` of that `attempt-output` chunk: streamed output grouped under its attempt (Q69). */
  attemptOutput: 'attempt-output',
  /** `[log]` → {@link LogRecord}: the directory of logs. */
  logs: 'logs',
  /** `[log]` → cached projection state (see `projection-cache.ts`). */
  projections: 'projections',
} as const

/** Layout of the database holding the event logs and the projection cache. Never holds a secret. */
export const EVENTS_DATABASE: DatabaseSchema = {
  name: 'committee-events',
  version: 1,
  stores: [EVENT_STORES.events, EVENT_STORES.attemptOutput, EVENT_STORES.logs, EVENT_STORES.projections],
}

/** One entry of the log directory. */
export interface LogRecord {
  readonly log: string
  /** `at` of the log's first event. */
  readonly createdAt: number
}

/**
 * The event store port plus what the local stores add: the directory of
 * logs, and an attempt's output chunks read without scanning the log.
 * Core needs only the port; the additions are for tools and tests.
 */
export interface LocalEventStore extends EventStore {
  /** Every log that has events, in order of log ID. A log exists from its first append until it is deleted. */
  listLogs(): Promise<readonly LogRecord[]>
  /** The `attempt-output` events of one attempt, in chunk order, as stored. */
  readAttemptOutput(log: LogId, attemptId: string): Promise<readonly PersistedEvent[]>
}

const LOG_STORES = [EVENT_STORES.events, EVENT_STORES.attemptOutput, EVENT_STORES.logs]

async function lastSeqIn(tx: Pick<WriteTransaction, 'getRange'>, log: string): Promise<number> {
  const [last] = await tx.getRange(EVENT_STORES.events, { prefix: [log] }, { reverse: true, limit: 1 })
  const seq = last?.key[1]
  return typeof seq === 'number' ? seq : 0
}

function attemptOutputKey(event: DomainEvent): readonly [string, number] | null {
  if (event.type !== 'attempt-output') return null
  return [event.attemptId, event.index]
}

/**
 * An {@link EventStore} over an adapter whose schema is {@link EVENTS_DATABASE}.
 *
 * - Append-only: an append that does not continue the log without a gap is
 *   rejected with `EventStoreConflictError` and stores nothing. Stored
 *   events are never rewritten; only {@link EventStore.deleteLog} removes them.
 * - Atomic: one append is one transaction, events and their indexes together.
 * - Ordered: appends are applied in call order, because the adapter runs
 *   transactions in request order and the gap check runs inside the transaction.
 * - Opaque: events are stored as given, schema version included, and read
 *   back unchanged; `upcastEvent` interprets them on read.
 */
export function createEventStore(adapter: StorageAdapter): LocalEventStore {
  return {
    append(log, events) {
      return adapter.write(LOG_STORES, async (tx) => {
        const last = await lastSeqIn(tx, log)
        let expected = last + 1
        for (const event of events) {
          if (event.log !== log) throw new EventStoreConflictError(log, expected, event.seq)
          if (event.seq !== expected) throw new EventStoreConflictError(log, expected, event.seq)
          expected += 1
        }
        const first = events[0]
        if (first === undefined) return
        if (last === 0) {
          const record: LogRecord = { log, createdAt: first.at }
          tx.put(EVENT_STORES.logs, [log], record)
        }
        for (const event of events) {
          tx.put(EVENT_STORES.events, [log, event.seq], event)
          const output = attemptOutputKey(event)
          if (output !== null) tx.put(EVENT_STORES.attemptOutput, [log, ...output], event.seq)
        }
      })
    },

    read(log, afterSeq = 0) {
      const from = Number.isFinite(afterSeq) ? Math.floor(afterSeq) + 1 : afterSeq > 0 ? Infinity : -Infinity
      return adapter.read([EVENT_STORES.events], async (tx) => {
        const entries = await tx.getRange(EVENT_STORES.events, { prefix: [log], from })
        return entries.map((entry) => entry.value as PersistedEvent)
      })
    },

    lastSeq(log) {
      return adapter.read([EVENT_STORES.events], (tx) => lastSeqIn(tx, log))
    },

    deleteLog(log) {
      return adapter.write(LOG_STORES, (tx) => {
        tx.deleteRange(EVENT_STORES.events, { prefix: [log] })
        tx.deleteRange(EVENT_STORES.attemptOutput, { prefix: [log] })
        tx.delete(EVENT_STORES.logs, [log])
        return Promise.resolve()
      })
    },

    listLogs() {
      return adapter.read([EVENT_STORES.logs], async (tx) => {
        const entries = await tx.getRange(EVENT_STORES.logs, { prefix: [] })
        return entries.map((entry) => entry.value as LogRecord)
      })
    },

    readAttemptOutput(log, attemptId) {
      return adapter.read([EVENT_STORES.events, EVENT_STORES.attemptOutput], async (tx) => {
        const chunks = await tx.getRange(EVENT_STORES.attemptOutput, { prefix: [log, attemptId] })
        const events: PersistedEvent[] = []
        for (const chunk of chunks) {
          const event = await tx.get(EVENT_STORES.events, [log, chunk.value as number])
          if (event !== undefined) events.push(event as PersistedEvent)
        }
        return events
      })
    },
  }
}

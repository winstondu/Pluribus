/**
 * Conformance suites for the storage ports: one contract, run against every
 * implementation (the IndexedDB adapter, the in-memory adapter, and core's
 * in-memory fakes). The `@committee/storage/conformance` entry loads Vitest.
 *
 * - {@link describeEventStore}, {@link describeProjectionCache},
 *   {@link describeSecretsStore}: the ports alone.
 * - {@link describeCommitteeStorage}: this package's stores together over one
 *   pair of databases: reload, the log directory, output grouped under its
 *   attempt, and that the key never reaches the events database.
 */
import { EventStoreConflictError, type CachedState, type EventStore, type ProjectionCache, type SecretsStore } from '@committee/core/ports'
import {
  APP_LOG,
  EVENT_SCHEMA_VERSION,
  upcastEvent,
  type AppEvent,
  type AttemptId,
  type ConversationId,
  type DomainEvent,
  type EventId,
  type LogId,
  type PersistedEvent,
} from '@committee/protocol'
import { describe, expect, test } from 'vitest'
import type { StorageAdapter } from '../src/adapter'
import { EVENTS_DATABASE } from '../src/event-store'
import type { CommitteeStorage } from '../src/storage'
import { secretControls } from '../src/secrets-store'

type Make<T> = () => T | Promise<T>

// ─────────────────────────── event builders ───────────────────────────

const A = 'cnv_01JCONFORMANCEAAAAAAAAAAAA' as ConversationId
const B = 'cnv_01JCONFORMANCEBBBBBBBBBBBB' as ConversationId

/** A streamed output chunk: the most frequent event, and the one grouped under its attempt. */
export function outputEvent(log: ConversationId, seq: number, attemptId: string, index: number, text: string): DomainEvent {
  return {
    id: `evt_${log}_${String(seq)}` as EventId,
    log,
    seq,
    v: EVENT_SCHEMA_VERSION,
    at: 1_700_000_000_000 + seq,
    type: 'attempt-output',
    attemptId: attemptId as AttemptId,
    index,
    text,
  }
}

function appEvent(seq: number, conversationId: ConversationId): AppEvent {
  return {
    id: `evt_app_${String(seq)}` as EventId,
    log: APP_LOG,
    seq,
    v: EVENT_SCHEMA_VERSION,
    at: 1_700_000_000_000 + seq,
    type: 'conversation-created',
    conversationId,
    title: 'New conversation',
  }
}

/** Events `from`..`to` of a log, as output chunks of one attempt. */
function run(log: ConversationId, from: number, to: number, attemptId = 'att_1'): DomainEvent[] {
  const events: DomainEvent[] = []
  for (let seq = from; seq <= to; seq += 1) events.push(outputEvent(log, seq, attemptId, seq - from, `chunk ${String(seq)}`))
  return events
}

function seqs(events: readonly PersistedEvent[]): number[] {
  return events.map((event) => event.seq)
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('Expected the call to reject')
}

// ─────────────────────────── EventStore ───────────────────────────

export function describeEventStore(name: string, make: Make<EventStore>): void {
  describe(`${name} · EventStore`, () => {
    test('an unknown log reads as empty, with last sequence number 0', async () => {
      const store = await make()
      expect(await store.read(A)).toEqual([])
      expect(await store.lastSeq(A)).toBe(0)
    })

    test('ordering: events read back in sequence order, across several appends', async () => {
      const store = await make()
      await store.append(A, run(A, 1, 3))
      await store.append(A, run(A, 4, 4))
      await store.append(A, run(A, 5, 12))
      const read = await store.read(A)
      expect(seqs(read)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
      expect(await store.lastSeq(A)).toBe(12)
    })

    test('ordering: sequence numbers order numerically, not as text', async () => {
      const store = await make()
      await store.append(A, run(A, 1, 25))
      expect(seqs(await store.read(A, 8))).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25])
    })

    test('read after a sequence number returns only the later events', async () => {
      const store = await make()
      await store.append(A, run(A, 1, 5))
      expect(seqs(await store.read(A, 3))).toEqual([4, 5])
      expect(seqs(await store.read(A, 5))).toEqual([])
      expect(seqs(await store.read(A, 0))).toEqual([1, 2, 3, 4, 5])
    })

    test('appends issued without waiting are applied in call order', async () => {
      const store = await make()
      await Promise.all([store.append(A, run(A, 1, 2)), store.append(A, run(A, 3, 5)), store.append(A, run(A, 6, 6))])
      expect(seqs(await store.read(A))).toEqual([1, 2, 3, 4, 5, 6])
    })

    test('of two concurrent appends at the same position, the first wins and the second is rejected', async () => {
      const store = await make()
      const first = outputEvent(A, 1, 'att_1', 0, 'first')
      const second = outputEvent(A, 1, 'att_2', 0, 'second')
      const results = await Promise.allSettled([store.append(A, [first]), store.append(A, [second])])
      expect(results[0]?.status).toBe('fulfilled')
      expect(results[1]?.status).toBe('rejected')
      expect(await store.read(A)).toEqual([first])
    })

    test('append-only: a stored event cannot be overwritten', async () => {
      const store = await make()
      const original = run(A, 1, 2)
      await store.append(A, original)
      const error = await rejectionOf(store.append(A, [outputEvent(A, 2, 'att_1', 1, 'rewritten')]))
      expect(error).toBeInstanceOf(EventStoreConflictError)
      expect((error as EventStoreConflictError).expectedSeq).toBe(3)
      expect((error as EventStoreConflictError).receivedSeq).toBe(2)
      expect(await store.read(A)).toEqual(original)
    })

    test('append-only: a gap is rejected with EventStoreConflictError', async () => {
      const store = await make()
      await store.append(A, run(A, 1, 2))
      const error = await rejectionOf(store.append(A, run(A, 4, 5)))
      expect(error).toBeInstanceOf(EventStoreConflictError)
      expect((error as EventStoreConflictError).expectedSeq).toBe(3)
      expect((error as EventStoreConflictError).receivedSeq).toBe(4)
      expect(await store.lastSeq(A)).toBe(2)
    })

    test('a new log must start at sequence number 1', async () => {
      const store = await make()
      expect(await rejectionOf(store.append(A, run(A, 2, 3)))).toBeInstanceOf(EventStoreConflictError)
      expect(await store.read(A)).toEqual([])
    })

    test('an append is atomic: a gap in the middle of a batch stores none of it', async () => {
      const store = await make()
      await store.append(A, run(A, 1, 1))
      const batch = [...run(A, 2, 3), outputEvent(A, 5, 'att_1', 4, 'gap')]
      expect(await rejectionOf(store.append(A, batch))).toBeInstanceOf(EventStoreConflictError)
      expect(seqs(await store.read(A))).toEqual([1])
      await store.append(A, run(A, 2, 3))
      expect(seqs(await store.read(A))).toEqual([1, 2, 3])
    })

    test("an event of another log is rejected and nothing is stored", async () => {
      const store = await make()
      await expect(store.append(A, [outputEvent(A, 1, 'att_1', 0, 'a'), outputEvent(B, 2, 'att_1', 1, 'b')])).rejects.toThrow()
      expect(await store.read(A)).toEqual([])
      expect(await store.read(B)).toEqual([])
    })

    test('an empty append changes nothing', async () => {
      const store = await make()
      await store.append(A, [])
      expect(await store.lastSeq(A)).toBe(0)
      await store.append(A, run(A, 1, 1))
      await store.append(A, [])
      expect(await store.lastSeq(A)).toBe(1)
    })

    test('logs are independent: each conversation and the app log count from 1', async () => {
      const store = await make()
      await store.append(A, run(A, 1, 3))
      await store.append(B, run(B, 1, 2))
      await store.append(APP_LOG, [appEvent(1, A), appEvent(2, B)])
      expect(seqs(await store.read(A))).toEqual([1, 2, 3])
      expect(seqs(await store.read(B))).toEqual([1, 2])
      expect((await store.read(APP_LOG)).map((event) => event.type)).toEqual(['conversation-created', 'conversation-created'])
      expect(await store.lastSeq(APP_LOG)).toBe(2)
    })

    test('events are stored as given and read back unchanged, schema version included', async () => {
      const store = await make()
      const events = run(A, 1, 2)
      await store.append(A, events)
      const read = await store.read(A)
      expect(read).toEqual(events)
      for (const event of read) {
        expect(event.v).toBe(EVENT_SCHEMA_VERSION)
        expect(upcastEvent(event)).toEqual(events[event.seq - 1])
      }
    })

    test('the store keeps copies: changing what was appended or read changes nothing stored', async () => {
      const store = await make()
      const appended = [{ ...outputEvent(A, 1, 'att_1', 0, 'kept') }] as Array<Record<string, unknown>>
      await store.append(A, appended as unknown as DomainEvent[])
      ;(appended[0] as Record<string, unknown>)['text'] = 'changed after append'
      const read = await store.read(A)
      ;(read[0] as unknown as Record<string, unknown>)['text'] = 'changed after read'
      expect((await store.read(A))[0]?.['text']).toBe('kept')
    })

    test('streamed output chunks of interleaved attempts keep their log order and their attempt', async () => {
      const store = await make()
      await store.append(A, [
        outputEvent(A, 1, 'att_x', 0, 'x0'),
        outputEvent(A, 2, 'att_y', 0, 'y0'),
        outputEvent(A, 3, 'att_x', 1, 'x1'),
        outputEvent(A, 4, 'att_y', 1, 'y1'),
      ])
      const read = await store.read(A)
      expect(read.map((event) => [event['attemptId'], event['index']])).toEqual([
        ['att_x', 0],
        ['att_y', 0],
        ['att_x', 1],
        ['att_y', 1],
      ])
    })

    test('deleting a conversation removes its whole log and nothing else', async () => {
      const store = await make()
      await store.append(A, run(A, 1, 4))
      await store.append(B, run(B, 1, 2))
      await store.append(APP_LOG, [appEvent(1, A)])
      await store.deleteLog(A)
      expect(await store.read(A)).toEqual([])
      expect(await store.lastSeq(A)).toBe(0)
      expect(seqs(await store.read(B))).toEqual([1, 2])
      expect(seqs(await store.read(APP_LOG))).toEqual([1])
    })

    test('a deleted log starts again at sequence number 1, and deleting a missing log is harmless', async () => {
      const store = await make()
      await store.append(A, run(A, 1, 3))
      await store.deleteLog(A)
      await store.deleteLog(A)
      await store.deleteLog(B)
      expect(await rejectionOf(store.append(A, run(A, 4, 4)))).toBeInstanceOf(EventStoreConflictError)
      await store.append(A, run(A, 1, 1))
      expect(seqs(await store.read(A))).toEqual([1])
    })
  })
}

// ─────────────────────────── ProjectionCache ───────────────────────────

const cachedState = (throughSeq: number, label: string): CachedState => ({
  throughSeq,
  stateVersion: 3,
  state: { label, nested: { list: [1, 'two', null, true] }, empty: null },
})

export function describeProjectionCache(name: string, make: Make<ProjectionCache>): void {
  describe(`${name} · ProjectionCache`, () => {
    test('nothing is cached for an unknown log', async () => {
      const cache = await make()
      expect(await cache.load(A)).toBeNull()
    })

    test('a saved state loads back equal', async () => {
      const cache = await make()
      await cache.save(A, cachedState(7, 'a'))
      expect(await cache.load(A)).toEqual(cachedState(7, 'a'))
    })

    test('save replaces what was cached', async () => {
      const cache = await make()
      await cache.save(A, cachedState(7, 'old'))
      await cache.save(A, cachedState(9, 'new'))
      expect(await cache.load(A)).toEqual(cachedState(9, 'new'))
    })

    test('entries are per log, and delete removes only its own', async () => {
      const cache = await make()
      await cache.save(A, cachedState(1, 'a'))
      await cache.save(B, cachedState(2, 'b'))
      await cache.save(APP_LOG, cachedState(3, 'app'))
      await cache.delete(A)
      await cache.delete(A)
      expect(await cache.load(A)).toBeNull()
      expect(await cache.load(B)).toEqual(cachedState(2, 'b'))
      expect(await cache.load(APP_LOG)).toEqual(cachedState(3, 'app'))
    })

    test('the cache keeps copies', async () => {
      const cache = await make()
      const saved = { throughSeq: 1, stateVersion: 1, state: { label: 'kept' } }
      await cache.save(A, saved)
      saved.state.label = 'changed after save'
      const loaded = await cache.load(A)
      ;(loaded?.state as Record<string, unknown>)['label'] = 'changed after load'
      expect((await cache.load(A))?.state).toEqual({ label: 'kept' })
    })
  })
}

// ─────────────────────────── SecretsStore ───────────────────────────

const KEY = 'sk-or-v1-conformance-0000000000000000000000000000'

export function describeSecretsStore(name: string, make: Make<SecretsStore>): void {
  describe(`${name} · SecretsStore`, () => {
    test('no key is stored at first', async () => {
      const secrets = await make()
      expect(await secrets.get('openrouter-key')).toBeNull()
    })

    test('a stored key reads back, and setting it again replaces it', async () => {
      const secrets = await make()
      await secrets.set('openrouter-key', KEY)
      expect(await secrets.get('openrouter-key')).toBe(KEY)
      await secrets.set('openrouter-key', `${KEY}-2`)
      expect(await secrets.get('openrouter-key')).toBe(`${KEY}-2`)
    })

    test('the OpenRouter key and the Anthropic key are held apart: each reads back, is replaced and is removed by itself', async () => {
      const secrets = await make()
      const anthropic = 'sk-ant-api03-conformance-0123456789'
      expect(await secrets.get('anthropic-key')).toBeNull()
      await secrets.set('openrouter-key', KEY)
      await secrets.set('anthropic-key', anthropic)
      expect(await secrets.get('openrouter-key')).toBe(KEY)
      expect(await secrets.get('anthropic-key')).toBe(anthropic)
      await secrets.set('anthropic-key', `${anthropic}-2`)
      expect(await secrets.get('openrouter-key')).toBe(KEY)
      await secrets.delete('anthropic-key')
      expect(await secrets.get('anthropic-key')).toBeNull()
      expect(await secrets.get('openrouter-key')).toBe(KEY)
      await secrets.delete('openrouter-key')
      expect(await secrets.get('openrouter-key')).toBeNull()
    })

    test('delete removes the key, and deleting a missing key is harmless', async () => {
      const secrets = await make()
      await secrets.set('openrouter-key', KEY)
      await secrets.delete('openrouter-key')
      expect(await secrets.get('openrouter-key')).toBeNull()
      await secrets.delete('openrouter-key')
      expect(await secrets.get('openrouter-key')).toBeNull()
    })
  })
}

// ─────────────────────────── the stores together ───────────────────────────

export interface StorageHarness {
  /** Opens the stores over this harness's databases. Opening again after `close()` is a reload. */
  open(): Promise<CommitteeStorage>
  /** A raw adapter over the same events database, to inspect everything stored there. */
  openRawEvents(): StorageAdapter
}

async function dumpEventsDatabase(harness: StorageHarness): Promise<string> {
  const raw = harness.openRawEvents()
  try {
    const stores = [...raw.schema.stores]
    const dump = await raw.read(stores, async (tx) => {
      const all: Record<string, unknown> = {}
      for (const store of stores) all[store] = await tx.getRange(store, { prefix: [] })
      return all
    })
    return JSON.stringify(dump)
  } finally {
    raw.close()
  }
}

export function describeCommitteeStorage(name: string, make: Make<StorageHarness>): void {
  describe(`${name} · storage`, () => {
    test('reload produces the same log, cache and key', async () => {
      const harness = await make()
      const first = await harness.open()
      const logA = [...run(A, 1, 3, 'att_1'), ...run(A, 4, 6, 'att_2')]
      await first.eventStore.append(APP_LOG, [appEvent(1, A), appEvent(2, B)])
      await first.eventStore.append(A, logA)
      await first.eventStore.append(B, run(B, 1, 2))
      await first.projectionCache.save(A, cachedState(6, 'a'))
      await first.secretsStore.set('openrouter-key', KEY)
      const before = {
        app: await first.eventStore.read(APP_LOG),
        a: await first.eventStore.read(A),
        b: await first.eventStore.read(B),
        logs: await first.eventStore.listLogs(),
      }
      first.close()

      const second = await harness.open()
      expect(await second.eventStore.read(APP_LOG)).toEqual(before.app)
      expect(await second.eventStore.read(A)).toEqual(before.a)
      expect(await second.eventStore.read(A)).toEqual(logA)
      expect(await second.eventStore.read(B)).toEqual(before.b)
      expect(await second.eventStore.lastSeq(A)).toBe(6)
      expect(await second.eventStore.listLogs()).toEqual(before.logs)
      expect(await second.eventStore.readAttemptOutput(A, 'att_2')).toEqual(logA.slice(3))
      expect(await second.projectionCache.load(A)).toEqual(cachedState(6, 'a'))
      expect(await second.secretsStore.get('openrouter-key')).toBe(KEY)
      // The reloaded log continues where it stopped.
      await second.eventStore.append(A, run(A, 7, 7, 'att_3'))
      expect(await rejectionOf(second.eventStore.append(A, run(A, 7, 7, 'att_3')))).toBeInstanceOf(EventStoreConflictError)
      second.close()
    })

    test('a closed store rejects further calls', async () => {
      const harness = await make()
      const storage = await harness.open()
      storage.close()
      await expect(storage.eventStore.read(A)).rejects.toThrow()
      await expect(storage.secretsStore.get('openrouter-key')).rejects.toThrow()
    })

    test('an event written at another schema version is kept as written, for upcasting on read', async () => {
      const harness = await make()
      const storage = await harness.open()
      const legacy = { ...outputEvent(A, 1, 'att_1', 0, 'old shape'), v: 0, legacyField: { kept: true } }
      await storage.eventStore.append(A, [legacy as unknown as DomainEvent])
      storage.close()
      const reopened = await harness.open()
      const [stored] = await reopened.eventStore.read(A)
      expect(stored).toEqual(legacy)
      expect(stored?.v).toBe(0)
      expect(() => upcastEvent(stored as PersistedEvent)).toThrow(/schema version/)
      reopened.close()
    })

    test('the conversation list: a log is listed from its first append until it is deleted', async () => {
      const harness = await make()
      const storage = await harness.open()
      expect(await storage.eventStore.listLogs()).toEqual([])
      await storage.eventStore.append(B, run(B, 1, 1))
      await storage.eventStore.append(A, run(A, 1, 2))
      await storage.eventStore.append(A, run(A, 3, 3))
      await storage.eventStore.append(APP_LOG, [appEvent(1, A)])
      const listed = (await storage.eventStore.listLogs()).map((record) => record.log)
      expect([...listed].sort()).toEqual([A, B, APP_LOG].sort())
      expect((await storage.eventStore.listLogs()).find((record) => record.log === A)?.createdAt).toBe(run(A, 1, 1)[0]?.at)
      await storage.eventStore.deleteLog(A)
      expect((await storage.eventStore.listLogs()).map((record) => record.log).sort()).toEqual([B, APP_LOG].sort())
      storage.close()
    })

    test('streamed output is grouped under its attempt, in chunk order', async () => {
      const harness = await make()
      const storage = await harness.open()
      const events = [
        outputEvent(A, 1, 'att_x', 0, 'x0'),
        outputEvent(A, 2, 'att_y', 0, 'y0'),
        outputEvent(A, 3, 'att_x', 1, 'x1'),
        outputEvent(A, 4, 'att_x', 2, 'x2'),
        outputEvent(A, 5, 'att_y', 1, 'y1'),
      ]
      await storage.eventStore.append(A, events.slice(0, 2))
      await storage.eventStore.append(A, events.slice(2))
      await storage.eventStore.append(B, [outputEvent(B, 1, 'att_x', 0, 'other conversation')])
      const texts = async (log: LogId, attempt: string) =>
        (await storage.eventStore.readAttemptOutput(log, attempt)).map((event) => event['text'])
      expect(await texts(A, 'att_x')).toEqual(['x0', 'x1', 'x2'])
      expect(await texts(A, 'att_y')).toEqual(['y0', 'y1'])
      expect(await texts(B, 'att_x')).toEqual(['other conversation'])
      expect(await texts(A, 'att_missing')).toEqual([])
      await storage.eventStore.deleteLog(A)
      expect(await texts(A, 'att_x')).toEqual([])
      expect(await texts(B, 'att_x')).toEqual(['other conversation'])
      storage.close()
    })

    test('a rejected append leaves no trace in the attempt grouping or the conversation list', async () => {
      const harness = await make()
      const storage = await harness.open()
      await expect(storage.eventStore.append(A, [outputEvent(A, 1, 'att_x', 0, 'x0'), outputEvent(A, 3, 'att_x', 1, 'x1')])).rejects.toBeInstanceOf(
        EventStoreConflictError,
      )
      expect(await storage.eventStore.readAttemptOutput(A, 'att_x')).toEqual([])
      expect(await storage.eventStore.listLogs()).toEqual([])
      storage.close()
    })

    test('the key never appears in the events database', async () => {
      const harness = await make()
      const storage = await harness.open()
      await storage.secretsStore.set('openrouter-key', KEY)
      await storage.eventStore.append(APP_LOG, [appEvent(1, A)])
      await storage.eventStore.append(A, run(A, 1, 4))
      await storage.projectionCache.save(A, cachedState(4, 'a'))
      expect(await storage.secretsStore.get('openrouter-key')).toBe(KEY)
      storage.close()

      const dump = await dumpEventsDatabase(harness)
      expect(dump).toContain('chunk 4')
      expect(dump).not.toContain(KEY)
      expect(dump).not.toContain('sk-or-')
      expect(EVENTS_DATABASE.stores).not.toContain('secrets')
    })

    test('the secrets store offers set, clear and "is configured"; only the backend reads the value', async () => {
      const harness = await make()
      const storage = await harness.open()
      const controls = secretControls(storage.secretsStore)
      expect(Object.keys(controls).sort()).toEqual(['clear', 'isConfigured', 'set'])
      expect(await controls.isConfigured('openrouter-key')).toBe(false)
      await controls.set('openrouter-key', `  ${KEY}\n`)
      expect(await controls.isConfigured('openrouter-key')).toBe(true)
      expect(await storage.secretsStore.get('openrouter-key')).toBe(KEY)
      await controls.clear('openrouter-key')
      expect(await controls.isConfigured('openrouter-key')).toBe(false)
      expect(await storage.secretsStore.get('openrouter-key')).toBeNull()
      storage.close()
    })

    test('an empty key is refused, and the refusal does not repeat what was given', async () => {
      const harness = await make()
      const storage = await harness.open()
      const error = await rejectionOf(storage.secretsStore.set('openrouter-key', '   '))
      expect(error).toBeInstanceOf(Error)
      expect(await storage.secretsStore.isConfigured('openrouter-key')).toBe(false)
      const unknown = await rejectionOf(storage.secretsStore.set('other' as 'openrouter-key', KEY))
      expect(String((unknown as Error).message)).not.toContain(KEY)
      storage.close()
    })
  })
}

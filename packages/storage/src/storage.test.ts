import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, test } from 'vitest'
import { describeCommitteeStorage, describeEventStore, describeProjectionCache, describeSecretsStore, type StorageHarness } from './conformance'
import { compareKeys, keyInRange, type StorageKey } from './adapter'
import { EVENTS_DATABASE } from './event-store'
import { createMemoryStorage, MemoryDatabase, openIndexedDbAdapter, openIndexedDbStorage, openMemoryAdapter } from './index'

function indexedDbHarness(): StorageHarness {
  // A fresh factory per test is a fresh, empty set of databases.
  const indexedDB = new IDBFactory()
  return {
    open: () => openIndexedDbStorage({ indexedDB }),
    openRawEvents: () => openIndexedDbAdapter(EVENTS_DATABASE, { indexedDB }),
  }
}

function memoryHarness(): StorageHarness {
  const events = new MemoryDatabase()
  const secrets = new MemoryDatabase()
  return {
    open: () => Promise.resolve(createMemoryStorage({ events, secrets })),
    openRawEvents: () => openMemoryAdapter(EVENTS_DATABASE, events),
  }
}

const adapters: ReadonlyArray<readonly [string, () => StorageHarness]> = [
  ['IndexedDB adapter', indexedDbHarness],
  ['in-memory adapter', memoryHarness],
]

for (const [name, harness] of adapters) {
  describeEventStore(name, async () => (await harness().open()).eventStore)
  describeProjectionCache(name, async () => (await harness().open()).projectionCache)
  describeSecretsStore(name, async () => (await harness().open()).secretsStore)
  describeCommitteeStorage(name, harness)
}

describe('IndexedDB storage', () => {
  test('keeps the key in committee-secrets, a database separate from committee-events', async () => {
    const indexedDB = new IDBFactory()
    const storage = await openIndexedDbStorage({ indexedDB })
    await storage.secretsStore.set('openrouter-key', 'sk-or-v1-separate-database')
    const names = (await indexedDB.databases()).map((database) => database.name).sort()
    expect(names).toEqual(['committee-events', 'committee-secrets'])
    storage.close()
  })

  test('uses the global indexedDB when none is given, as in a Web Worker (no window, no localStorage)', async () => {
    expect(typeof (globalThis as { window?: unknown }).window).toBe('undefined')
    expect(typeof (globalThis as { localStorage?: unknown }).localStorage).toBe('undefined')
    const storage = await openIndexedDbStorage({ eventsDatabaseName: 'global-events', secretsDatabaseName: 'global-secrets' })
    await storage.eventStore.append('app', [])
    expect(await storage.eventStore.lastSeq('app')).toBe(0)
    storage.close()
  })

  test('refuses to put the secrets in the events database', async () => {
    await expect(openIndexedDbStorage({ indexedDB: new IDBFactory(), eventsDatabaseName: 'same', secretsDatabaseName: 'same' })).rejects.toThrow()
  })

  test('steps aside when another connection upgrades the database, and reconnects on next use', async () => {
    const indexedDB = new IDBFactory()
    const storage = await openIndexedDbStorage({ indexedDB })
    await storage.projectionCache.save('app', { throughSeq: 1, stateVersion: 1, state: null })
    const upgraded = openIndexedDbAdapter({ ...EVENTS_DATABASE, version: 2 }, { indexedDB })
    await upgraded.read(['events'], () => Promise.resolve())
    upgraded.close()
    // Our version-1 connection closed for the upgrade; reopening at version 1 now fails with a VersionError.
    await expect(storage.projectionCache.load('app')).rejects.toThrow()
    storage.close()
  })
})

describe('adapter key order', () => {
  test('matches IndexedDB: numbers before strings, element by element, shorter first', () => {
    const keys: StorageKey[] = [['b'], ['a', 'x'], ['a', 10], ['a', 2], ['a'], ['a', 2, 'z'], [1]]
    expect([...keys].sort(compareKeys)).toEqual([[1], ['a'], ['a', 2], ['a', 2, 'z'], ['a', 10], ['a', 'x'], ['b']])
  })

  test('a range matches its prefix, and bounds apply to the next element', () => {
    expect(keyInRange(['a', 3], { prefix: ['a'] })).toBe(true)
    expect(keyInRange(['ab', 3], { prefix: ['a'] })).toBe(false)
    expect(keyInRange(['a', 3], { prefix: ['a'], from: 4 })).toBe(false)
    expect(keyInRange(['a', 'x'], { prefix: ['a'], from: 0 })).toBe(false)
    expect(keyInRange(['a', 4, 'z'], { prefix: ['a'], to: 4 })).toBe(true)
  })
})

describe('in-memory adapter', () => {
  test('a failed transaction is rolled back', async () => {
    const adapter = openMemoryAdapter({ name: 'm', version: 1, stores: ['s'] })
    await adapter.write(['s'], (tx) => {
      tx.put('s', ['k', 1], 'kept')
      return Promise.resolve()
    })
    await expect(
      adapter.write(['s'], (tx) => {
        tx.put('s', ['k', 1], 'overwritten')
        tx.put('s', ['k', 2], 'added')
        tx.deleteRange('s', { prefix: [] })
        return Promise.reject(new Error('abort'))
      }),
    ).rejects.toThrow('abort')
    const entries = await adapter.read(['s'], (tx) => tx.getRange('s', { prefix: [] }))
    expect(entries).toEqual([{ key: ['k', 1], value: 'kept' }])
  })
})

describe('IndexedDB adapter', () => {
  test('a failed transaction is rolled back', async () => {
    const adapter = openIndexedDbAdapter({ name: 'i', version: 1, stores: ['s'] }, { indexedDB: new IDBFactory() })
    await adapter.write(['s'], (tx) => {
      tx.put('s', ['k', 1], 'kept')
      return Promise.resolve()
    })
    await expect(
      adapter.write(['s'], async (tx) => {
        tx.put('s', ['k', 2], 'added')
        await tx.get('s', ['k', 1])
        tx.deleteRange('s', { prefix: [] })
        throw new Error('abort')
      }),
    ).rejects.toThrow('abort')
    const entries = await adapter.read(['s'], (tx) => tx.getRange('s', { prefix: [] }))
    expect(entries).toEqual([{ key: ['k', 1], value: 'kept' }])
    expect(await adapter.read(['s'], (tx) => tx.getRange('s', { prefix: ['k'] }, { reverse: true, limit: 1 }))).toEqual([
      { key: ['k', 1], value: 'kept' },
    ])
    adapter.close()
  })
})

import { wrap, type IDBPDatabase, type IDBPTransaction } from 'idb'
import {
  assertValidKey,
  assertValidRange,
  StorageClosedError,
  type DatabaseSchema,
  type KeyRange,
  type RangeOptions,
  type StorageAdapter,
  type StorageEntry,
  type StorageKey,
  type WriteTransaction,
} from './adapter'

export interface IndexedDbAdapterOptions {
  /**
   * The IndexedDB factory. Defaults to `globalThis.indexedDB`, which exists
   * in a window and in a Web Worker alike; tests pass `fake-indexeddb`'s.
   */
  readonly indexedDB?: IDBFactory
}

type Database = IDBPDatabase<unknown>
type Transaction = IDBPTransaction<unknown, string[], IDBTransactionMode>

/**
 * Builds the IndexedDB key range for a {@link KeyRange}. Relies on the
 * array-key order: an empty array sorts after every number and string, so
 * `[...prefix, []]` bounds everything that starts with `prefix`.
 */
function toIdbRange(range: KeyRange): IDBKeyRange | undefined {
  const prefix = [...range.prefix]
  if (range.from === undefined && range.to === undefined) {
    if (prefix.length === 0) return undefined
    return IDBKeyRange.bound(prefix, [...prefix, []])
  }
  return IDBKeyRange.bound([...prefix, range.from ?? -Infinity], [...prefix, range.to ?? Infinity, []])
}

function asKey(key: IDBValidKey): StorageKey {
  return key as unknown as StorageKey
}

function resolveFactory(options: IndexedDbAdapterOptions): IDBFactory {
  const factory = options.indexedDB ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB
  if (factory === undefined) throw new Error('IndexedDB is not available in this environment')
  return factory
}

/**
 * Opens an adapter over one IndexedDB database. Uses only what a dedicated
 * Web Worker has (`indexedDB`, `IDBKeyRange`, structured clone): no
 * `window`, `document` or `localStorage`.
 *
 * The connection is opened lazily and reopened after the browser closes it,
 * or after it is closed to let another context upgrade the database
 * (`versionchange`). Transactions are created in request order, which is
 * also IndexedDB's execution order for transactions over the same stores.
 */
export function openIndexedDbAdapter(schema: DatabaseSchema, options: IndexedDbAdapterOptions = {}): StorageAdapter {
  const factory = resolveFactory(options)
  let closed = false
  let connection: Promise<Database> | null = null

  function connect(): Promise<Database> {
    if (connection !== null) return connection
    const opening = new Promise<Database>((resolve, reject) => {
      const request = factory.open(schema.name, schema.version)
      request.onupgradeneeded = () => {
        const db = request.result
        for (const store of schema.stores) {
          if (!db.objectStoreNames.contains(store)) db.createObjectStore(store)
        }
      }
      request.onsuccess = () => {
        const db = request.result
        // Another context wants a newer version: step aside and reopen on next use.
        db.onversionchange = () => {
          db.close()
          if (connection === opening) connection = null
        }
        // The browser closed the connection (storage cleared, disk error): reopen on next use.
        db.onclose = () => {
          if (connection === opening) connection = null
        }
        resolve(wrap(db))
      }
      request.onerror = () => {
        reject(request.error ?? new Error(`Could not open ${schema.name}`))
      }
      // onblocked: an older connection elsewhere has not closed yet; open waits for it.
    })
    connection = opening
    opening.catch(() => {
      if (connection === opening) connection = null
    })
    return opening
  }

  async function run<T>(stores: readonly string[], mode: IDBTransactionMode, fn: (tx: WriteTransaction) => Promise<T>): Promise<T> {
    if (closed) throw new StorageClosedError(schema.name)
    const db = await connect()
    if (closed) throw new StorageClosedError(schema.name)
    const tx = db.transaction([...stores], mode) as Transaction
    // Settles on commit or abort; observed here so an abort is never an unhandled rejection.
    const done = tx.done.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    )

    const storeOf = (name: string) => {
      if (!stores.includes(name)) throw new Error(`Object store ${name} is not in this transaction`)
      return tx.objectStore(name)
    }

    const getRange = async (name: string, range: KeyRange, rangeOptions: RangeOptions = {}): Promise<StorageEntry[]> => {
      assertValidRange(range)
      const store = storeOf(name)
      const query = toIdbRange(range)
      const limit = rangeOptions.limit === undefined ? undefined : Math.max(0, rangeOptions.limit)
      if (limit === 0) return []
      if (rangeOptions.reverse !== true) {
        const [keys, values] = await Promise.all([store.getAllKeys(query, limit), store.getAll(query, limit)])
        return keys.map((key, i) => ({ key: asKey(key), value: values[i] as unknown }))
      }
      const entries: StorageEntry[] = []
      let cursor = await store.openCursor(query, 'prev')
      while (cursor !== null && (limit === undefined || entries.length < limit)) {
        entries.push({ key: asKey(cursor.key), value: cursor.value as unknown })
        cursor = await cursor.continue()
      }
      return entries
    }

    const api: WriteTransaction = {
      async get(name, key) {
        assertValidKey(key)
        return (await storeOf(name).get([...key])) as unknown
      },
      getRange,
      async has(name, range) {
        assertValidRange(range)
        return (await storeOf(name).count(toIdbRange(range))) > 0
      },
      put(name, key, value) {
        assertValidKey(key)
        const store = storeOf(name)
        if (store.put === undefined) throw new Error('The transaction is read-only')
        void store.put(value, [...key]).catch(() => undefined)
      },
      delete(name, key) {
        assertValidKey(key)
        const store = storeOf(name)
        if (store.delete === undefined) throw new Error('The transaction is read-only')
        void store.delete([...key]).catch(() => undefined)
      },
      deleteRange(name, range) {
        assertValidRange(range)
        const store = storeOf(name)
        if (store.delete === undefined || store.clear === undefined) throw new Error('The transaction is read-only')
        const query = toIdbRange(range)
        void (query === undefined ? store.clear() : store.delete(query)).catch(() => undefined)
      },
    }

    let result: T
    try {
      result = await fn(api)
    } catch (error) {
      try {
        tx.abort()
      } catch {
        // Already finished; the outcome below says how.
      }
      await done
      throw error
    }
    const outcome = await done
    if (!outcome.ok) throw outcome.error
    return result
  }

  return {
    schema,
    read: (stores, fn) => run(stores, 'readonly', fn),
    write: (stores, fn) => run(stores, 'readwrite', fn),
    close() {
      closed = true
      const current = connection
      connection = null
      void current?.then((db) => db.close(), () => undefined)
    },
  }
}

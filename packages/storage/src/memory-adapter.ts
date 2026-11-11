import {
  assertValidKey,
  assertValidRange,
  compareKeys,
  keyInRange,
  StorageClosedError,
  type DatabaseSchema,
  type KeyRange,
  type RangeOptions,
  type StorageAdapter,
  type StorageEntry,
  type StorageKey,
  type WriteTransaction,
} from './adapter'

interface Row {
  readonly key: StorageKey
  readonly value: unknown
}

type StoreRows = Map<string, Row>

/**
 * The data of one in-memory database. It outlives the adapters opened over
 * it, so a test can close an adapter and open a new one over the same data,
 * the way a reload reopens an IndexedDB database.
 */
export class MemoryDatabase {
  /** @internal store name → encoded key → row */
  readonly stores = new Map<string, StoreRows>()
  /** @internal one queue for every adapter over this data: transactions run in request order. */
  tail: Promise<unknown> = Promise.resolve()
}

/** Encodes a key so that equal keys, and only equal keys, give the same string. */
function encode(key: StorageKey): string {
  return JSON.stringify(key)
}

/**
 * Opens an adapter over `database` (a fresh one when omitted). Behaves like
 * the IndexedDB adapter: values are structured-cloned in and out, each
 * transaction is atomic, and transactions run strictly in the order they
 * were requested.
 */
export function openMemoryAdapter(schema: DatabaseSchema, database: MemoryDatabase = new MemoryDatabase()): StorageAdapter {
  for (const name of schema.stores) {
    if (!database.stores.has(name)) database.stores.set(name, new Map())
  }
  let closed = false

  function rowsOf(store: string, allowed: readonly string[]): StoreRows {
    if (!allowed.includes(store)) throw new Error(`Object store ${store} is not in this transaction`)
    const rows = database.stores.get(store)
    if (!rows) throw new Error(`Object store ${store} does not exist in ${schema.name}`)
    return rows
  }

  function rangeOf(rows: StoreRows, range: KeyRange, options: RangeOptions = {}): StorageEntry[] {
    assertValidRange(range)
    const matching = [...rows.values()].filter((row) => keyInRange(row.key, range))
    matching.sort((a, b) => compareKeys(a.key, b.key))
    if (options.reverse === true) matching.reverse()
    const limited = options.limit === undefined ? matching : matching.slice(0, Math.max(0, options.limit))
    return limited.map((row) => ({ key: [...row.key], value: structuredClone(row.value) }))
  }

  function run<T>(stores: readonly string[], writable: boolean, fn: (tx: WriteTransaction) => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new StorageClosedError(schema.name))
    for (const store of stores) rowsOf(store, stores)

    const execute = async (): Promise<T> => {
      if (closed) throw new StorageClosedError(schema.name)
      // Writes go straight to the rows; the undo journal restores them if the transaction fails.
      const undo: Array<() => void> = []
      let active = true

      const assertActive = (): void => {
        if (!active) throw new Error('The transaction has finished')
      }
      const assertWritable = (): void => {
        assertActive()
        if (!writable) throw new Error('The transaction is read-only')
      }
      const remove = (rows: StoreRows, encoded: string): void => {
        const previous = rows.get(encoded)
        if (previous === undefined) return
        rows.delete(encoded)
        undo.push(() => rows.set(encoded, previous))
      }

      const tx: WriteTransaction = {
        get(store, key) {
          assertActive()
          assertValidKey(key)
          const row = rowsOf(store, stores).get(encode(key))
          return Promise.resolve(row === undefined ? undefined : structuredClone(row.value))
        },
        getRange(store, range, options) {
          assertActive()
          return Promise.resolve(rangeOf(rowsOf(store, stores), range, options))
        },
        has(store, range) {
          assertActive()
          return Promise.resolve(rangeOf(rowsOf(store, stores), range, { limit: 1 }).length > 0)
        },
        put(store, key, value) {
          assertWritable()
          assertValidKey(key)
          const rows = rowsOf(store, stores)
          const encoded = encode(key)
          const row: Row = { key: [...key], value: structuredClone(value) }
          const previous = rows.get(encoded)
          rows.set(encoded, row)
          undo.push(() => {
            if (previous === undefined) rows.delete(encoded)
            else rows.set(encoded, previous)
          })
        },
        delete(store, key) {
          assertWritable()
          assertValidKey(key)
          remove(rowsOf(store, stores), encode(key))
        },
        deleteRange(store, range) {
          assertWritable()
          assertValidRange(range)
          const rows = rowsOf(store, stores)
          for (const [encoded, row] of [...rows]) {
            if (keyInRange(row.key, range)) remove(rows, encoded)
          }
        },
      }

      try {
        const result = await fn(tx)
        active = false
        return result
      } catch (error) {
        active = false
        for (let i = undo.length - 1; i >= 0; i -= 1) undo[i]?.()
        throw error
      }
    }

    const result = database.tail.then(execute)
    database.tail = result.catch(() => undefined)
    return result
  }

  return {
    schema,
    read: (stores, fn) => run(stores, false, fn),
    write: (stores, fn) => run(stores, true, fn),
    close() {
      closed = true
    },
  }
}

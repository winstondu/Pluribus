/**
 * The one adapter interface both stores are built on (11 · "Records and
 * storage": the event store and the projection cache sit behind the same
 * adapter interfaces, Q58, Q63). It is a small transactional key-value
 * store with ordered range reads, shaped after IndexedDB so the in-memory
 * adapter can behave identically:
 *
 * - A database has named object stores, fixed when it is opened.
 * - A key is an array of strings and numbers. Keys order element by element,
 *   numbers before strings, and a shorter key before a longer one that starts
 *   with it (IndexedDB's array-key order).
 * - Values are structured-cloned on the way in and on the way out: a caller
 *   never shares an object with the store.
 * - A transaction is atomic: every write in it is applied or none is. If the
 *   callback throws or rejects, the transaction is aborted.
 * - Transactions run one after another in the order they were requested
 *   (a write never interleaves with another transaction it overlaps).
 *
 * The callback may await only the transaction's own reads. Awaiting anything
 * else (a timer, a fetch, another transaction) lets an IndexedDB transaction
 * commit early, and makes the in-memory adapter wait on itself.
 */

/** One element of a key. Numbers must be finite. */
export type KeyPart = string | number

/** A storage key: an array of parts, compared element by element. */
export type StorageKey = readonly KeyPart[]

/**
 * Every key that starts with `prefix`. When `from` or `to` is given, the key
 * element directly after the prefix must be a number within those inclusive
 * bounds. An empty prefix with no bounds is the whole object store.
 */
export interface KeyRange {
  readonly prefix: StorageKey
  readonly from?: number
  readonly to?: number
}

export interface RangeOptions {
  /** Descending key order. Default false. */
  readonly reverse?: boolean
  /** At most this many entries. */
  readonly limit?: number
}

export interface StorageEntry {
  readonly key: StorageKey
  readonly value: unknown
}

export interface ReadTransaction {
  /** The value under `key`, or `undefined` when there is none. */
  get(store: string, key: StorageKey): Promise<unknown>
  /** The entries in `range`, in key order. */
  getRange(store: string, range: KeyRange, options?: RangeOptions): Promise<readonly StorageEntry[]>
  /** Whether any key falls in `range`. */
  has(store: string, range: KeyRange): Promise<boolean>
}

/**
 * Writes are queued in call order and applied when the transaction commits.
 * Reads issued after a write in the same transaction see it.
 */
export interface WriteTransaction extends ReadTransaction {
  put(store: string, key: StorageKey, value: unknown): void
  delete(store: string, key: StorageKey): void
  deleteRange(store: string, range: KeyRange): void
}

export interface DatabaseSchema {
  /** Database name: `pluribus-events`, `pluribus-secrets`. */
  readonly name: string
  /** Schema version of the database layout (object stores), not of the events. */
  readonly version: number
  readonly stores: readonly string[]
}

export interface StorageAdapter {
  readonly schema: DatabaseSchema
  /** Runs a read-only transaction over `stores`. */
  read<T>(stores: readonly string[], fn: (tx: ReadTransaction) => Promise<T>): Promise<T>
  /** Runs an atomic read-write transaction over `stores`. Resolves once it has committed. */
  write<T>(stores: readonly string[], fn: (tx: WriteTransaction) => Promise<T>): Promise<T>
  /** Closes the connection. Later calls reject. */
  close(): void
}

/** Rejection for a call on a closed adapter. */
export class StorageClosedError extends Error {
  constructor(name: string) {
    super(`Storage database ${name} is closed`)
    this.name = 'StorageClosedError'
  }
}

// ─────────────────────────── key helpers, shared by both adapters ───────────────────────────

/** Throws when a key cannot be stored. */
export function assertValidKey(key: StorageKey): void {
  if (!Array.isArray(key)) throw new TypeError('A storage key must be an array')
  for (const part of key) {
    if (typeof part === 'number') {
      if (!Number.isFinite(part)) throw new TypeError('A storage key number must be finite')
    } else if (typeof part !== 'string') {
      throw new TypeError('A storage key part must be a string or a number')
    }
  }
}

function comparePart(a: KeyPart, b: KeyPart): number {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0
  if (typeof a === 'number') return -1
  if (typeof b === 'number') return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** IndexedDB's order for array keys of strings and numbers. */
export function compareKeys(a: StorageKey, b: StorageKey): number {
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i += 1) {
    const order = comparePart(a[i] as KeyPart, b[i] as KeyPart)
    if (order !== 0) return order
  }
  return a.length - b.length
}

/** Whether `key` falls in `range`. */
export function keyInRange(key: StorageKey, range: KeyRange): boolean {
  if (key.length < range.prefix.length) return false
  for (let i = 0; i < range.prefix.length; i += 1) {
    if (comparePart(key[i] as KeyPart, range.prefix[i] as KeyPart) !== 0) return false
  }
  if (range.from === undefined && range.to === undefined) return true
  const next = key[range.prefix.length]
  if (typeof next !== 'number') return false
  if (range.from !== undefined && next < range.from) return false
  if (range.to !== undefined && next > range.to) return false
  return true
}

export function assertValidRange(range: KeyRange): void {
  assertValidKey(range.prefix)
  if (range.from !== undefined && Number.isNaN(range.from)) throw new TypeError('A range bound must be a number')
  if (range.to !== undefined && Number.isNaN(range.to)) throw new TypeError('A range bound must be a number')
}

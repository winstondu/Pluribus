/**
 * @pluribus/storage — the event store, projection cache and local secrets
 * store behind one adapter interface, with an IndexedDB adapter for the
 * embedded backend and an in-memory adapter for tests (11 · "Records and
 * storage", Q58, Q63, Q64).
 *
 * The conformance suites are a separate entry, `@pluribus/storage/conformance`,
 * because they import `vitest` and this entry is bundled into the Worker.
 */
export type {
  DatabaseSchema,
  KeyPart,
  KeyRange,
  RangeOptions,
  ReadTransaction,
  StorageAdapter,
  StorageEntry,
  StorageKey,
  WriteTransaction,
} from './adapter'
export { StorageClosedError, compareKeys } from './adapter'
export { openIndexedDbAdapter, type IndexedDbAdapterOptions } from './indexeddb-adapter'
export { MemoryDatabase, openMemoryAdapter } from './memory-adapter'
export { createEventStore, EVENT_STORES, EVENTS_DATABASE, type LocalEventStore, type LogRecord } from './event-store'
export { createProjectionCache } from './projection-cache'
export {
  createSecretsStore,
  secretControls,
  SECRETS_DATABASE,
  SecretsStoreError,
  type LocalSecretsStore,
  type SecretControls,
} from './secrets-store'
export {
  createMemoryStorage,
  openIndexedDbStorage,
  type PluribusStorage,
  type IndexedDbStorageOptions,
  type MemoryStorageOptions,
} from './storage'

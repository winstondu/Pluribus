import type { ProjectionCache } from '@pluribus/core/ports'
import type { DatabaseSchema, StorageAdapter } from './adapter'
import { createEventStore, EVENTS_DATABASE, type LocalEventStore } from './event-store'
import { openIndexedDbAdapter } from './indexeddb-adapter'
import { MemoryDatabase, openMemoryAdapter } from './memory-adapter'
import { createProjectionCache } from './projection-cache'
import { createSecretsStore, SECRETS_DATABASE, type LocalSecretsStore } from './secrets-store'

/** The three stores the backend is given (`CoreDependencies`), over two separate databases. */
export interface PluribusStorage {
  readonly eventStore: LocalEventStore
  readonly projectionCache: ProjectionCache
  readonly secretsStore: LocalSecretsStore
  /** Closes both databases. */
  close(): void
}

function storageOver(events: StorageAdapter, secrets: StorageAdapter): PluribusStorage {
  return {
    eventStore: createEventStore(events),
    projectionCache: createProjectionCache(events),
    secretsStore: createSecretsStore(secrets),
    close() {
      events.close()
      secrets.close()
    },
  }
}

export interface IndexedDbStorageOptions {
  /** Defaults to `globalThis.indexedDB` (the Worker's). */
  readonly indexedDB?: IDBFactory
  /** Database names, for tests. Default `pluribus-events` and `pluribus-secrets`. */
  readonly eventsDatabaseName?: string
  readonly secretsDatabaseName?: string
}

/**
 * Opens the embedded backend's storage: `pluribus-events` for the event
 * logs and the projection cache, and `pluribus-secrets`, a separate
 * database, for the OpenRouter key. Call it in the Worker. Resolves once
 * both databases are open, so a broken or blocked database fails here.
 */
export async function openIndexedDbStorage(options: IndexedDbStorageOptions = {}): Promise<PluribusStorage> {
  const adapterOptions = options.indexedDB === undefined ? {} : { indexedDB: options.indexedDB }
  const eventsSchema: DatabaseSchema = { ...EVENTS_DATABASE, name: options.eventsDatabaseName ?? EVENTS_DATABASE.name }
  const secretsSchema: DatabaseSchema = { ...SECRETS_DATABASE, name: options.secretsDatabaseName ?? SECRETS_DATABASE.name }
  if (eventsSchema.name === secretsSchema.name) throw new Error('The secrets database must be separate from the events database')
  const events = openIndexedDbAdapter(eventsSchema, adapterOptions)
  const secrets = openIndexedDbAdapter(secretsSchema, adapterOptions)
  try {
    await Promise.all([
      events.read([...eventsSchema.stores], () => Promise.resolve()),
      secrets.read([...secretsSchema.stores], () => Promise.resolve()),
    ])
  } catch (error) {
    events.close()
    secrets.close()
    throw error
  }
  return storageOver(events, secrets)
}

export interface MemoryStorageOptions {
  /** Existing data to open over, to simulate a reload. Fresh when omitted. */
  readonly events?: MemoryDatabase
  readonly secrets?: MemoryDatabase
}

/** The same three stores in memory, with the same behavior as {@link openIndexedDbStorage}. */
export function createMemoryStorage(options: MemoryStorageOptions = {}): PluribusStorage {
  return storageOver(
    openMemoryAdapter(EVENTS_DATABASE, options.events ?? new MemoryDatabase()),
    openMemoryAdapter(SECRETS_DATABASE, options.secrets ?? new MemoryDatabase()),
  )
}

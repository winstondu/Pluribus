import type { SecretName, SecretsStore } from '@pluribus/core/ports'
import type { DatabaseSchema, StorageAdapter } from './adapter'

const SECRETS = 'secrets'

/**
 * Layout of the secrets database. It is a database of its own, never an
 * object store inside `pluribus-events`, so the key cannot travel with an
 * export, a copy or a dump of the event log or the projection cache (Q64, Q73).
 */
export const SECRETS_DATABASE: DatabaseSchema = {
  name: 'pluribus-secrets',
  version: 1,
  stores: [SECRETS],
}

const SECRET_NAMES: readonly SecretName[] = ['openrouter-key', 'anthropic-key']

/**
 * The local secrets store. The port's `get` is the read reserved for the
 * backend: only the provider's `getKey` calls it, in the Worker. Everything
 * else (settings, the key prompt) uses {@link SecretControls}.
 */
export interface LocalSecretsStore extends SecretsStore {
  /** Whether a secret is stored. Settings show only this (Q64). */
  isConfigured(name: SecretName): Promise<boolean>
  /** Removes the secret; same as `delete`. */
  clear(name: SecretName): Promise<void>
}

/** The secrets store without its read: set, clear and "is configured". */
export interface SecretControls {
  set(name: SecretName, value: string): Promise<void>
  clear(name: SecretName): Promise<void>
  isConfigured(name: SecretName): Promise<boolean>
}

/** Rejection of a secrets operation. Its message never contains a secret. */
export class SecretsStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecretsStoreError'
  }
}

function assertName(name: SecretName): void {
  if (!SECRET_NAMES.includes(name)) throw new SecretsStoreError('Unknown secret name')
}

/**
 * Runs a storage call so that a failure surfaces as a {@link SecretsStoreError}
 * naming the operation only: an underlying error could carry the value.
 */
async function guarded<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof SecretsStoreError) throw error
    const kind = error instanceof Error ? error.name : 'Error'
    throw new SecretsStoreError(`Secrets store ${operation} failed (${kind})`)
  }
}

/**
 * A {@link SecretsStore} over an adapter whose schema is
 * {@link SECRETS_DATABASE}. Open that adapter on its own database; never
 * pass the events database's adapter here. `set` stores the value with
 * surrounding whitespace removed (a pasted key often ends in a newline).
 */
export function createSecretsStore(adapter: StorageAdapter): LocalSecretsStore {
  const ownDatabase = adapter.schema.stores.length === 1 && adapter.schema.stores[0] === SECRETS
  if (!ownDatabase) {
    throw new SecretsStoreError(`The secrets store needs its own database, ${SECRETS_DATABASE.name}`)
  }

  const remove = (name: SecretName): Promise<void> =>
    guarded('clear', async () => {
      assertName(name)
      await adapter.write([SECRETS], (tx) => {
        tx.delete(SECRETS, [name])
        return Promise.resolve()
      })
    })

  const get = (name: SecretName): Promise<string | null> =>
    guarded('read', async () => {
      assertName(name)
      const value = await adapter.read([SECRETS], (tx) => tx.get(SECRETS, [name]))
      return typeof value === 'string' && value.length > 0 ? value : null
    })

  return {
    get,
    set(name, value) {
      return guarded('set', async () => {
        assertName(name)
        if (typeof value !== 'string' || value.trim().length === 0) throw new SecretsStoreError('A secret must be a non-empty string')
        await adapter.write([SECRETS], (tx) => {
          tx.put(SECRETS, [name], value.trim())
          return Promise.resolve()
        })
      })
    },
    delete: remove,
    clear: remove,
    async isConfigured(name) {
      return (await get(name)) !== null
    },
  }
}

/** The store's controls without its read, for code that must never see the value. */
export function secretControls(store: LocalSecretsStore): SecretControls {
  return {
    set: (name, value) => store.set(name, value),
    clear: (name) => store.clear(name),
    isConfigured: (name) => store.isConfigured(name),
  }
}

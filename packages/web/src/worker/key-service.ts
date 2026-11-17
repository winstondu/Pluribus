import type { KeyCheck, KeyProviderName } from '@pluribus/protocol'
import type { KeyService } from './key-channel'

/**
 * The embedded backend's key service: the only code that writes a provider
 * key. It runs in the Worker, over the local secrets store.
 *
 * - `check` asks the provider about a key that is not stored yet.
 * - `set` and `remove` write the secrets store, then tell the backend that
 *   the key status changed. The backend reads only whether each key is
 *   present, and records that.
 *
 * Nothing here returns, logs or throws a key: a failure is reported by a
 * fixed message.
 */

/** The secrets store's write side, by secret name. */
export interface KeyVault {
  set(name: 'openrouter-key', value: string): Promise<void>
  delete(name: 'openrouter-key'): Promise<void>
}

export interface KeyServiceDependencies {
  readonly vault: KeyVault
  /** `Backend.refreshKeyStatus`. */
  readonly refreshKeyStatus: () => Promise<void>
  readonly checks: { readonly [P in KeyProviderName]: (key: string, signal: AbortSignal) => Promise<KeyCheck> }
}

const SECRET_NAMES = { openrouter: 'openrouter-key' } as const

export function createKeyService(deps: KeyServiceDependencies): KeyService {
  return {
    check: (provider, key, signal) => deps.checks[provider](key, signal),
    async set(provider, key) {
      if (key.trim() === '') return { ok: false, message: 'The key cannot be empty.' }
      try {
        await deps.vault.set(SECRET_NAMES[provider], key)
        await deps.refreshKeyStatus()
        return { ok: true }
      } catch {
        return { ok: false, message: 'The key could not be stored in this browser.' }
      }
    },
    async remove(provider) {
      try {
        await deps.vault.delete(SECRET_NAMES[provider])
        await deps.refreshKeyStatus()
        return { ok: true }
      } catch {
        return { ok: false, message: 'The key could not be removed from this browser.' }
      }
    },
  }
}

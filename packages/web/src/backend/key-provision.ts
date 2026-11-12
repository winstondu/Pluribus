import type { KeyCheck, KeyProviderName } from '@committee/protocol'

/**
 * How this deployment provides provider keys (11 · "Key handling").
 *
 * Which model and provider each role uses is configuration, and belongs to
 * the backend: the client reads it from the app snapshot and changes it
 * with `change-settings`. Providing a key is the one part that differs by
 * deployment, so it sits behind this interface and nowhere else:
 *
 * - **Embedded** (`src/worker/key-channel.ts`): the page hands a key to the
 *   backend Worker once. The Worker checks it, keeps it in the local
 *   secrets store, and tells the backend that the key status changed. The
 *   key is never echoed back and is never part of a command, an event, a
 *   setting, an export or a log.
 * - **Server** ({@link serverKeyProvision}): keys come from the server's
 *   environment. `canProvideKeys` is false; the key prompt is not shown and
 *   the settings say "configured on the server".
 * - **Fixtures and tests** ({@link createScriptedKeyProvision}).
 *
 * Whether a key is configured is not asked here: the backend reports it in
 * the app snapshot (`key`, `anthropicKey`), never the value. No component
 * imports the Worker or the storage package; components use this interface
 * through `useKeyProvision()`.
 */
export interface KeyProvision {
  /** False when keys are not this client's to provide. The client then offers no way to enter, replace or remove one. */
  readonly canProvideKeys: boolean
  /**
   * Checks a key that has not been saved. Rejects only when `signal` was
   * aborted; every other outcome, the provider being unreachable included,
   * is a {@link KeyCheck}.
   */
  check(provider: KeyProviderName, key: string, signal: AbortSignal): Promise<KeyCheck>
  /** Stores the key, replacing any earlier one. The backend's key status follows on the stream. */
  set(provider: KeyProviderName, key: string): Promise<KeyProvisionResult>
  /** Removes the key. */
  remove(provider: KeyProviderName): Promise<KeyProvisionResult>
}

/** `message` never contains a key. */
export type KeyProvisionResult = { readonly ok: true } | { readonly ok: false; readonly message: string }

const NOT_PROVIDED_HERE: KeyProvisionResult = { ok: false, message: 'Keys are configured on the server.' }

/**
 * The provision of a deployment whose keys come from the server's
 * environment. Nothing can be entered, so nothing is ever sent.
 */
export const serverKeyProvision: KeyProvision = {
  canProvideKeys: false,
  check: () => Promise.resolve({ status: 'unverified', httpStatus: 0 }),
  set: () => Promise.resolve(NOT_PROVIDED_HERE),
  remove: () => Promise.resolve(NOT_PROVIDED_HERE),
}

/** What a scripted provision tells its backend when a key was stored or removed. */
export interface ScriptedKeyTarget {
  setKeyConfigured(provider: KeyProviderName, configured: boolean): void
}

const SCRIPTED_DELAY_MS = 700

/**
 * The provision used with the fixture backend, where nothing may reach the
 * network. A key containing "invalid" is rejected, "offline" cannot be
 * checked, "nocredit" is valid but out of credit, "blocked" may not be used
 * from a browser; anything else is valid. It keeps no key: storing one only
 * marks it configured on the fixture backend.
 */
export function createScriptedKeyProvision(target: ScriptedKeyTarget | null, delayMs: number = SCRIPTED_DELAY_MS): KeyProvision {
  const verdict = (provider: KeyProviderName, key: string): KeyCheck => {
    if (key.includes('invalid')) return { status: 'invalid' }
    if (key.includes('offline')) return { status: 'offline' }
    if (key.includes('blocked')) return { status: 'blocked', reason: 'This organization does not allow requests from a browser.' }
    if (key.includes('nocredit')) return { status: 'valid', label: null, credit: { kind: 'exhausted' } }
    return provider === 'openrouter'
      ? { status: 'valid', label: 'sk-or-v1-fix…ure', credit: { kind: 'remaining', dollars: 12.4 } }
      : { status: 'valid', label: null, credit: { kind: 'available' } }
  }
  const change = (provider: KeyProviderName, configured: boolean): Promise<KeyProvisionResult> => {
    if (!target) return Promise.resolve({ ok: false, message: 'No backend is connected.' })
    target.setKeyConfigured(provider, configured)
    return Promise.resolve({ ok: true })
  }
  return {
    canProvideKeys: true,
    check: (provider, key, signal) =>
      new Promise<KeyCheck>((resolve, reject) => {
        const timer = setTimeout(() => resolve(verdict(provider, key)), delayMs)
        signal.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new DOMException('Aborted', 'AbortError'))
        })
      }),
    set: (provider) => change(provider, true),
    remove: (provider) => change(provider, false),
  }
}

/// <reference lib="webworker" />
import { createBackend } from '@pluribus/core'
import type { Backend } from '@pluribus/core/ports'
import { servePort, type BackendMessage, type ClientMessage, type WirePort } from '@pluribus/protocol'
import {
  checkOpenRouterKey,
  createOpenRouterDecisionProvider,
  createOpenRouterDecomposer,
  createOpenRouterModelProvider,
} from '@pluribus/providers'
import { openIndexedDbStorage, type PluribusStorage } from '@pluribus/storage'
import { serveKeys, type KeyPort, type KeyService } from './key-channel'
import { createKeyService } from './key-service'
import { createSystemIds, systemClock, systemTimers } from './system'

/**
 * The embedded backend (11 · "Embedded"): core, the OpenRouter providers and
 * IndexedDB storage, served to the page over this Worker's port.
 * Beside the backend protocol the Worker answers the page's key requests
 * (`key-channel.ts`): the one place a provider key is checked and stored.
 *
 * Exactly one executor may run over the local stores (PLAN §2, "Interruption
 * and the single executor"). The Worker asks for the `pluribus-backend` Web
 * Lock before it opens storage. If another tab holds it, the page is told
 * `standby` and this Worker keeps waiting; it builds and starts the backend
 * when the other tab closes and its lock is released. The lock is held for
 * the Worker's lifetime: closing the tab ends the Worker, which is the
 * interrupted case, recovered by the next `start()`.
 */

export const BACKEND_LOCK = 'pluribus-backend'

const scope = self as unknown as DedicatedWorkerGlobalScope
const port = scope as unknown as WirePort<ClientMessage, BackendMessage>

let resolveBackend: (backend: Backend) => void = () => {}
let rejectBackend: (error: unknown) => void = () => {}
const backendReady = new Promise<Backend>((resolve, reject) => {
  resolveBackend = resolve
  rejectBackend = reject
})

let resolveKeys: (service: KeyService) => void = () => {}
const keysReady = new Promise<KeyService>((resolve) => {
  resolveKeys = resolve
})

// Listen at once: requests that arrive while the backend waits for the lock
// or starts are held and answered in arrival order once it is ready.
servePort(backendReady, port)
serveKeys(scope as unknown as KeyPort, keysReady)

async function build(storage: PluribusStorage): Promise<Backend> {
  // The only way a provider sees the key: read from the secrets store on each call.
  const getKey = (): Promise<string | null> => storage.secretsStore.get('openrouter-key')
  const modelProvider = createOpenRouterModelProvider({ getKey })
  // Every run's tokens are counted before it starts, and the first count reads OpenRouter's model
  // catalog (context limits). Read it now, so the first run after a load, an interrupted attempt
  // retried at start included, does not sit at "Waiting for a free slot" while a slot is free.
  void modelProvider.countTokens({ model: '', messages: [] })
  const backend = createBackend({
    modelProvider,
    decisionProvider: createOpenRouterDecisionProvider({ getKey }),
    decomposer: createOpenRouterDecomposer({ getKey }),
    eventStore: storage.eventStore,
    projectionCache: storage.projectionCache,
    secretsStore: storage.secretsStore,
    clock: systemClock,
    timers: systemTimers,
    ids: createSystemIds(),
  })
  await backend.start()
  resolveKeys(
    createKeyService({
      vault: storage.secretsStore,
      refreshKeyStatus: () => backend.refreshKeyStatus(),
      checks: { openrouter: checkOpenRouterKey },
    }),
  )
  return backend
}

async function serveHoldingLock(): Promise<void> {
  try {
    const storage = await openIndexedDbStorage()
    resolveBackend(await build(storage))
  } catch (error) {
    rejectBackend(error instanceof Error ? error : new Error(String(error)))
    return
  }
  // Keep the lock until the Worker ends.
  await new Promise<never>(() => {})
}

async function main(): Promise<void> {
  const locks = scope.navigator.locks as LockManager | undefined
  if (!locks) {
    // No Web Locks (very old browsers): there is no way to know about another tab.
    await serveHoldingLock()
    return
  }
  let acquired = false
  await locks.request(BACKEND_LOCK, { ifAvailable: true }, async (lock) => {
    if (lock === null) return
    acquired = true
    await serveHoldingLock()
  })
  if (acquired) return
  scope.postMessage({ kind: 'standby', reason: 'another-tab' } satisfies BackendMessage)
  await locks.request(BACKEND_LOCK, async () => {
    await serveHoldingLock()
  })
}

void main().catch((error: unknown) => rejectBackend(error))

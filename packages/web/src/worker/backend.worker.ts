/// <reference lib="webworker" />
import { createBackend } from '@committee/core'
import type { Backend } from '@committee/core/ports'
import { servePort, type BackendMessage, type ClientMessage, type WirePort } from '@committee/protocol'
import {
  createOpenRouterDecisionProvider,
  createOpenRouterDecomposer,
  createOpenRouterModelProvider,
  createOpenRouterPreparer,
} from '@committee/providers'
import { openIndexedDbStorage, type CommitteeStorage } from '@committee/storage'
import { runAsOwner, type OwnershipLocks } from './ownership'
import { createSystemIds, systemClock, systemTimers } from './system'

/**
 * The embedded backend (11 · "Embedded"): core, the OpenRouter providers and
 * IndexedDB storage, served to the page over this Worker's port.
 *
 * Exactly one executor may run over the local stores (PLAN §2, "Interruption
 * and the single executor"; Q99). The Worker asks for the `committee-backend`
 * Web Lock before it opens storage (`ownership.ts`). If another tab holds it,
 * the page is told `standby` and this Worker keeps waiting; it builds and
 * starts the backend when the other tab closes and its lock is released. The
 * lock is held for the Worker's lifetime: closing the tab ends the Worker,
 * which is the interrupted case, recovered by the next `start()`.
 */

const scope = self as unknown as DedicatedWorkerGlobalScope
const port = scope as unknown as WirePort<ClientMessage, BackendMessage>

let resolveBackend: (backend: Backend) => void = () => {}
let rejectBackend: (error: unknown) => void = () => {}
const backendReady = new Promise<Backend>((resolve, reject) => {
  resolveBackend = resolve
  rejectBackend = reject
})

// Listen at once: requests that arrive while the backend waits for the lock
// or starts are held and answered in arrival order once it is ready.
servePort(backendReady, port)

async function build(storage: CommitteeStorage): Promise<Backend> {
  // The only way a provider sees the key: read from the secrets store on each call.
  const getKey = (): Promise<string | null> => storage.secretsStore.get('openrouter-key')
  const modelProvider = createOpenRouterModelProvider({ getKey })
  // Every run's tokens are counted before it starts, and the first count reads OpenRouter's model
  // catalog (context limits). Read it now, so the first run after a load, an interrupted attempt
  // retried at start included, does not sit at "Waiting for a free slot" while a slot is free.
  void modelProvider.countTokens({ model: '', messages: [] })
  const backend = createBackend({
    modelProvider,
    preparer: createOpenRouterPreparer({ getKey }),
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

const locks = scope.navigator.locks as (LockManager & OwnershipLocks) | undefined
void runAsOwner(locks, {
  standby: () => scope.postMessage({ kind: 'standby', reason: 'another-tab' } satisfies BackendMessage),
  serve: serveHoldingLock,
}).catch((error: unknown) => rejectBackend(error))

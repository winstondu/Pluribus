import { createPortClient, type PortClient, type StandbyReason } from '@committee/protocol'
import type { KeyProvision } from '@/backend/key-provision'
import { createWorkerKeyProvision, type KeyPort } from './key-channel'

/**
 * The page's side of the embedded backend: starts the backend Worker and
 * returns a {@link PortClient} over it, with the embedded deployment's
 * {@link KeyProvision} on the same Worker. `src/backend/connect.ts` finds this
 * file by glob and calls the default export.
 *
 * One Worker per page. React's StrictMode runs the app's connect effect
 * twice in development; a second Worker would find the first one holding the
 * `committee-backend` lock and stand by forever. So every call returns the
 * same client, and standby is reported to every caller's hook, including
 * one that connects after it was announced.
 */

interface Hooks {
  onStandby(reason: StandbyReason): void
}

interface Connection {
  readonly client: PortClient
  readonly keys: KeyProvision
  readonly hooks: Set<Hooks>
  standby: StandbyReason | null
}

let connection: Connection | null = null

function open(): Connection {
  const worker = new Worker(new URL('./backend.worker.ts', import.meta.url), { type: 'module', name: 'committee-backend' })
  const hooks = new Set<Hooks>()
  const opened: Connection = {
    hooks,
    standby: null,
    keys: createWorkerKeyProvision(worker as unknown as KeyPort),
    client: createPortClient(worker, {
      onStandby(reason) {
        opened.standby = reason
        for (const hook of hooks) hook.onStandby(reason)
      },
    }),
  }
  // A Worker that fails to load (a syntax or network error in its script) would never answer:
  // fail the connection rather than leave the page "connecting". After `ready`, an uncaught
  // error inside the Worker is the backend's own and the connection stays.
  let ready = false
  void opened.client.ready.then(() => {
    ready = true
  })
  worker.addEventListener('error', (event) => {
    if (ready) return
    event.preventDefault()
    opened.client.dispose()
  })
  return opened
}

export default function connectWorker(hooks: Hooks): { readonly client: PortClient; readonly keys: KeyProvision } {
  connection ??= open()
  connection.hooks.add(hooks)
  if (connection.standby !== null) hooks.onStandby(connection.standby)
  return { client: connection.client, keys: connection.keys }
}

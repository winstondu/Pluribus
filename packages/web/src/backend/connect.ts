import type { BackendClient, PortClient, StandbyReason } from '@pluribus/protocol'
import type { FixtureBackend } from '@/fixtures'
import { createScriptedKeyProvision, type KeyProvision } from './key-provision'
import { createBackendStore, type BackendStore } from './store'

export type ConnectionMode = 'fixture' | 'worker'

export interface Connection {
  readonly mode: ConnectionMode
  readonly store: BackendStore
  /** Set in fixture mode. */
  readonly fixture: FixtureBackend | null
  /** How this deployment provides provider keys: the Worker's key service, or the scripted one with fixtures. */
  readonly keys: KeyProvision
}

/** Fixtures are available on the dev server, and in a build made with `VITE_FIXTURES=1`. */
export const FIXTURES_ENABLED: boolean = import.meta.env.DEV || import.meta.env.VITE_FIXTURES === '1'

type ConnectWorker = (hooks: { onStandby(reason: StandbyReason): void }) => { readonly client: PortClient; readonly keys: KeyProvision }

/** `src/worker/client.ts` is integration's; the glob matches nothing until it exists. */
const workerModules = import.meta.glob<{ default: ConnectWorker }>('../worker/client.ts')

const WORKER_NOT_WIRED = 'Worker backend not wired'

/** A client for a backend that is not there: every call says so. */
function unavailableClient(message: string): BackendClient {
  return {
    send: async () => ({ ok: false, error: { code: 'internal', message } }) as never,
    subscribe: () => () => {},
    snapshot: async () => ({ ok: false, error: { code: 'internal', message } }),
  }
}

function failedStore(message: string): BackendStore {
  const store = createBackendStore(unavailableClient(message), { ready: new Promise<void>(() => {}) })
  store.setStatus('failed', message)
  return store
}

async function connectFixture(id: string, manual: boolean): Promise<Connection> {
  const { createFixtureBackend, getFixture, fixtures } = await import('@/fixtures')
  const fixture = getFixture(id)
  if (!fixture) {
    const known = fixtures.map((candidate) => candidate.id).join(', ')
    return { mode: 'fixture', store: failedStore(`No fixture "${id}". Known fixtures: ${known}`), fixture: null, keys: createScriptedKeyProvision(null) }
  }
  // `manual` leaves the steps to whoever holds the handle (the fixture gallery's stepper, an e2e test).
  const backend = createFixtureBackend(fixture, { timers: !manual })
  return { mode: 'fixture', store: createBackendStore(backend), fixture: backend, keys: createScriptedKeyProvision(backend) }
}

async function connectWorker(): Promise<Connection> {
  const load = workerModules['../worker/client.ts']
  if (!load) return { mode: 'worker', store: failedStore(WORKER_NOT_WIRED), fixture: null, keys: createScriptedKeyProvision(null) }
  let store: BackendStore | null = null
  let standby: StandbyReason | null = null
  try {
    const module = await load()
    const { client, keys } = module.default({
      onStandby(reason) {
        standby = reason
        store?.setStatus('standby', reason)
      },
    })
    store = createBackendStore(client, { ready: client.ready })
    if (standby !== null && store.getState().status === 'connecting') store.setStatus('standby', standby)
    return { mode: 'worker', store, fixture: null, keys }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { mode: 'worker', store: failedStore(message), fixture: null, keys: createScriptedKeyProvision(null) }
  }
}

/**
 * Chooses the backend for this page load: `?fixture=<id>` runs one fixture
 * on the scripted backend (add `&manual` to play its steps by hand through
 * `window.__pluribusFixture`); otherwise the Worker backend.
 */
export function connect(search: string = globalThis.location?.search ?? ''): Promise<Connection> {
  const params = new URLSearchParams(search)
  const fixtureId = params.get('fixture')
  if (fixtureId !== null && FIXTURES_ENABLED) return connectFixture(fixtureId, params.has('manual'))
  return connectWorker()
}

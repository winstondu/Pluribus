import type { BackendClient } from '@pluribus/protocol'
import { render, type RenderResult } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { AppEnvironmentProvider, createEnvironment } from '@/app/environment'
import { UiStateProvider, createUiStore, type UiStore } from '@/app/ui-state'
import { BackendProvider, createBackendStore, createScriptedKeyProvision, type BackendStore, type KeyProvision } from '@/backend'
import { TooltipProvider } from '@/components/ui/tooltip'
import { createFixtureBackend, getFixture, type Fixture, type FixtureBackend } from '@/fixtures'

export interface RenderWithBackendResult extends RenderResult {
  /** The fixture backend, or null when a `client` was given. Drive it with `step()` and `playAll()`; read `sent`. */
  readonly backend: FixtureBackend | null
  readonly store: BackendStore
  /** The fresh ui-state of this render. */
  readonly ui: UiStore
  /** Resolves once the app snapshot and the fixture conversation are in the store. */
  readonly ready: Promise<void>
}

/**
 * Mounts `ui` inside `BackendProvider` with a fresh ui-state. The default
 * fixture is `empty`. Timers are off: play steps with `backend.step()`
 * inside `act()`.
 *
 * ```ts
 * const { backend, ready } = renderWithBackend(<TranscriptPane />, { fixture: getFixture('streaming') })
 * await ready
 * ```
 */
export function renderWithBackend(
  ui: ReactElement,
  options: { fixture?: Fixture; client?: BackendClient; keys?: KeyProvision } = {},
): RenderWithBackendResult {
  let backend: FixtureBackend | null = null
  let client = options.client
  if (!client) {
    const fixture = options.fixture ?? getFixture('empty')
    if (!fixture) throw new Error('renderWithBackend: the `empty` fixture is missing')
    backend = createFixtureBackend(fixture, { timers: false })
    client = backend
  }
  const store = createBackendStore(client)
  const uiStore = createUiStore()
  // The deployment's key provision: scripted over the fixture backend unless a test supplies one (a server's, say).
  const environment = createEnvironment(options.keys ?? createScriptedKeyProvision(backend, 0), false)

  const ready = new Promise<void>((resolve) => {
    const settled = (): boolean => {
      const state = store.getState()
      if (state.status === 'failed') return true
      if (state.status !== 'ready' || state.app === null) return false
      return state.app.conversations.length === 0 || state.conversation !== null
    }
    if (settled()) return resolve()
    const unsubscribe = store.subscribe(() => {
      if (settled()) {
        unsubscribe()
        resolve()
      }
    })
  })

  function Wrapper(props: { children: ReactNode }) {
    return (
      <BackendProvider store={store}>
        <UiStateProvider store={uiStore}>
          <AppEnvironmentProvider environment={environment}>
            <TooltipProvider>{props.children}</TooltipProvider>
          </AppEnvironmentProvider>
        </UiStateProvider>
      </BackendProvider>
    )
  }

  const result = render(ui, { wrapper: Wrapper })
  return Object.assign(result, { backend, store, ui: uiStore, ready })
}

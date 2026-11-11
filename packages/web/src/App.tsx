import { useEffect, useMemo, useState } from 'react'
import { AppEnvironmentProvider, OFFLINE_ENVIRONMENT, createLiveEnvironment } from '@/app/environment'
import { Shell } from '@/app/shell'
import { UiStateProvider, createUiStore } from '@/app/ui-state'
import { BackendProvider, connect, type Connection } from '@/backend'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'

/**
 * The app: connects to a backend (the Worker, or a fixture with
 * `?fixture=<id>`), then mounts the shell over the client store. Nothing
 * below this component knows which backend it is talking to.
 */
export function App() {
  const [connection, setConnection] = useState<Connection | null>(null)
  const uiStore = useMemo(() => createUiStore(), [])

  useEffect(() => {
    let cancelled = false
    let opened: Connection | null = null
    void connect().then((next) => {
      if (cancelled) {
        next.store.dispose()
        next.fixture?.dispose()
        return
      }
      opened = next
      // The handle the gallery's stepper and e2e tests drive: always the backend this app is mounted on.
      if (next.fixture) window.__committeeFixture = next.fixture
      setConnection(next)
    })
    return () => {
      cancelled = true
      opened?.store.dispose()
      opened?.fixture?.dispose()
    }
  }, [])

  const environment = useMemo(
    () => (connection?.mode === 'worker' ? createLiveEnvironment() : OFFLINE_ENVIRONMENT),
    [connection?.mode],
  )

  if (!connection) return <div className="h-dvh bg-background" />

  return (
    <BackendProvider store={connection.store}>
      <UiStateProvider store={uiStore}>
        <AppEnvironmentProvider environment={environment}>
          <TooltipProvider delayDuration={400} skipDelayDuration={300}>
            <Shell className="h-dvh" />
            <Toaster position="bottom-right" />
          </TooltipProvider>
        </AppEnvironmentProvider>
      </UiStateProvider>
    </BackendProvider>
  )
}

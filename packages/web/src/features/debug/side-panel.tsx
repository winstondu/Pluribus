import { useEffect } from 'react'
import { useUiState } from '@/app/ui-state'
import { useActiveConversationId, useApp } from '@/backend'
import { cn } from '@/lib/utils'
import { Compare } from './compare/compare'
import { useDebugState, type DebugTab } from './debug-state'
import { MiniMap } from './mini-map/mini-map'
import { RunInspector } from './run-inspector/run-inspector'

const TAB_LABEL: Record<DebugTab, string> = { 'mini-map': 'Mini-map', run: 'Run', compare: 'Compare' }

/**
 * The inspection panel: one tab per view that is switched on. The mini-map
 * and the run inspector exist behind their debug toggles. Compare exists
 * behind its toggle too, and also whenever a decomposition is open, because
 * the "split from one message" link is always available (Q53, Q87). When
 * Compare is placed on the message (`debug.comparePlacement` is `inline`),
 * the panel has no Compare tab: the card in the transcript is Compare.
 */
export function DebugSidePanel() {
  const debug = useApp()?.settings.debug
  const conversationId = useActiveConversationId()
  const compareInSidePanel = debug?.comparePlacement !== 'inline'
  const opened = useUiState((state) => state.compare)
  const compare = compareInSidePanel ? opened : null
  const inspected = useUiState((state) => state.inspected)
  const tab = useDebugState((state) => state.tab)
  const setTab = useDebugState((state) => state.setTab)
  const reset = useDebugState((state) => state.reset)

  const tabs: DebugTab[] = []
  if (debug?.miniMap) tabs.push('mini-map')
  if (debug?.runInspector) tabs.push('run')
  if (compareInSidePanel && (debug?.compareIndependent || compare !== null)) tabs.push('compare')

  // What points into a conversation does not outlive it. The state is kept outside the component, because below
  // 1180 px the panel lives in a sheet and is unmounted whenever the sheet is closed.
  useEffect(() => {
    if (useDebugState.getState().seen.conversationId !== conversationId) reset(conversationId)
  }, [conversationId, reset])

  // Asking for a decomposition or a run from anywhere brings its tab forward,
  // except when the mini-map asked, so the map stays in front of its user.
  useEffect(() => {
    const state = useDebugState.getState()
    if (state.seen.compare === compare) return
    state.markSeen({ compare })
    if (compare !== null) setTab('compare')
  }, [compare, setTab])
  useEffect(() => {
    const state = useDebugState.getState()
    if (state.seen.inspected === inspected) return
    state.markSeen({ inspected })
    if (state.keepTab) state.setKeepTab(false)
    else if (inspected !== null && debug?.runInspector) setTab('run')
  }, [inspected, debug?.runInspector, setTab])

  if (tabs.length === 0) return null
  const active: DebugTab = tab !== null && tabs.includes(tab) ? tab : (tabs[0] ?? 'mini-map')

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col" data-testid="debug-side-panel">
      <div role="tablist" aria-label="Inspection views" className="flex shrink-0 gap-4 border-b border-border px-4">
        {tabs.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            id={`debug-tab-${name}`}
            aria-selected={active === name}
            aria-controls={`debug-panel-${name}`}
            tabIndex={active === name ? 0 : -1}
            onClick={() => setTab(name)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
              const next = tabs[(tabs.indexOf(name) + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]
              if (!next) return
              setTab(next)
              document.getElementById(`debug-tab-${next}`)?.focus()
            }}
            className={cn(
              '-mb-px h-11 border-b-2 text-sm outline-none focus-visible:text-primary',
              active === name
                ? 'border-foreground font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {TAB_LABEL[name]}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`debug-panel-${active}`}
        aria-labelledby={`debug-tab-${active}`}
        className="flex min-h-0 flex-1 flex-col"
      >
        {active === 'mini-map' ? <MiniMap /> : null}
        {active === 'run' ? <RunInspector /> : null}
        {active === 'compare' ? <Compare /> : null}
      </div>
    </div>
  )
}

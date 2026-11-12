import { useEffect, useState } from 'react'
import { useActiveConversationId, useApp, useConversationLoading } from '@/backend'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import { useMediaQuery } from '@/hooks/use-media-query'
import { cn } from '@/lib/utils'
import { featureComponent } from './features'
import { Header } from './header'
import { useKeyProvision } from './environment'
import { KeyPrompt } from './key-prompt'
import { SettingsDialog } from './settings/settings-dialog'
import { Sidebar } from './sidebar'
import { ComposerStandIn, TranscriptStandIn } from './stand-ins'
import { BackendGate } from './standby-notice'
import { useUiState } from './ui-state'
import { useCreateConversation } from './use-create-conversation'

// Entry components of the features, or null while a feature does not exist.
const TranscriptPane = featureComponent('transcript', 'TranscriptPane')
const ComposerDock = featureComponent('composer', 'ComposerDock')
const DebugSidePanel = featureComponent('debug', 'DebugSidePanel')
const OperationGraphDrawer = featureComponent('debug', 'OperationGraphDrawer')

/**
 * The one screen (PLAN section 5):
 *
 *   sidebar │ header                          │ debug side panel
 *           │ transcript                      │
 *           │ composer dock                   │
 *           │ operation graph drawer          │
 *
 * The shell owns the regions and what is open; the features fill them. It
 * fills its parent, so the app gives it the window and the fixture gallery
 * gives it a frame.
 */
export function Shell({ className }: { className?: string }) {
  return (
    <div className={cn('h-full min-h-0 bg-background text-foreground', className)}>
      <BackendGate>
        <ShellLayout />
      </BackendGate>
    </div>
  )
}

function ShellLayout() {
  const app = useApp()
  const activeId = useActiveConversationId()
  const loading = useConversationLoading()
  const wide = useMediaQuery('(min-width: 900px)')
  const roomForSidePanel = useMediaQuery('(min-width: 1180px)')
  const sidebarOpen = useUiState((state) => state.sidebarOpen)
  const setSidebarOpen = useUiState((state) => state.setSidebarOpen)
  const openKeyPrompt = useUiState((state) => state.openKeyPrompt)
  const compare = useUiState((state) => state.compare)
  const inspected = useUiState((state) => state.inspected)
  const resetForConversation = useUiState((state) => state.resetForConversation)
  const [sidePanelSheetOpen, setSidePanelSheetOpen] = useState(false)

  // First run: no key yet, so the key prompt opens by itself, once per load.
  const keyConfigured = app?.key.configured
  const { canProvideKeys } = useKeyProvision()
  const [prompted, setPrompted] = useState(false)
  useEffect(() => {
    if (keyConfigured === false && !prompted && canProvideKeys) {
      setPrompted(true)
      openKeyPrompt()
    }
  }, [keyConfigured, prompted, openKeyPrompt, canProvideKeys])

  // What points into a conversation (reply targets, Focus, the inspected run) does not outlive it.
  useEffect(() => resetForConversation(), [activeId, resetForConversation])

  // The sheet is for narrow windows only.
  useEffect(() => {
    if (wide && sidebarOpen) setSidebarOpen(false)
  }, [wide, sidebarOpen, setSidebarOpen])

  const debug = app?.settings.debug
  // Compare placed on the message is not in the side panel.
  const compareInSidePanel = debug?.comparePlacement !== 'inline'
  const sidePanelWanted =
    DebugSidePanel !== null &&
    ((compareInSidePanel && compare !== null) ||
      (debug ? debug.miniMap || debug.runInspector || (compareInSidePanel && debug.compareIndependent) : false))
  const drawerWanted = OperationGraphDrawer !== null && debug?.operationGraph === true

  // Asking to inspect a run or a decomposition brings the panel forward when it lives in a sheet.
  useEffect(() => {
    if (((compareInSidePanel && compare !== null) || inspected !== null) && !roomForSidePanel) setSidePanelSheetOpen(true)
  }, [compare, compareInSidePanel, inspected, roomForSidePanel])

  return (
    <div className="flex h-full min-h-0">
      <aside className="hidden w-(--spacing-sidebar) shrink-0 border-r border-sidebar-border shell:block">
        <Sidebar />
      </aside>
      <Sheet open={sidebarOpen && !wide} onOpenChange={setSidebarOpen}>
        <SheetContent side="left" showCloseButton={false} className="w-[min(18rem,85vw)] gap-0 p-0">
          <SheetTitle className="sr-only">Conversations</SheetTitle>
          <SheetDescription className="sr-only">Create, open or delete a conversation.</SheetDescription>
          <Sidebar onNavigate={() => setSidebarOpen(false)} />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <Header
          sidePanelAsSheet={!roomForSidePanel}
          sidePanelAvailable={sidePanelWanted}
          onOpenSidePanel={() => setSidePanelSheetOpen(true)}
        />
        <div className="flex min-h-0 flex-1">
          <main className="flex min-w-0 flex-1 flex-col" aria-label="Conversation">
            {activeId === null ? (
              <NoConversation />
            ) : loading ? (
              <div className="min-h-0 flex-1" aria-busy="true" />
            ) : (
              <>
                {/* The transcript is the primary view: the dock and the drawer below it can never take all of it. */}
                <section aria-label="Transcript" className="flex min-h-36 flex-1 flex-col">
                  {TranscriptPane ? <TranscriptPane /> : <TranscriptStandIn />}
                </section>
                <section aria-label="Composer" className="shrink-0">
                  {ComposerDock ? <ComposerDock /> : <ComposerStandIn />}
                </section>
              </>
            )}
            {drawerWanted && OperationGraphDrawer ? (
              <section aria-label="Operation graph" className="flex min-h-24 shrink flex-col overflow-hidden border-t border-border bg-surface">
                <OperationGraphDrawer />
              </section>
            ) : null}
          </main>
          {sidePanelWanted && DebugSidePanel && roomForSidePanel ? (
            <aside aria-label="Inspection" className="flex w-[22.5rem] shrink-0 flex-col border-l border-border bg-surface">
              <DebugSidePanel />
            </aside>
          ) : null}
        </div>
      </div>

      {sidePanelWanted && DebugSidePanel && !roomForSidePanel ? (
        <Sheet open={sidePanelSheetOpen} onOpenChange={setSidePanelSheetOpen}>
          <SheetContent side="right" className="w-[min(24rem,92vw)] gap-0 p-0">
            <SheetTitle className="sr-only">Inspection</SheetTitle>
            <SheetDescription className="sr-only">Mini-map, run inspector and Compare.</SheetDescription>
            <DebugSidePanel />
          </SheetContent>
        </Sheet>
      ) : null}

      <KeyPrompt />
      <SettingsDialog />
    </div>
  )
}

function NoConversation() {
  const createConversation = useCreateConversation()
  const app = useApp()
  const none = (app?.conversations.length ?? 0) === 0
  return (
    <div className="grid min-h-0 flex-1 place-items-center px-6">
      <div className="max-w-sm text-center">
        <h2 className="display text-balance">{none ? 'Start the first conversation' : 'No conversation is open'}</h2>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          {none
            ? 'Committee answers several requests at once in one chat, and shows you how they relate.'
            : 'Choose one from the list, or start a new one.'}
        </p>
        <Button className="mt-5" onClick={() => void createConversation()}>
          New conversation
        </Button>
      </div>
    </div>
  )
}

import { MenuIcon, PanelRightIcon } from 'lucide-react'
import { useActiveConversationId, useApp } from '@/backend'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { featureComponent } from './features'
import { useUiState } from './ui-state'

const FocusBar = featureComponent('association', 'FocusBar')

/**
 * The bar above the transcript: the conversation's title and the Focus bar
 * (from the association feature). Under 900 px it also carries the button
 * that opens the conversation list.
 */
export function Header(props: { sidePanelAsSheet: boolean; sidePanelAvailable: boolean; onOpenSidePanel(): void }) {
  const app = useApp()
  const activeId = useActiveConversationId()
  const setSidebarOpen = useUiState((state) => state.setSidebarOpen)
  const title = app?.conversations.find((conversation) => conversation.id === activeId)?.title ?? 'Pluribus'

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3 sm:px-4">
      <Button
        variant="ghost"
        size="icon"
        aria-label="Open the conversation list"
        className="shell:hidden"
        onClick={() => setSidebarOpen(true)}
      >
        <MenuIcon />
      </Button>
      <h1 className="min-w-0 truncate text-sm font-medium">{title}</h1>
      <div className="min-w-0 flex-1">{FocusBar ? <FocusBar /> : null}</div>
      {props.sidePanelAsSheet && props.sidePanelAvailable ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Open the inspection panel" onClick={props.onOpenSidePanel}>
              <PanelRightIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Inspection panel</TooltipContent>
        </Tooltip>
      ) : null}
    </header>
  )
}

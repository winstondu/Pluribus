import type { DebugToggles } from '@pluribus/protocol'
import { MenuIcon, PanelRightIcon, ScanSearchIcon } from 'lucide-react'
import { useActiveConversationId, useApp } from '@/backend'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { featureComponent } from './features'
import { DEBUG_VIEWS, useChangeSettings } from './settings/settings-dialog'
import { useUiState } from './ui-state'

const FocusBar = featureComponent('association', 'FocusBar')
const ExportLogs = featureComponent('debug', 'ExportLogsMenuItem')

/**
 * The bar above the transcript: the conversation's title, the Focus bar
 * (from the association feature), and the debug menu with the four view
 * toggles and "Export full logs". Under 900 px it also carries the button that opens the
 * conversation list.
 */
export function Header(props: { sidePanelAsSheet: boolean; sidePanelAvailable: boolean; onOpenSidePanel(): void }) {
  const app = useApp()
  const activeId = useActiveConversationId()
  const setSidebarOpen = useUiState((state) => state.setSidebarOpen)
  const change = useChangeSettings()
  const title = app?.conversations.find((conversation) => conversation.id === activeId)?.title ?? 'Pluribus'
  const debug = app?.settings.debug
  const anyDebug = debug ? DEBUG_VIEWS.some((view) => debug[view.key]) : false

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
      {debug ? (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Debug views"
                  className={anyDebug ? 'text-primary' : 'text-muted-foreground'}
                >
                  <ScanSearchIcon />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>Debug views</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel>Debug views</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {DEBUG_VIEWS.map((view) => (
              <DropdownMenuCheckboxItem
                key={view.key}
                checked={debug[view.key]}
                onCheckedChange={(checked) => void change({ debug: { [view.key]: checked } as Partial<DebugToggles> })}
                onSelect={(event) => event.preventDefault()}
              >
                {view.label}
              </DropdownMenuCheckboxItem>
            ))}
            {ExportLogs ? <ExportLogs /> : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </header>
  )
}

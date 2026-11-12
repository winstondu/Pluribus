import type { ConversationId, ConversationSummary } from '@pluribus/protocol'
import { EllipsisIcon, KeyRoundIcon, PlusIcon, SettingsIcon, Trash2Icon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useActiveConversationId, useApp, useOpenConversation, useSend } from '@/backend'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { formatRelativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { BrandMark, Wordmark } from './brand'
import { ThemeToggle } from './theme-toggle'
import { useKeyProvision } from './environment'
import { useUiState } from './ui-state'
import { useCreateConversation } from './use-create-conversation'

/**
 * The conversation list: create, open, delete (Q70). The same content is
 * the fixed left column on wide windows and a sheet under 900 px;
 * `onNavigate` lets the sheet close itself after a choice.
 */
export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const app = useApp()
  const send = useSend()
  const activeId = useActiveConversationId()
  const openConversation = useOpenConversation()
  const openSettings = useUiState((state) => state.openSettings)
  const openKeyPrompt = useUiState((state) => state.openKeyPrompt)
  const { canProvideKeys } = useKeyProvision()
  const resetForConversation = useUiState((state) => state.resetForConversation)
  const createConversation = useCreateConversation()
  const [deleting, setDeleting] = useState<ConversationSummary | null>(null)
  const conversations = app?.conversations ?? []

  function open(id: ConversationId): void {
    if (id !== activeId) resetForConversation()
    openConversation(id)
    onNavigate?.()
  }

  async function create(): Promise<void> {
    if (await createConversation()) onNavigate?.()
  }

  async function confirmDelete(): Promise<void> {
    const target = deleting
    if (!target) return
    setDeleting(null)
    const result = await send({ type: 'delete-conversation', conversationId: target.id })
    if (!result.ok) toast.error('Could not delete the conversation', { description: result.error.message })
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-14 shrink-0 items-center gap-2.5 px-4">
        <BrandMark />
        <Wordmark />
      </div>

      <div className="px-3 pb-3">
        <Button variant="outline" className="h-9 w-full justify-start gap-2 px-2.5" onClick={() => void create()}>
          <PlusIcon />
          New conversation
        </Button>
      </div>

      <nav aria-label="Conversations" className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <h2 className="eyebrow px-2 pt-2 pb-1.5">Conversations</h2>
        {conversations.length === 0 ? (
          <p className="px-2 py-1 text-xs leading-relaxed text-muted-foreground">
            Nothing here yet. Conversations are kept in this browser.
          </p>
        ) : (
          <ul className="flex flex-col gap-px">
            {conversations.map((conversation) => {
              const active = conversation.id === activeId
              return (
                <li key={conversation.id} className="group/row relative">
                  <button
                    type="button"
                    aria-current={active ? 'page' : undefined}
                    onClick={() => open(conversation.id)}
                    className={cn(
                      'flex w-full flex-col rounded-lg py-1.5 pr-9 pl-2.5 text-left transition-colors duration-(--duration-fast)',
                      active ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/60',
                    )}
                  >
                    <span className={cn('truncate text-[0.8125rem]', active ? 'font-medium' : 'text-foreground/90')}>
                      {conversation.title}
                    </span>
                    <span className="text-2xs text-faint-foreground">{formatRelativeTime(conversation.createdAt)}</span>
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Options for ${conversation.title}`}
                        className={cn(
                          'absolute top-1/2 right-1.5 -translate-y-1/2 text-muted-foreground opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100',
                          // No hover on touch screens: keep the control reachable.
                          '[@media(hover:none)]:opacity-100',
                        )}
                      >
                        <EllipsisIcon />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-40">
                      <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(conversation)}>
                        <Trash2Icon />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              )
            })}
          </ul>
        )}
      </nav>

      <div className="shrink-0 border-t border-sidebar-border p-3">
        {app && !app.key.configured && canProvideKeys ? (
          <button
            type="button"
            onClick={() => {
              openKeyPrompt()
              onNavigate?.()
            }}
            className="pressable mb-2 flex w-full items-center gap-2.5 rounded-lg border border-dashed border-border-strong px-2.5 py-2 text-left hover:bg-sidebar-accent/60"
          >
            <KeyRoundIcon aria-hidden className="size-4 shrink-0 text-warning" />
            <span className="min-w-0">
              <span className="block text-xs font-medium">Add an OpenRouter key</span>
              <span className="block text-2xs text-muted-foreground">Needed to send messages</span>
            </span>
          </button>
        ) : null}
        <div className="flex items-center justify-between gap-2">
          <Button
            variant="ghost"
            className="h-8 gap-2 px-2 text-muted-foreground hover:text-foreground"
            onClick={() => {
              openSettings()
              onNavigate?.()
            }}
          >
            <SettingsIcon />
            Settings
          </Button>
          <ThemeToggle />
        </div>
      </div>

      <Dialog open={deleting !== null} onOpenChange={(next) => (next ? undefined : setDeleting(null))}>
        <DialogContent showCloseButton={false} className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete this conversation?</DialogTitle>
            <DialogDescription>
              “{deleting?.title}” and its whole history are removed from this browser. Work still running in it is
              aborted. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Keep
            </Button>
            <Button variant="destructive" onClick={() => void confirmDelete()}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

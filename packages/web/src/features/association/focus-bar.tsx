import type { ChainAssociation, ChainId } from '@committee/protocol'
import { XIcon } from 'lucide-react'
import { useEffect } from 'react'
import { useUiState } from '@/app/ui-state'
import { useChain } from '@/backend'
import { chainColor } from '@/design/chains'
import { cn } from '@/lib/utils'

/**
 * Focus in the header: names the chain being previewed, or the pinned one
 * with a button that clears it. Escape clears the pin too. Nothing is shown
 * while no chain is focused.
 */
export function FocusBar() {
  const pinned = useUiState((state) => state.focus.pinned)
  const preview = useUiState((state) => state.focus.preview)
  const pinFocus = useUiState((state) => state.pinFocus)

  useEffect(() => {
    if (pinned === null) return
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      // A dialog, menu or popover that is open owns Escape.
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"], [data-slot="popover-content"]')) return
      pinFocus(null)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [pinned, pinFocus])

  const shown = preview ?? pinned
  if (shown === null) return null
  return (
    <div className="flex min-w-0 items-center pl-2" data-slot="focus-bar">
      <FocusChip chainId={shown} pinned={shown === pinned} onClear={() => pinFocus(null)} />
    </div>
  )
}

function FocusChip(props: { chainId: ChainId; pinned: boolean; onClear(): void }) {
  const chain = useChain(props.chainId)
  if (!chain) return null
  return <Chip chain={chain} pinned={props.pinned} onClear={props.onClear} />
}

function Chip({ chain, pinned, onClear }: { chain: ChainAssociation; pinned: boolean; onClear(): void }) {
  return (
    <span
      role="status"
      className={cn(
        'inline-flex h-7 min-w-0 items-center gap-1.5 rounded-full border border-border bg-surface pl-2.5 text-xs',
        pinned ? 'pr-0.5' : 'pr-2.5',
      )}
    >
      <span aria-hidden className="size-2 flex-none rounded-full" style={{ background: chainColor(chain.colorIndex) }} />
      <span className="flex-none text-faint-foreground">Focus</span>
      <span className="truncate font-medium">{chain.label}</span>
      {pinned ? (
        <button
          type="button"
          aria-label={`Clear Focus on ${chain.label}`}
          onClick={onClear}
          className="pressable grid size-6 flex-none place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <XIcon aria-hidden className="size-3.5" />
        </button>
      ) : null}
    </span>
  )
}

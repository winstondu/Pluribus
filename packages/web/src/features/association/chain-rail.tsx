import type { ChainAssociation, ChainId } from '@committee/protocol'
import { useUiState } from '@/app/ui-state'
import { useChain } from '@/backend'
import { chainColor } from '@/design/chains'
import { cn } from '@/lib/utils'

/**
 * The margin rail of one transcript item: the handling chain, or chains, of
 * a message or an answer section (09 §2). Always shown.
 *
 * Each chain is its own segment and its own control. Several chains are
 * separate blocks with hard edges, one above the other, never a gradient
 * that could read as a third chain color.
 *
 * Pointer hover and keyboard focus preview that chain's Focus; a click, a
 * tap, Enter or Space pins it, and again unpins it. Leaving a preview goes
 * back to the pin, or to no Focus.
 */
export function ChainRail({ chainIds, className }: { chainIds: readonly ChainId[]; className?: string }) {
  return (
    <span data-slot="chain-rail" className={cn('flex w-(--spacing-rail) flex-none flex-col gap-0.5 self-stretch', className)}>
      {chainIds.length === 0 ? (
        <span aria-hidden data-chain="none" className="min-h-4 flex-1 rounded-full bg-border-strong" />
      ) : (
        chainIds.map((chainId) => <RailSegment key={chainId} chainId={chainId} />)
      )}
    </span>
  )
}

function RailSegment({ chainId }: { chainId: ChainId }) {
  const chain = useChain(chainId)
  if (!chain) return <span aria-hidden data-chain="unknown" className="min-h-4 flex-1 rounded-full bg-border-strong" />
  return <RailButton chain={chain} />
}

function RailButton({ chain }: { chain: ChainAssociation }) {
  const pinned = useUiState((state) => state.focus.pinned === chain.id)
  const active = useUiState((state) => (state.focus.preview ?? state.focus.pinned) === chain.id)
  const previewFocus = useUiState((state) => state.previewFocus)
  const pinFocus = useUiState((state) => state.pinFocus)
  return (
    <button
      type="button"
      data-chain={chain.id}
      data-color-index={chain.colorIndex}
      data-active={active ? '' : undefined}
      aria-label={`Focus ${chain.label}`}
      aria-pressed={pinned}
      title={chain.label}
      onPointerEnter={(event) => {
        // A touch has no hover: its tap pins, and a preview would only stick.
        if (event.pointerType !== 'touch') previewFocus(chain.id)
      }}
      onPointerLeave={() => previewFocus(null)}
      onFocus={(event) => {
        if (event.currentTarget.matches(':focus-visible')) previewFocus(chain.id)
      }}
      onBlur={() => previewFocus(null)}
      onClick={() => pinFocus(pinned ? null : chain.id)}
      className={cn(
        // The bar is 3 px wide; the control around it is wide enough to hit.
        'group/rail relative min-h-4 flex-1 cursor-pointer rounded-full outline-none',
        'before:absolute before:inset-y-0 before:-right-2.5 before:-left-4 before:content-[""]',
        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'absolute inset-0 origin-center rounded-full transition-transform duration-(--duration-fast) ease-out motion-reduce:transition-none',
          'data-[on]:scale-x-[1.67] group-hover/rail:scale-x-[1.67]',
        )}
        data-on={active ? '' : undefined}
        style={{ background: chainColor(chain.colorIndex) }}
      />
    </button>
  )
}

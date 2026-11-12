import type { ChainId } from '@pluribus/protocol'
import type { ReactNode } from 'react'
import { useGenealogy } from '@/backend'
import { chainColor } from '@/design/chains'
import { cn } from '@/lib/utils'

/** A chain named with its color: a swatch and the label. The color means the chain and nothing else. */
export function ChainName({ chainId, className }: { chainId: ChainId; className?: string }) {
  const chain = useGenealogy().chains[chainId]
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)} data-chain={chainId}>
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={{ background: chainColor(chain?.colorIndex ?? 0) }}
      />
      <span className="truncate">{chain?.label ?? chainId}</span>
      {chain ? <span className="shrink-0 text-faint-foreground">{CHAIN_KIND_WORD[chain.kind]}</span> : null}
    </span>
  )
}

export const CHAIN_KIND_WORD = { root: 'chain', fork: 'fork', branch: 'branch', join: 'join chain' } as const

/** An exact ID, in mono, selectable. IDs are shown on request, never as primary text. */
export function Id({ children, className }: { children: string; className?: string }) {
  return (
    <code className={cn('font-mono text-2xs break-all text-muted-foreground select-all', className)}>{children}</code>
  )
}

/** A labelled row of a detail list. */
export function Row({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 py-1 text-xs leading-relaxed', className)}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-5 py-10 text-center">
      <p className="text-sm font-medium text-balance">{title}</p>
      {children ? <p className="mt-2 text-xs leading-relaxed text-pretty text-muted-foreground">{children}</p> : null}
    </div>
  )
}

/** A quiet block of text shown exactly as recorded: no Markdown, whitespace kept. */
export function Verbatim({ children, className, label }: { children: string; className?: string; label?: string }) {
  return (
    <pre
      aria-label={label}
      className={cn(
        'rounded-md border border-border bg-background px-2.5 py-2 font-sans text-xs leading-relaxed break-words whitespace-pre-wrap',
        className,
      )}
    >
      {children}
    </pre>
  )
}

export function Pill({ children, tone = 'quiet' }: { children: ReactNode; tone?: 'quiet' | 'warning' | 'bad' | 'good' }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center rounded-full px-2 text-2xs font-medium whitespace-nowrap',
        tone === 'quiet' && 'bg-muted text-muted-foreground',
        tone === 'warning' && 'bg-warning-tint text-warning',
        tone === 'bad' && 'bg-destructive-tint text-destructive',
        tone === 'good' && 'bg-success-tint text-success',
      )}
    >
      {children}
    </span>
  )
}

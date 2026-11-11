import type { SectionStatus } from '@committee/protocol'
import { BanIcon, CircleAlertIcon, HistoryIcon, SquareIcon, UnplugIcon, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/** The states that leave a mark on text or on a section: distinct states, labeled distinctly (08). */
export type MarkKind = 'failed' | 'stopped' | 'interrupted' | 'cancelled' | 'superseded'

const MARK_ICON: { [K in MarkKind]: LucideIcon } = {
  failed: CircleAlertIcon,
  stopped: SquareIcon,
  interrupted: UnplugIcon,
  cancelled: BanIcon,
  superseded: HistoryIcon,
}

const MARK_TONE: { [K in MarkKind]: string } = {
  failed: 'text-destructive',
  stopped: 'text-muted-foreground',
  interrupted: 'text-warning',
  cancelled: 'text-muted-foreground',
  superseded: 'text-muted-foreground',
}

/** The label kept on work that did not complete, or was replaced. The text comes from the projection. */
export function Mark({ kind, children, className }: { kind: MarkKind; children: React.ReactNode; className?: string }) {
  const Icon = MARK_ICON[kind]
  return (
    <span data-mark={kind} className={cn('inline-flex items-center gap-1.5 text-xs font-medium', MARK_TONE[kind], className)}>
      <Icon aria-hidden className="size-3.5 flex-none" />
      <span>{children}</span>
    </span>
  )
}

/** Status kinds in which something is happening right now; the others are waits. */
const ACTIVE_STATUS: ReadonlySet<string> = new Set(['responding', 'retrying', 'routing'])

/**
 * The status line of a responding bubble or pending section. Status text is
 * not answer text: it lives here, on the bubble, never on the user message.
 */
export function StatusLine({ kind, text, className }: { kind: SectionStatus['kind'] | 'routing' | 'routing-failed' | 'awaiting-target'; text: string; className?: string }) {
  const active = ACTIVE_STATUS.has(kind)
  return (
    <p role="status" data-status={kind} className={cn('flex items-center gap-2 text-sm text-muted-foreground', className)}>
      <span
        aria-hidden
        className={cn(
          'size-1.5 flex-none rounded-full',
          active ? 'animate-pending bg-current' : 'border border-current opacity-70',
        )}
      />
      <span>{text}</span>
    </p>
  )
}

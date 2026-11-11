import { cn } from '@/lib/utils'

/**
 * The Committee mark: one conversation (the outer line) holding several
 * lines of work (the three strokes inside it). Drawn with currentColor.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-grid size-7 shrink-0 place-items-center rounded-[9px] bg-primary text-primary-foreground shadow-[inset_0_1px_0_oklch(1_0_0/14%)]',
        className,
      )}
    >
      <svg viewBox="0 0 16 16" className="size-[58%]" fill="none" stroke="currentColor" strokeLinecap="round">
        <path d="M3.25 3v10" strokeWidth="1.6" />
        <path d="M7 4.5h6" strokeWidth="1.35" opacity="0.95" />
        <path d="M7 8h4.25" strokeWidth="1.35" opacity="0.75" />
        <path d="M7 11.5h5.25" strokeWidth="1.35" opacity="0.55" />
      </svg>
    </span>
  )
}

export function Wordmark({ className }: { className?: string }) {
  return <span className={cn('font-serif text-[1.0625rem] font-medium tracking-[-0.01em]', className)}>Committee</span>
}

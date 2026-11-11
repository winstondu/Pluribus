import type { FocusRelation } from '@/features/association'

/**
 * How Focus looks on a transcript item. Related items get a quiet wash and
 * keep their own rail color; unrelated ones are dimmed. Only color and
 * opacity change, so Focus never moves anything.
 */
export function focusClass(relation: FocusRelation): string {
  const base = '-mx-2 rounded-lg px-2 transition-[opacity,background-color] duration-(--duration-fast) motion-reduce:transition-none'
  switch (relation) {
    case 'own':
    case 'inherited':
      return `${base} bg-muted/70`
    case 'dimmed':
      return `${base} opacity-35`
    case 'none':
      return base
  }
}

/** Says why an item of another chain is lit: the focused chain's runs read it. */
export function FocusTag({ relation }: { relation: FocusRelation }) {
  if (relation !== 'inherited') return null
  return (
    <span data-slot="focus-tag" className="text-2xs text-faint-foreground">
      in context
    </span>
  )
}

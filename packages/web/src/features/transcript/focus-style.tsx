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

/**
 * Says why an item of another chain is lit: the focused chain's runs read it.
 *
 * With `reserve`, the tag always takes its space and only its visibility
 * changes. A preview starts on hover, so a tag that added a row, or wrapped
 * its line, would move the rail out from under the pointer and end the
 * preview that drew it.
 */
export function FocusTag({ relation, reserve = false }: { relation: FocusRelation; reserve?: boolean }) {
  const shown = relation === 'inherited'
  if (!shown && !reserve) return null
  return (
    <span
      data-slot="focus-tag"
      aria-hidden={shown ? undefined : true}
      className={shown ? 'text-2xs whitespace-nowrap text-faint-foreground' : 'invisible text-2xs whitespace-nowrap'}
    >
      in context
    </span>
  )
}

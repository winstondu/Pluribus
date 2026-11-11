import type { MessageId, SectionId } from '@committee/protocol'

/**
 * Brings a transcript item into view and marks it for a moment. This is
 * always something the user asked for (a queue item's link, "See the
 * revision", "Show in transcript" from the operation graph), so it may move
 * the viewport; new output never does.
 */
function reveal(selector: string): boolean {
  const element = document.querySelector<HTMLElement>(selector)
  if (!element) return false
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  element.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' })
  // Restart the mark when the same item is revealed twice in a row.
  element.removeAttribute('data-revealed')
  void element.offsetWidth
  element.setAttribute('data-revealed', '')
  window.setTimeout(() => element.removeAttribute('data-revealed'), 1600)
  return true
}

function escape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&')
}

export function revealMessage(messageId: MessageId): boolean {
  return reveal(`[data-message-id="${escape(messageId)}"]`)
}

export function revealSectionElement(sectionId: SectionId): boolean {
  return reveal(`[data-section-id="${escape(sectionId)}"]`)
}

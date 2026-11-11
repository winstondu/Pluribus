import type { PauseCause } from './model'
import type { SectionCounts } from './projections'

/**
 * Text the specification pins down (10 · "Fixed wording"), plus the few
 * status words the build had to choose. The backend uses these to fill the
 * ready-to-show text fields of the projections, and the client uses the
 * constants for its own chrome, so the two never drift apart.
 */
export const WORDING = {
  /** Scroll affordance while the reader is scrolled away (Q15). */
  newOutput: 'New output ↓',
  /** Link joining split messages; opens Compare (Q53). */
  splitLink: 'split from one message',
  /** Status during automatic retries (Q47). */
  retrying: 'Retrying…',
  /** Status while held by a provider's rate limit. Never used for a dependency wait (Q47, Q60). */
  waitingForCapacity: 'Waiting for capacity',
  /** Build choice: status while ready work is held only by the concurrency limit. */
  waitingForSlot: 'Waiting for a free slot',
  /** Build choice: status of a responding bubble whose attempt is in flight with no text yet. */
  responding: 'Responding…',
  /** Build choice: status of work held by an elicitation. */
  awaitingAnswer: 'Waiting for your answer',
  /** Build choice: status of a message's responding bubble while routing is working. */
  routing: 'Routing…',
  /** Build choice: lead-in of the notice on a responding bubble whose routing failed; the provider's message follows. */
  routingFailed: 'Could not route this message',
  /** Build choice: shown instead of the app while another tab runs the backend. */
  openInAnotherTab: 'Committee is open in another tab',
  /** Mark on collapsed superseded partial text (Q38). */
  supersededPartial: 'Superseded — revised below',
  /** Build choice: mark on finished work that was superseded. */
  supersededFinished: 'Superseded',
  /** Note on a reply aimed at a superseded section (Q43). */
  replyingToRevised: 'Replying to the revised version',
  /** Failure message for exhausted credits (HTTP 402). */
  outOfCredits: 'Out of OpenRouter credits',
  /** Build choice: marks on text that did not complete. Distinct states, labeled distinctly (08). */
  failed: 'Failed',
  stopped: 'Stopped',
  interrupted: 'Interrupted',
  cancelled: 'Cancelled',
  /** Build choice: mark on visible text kept after a stop (Q22: "marked partial and stopped"). */
  stoppedPartial: 'Stopped · partial',
} as const

/** "neighborhoods + activities". */
export function joinLabels(labels: readonly string[]): string {
  return labels.join(' + ')
}

/** "Waiting for neighborhoods + activities" / "Revised · waiting for neighborhoods + activities" (Q41). */
export function waitingText(labels: readonly string[], revised: boolean): string {
  const joined = joinLabels(labels)
  return revised ? `Revised · waiting for ${joined}` : `Waiting for ${joined}`
}

/** "Paused — activities failed" / "… stopped" / "… interrupted" (Q48). */
export function pausedText(cause: Pick<PauseCause, 'label' | 'outcome'>): string {
  return `Paused — ${cause.label} ${cause.outcome}`
}

/** Labels of the three recovery choices (Q48): "Retry activities", "Continue without activities", "Cancel itinerary". */
export function recoveryLabels(
  prerequisiteLabel: string,
  pausedLabel: string,
): {
  readonly retry: string
  readonly continueWithout: string
  readonly cancel: string
} {
  return {
    retry: `Retry ${prerequisiteLabel}`,
    continueWithout: `Continue without ${prerequisiteLabel}`,
    cancel: `Cancel ${pausedLabel}`,
  }
}

/** "Based on superseded neighborhood recommendations" (Q40). */
export function supersededInputText(labels: readonly string[]): string {
  return `Based on superseded ${joinLabels(labels)}`
}

/** "Redid itinerary by default" (Q45, Q95). */
export function redoneByDefaultText(label: string): string {
  return `Redid ${label} by default`
}

/**
 * Compact count for a reply group header, such as "2 done · 1 failed · 1
 * stopped" (Q50). Returns null unless results are mixed, meaning at least
 * one section ended without completing. There is never an overall failed or
 * cancelled label.
 */
export function groupCountText(counts: SectionCounts): string | null {
  const unfinished = counts.failed + counts.stopped + counts.interrupted + counts.cancelled
  if (unfinished === 0) return null
  const parts: string[] = []
  if (counts.done > 0) parts.push(`${counts.done} done`)
  if (counts.failed > 0) parts.push(`${counts.failed} failed`)
  if (counts.stopped > 0) parts.push(`${counts.stopped} stopped`)
  if (counts.interrupted > 0) parts.push(`${counts.interrupted} interrupted`)
  if (counts.cancelled > 0) parts.push(`${counts.cancelled} cancelled`)
  if (counts.inProgress > 0) parts.push(`${counts.inProgress} pending`)
  return parts.join(' · ')
}

/**
 * A provisional label for work that has no generated one: the request's
 * first words, without trailing punctuation. Deterministic, so core can use
 * it without a model call.
 */
export function provisionalLabel(text: string, maxWords = 6): string {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return 'request'
  const head = words.slice(0, maxWords).join(' ').replace(/[\s.,;:!?…]+$/u, '')
  return words.length > maxWords ? `${head}…` : head
}

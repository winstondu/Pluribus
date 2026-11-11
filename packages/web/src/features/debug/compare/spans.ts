import type { TextSpan } from '@committee/protocol'

/** A run of the original text and the marks that cover it. */
export interface Segment<M> {
  readonly start: number
  readonly end: number
  readonly text: string
  readonly marks: readonly M[]
}

/**
 * Cuts `text` at every span boundary, so overlapping spans can each be drawn
 * over the same untouched text. Joining the segments' text gives `text`
 * back exactly, character for character.
 */
export function segmentText<M>(text: string, marks: readonly { span: TextSpan; mark: M }[]): Segment<M>[] {
  const clamp = (value: number) => Math.max(0, Math.min(text.length, Math.trunc(value)))
  const valid = marks
    .map(({ span, mark }) => ({ start: clamp(span.start), end: clamp(span.end), mark }))
    .filter((entry) => entry.end > entry.start)
  const cuts = new Set<number>([0, text.length])
  for (const entry of valid) {
    cuts.add(entry.start)
    cuts.add(entry.end)
  }
  const points = [...cuts].sort((a, b) => a - b)
  const segments: Segment<M>[] = []
  for (let i = 0; i < points.length - 1; i += 1) {
    const start = points[i] ?? 0
    const end = points[i + 1] ?? start
    if (end <= start) continue
    segments.push({
      start,
      end,
      text: text.slice(start, end),
      marks: valid.filter((entry) => entry.start <= start && entry.end >= end).map((entry) => entry.mark),
    })
  }
  return segments
}

/** The exact source text of some spans, in order, with a mark where text between them was left out. */
export function spanText(text: string, spans: readonly TextSpan[]): string {
  return [...spans]
    .sort((a, b) => a.start - b.start)
    .map((span) => text.slice(span.start, span.end))
    .filter((part) => part.length > 0)
    .join(' … ')
}

import type { DecompositionView, FragmentView } from '@pluribus/protocol'
import { motion } from 'motion/react'
import { CompareHeading, FragmentDetail, SourceSection } from './compare-parts'

/** The card's entrance: the transcript's `ENTER` timing and a short rise (`--ease-out`, 200 ms, 6 px). */
const ENTER = { duration: 0.2, ease: [0.23, 1, 0.32, 1] } as const
const RISE = 6

/**
 * Compare as a card on the message in the transcript, when
 * `debug.comparePlacement` is `inline`. It is the side panel's Compare made
 * of the same parts; the message that carries it marks the source text
 * itself, so the card repeats the original only when no message on screen
 * shows it (`showSource`, for split messages).
 *
 * It opens with a short fade and rise, from the toggle above it, and closes
 * at once. Under reduced motion the transcript's `MotionConfig` keeps only
 * the fade.
 */
export function CompareCard(props: {
  decomposition: DecompositionView
  selected: FragmentView | null
  onSelect(fragment: FragmentView): void
  showSource: boolean
  id?: string
}) {
  const { decomposition, selected } = props
  return (
    <motion.section
      id={props.id}
      aria-label="Decomposition"
      data-testid="compare-card"
      initial={{ opacity: 0, y: -RISE }}
      animate={{ opacity: 1, y: 0 }}
      transition={ENTER}
      className="@container mt-1.5 rounded-xl border border-border bg-surface"
    >
      <CompareHeading decomposition={decomposition} eyebrow="Decomposition" />
      {props.showSource ? <SourceSection decomposition={decomposition} selected={selected} /> : null}
      <FragmentDetail decomposition={decomposition} selected={selected} onSelect={props.onSelect} columns="responsive" />
    </motion.section>
  )
}

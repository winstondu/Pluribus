import { MotionConfig } from 'motion/react'
import { ComposerInput } from './composer-input'
import { ElicitationModal } from './elicitation-modal'
import { QueueItems } from './queue-items'

/**
 * Everything under the transcript, top to bottom: the elicitation modal
 * (target ambiguity, choice with default), the queue items, and the
 * composer with its reply-target chips. It does not scroll with the
 * transcript, and the composer stays usable while a modal is open.
 */
export function ComposerDock() {
  return (
    <MotionConfig reducedMotion="user">
      <div data-slot="composer-dock" className="shrink-0 px-4 pb-4 sm:px-6">
        <div className="relative mx-auto flex w-full max-w-(--spacing-transcript) flex-col">
          <ElicitationModal />
          <QueueItems />
          <ComposerInput />
        </div>
      </div>
    </MotionConfig>
  )
}

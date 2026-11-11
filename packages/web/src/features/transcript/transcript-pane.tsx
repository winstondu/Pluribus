import type { TranscriptItemRef } from '@committee/protocol'
import { WORDING } from '@committee/protocol'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import { useEffect, useRef } from 'react'
import { useUiState } from '@/app/ui-state'
import { useActiveConversationId, useTranscriptOrder } from '@/backend'
import { MessageRow } from './message-row'
import { ENTER, EntranceContext, EXIT, MOVE, RISE, useEntrance } from './motion'
import { ResponseRow } from './response-row'
import { revealSectionElement } from './reveal'
import { useScrollFollow } from './use-scroll-follow'

/**
 * The transcript of the open conversation: `transcript.order`, exactly, top
 * to bottom. The backend decides every position; this draws them and
 * animates the changes between them.
 */
export function TranscriptPane() {
  const conversationId = useActiveConversationId()
  return (
    <MotionConfig reducedMotion="user">
      <Transcript key={conversationId ?? 'none'} />
    </MotionConfig>
  )
}

function Transcript() {
  const order = useTranscriptOrder()
  const follow = useScrollFollow()
  const reveal = useUiState((state) => state.reveal)

  // Entrances play for what arrives after the conversation was first drawn, not for the conversation itself.
  const entrances = useRef(false)
  useEffect(() => {
    entrances.current = true
  }, [])

  // "Show in transcript" from another view (Q81).
  useEffect(() => {
    if (reveal) revealSectionElement(reveal.sectionId)
  }, [reveal])

  return (
    <EntranceContext.Provider value={entrances}>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <motion.div
          ref={follow.scroller}
          layoutScroll
          onScroll={follow.onScroll}
          data-slot="transcript-scroller"
          tabIndex={-1}
          className="scroll-quiet min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none"
        >
          {order.length === 0 ? (
            <EmptyTranscript />
          ) : (
            <div
              ref={follow.content}
              role="log"
              aria-label="Messages and replies"
              aria-live="off"
              className="relative mx-auto flex w-full max-w-(--spacing-transcript) flex-col gap-7 px-4 pt-8 pb-10 sm:px-6"
            >
              <AnimatePresence mode="popLayout" initial={false}>
                {order.map((item, index) => (
                  <TranscriptItem key={`${item.kind}:${item.id}`} item={item} index={index} />
                ))}
              </AnimatePresence>
            </div>
          )}
        </motion.div>

        <AnimatePresence>
          {follow.hasNewOutput ? (
            <motion.div
              key="new-output"
              className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center"
              initial={{ opacity: 0, y: RISE }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: EXIT }}
              transition={ENTER}
            >
              <button
                type="button"
                onClick={follow.jumpToBottom}
                className="pressable pointer-events-auto rounded-full border border-border-strong/70 bg-surface-raised px-3.5 py-1.5 text-xs font-medium shadow-raised hover:bg-muted"
              >
                {WORDING.newOutput}
              </button>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </EntranceContext.Provider>
  )
}

/**
 * One position in the transcript. When the item's index changes it slides
 * to its new place: a reply that showed its first text moves up to where it
 * is now fixed, and the responding bubbles it overtook are pushed down, at
 * the same time and on the same curve. An item that is dropped fades while
 * the others close over it.
 *
 * `layoutDependency` is the index, so an answer streaming higher up, which
 * changes heights but no index, never starts a layout animation here.
 */
function TranscriptItem({ item, index, ref }: { item: TranscriptItemRef; index: number; ref?: React.Ref<HTMLDivElement> }) {
  const enter = useEntrance()
  return (
    <motion.div
      ref={ref}
      layout="position"
      layoutDependency={index}
      data-transcript-item={item.kind}
      // A user message appears at once: it is the user's own keystroke, and nothing should make them wait
      // to see it. A reply fades in, without travel; the only movement in the transcript is a change of place.
      initial={enter && item.kind === 'response' ? { opacity: 0 } : false}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: EXIT }}
      transition={{ ...ENTER, layout: MOVE }}
    >
      {item.kind === 'message' ? <MessageRow id={item.id} /> : <ResponseRow id={item.id} />}
    </motion.div>
  )
}

function EmptyTranscript() {
  return (
    <div className="grid h-full place-items-center px-6">
      <div className="max-w-sm text-center">
        <h2 className="display text-balance">One chat, many lines of work</h2>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Ask for several things at once, or keep asking while an answer is still being written. Each request runs on its
          own and takes its place when its first words arrive.
        </p>
      </div>
    </div>
  )
}

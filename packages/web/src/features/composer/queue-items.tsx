import type { QueueItemView, RecoveryView, SectionId } from '@pluribus/protocol'
import { ClockIcon, PauseIcon } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useStore } from 'zustand'
import { useUiState } from '@/app/ui-state'
import { useBackendStore, useQueue } from '@/backend'
import { Button } from '@/components/ui/button'
import { ENTER, EXIT, revealMessage, useCommand } from '@/features/transcript'
import { cn } from '@/lib/utils'

/**
 * The composer queue (03 · "Composer queue"): one item per message that
 * waits on in-flight work, saying why in the backend's words and linked to
 * its message in the transcript. An item clears when processing begins. A
 * paused item carries the recovery choice, which has no default.
 *
 * The dock sits under the transcript, so an item's height is the
 * transcript's bottom edge. An item therefore stays in the flow and opens
 * and closes its own space together with its fade (an accordion: the one
 * place height animates), and the transcript's edge travels with it instead
 * of jumping by a whole item in one frame. Reduced motion keeps the cut.
 */
export function QueueItems() {
  const items = useQueue().items
  const reduce = useReducedMotion()
  const closed = { opacity: 0, height: 0 }
  return (
    <ul aria-label="Waiting messages" data-slot="queue" className="scroll-quiet relative flex max-h-[32dvh] flex-col overflow-y-auto">
      <AnimatePresence initial={false}>
        {items.map((item) => (
          <motion.li
            key={item.id}
            // Clipped while its space opens and closes. No padding here: a closed item must take no height at all.
            className="shrink-0 overflow-clip"
            initial={reduce ? false : closed}
            animate={{ opacity: 1, height: 'auto' }}
            exit={reduce ? { opacity: 0, height: 0, transition: { duration: 0 } } : { ...closed, transition: EXIT }}
            transition={reduce ? { duration: 0 } : ENTER}
          >
            <div className="pb-1.5">
              <QueueItem item={item} />
            </div>
          </motion.li>
        ))}
      </AnimatePresence>
    </ul>
  )
}

/**
 * The section of what the item waits for, so that its name leads somewhere:
 * the paused item's cause, or the current section of the first directive
 * still unfinished behind a wait target. Null when it has no section yet.
 */
function usePrerequisiteSectionId(item: QueueItemView): SectionId | null {
  return useStore(useBackendStore(), (state): SectionId | null => {
    const sections = state.conversation?.transcript.sections
    if (!sections) return null
    if (item.recovery) return sections[item.recovery.retry.sectionId] ? item.recovery.retry.sectionId : null
    const waiting = new Set(item.waitingFor.flatMap((target) => target.directiveIds))
    let found: SectionId | null = null
    for (const section of Object.values(sections)) {
      // A directive's superseded sections stay in the transcript; the one it waits for is the current one.
      if (waiting.has(section.directiveId) && section.state !== 'superseded') found ??= section.id
    }
    return found
  })
}

function QueueItem({ item }: { item: QueueItemView }) {
  const paused = item.state === 'paused'
  const Icon = paused ? PauseIcon : ClockIcon
  const revealSection = useUiState((state) => state.revealSection)
  const prerequisiteSectionId = usePrerequisiteSectionId(item)
  const names = item.recovery ? item.recovery.cause.label : item.waitingFor.map((target) => target.label).join(', ')
  return (
    <div
      data-queue-item={item.id}
      data-state={item.state}
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border bg-surface px-3 py-2 text-xs',
        paused ? 'border-warning/35 bg-warning-tint' : 'border-border',
      )}
    >
      <div className="flex min-w-0 flex-1 basis-56 items-center gap-2">
        <Icon aria-hidden className={cn('size-3.5 flex-none', paused ? 'text-warning' : 'text-faint-foreground')} />
        <span className="min-w-0">
          <button
            type="button"
            onClick={() => revealMessage(item.messageId)}
            aria-label={`${item.label}. Show its message`}
            className="pressable rounded-sm text-left font-medium text-foreground underline-offset-4 hover:underline"
          >
            {item.label}
          </button>
          <span className="text-muted-foreground"> · </span>
          {prerequisiteSectionId ? (
            // What it waits for is named by a label; the name leads to the section that carries it.
            <button
              type="button"
              data-slot="queue-prerequisite"
              onClick={() => revealSection(prerequisiteSectionId)}
              aria-label={`${item.text}. Show ${names} in the transcript`}
              className="pressable rounded-sm text-left text-muted-foreground underline decoration-border-strong underline-offset-4 hover:text-foreground hover:decoration-foreground"
            >
              {item.text}
            </button>
          ) : (
            <span className="text-muted-foreground">{item.text}</span>
          )}
          {item.heldByBarrier ? <span className="text-faint-foreground"> · held with the rest of its request</span> : null}
        </span>
      </div>
      {item.recovery ? <RecoveryChoice item={item} recovery={item.recovery} /> : null}
    </div>
  )
}

/** Retry the prerequisite, continue without it, or cancel the paused request (Q48). Pluribus waits for as long as it takes. */
function RecoveryChoice({ item, recovery }: { item: QueueItemView; recovery: RecoveryView }) {
  const command = useCommand()
  return (
    <div role="group" aria-label={`Recovery choice for ${item.label}`} className="flex flex-wrap items-center gap-1.5">
      <Button
        variant="outline"
        size="xs"
        onClick={() => void command({ type: 'retry', target: { kind: 'section', sectionId: recovery.retry.sectionId } })}
      >
        {recovery.retry.label}
      </Button>
      <Button variant="outline" size="xs" onClick={() => void command({ type: 'continue-without', directiveId: item.directiveId })}>
        {recovery.continueWithout.label}
      </Button>
      <Button variant="ghost" size="xs" onClick={() => void command({ type: 'cancel', directiveId: item.directiveId })}>
        {recovery.cancel.label}
      </Button>
    </div>
  )
}

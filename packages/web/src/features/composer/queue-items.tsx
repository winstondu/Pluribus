import type { QueueItemView, RecoveryView } from '@committee/protocol'
import { ClockIcon, PauseIcon } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useQueue } from '@/backend'
import { Button } from '@/components/ui/button'
import { ENTER, EXIT, MOVE, RISE, revealMessage, useCommand } from '@/features/transcript'
import { cn } from '@/lib/utils'

/**
 * The composer queue (03 · "Composer queue"): one item per message that
 * waits on in-flight work, saying why in the backend's words and linked to
 * its message in the transcript. An item clears when processing begins; it
 * fades while the others close over it. A paused item carries the recovery
 * choice, which has no default.
 */
export function QueueItems() {
  const items = useQueue().items
  // Any change to the list can move every item (the dock is anchored at the bottom), so all re-measure together.
  const listKey = items.map((item) => item.id).join(' ')
  return (
    <ul aria-label="Waiting messages" data-slot="queue" className="relative flex flex-col">
      <AnimatePresence mode="popLayout" initial={false}>
        {items.map((item) => (
          <motion.li
            key={item.id}
            className="pb-1.5"
            layout="position"
            layoutDependency={listKey}
            initial={{ opacity: 0, y: RISE }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: EXIT }}
            transition={{ ...ENTER, layout: MOVE }}
          >
            <QueueItem item={item} />
          </motion.li>
        ))}
      </AnimatePresence>
    </ul>
  )
}

function QueueItem({ item }: { item: QueueItemView }) {
  const paused = item.state === 'paused'
  const Icon = paused ? PauseIcon : ClockIcon
  return (
    <div
      data-queue-item={item.id}
      data-state={item.state}
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border bg-surface px-3 py-2 text-xs',
        paused ? 'border-warning/35 bg-warning-tint' : 'border-border',
      )}
    >
      <button
        type="button"
        onClick={() => revealMessage(item.messageId)}
        aria-label={`${item.label}: ${item.text}. Show its message`}
        className="pressable group/link flex min-w-0 flex-1 basis-56 items-center gap-2 rounded-md text-left"
      >
        <Icon aria-hidden className={cn('size-3.5 flex-none', paused ? 'text-warning' : 'text-faint-foreground')} />
        <span className="min-w-0">
          <span className="font-medium text-foreground underline-offset-4 group-hover/link:underline">{item.label}</span>
          <span className="text-muted-foreground"> · {item.text}</span>
          {item.heldByBarrier ? <span className="text-faint-foreground"> · held with the rest of its request</span> : null}
        </span>
      </button>
      {item.recovery ? <RecoveryChoice item={item} recovery={item.recovery} /> : null}
    </div>
  )
}

/** Retry the prerequisite, continue without it, or cancel the paused request (Q48). Committee waits for as long as it takes. */
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

import type { MessageId, ResponseId, ResponseReason, ResponseView, SectionId } from '@committee/protocol'
import { RotateCwIcon } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { memo } from 'react'
import { useMessage, useResponse, useSection } from '@/backend'
import { Button } from '@/components/ui/button'
import { ChainRail, useFocusedChainId, useSectionsFocus } from '@/features/association'
import { cn } from '@/lib/utils'
import { Mark, StatusLine } from './marks'
import { ENTER, EXIT, MOVE, useEntrance, useKept } from './motion'
import { SectionBlock } from './section'
import { useCommand } from './use-command'

/** What an additional response is, said quietly beside "Committee" (03: never inserted into the earlier response). */
const REASON_LABEL: { [R in ResponseReason]: string | null } = {
  answer: null,
  'clarification-question': 'needs one thing from you',
  'clarified-answer': 'after your answer',
  'revision-replacement': 'revised',
  'prerequisite-revised': 'redone after a revision',
  redo: 'redone',
}

/**
 * One reply at one transcript position: a responding bubble, a single
 * answer, or a reply group with a section per fragment. Sections are drawn
 * in `sectionIds` order, which the backend decides.
 */
export const ResponseRow = memo(function ResponseRow({ id }: { id: ResponseId }) {
  const response = useKept(useResponse(id))
  return response ? <ResponseBody response={response} /> : null
})

function ResponseBody({ response }: { response: ResponseView }) {
  const headerFocus = useSectionsFocus(response.sectionIds)
  const focused = useFocusedChainId() !== null
  const dimHeader = focused && (response.sectionIds.length === 0 || headerFocus === 'dimmed')
  const reasonLabel = REASON_LABEL[response.reason]
  const soleSectionId = !response.grouped && response.reason !== 'answer' ? response.sectionIds[0] : undefined

  return (
    <article
      aria-label={response.grouped ? 'Reply group' : 'Reply'}
      data-response-id={response.id}
      data-placement={response.placement}
      data-reason={response.reason}
      data-grouped={response.grouped ? '' : undefined}
      className="flex flex-col gap-2.5"
    >
      <header
        className={cn(
          'flex flex-wrap items-baseline gap-x-2 pl-[calc(var(--spacing-rail)+0.875rem)] text-xs transition-opacity duration-(--duration-fast) motion-reduce:transition-none',
          dimHeader && 'opacity-35',
        )}
      >
        <span className="font-medium text-muted-foreground">Committee</span>
        {reasonLabel ? <span className="text-faint-foreground">{reasonLabel}</span> : null}
        {soleSectionId ? <SoleTitle sectionId={soleSectionId} /> : null}
        {response.header?.countText ? (
          <span data-slot="group-count" className="tabular text-faint-foreground">
            {response.header.countText}
          </span>
        ) : null}
      </header>

      {response.routing ? <RoutingBubble response={response} dimmed={focused} /> : null}

      {response.sectionIds.length > 0 ? (
        <div className="relative flex flex-col gap-3.5">
          <AnimatePresence mode="popLayout" initial={false}>
            {response.sectionIds.map((sectionId, index) => (
              <SectionSlot key={sectionId} id={sectionId} index={index} grouped={response.grouped} />
            ))}
          </AnimatePresence>
        </div>
      ) : null}
    </article>
  )
}

/**
 * A section's place inside its response. When its index changes (a section
 * showing its first output takes its place above pending ones) it slides
 * there. Text growing in a section above changes no index and animates
 * nothing.
 */
function SectionSlot({ id, index, grouped, ref }: { id: SectionId; index: number; grouped: boolean; ref?: React.Ref<HTMLDivElement> }) {
  const enter = useEntrance()
  return (
    <motion.div
      ref={ref}
      layout="position"
      layoutDependency={index}
      initial={enter ? { opacity: 0 } : false}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: EXIT }}
      transition={{ ...ENTER, layout: MOVE }}
    >
      <SectionBlock id={id} grouped={grouped} />
    </motion.div>
  )
}

function SoleTitle({ sectionId }: { sectionId: SectionId }) {
  const title = useSection(sectionId)?.title
  return title ? <span className="text-faint-foreground">· {title}</span> : null
}

/**
 * The provisional responding bubble of a message that is not routed yet.
 * This is where routing status and a routing failure are shown; nothing is
 * drawn on the user message (P7). A routing failure offers Retry here too,
 * which is the request's Retry.
 */
function RoutingBubble({ response, dimmed }: { response: ResponseView; dimmed: boolean }) {
  const routing = response.routing
  if (!routing) return null
  return (
    <div
      data-slot="routing-bubble"
      data-routing={routing.state}
      className={cn('flex gap-3.5 transition-opacity duration-(--duration-fast) motion-reduce:transition-none', dimmed && 'opacity-35')}
    >
      <ChainRail chainIds={[]} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 py-0.5">
        {routing.state === 'failed' ? (
          <>
            <p role="alert" className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm text-destructive">
              <Mark kind="failed" className="self-center">
                Not routed
              </Mark>
              <span>{routing.text}</span>
            </p>
            <RetryRouting messageId={response.messageId} />
          </>
        ) : (
          <StatusLine kind={routing.state} text={routing.text} />
        )}
      </div>
    </div>
  )
}

function RetryRouting({ messageId }: { messageId: MessageId }) {
  const command = useCommand()
  const retry = useMessage(messageId)?.actions.retry === true
  if (!retry) return null
  return (
    <div className="-ml-2">
      <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => void command({ type: 'retry', target: { kind: 'request', messageId } })}>
        <RotateCwIcon aria-hidden />
        Retry
      </Button>
    </div>
  )
}

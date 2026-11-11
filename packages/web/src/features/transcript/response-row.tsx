import type { ResponseId, ResponseReason, ResponseView, SectionCounts, SectionId } from '@committee/protocol'
import { AnimatePresence, motion } from 'motion/react'
import { memo } from 'react'
import { useResponse, useSection } from '@/backend'
import { ChainRail, useFocusedChainId, useSectionFocus, useSectionsFocus } from '@/features/association'
import { cn } from '@/lib/utils'
import { FocusTag } from './focus-style'
import { StatusLine } from './marks'
import { ENTER, EXIT, MOVE, useEntrance, useKept } from './motion'
import { SectionBlock } from './section'

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
  // A single answer is named here, so a queue item, a note or a reply chip that names it by its label can be matched to it.
  const soleSectionId = response.grouped ? undefined : response.sectionIds[0]

  const countText = response.header && isMixed(response.header.counts) ? response.header.countText : null

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
        {countText ? (
          <span data-slot="group-count" className="tabular text-faint-foreground">
            {countText}
          </span>
        ) : null}
        {soleSectionId ? <SoleFocusTag sectionId={soleSectionId} /> : null}
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
  return title ? (
    <span data-slot="section-title" className="min-w-0 truncate text-faint-foreground">
      · {title}
    </span>
  ) : null
}

/** The "in context" tag of a single answer. Its space is always there, so previewing Focus moves nothing. */
function SoleFocusTag({ sectionId }: { sectionId: SectionId }) {
  return <FocusTag relation={useSectionFocus(sectionId)} reserve />
}

/**
 * The header count is for mixed results only (03, Q50): at least two
 * different outcomes. One outcome alone, such as "2 failed", would read as
 * a failed label for the whole request, which a request never shows.
 */
function isMixed(counts: SectionCounts): boolean {
  const outcomes = [counts.done, counts.failed, counts.stopped, counts.interrupted, counts.cancelled, counts.inProgress]
  return outcomes.filter((count) => count > 0).length >= 2
}

/**
 * The provisional responding bubble of a message that is not routed yet.
 * This is where routing status and a routing failure are shown; nothing is
 * drawn on the user message (P7). A routing failure's Retry is the
 * request's, in the message header (10 · Controls), and is not repeated here.
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
        {/* A failure is status, not a mark: a request as a whole never shows failed (08, 10). */}
        <StatusLine kind={routing.state === 'failed' ? 'routing-failed' : routing.state} text={routing.text} />
      </div>
    </div>
  )
}

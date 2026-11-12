import type { AttemptId, AttemptView, SectionId, SectionNote, SectionView } from '@pluribus/protocol'
import { WORDING } from '@pluribus/protocol'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronRightIcon,
  CornerDownLeftIcon,
  RefreshCwIcon,
  RotateCwIcon,
  ScanSearchIcon,
  SquareIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { memo, useState } from 'react'
import { useUiState } from '@/app/ui-state'
import { useApp, useAttempt, useSection } from '@/backend'
import { Button } from '@/components/ui/button'
import { ChainRail, useSectionFocus } from '@/features/association'
import { cn } from '@/lib/utils'
import { AnswerText } from './answer-text'
import { focusClass, FocusTag } from './focus-style'
import { Mark, StatusLine, type MarkKind } from './marks'
import { COLLAPSE, useKept } from './motion'
import { useCommand } from './use-command'

const MARK_KINDS: ReadonlySet<string> = new Set(['failed', 'stopped', 'interrupted', 'cancelled', 'superseded'])

function markKind(state: string): MarkKind {
  return MARK_KINDS.has(state) ? (state as MarkKind) : 'stopped'
}

/** One answer section: the slot one directive's output occupies. Renders exactly what the projection says. */
export const SectionBlock = memo(function SectionBlock({ id, grouped }: { id: SectionId; grouped: boolean }) {
  const section = useKept(useSection(id))
  return section ? <SectionBody section={section} grouped={grouped} /> : null
})

function SectionBody({ section, grouped }: { section: SectionView; grouped: boolean }) {
  const relation = useSectionFocus(section.id)
  const superseded = section.state === 'superseded'
  const [historyOpen, setHistoryOpen] = useState(false)
  const lastAttemptId = section.attemptIds.at(-1)
  // A settled state with no listed attempt has no text to carry its mark, so the section carries it.
  const bareMark =
    section.attemptIds.length === 0 &&
    (section.state === 'stopped' || section.state === 'interrupted' || section.state === 'cancelled')

  return (
    <section
      aria-label={section.title}
      data-section-id={section.id}
      data-state={section.state}
      data-placement={section.placement}
      data-focus={relation}
      className={cn('group/section flex gap-3.5', focusClass(relation))}
    >
      <ChainRail chainIds={[section.chainId]} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 py-0.5">
        {/* An ungrouped section is named, and tagged under Focus, in its reply's header line (response-row). */}
        {grouped ? (
          <div className="flex items-baseline gap-2">
            <h3 className="min-w-0 text-[0.8125rem] font-medium">{section.title}</h3>
            <FocusTag relation={relation} reserve />
          </div>
        ) : null}

        {superseded && section.superseded ? (
          <SupersededRow
            section={section}
            markText={section.superseded.markText}
            hasText={section.attemptIds.length > 0}
            open={historyOpen}
            onToggle={() => setHistoryOpen((open) => !open)}
          />
        ) : null}

        {section.attemptIds.map((attemptId) => (
          <AttemptBlock
            key={attemptId}
            id={attemptId}
            current={attemptId === lastAttemptId}
            sectionState={section.state}
            historyOpen={superseded ? historyOpen : null}
            directiveId={section.directiveId}
          />
        ))}

        {section.status ? <StatusLine kind={section.status.kind} text={section.status.text} /> : null}

        {section.state === 'failed' ? (
          <p role="alert" data-slot="failure-notice" className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm text-destructive">
            <Mark kind="failed" className="self-center">
              Failed
            </Mark>
            {section.failure ? <span>{section.failure.message}</span> : null}
          </p>
        ) : null}

        {bareMark ? <BareMark state={section.state} /> : null}

        {section.replacesSectionId ? <ReplacesLink sectionId={section.replacesSectionId} /> : null}

        {section.notes.map((note) => (
          <Note key={note.kind + note.text} note={note} section={section} />
        ))}

        <SectionControls section={section} />
      </div>
    </section>
  )
}

const BARE_MARK_TEXT = { stopped: 'Stopped', interrupted: 'Interrupted', cancelled: 'Cancelled' } as const

function BareMark({ state }: { state: SectionView['state'] }) {
  if (state !== 'stopped' && state !== 'interrupted' && state !== 'cancelled') return null
  return (
    <p>
      <Mark kind={state}>{BARE_MARK_TEXT[state]}</Mark>
    </p>
  )
}

/** The mark of a superseded section, its link to the replacement, and the toggle for the text it kept. */
function SupersededRow(props: { section: SectionView; markText: string; hasText: boolean; open: boolean; onToggle(): void }) {
  const revealSection = useUiState((state) => state.revealSection)
  const replacement = props.section.superseded?.replacementSectionId ?? null
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {props.hasText ? (
        <button
          type="button"
          aria-expanded={props.open}
          onClick={props.onToggle}
          className="pressable -ml-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 hover:bg-muted"
        >
          <ChevronRightIcon
            aria-hidden
            className={cn('size-3.5 text-faint-foreground transition-transform duration-(--duration-fast) ease-out motion-reduce:transition-none', props.open && 'rotate-90')}
          />
          <Mark kind="superseded">{props.markText}</Mark>
        </button>
      ) : (
        <Mark kind="superseded">{props.markText}</Mark>
      )}
      {replacement ? (
        <button
          type="button"
          onClick={() => revealSection(replacement)}
          className="pressable inline-flex items-center gap-1 rounded-md text-xs text-primary underline-offset-4 hover:underline"
        >
          {props.section.superseded?.linkText ?? WORDING.seeRevision}
          <ArrowDownIcon aria-hidden className="size-3" />
        </button>
      ) : null}
    </p>
  )
}

function ReplacesLink({ sectionId }: { sectionId: SectionId }) {
  const revealSection = useUiState((state) => state.revealSection)
  const exists = useSection(sectionId) !== undefined
  // A status-only bubble that was dropped left no trace to link to (Q38).
  if (!exists) return null
  return (
    <p>
      <button
        type="button"
        onClick={() => revealSection(sectionId)}
        className="pressable inline-flex items-center gap-1 rounded-md text-xs text-faint-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        Replaces an earlier version
        <ArrowUpIcon aria-hidden className="size-3" />
      </button>
    </p>
  )
}

interface AttemptBlockProps {
  id: AttemptId
  /** The section's last attempt: the one its state describes. */
  current: boolean
  sectionState: SectionView['state']
  /** For a superseded section, whether its kept text is shown; null when the section is not superseded. */
  historyOpen: boolean | null
  directiveId: SectionView['directiveId']
}

const AttemptBlock = memo(function AttemptBlock(props: AttemptBlockProps) {
  const attempt = useKept(useAttempt(props.id))
  return attempt ? <AttemptBody attempt={attempt} {...props} /> : null
})

/**
 * One attempt inside its section's bubble. Text that did not complete keeps
 * its mark. Collapsed text (superseded, or earlier partial text above a
 * retry) folds to one line that opens again on request. Opening and closing
 * it by hand animates; the fold the backend asks for is drawn closed at once,
 * together with the line that replaces it.
 */
function AttemptBody({ attempt, current, sectionState, historyOpen, directiveId }: AttemptBlockProps & { attempt: AttemptView }) {
  const reduce = useReducedMotion()
  const [expanded, setExpanded] = useState(false)
  const inSuperseded = historyOpen !== null
  const collapsed = inSuperseded || attempt.collapsed
  const open = inSuperseded ? historyOpen : !attempt.collapsed || expanded
  const hasText = attempt.text.length > 0
  // The failure notice of a failed section already says "Failed" for its current attempt.
  // While the section is still being worked on (a retry is pending, waiting for capacity, or running), an earlier
  // attempt that left no text has nothing to mark: the status line says what is happening (08 · Retries, F3).
  const working = sectionState === 'pending' || sectionState === 'streaming'
  const mark =
    attempt.markText !== null &&
    !(current && sectionState === 'failed') &&
    !(inSuperseded && attempt.state === 'superseded') &&
    !(working && !hasText)
  const kind = markKind(attempt.state)

  return (
    <div data-attempt-id={attempt.id} data-state={attempt.state} data-collapsed={collapsed && !open ? '' : undefined} className="flex flex-col gap-1">
      {collapsed && !inSuperseded ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setExpanded((value) => !value)}
            className="pressable -ml-1 flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 text-left hover:bg-muted"
          >
            <ChevronRightIcon
              aria-hidden
              className={cn('size-3.5 flex-none text-faint-foreground transition-transform duration-(--duration-fast) ease-out motion-reduce:transition-none', open && 'rotate-90')}
            />
            <Mark kind={kind} className="flex-none">
              {attempt.markText ?? 'Earlier text'}
            </Mark>
            {!open && hasText ? <span className="truncate text-xs text-faint-foreground">{excerpt(attempt.text)}</span> : null}
          </button>
          <InspectAttempt directiveId={directiveId} attemptId={attempt.id} number={attempt.number} />
        </div>
      ) : null}

      {hasText ? (
        <motion.div
          // The fold animates only when the reader opens or closes it. When the projection collapses the text
          // (a retry began, the section was superseded) the header row and the closed height arrive in one
          // commit: remounting with `initial={false}` draws the closed state at once, so nothing below grows
          // for a frame and then shrinks back.
          key={collapsed ? 'collapsed' : 'plain'}
          initial={false}
          animate={{ height: open ? 'auto' : 0, opacity: open ? 1 : 0 }}
          transition={reduce ? { duration: 0 } : COLLAPSE}
          inert={!open}
          className={cn(collapsed && 'overflow-clip')}
        >
          <AnswerText text={attempt.text} streaming={attempt.state === 'streaming'} muted={collapsed} />
        </motion.div>
      ) : null}

      {mark && (!collapsed || inSuperseded) && (open || !hasText) ? (
        <p>
          <Mark kind={kind}>{attempt.markText}</Mark>
        </p>
      ) : null}
    </div>
  )
}

/**
 * One plain line of answer text, for places that do not render Markdown (a collapsed text's line, a candidate
 * in the target-ambiguity modal): Markdown syntax is dropped. At most `max` characters.
 */
export function excerpt(text: string, max = 96): string {
  const line = text
    .replace(/^\s*(`{3,}|~{3,}).*$/gm, ' ') // code fences
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // headings
    .replace(/^\s{0,3}>\s?/gm, '') // quotes
    .replace(/^\s*([-*+]|\d+[.)])\s+/gm, '') // list bullets
    .replace(/^\s*([-*_]\s*){3,}$/gm, ' ') // rules
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links and images
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2') // strong
    .replace(/(?<![\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?![\w*])/g, '$1') // emphasis
    .replace(/(?<![\w_])_(?=\S)([^_]+?)(?<=\S)_(?![\w_])/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/\*\*|__|`/g, '') // a marker left open by a stream that stopped
    .replace(/\s+/g, ' ')
    .trim()
  return line.length > max ? `${line.slice(0, max)}…` : line
}

function Note({ note, section }: { note: SectionNote; section: SectionView }) {
  const command = useCommand()
  switch (note.kind) {
    case 'superseded-input':
      return (
        <p data-note={note.kind} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <RefreshCwIcon aria-hidden className="size-3.5 flex-none text-faint-foreground" />
            {note.text}
          </span>
          {section.actions.regenerate ? (
            <Button variant="outline" size="xs" onClick={() => void command({ type: 'regenerate', sectionId: section.id })}>
              Regenerate
            </Button>
          ) : null}
        </p>
      )
    case 'redone-by-default':
      return (
        <p data-note={note.kind} className="text-xs text-faint-foreground">
          {note.text}
        </p>
      )
    case 'context-near-limit':
      return (
        <p data-note={note.kind} className="inline-flex items-center gap-1.5 text-xs text-warning">
          <TriangleAlertIcon aria-hidden className="size-3.5 flex-none" />
          {note.text}
        </p>
      )
  }
}

/** Exactly the controls `section.actions` offers, plus Inspect run behind its debug toggle. */
function SectionControls({ section }: { section: SectionView }) {
  const command = useCommand()
  const targeted = useUiState((state) => state.replyTargets.includes(section.id))
  const toggleReplyTarget = useUiState((state) => state.toggleReplyTarget)
  const inspect = useUiState((state) => state.inspect)
  const runInspector = useApp()?.settings.debug.runInspector === true
  const { reply, stop, retry, regenerate } = section.actions
  const regenerateInNote = section.notes.some((note) => note.kind === 'superseded-input')
  const looseRegenerate = regenerate && !regenerateInNote
  if (!reply && !stop && !retry && !looseRegenerate && !runInspector) return null
  const target = { kind: 'section', sectionId: section.id } as const
  const isQuestion = section.asksElicitationId !== null

  return (
    <div
      data-slot="section-controls"
      className="-ml-2 flex flex-wrap items-center gap-0.5 text-muted-foreground transition-opacity duration-(--duration-fast) [@media(hover:hover)]:opacity-70 group-focus-within/section:opacity-100 group-hover/section:opacity-100"
    >
      {stop ? (
        <Button variant="ghost" size="xs" onClick={() => void command({ type: 'stop', target })}>
          <SquareIcon aria-hidden />
          Stop
        </Button>
      ) : null}
      {retry ? (
        <Button variant="ghost" size="xs" onClick={() => void command({ type: 'retry', target })}>
          <RotateCwIcon aria-hidden />
          Retry
        </Button>
      ) : null}
      {looseRegenerate ? (
        <Button variant="ghost" size="xs" onClick={() => void command({ type: 'regenerate', sectionId: section.id })}>
          <RefreshCwIcon aria-hidden />
          Regenerate
        </Button>
      ) : null}
      {reply ? (
        <Button
          variant="ghost"
          size="xs"
          aria-pressed={targeted}
          onClick={() => toggleReplyTarget(section.id)}
          className={cn(targeted && 'bg-accent text-accent-foreground')}
        >
          <CornerDownLeftIcon aria-hidden />
          {isQuestion ? 'Answer' : 'Reply to this'}
        </Button>
      ) : null}
      {runInspector ? (
        <Button variant="ghost" size="xs" onClick={() => inspect({ directiveId: section.directiveId, attemptId: null })}>
          <ScanSearchIcon aria-hidden />
          Inspect run
        </Button>
      ) : null}
    </div>
  )
}

/** Inspect run beside a listed earlier attempt, behind the run inspector's debug toggle. */
function InspectAttempt(props: { directiveId: SectionView['directiveId']; attemptId: AttemptId; number: number }) {
  const inspect = useUiState((state) => state.inspect)
  const runInspector = useApp()?.settings.debug.runInspector === true
  if (!runInspector) return null
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={`Inspect run of attempt ${props.number}`}
      className="flex-none text-muted-foreground"
      onClick={() => inspect({ directiveId: props.directiveId, attemptId: props.attemptId })}
    >
      <ScanSearchIcon aria-hidden />
    </Button>
  )
}

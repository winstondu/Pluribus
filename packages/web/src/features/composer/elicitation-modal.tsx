import {
  ELICITATION_SURFACE,
  type DirectiveId,
  type ElicitationView,
  type SectionId,
} from '@committee/protocol'
import { LocateIcon, LockIcon } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { useUiState } from '@/app/ui-state'
import { useChain, useQueue } from '@/backend'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { chainColor } from '@/design/chains'
import { ENTER, EXIT, RISE, useCommand } from '@/features/transcript'
import { cn } from '@/lib/utils'

type TargetAmbiguity = Extract<ElicitationView, { kind: 'target-ambiguity' }>
type ChoiceWithDefault = Extract<ElicitationView, { kind: 'choice-with-default' }>

/**
 * The elicitations that appear as a modal above the composer (Q95): target
 * ambiguity and choice with default. One at a time, oldest first. It is a
 * panel in the dock, not a full-screen dialog: the transcript stays
 * readable and the composer stays usable beneath it.
 */
export function ElicitationModal() {
  const elicitations = useQueue().elicitations
  const current = elicitations.find((elicitation) => ELICITATION_SURFACE[elicitation.kind] === 'modal')
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      {current ? (
        <motion.div
          key={current.id}
          className="pb-2"
          initial={{ opacity: 0, y: RISE }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, transition: EXIT }}
          transition={ENTER}
        >
          {current.kind === 'target-ambiguity' ? <TargetAmbiguityModal elicitation={current} /> : null}
          {current.kind === 'choice-with-default' ? <ChoiceWithDefaultModal elicitation={current} /> : null}
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

function ModalFrame(props: { titleId: string; kind: ElicitationView['kind']; children: React.ReactNode }) {
  return (
    <section
      role="dialog"
      aria-modal="false"
      aria-labelledby={props.titleId}
      data-elicitation={props.kind}
      // Capped, scrolling inside itself, so the composer and some of the transcript stay on screen on a short viewport.
      className="scroll-quiet flex max-h-[min(45dvh,30rem)] flex-col gap-3 overflow-y-auto overscroll-contain rounded-2xl border border-border-strong/70 bg-surface-raised p-4 shadow-overlay [&>*]:shrink-0"
    >
      {props.children}
    </section>
  )
}

function Quote({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <p className="border-l-2 border-border-strong pl-3 text-sm text-muted-foreground">
      <span className="sr-only">{label}: </span>
      {children}
    </p>
  )
}

/**
 * Target ambiguity (Q10, Q20): the reply is not acted on until the user
 * picks among existing sections. No default, and no way to dismiss it into
 * a guess.
 */
function TargetAmbiguityModal({ elicitation }: { elicitation: TargetAmbiguity }) {
  const command = useCommand()
  const titleId = useId()
  const [chosen, setChosen] = useState<readonly SectionId[]>([])
  const [sending, setSending] = useState(false)

  function toggle(sectionId: SectionId): void {
    setChosen((current) => (current.includes(sectionId) ? current.filter((id) => id !== sectionId) : [...current, sectionId]))
  }

  async function choose(): Promise<void> {
    if (chosen.length === 0 || sending) return
    setSending(true)
    // Candidate order, not click order.
    const sectionIds = elicitation.candidates.map((candidate) => candidate.sectionId).filter((id) => chosen.includes(id))
    await command({ type: 'answer-elicitation', elicitationId: elicitation.id, answer: { kind: 'target-ambiguity', sectionIds } })
    setSending(false)
  }

  return (
    <ModalFrame titleId={titleId} kind={elicitation.kind}>
      <div className="flex flex-col gap-1.5">
        <h2 id={titleId} className="text-sm font-medium">
          Which answer is this about?
        </h2>
        <Quote label="Your message">{elicitation.messageText}</Quote>
      </div>
      <ul className="flex flex-col gap-1.5" aria-label="Candidate sections">
        {elicitation.candidates.map((candidate) => (
          <li key={candidate.sectionId}>
            <Candidate candidate={candidate} chosen={chosen.includes(candidate.sectionId)} onToggle={() => toggle(candidate.sectionId)} />
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-faint-foreground">Nothing happens with this message until you choose.</p>
        <Button size="sm" disabled={chosen.length === 0 || sending} onClick={() => void choose()}>
          {chosen.length > 1 ? `Choose ${chosen.length} sections` : 'Choose section'}
        </Button>
      </div>
    </ModalFrame>
  )
}

function Candidate(props: { candidate: TargetAmbiguity['candidates'][number]; chosen: boolean; onToggle(): void }) {
  const { candidate, chosen } = props
  const chain = useChain(candidate.chainId)
  const revealSection = useUiState((state) => state.revealSection)
  return (
    <div
      className={cn(
        'flex items-stretch rounded-xl border transition-[border-color,background-color] duration-(--duration-fast)',
        chosen ? 'border-primary/60 bg-accent' : 'border-border bg-surface hover:bg-muted/60',
      )}
    >
      <button
        type="button"
        aria-pressed={chosen}
        onClick={props.onToggle}
        className="pressable flex min-w-0 flex-1 items-stretch gap-3 rounded-l-xl px-3 py-2 text-left"
      >
        <span aria-hidden className="chain-rail" style={{ background: chain ? chainColor(chain.colorIndex) : 'var(--border-strong)' }} />
        <span className="flex min-w-0 flex-col">
          <span className="text-[0.8125rem] font-medium">{candidate.title}</span>
          <span className="truncate text-xs text-muted-foreground">{candidate.excerpt}</span>
        </span>
      </button>
      <button
        type="button"
        aria-label={`Show ${candidate.title} in the transcript`}
        onClick={() => revealSection(candidate.sectionId)}
        className="pressable grid w-9 flex-none place-items-center rounded-r-xl text-faint-foreground hover:text-foreground"
      >
        <LocateIcon aria-hidden className="size-3.5" />
      </button>
    </div>
  )
}

/** Whole seconds left until `deadlineAt`, ticking while the modal is shown. */
function useSecondsLeft(deadlineAt: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [deadlineAt])
  return Math.max(0, Math.ceil((deadlineAt - now) / 1000))
}

/**
 * The wait, drawn as a bar that empties. One linear transition for the whole
 * remaining wait, set once and again only when the deadline changes, so the
 * bar moves evenly instead of in one-second steps; the browser runs it off
 * the main thread. Reduced motion: the bar follows the whole seconds of the
 * text beside it, without a transition.
 */
function CountdownBar({ deadlineAt, waitMs, secondsLeft }: { deadlineAt: number; waitMs: number; secondsLeft: number }) {
  const reduce = useReducedMotion()
  const bar = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const element = bar.current
    if (!element || reduce) return
    const remaining = Math.max(0, deadlineAt - Date.now())
    const fraction = waitMs > 0 ? Math.min(1, remaining / waitMs) : 0
    element.style.transition = 'none'
    element.style.transform = `scaleX(${fraction})`
    // Commit the starting value before the transition to empty is set.
    void element.offsetWidth
    element.style.transition = `transform ${remaining}ms linear`
    element.style.transform = 'scaleX(0)'
  }, [deadlineAt, waitMs, reduce])
  const stepped = waitMs > 0 ? Math.min(1, (secondsLeft * 1000) / waitMs) : 0
  return (
    <span aria-hidden data-slot="countdown-bar" className="block h-0.5 overflow-hidden rounded-full bg-border">
      <span
        ref={bar}
        className="block h-full origin-left bg-primary"
        style={reduce ? { transform: `scaleX(${stepped})`, transition: 'none' } : undefined}
      />
    </span>
  )
}

const OPTION_STATE_NOTE = {
  finished: null,
  running: 'was running, so it is always redone',
  queued: 'has not started, so it picks up the change',
} as const

/**
 * Choice with default (Q42–Q45): which finished work to redo after a shared
 * requirement was revised. The pre-selection is the backend's; it stays
 * editable until the default is carried out, which happens when the wait
 * elapses or when the user sends another message. Work that was running or
 * queued is locked: it cannot be deselected (Q84).
 */
function ChoiceWithDefaultModal({ elicitation }: { elicitation: ChoiceWithDefault }) {
  const command = useCommand()
  const titleId = useId()
  const secondsLeft = useSecondsLeft(elicitation.deadlineAt)

  // The selection as the backend last reported it, edited optimistically until the next report.
  const reported = elicitation.options.filter((option) => option.selected).map((option) => option.directiveId)
  const reportedKey = reported.join(' ')
  const [edit, setEdit] = useState<{ key: string; redo: readonly DirectiveId[] } | null>(null)
  const selected = edit && edit.key === reportedKey ? edit.redo : reported

  function redoList(next: readonly DirectiveId[]): DirectiveId[] {
    // Only finished work is the user's to choose; locked options are redone whatever is sent.
    return elicitation.options.filter((option) => !option.locked && next.includes(option.directiveId)).map((option) => option.directiveId)
  }

  function toggle(directiveId: DirectiveId, checked: boolean): void {
    const next = checked ? [...selected, directiveId] : selected.filter((id) => id !== directiveId)
    setEdit({ key: reportedKey, redo: next })
    void command({
      type: 'answer-elicitation',
      elicitationId: elicitation.id,
      answer: { kind: 'choice-with-default', redo: redoList(next), confirm: false },
    })
  }

  function confirm(): void {
    void command({
      type: 'answer-elicitation',
      elicitationId: elicitation.id,
      answer: { kind: 'choice-with-default', redo: redoList(selected), confirm: true },
    })
  }

  return (
    <ModalFrame titleId={titleId} kind={elicitation.kind}>
      <div className="flex flex-col gap-1.5">
        <h2 id={titleId} className="text-sm font-medium">
          Which work should be redone?
        </h2>
        <Quote label="Your change">{elicitation.correction}</Quote>
      </div>
      <ul className="flex flex-col" aria-label="Work that may need redoing">
        {elicitation.options.map((option) => {
          const checked = option.locked || selected.includes(option.directiveId)
          const note = OPTION_STATE_NOTE[option.state]
          return (
            <li key={option.directiveId}>
              <label
                className={cn(
                  'flex items-center gap-3 rounded-lg px-2 py-1.5 text-sm',
                  option.locked ? 'text-muted-foreground' : 'cursor-pointer hover:bg-muted/60',
                )}
              >
                <Checkbox
                  checked={checked}
                  disabled={option.locked}
                  onCheckedChange={(value) => toggle(option.directiveId, value === true)}
                  aria-label={`Redo ${option.label}`}
                />
                <span className="min-w-0">
                  <span className={cn('font-medium', !option.locked && 'text-foreground')}>{option.label}</span>
                  {note ? <span className="text-xs text-faint-foreground"> · {note}</span> : null}
                </span>
                {option.locked ? <LockIcon aria-hidden className="ml-auto size-3.5 flex-none text-faint-foreground" /> : null}
              </label>
            </li>
          )
        })}
      </ul>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-40 flex-1 flex-col gap-1.5">
          <p className="text-xs text-muted-foreground">
            <span data-slot="countdown" className="tabular font-medium text-foreground">
              {secondsLeft > 0 ? `Redoes the selection in ${secondsLeft} s` : 'Redoing the selection…'}
            </span>
            <span className="text-faint-foreground">, or when you send another message</span>
          </p>
          <CountdownBar deadlineAt={elicitation.deadlineAt} waitMs={elicitation.waitMs} secondsLeft={secondsLeft} />
        </div>
        <Button size="sm" onClick={confirm}>
          Confirm selection
        </Button>
      </div>
    </ModalFrame>
  )
}

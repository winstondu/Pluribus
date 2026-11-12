import type { DecompositionView, FragmentId, FragmentView, MessageId, Requirement } from '@committee/protocol'
import { useId, useState, type ReactNode } from 'react'
import { useUiState } from '@/app/ui-state'
import { useGenealogy, useTranscript } from '@/backend'
import { Button } from '@/components/ui/button'
import { chainColor, chainTint } from '@/design/chains'
import { cn } from '@/lib/utils'
import { ChainName, Id, Pill, Verbatim } from '../parts'
import { segmentText, spanText } from './spans'

/**
 * The building blocks of Compare (09 §3), shared by both placements: the
 * debug side panel and the card on the message in the transcript
 * (`debug.comparePlacement`). Each renders what the decomposition in the
 * transcript projection records; none of them decides anything.
 */

/** The fragment selected in one Compare, the first by default. */
export function useFragmentSelection(decomposition: DecompositionView | null) {
  const [selectedId, setSelectedId] = useState<FragmentId | null>(decomposition?.fragments[0]?.fragmentId ?? null)
  const selected =
    decomposition?.fragments.find((fragment) => fragment.fragmentId === selectedId) ?? decomposition?.fragments[0] ?? null
  return [selected, (fragment: FragmentView) => setSelectedId(fragment.fragmentId)] as const
}

/** A fragment's color is its chain's color. */
function useFragmentColor(): (fragment: FragmentView) => number {
  const chains = useGenealogy().chains
  return (fragment) => chains[fragment.chainId]?.colorIndex ?? 0
}

type Mark = { kind: 'fragment'; fragment: FragmentView } | { kind: 'requirement'; requirement: Requirement }

/**
 * The original message's text, exactly, with every fragment's source spans
 * marked: the selected fragment's underlined in its chain's color, the
 * others with a quiet line, and the requirements it inherited from this
 * message shaded. Its caller supplies the element around it. In running
 * text (`inText`) requirements are only shaded, not set in a heavier
 * weight, so the message keeps its line breaks when the marks appear.
 */
export function SourceMarks(props: { decomposition: DecompositionView; selected: FragmentView | null; inText?: boolean }) {
  const { decomposition, selected, inText = false } = props
  const colorOf = useFragmentColor()
  const marks: { span: { start: number; end: number }; mark: Mark }[] = []
  for (const fragment of decomposition.fragments) {
    for (const span of fragment.sourceSpans) marks.push({ span, mark: { kind: 'fragment', fragment } })
  }
  for (const requirement of selected?.requirements ?? []) {
    const span = requirement.provenance.span
    if (span && requirement.provenance.messageId === decomposition.originalMessageId) {
      marks.push({ span, mark: { kind: 'requirement', requirement } })
    }
  }
  return segmentText(decomposition.originalText, marks).map((segment) => {
    const fragments = segment.marks.flatMap((mark) => (mark.kind === 'fragment' ? [mark.fragment] : []))
    const requirement = segment.marks.some((mark) => mark.kind === 'requirement')
    const own = selected ? fragments.some((fragment) => fragment.fragmentId === selected.fragmentId) : false
    const owner = own ? selected : fragments[0]
    if (!owner && !requirement) return <span key={segment.start}>{segment.text}</span>
    return (
      <mark
        key={segment.start}
        data-fragment={owner?.fragmentId}
        data-selected={own || undefined}
        data-requirement={requirement || undefined}
        className={cn('rounded-[3px] bg-transparent text-inherit', requirement && !inText && 'font-medium')}
        style={{
          background: own && owner ? chainTint(colorOf(owner)) : requirement ? 'var(--muted)' : undefined,
          boxShadow: owner
            ? `inset 0 ${own ? '-2px' : '-1px'} 0 ${own ? chainColor(colorOf(owner)) : 'var(--border-strong)'}`
            : 'inset 0 -1px 0 var(--border-strong)',
        }}
      >
        {segment.text}
      </mark>
    )
  })
}

/** "Exact source": the original message, marked, in a quiet box. */
export function SourceSection({ decomposition, selected }: { decomposition: DecompositionView; selected: FragmentView | null }) {
  return (
    <section className="px-4 pt-3" aria-label="Exact source">
      <h4 className="eyebrow">Exact source</h4>
      <p
        data-testid="compare-original"
        className="mt-1.5 rounded-md border border-border bg-background px-2.5 py-2 text-xs leading-[1.7] break-words whitespace-pre-wrap"
      >
        <SourceMarks decomposition={decomposition} selected={selected} />
      </p>
      <p className="mt-1.5 text-2xs leading-relaxed text-muted-foreground">
        The message exactly as sent. The selected part is underlined in its chain’s color; a requirement it inherited is
        shaded.
      </p>
    </section>
  )
}

/** What Compare is about: the title, how many parts, and how they were shown. */
export function CompareHeading(props: { decomposition: DecompositionView; eyebrow?: string; action?: ReactNode }) {
  const { decomposition } = props
  return (
    <div className="flex items-start justify-between gap-2 px-4 pt-3">
      <div>
        {props.eyebrow ? <p className="eyebrow mb-1">{props.eyebrow}</p> : null}
        <h3 className="text-sm font-medium">How this message was split</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {decomposition.fragments.length} parts ·{' '}
          {decomposition.presentation === 'split-messages' ? 'shown as split messages' : 'shown as one reply with sections'}
        </p>
      </div>
      {props.action}
    </div>
  )
}

/**
 * The parts, one tab each, with the chain's color. Arrow keys move between
 * them; the selected one is the only tab stop.
 */
export function FragmentTabs(props: {
  decomposition: DecompositionView
  selected: FragmentView | null
  onSelect(fragment: FragmentView): void
  /** The id of the tab panel the tabs control. */
  panelId: string
}) {
  const { decomposition, selected, onSelect } = props
  const colorOf = useFragmentColor()
  const prefix = useId()
  const tabId = (fragment: FragmentView) => `${prefix}-${fragment.fragmentId}`
  const fragments = decomposition.fragments
  return (
    <div role="tablist" aria-label="Parts" className="flex flex-wrap gap-1.5 px-4 pt-3">
      {fragments.map((fragment, index) => {
        const active = fragment.fragmentId === selected?.fragmentId
        return (
          <button
            key={fragment.fragmentId}
            id={tabId(fragment)}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={props.panelId}
            tabIndex={active ? 0 : -1}
            onClick={() => onSelect(fragment)}
            onKeyDown={(event) => {
              const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key]
              const next =
                event.key === 'Home'
                  ? fragments[0]
                  : event.key === 'End'
                    ? fragments[fragments.length - 1]
                    : step !== undefined
                      ? fragments[(index + step + fragments.length) % fragments.length]
                      : undefined
              if (!next) return
              event.preventDefault()
              onSelect(next)
              document.getElementById(tabId(next))?.focus()
            }}
            className={cn(
              'pressable inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
              active ? 'border-border-strong bg-background font-medium' : 'border-transparent bg-muted text-muted-foreground hover:text-foreground',
            )}
          >
            <span aria-hidden className="size-2 rounded-full" style={{ background: chainColor(colorOf(fragment)) }} />
            {fragment.label}
            {fragment.kind === 'revision' ? <span className="text-faint-foreground">correction</span> : null}
          </button>
        )
      })}
    </div>
  )
}

/**
 * One part: its exact source beside its rewritten instruction, the chain
 * that handled it, and the requirements it inherited. `columns` is
 * `responsive` where the space may be narrow: the two columns then stack.
 */
export function FragmentPanel(props: {
  decomposition: DecompositionView
  fragment: FragmentView
  id: string
  columns: 'fixed' | 'responsive'
}) {
  const { decomposition, fragment } = props
  const transcript = useTranscript()
  const revealSection = useUiState((state) => state.revealSection)
  const section = fragment.sectionId ? transcript.sections[fragment.sectionId] : undefined
  const source = spanText(decomposition.originalText, fragment.sourceSpans)

  return (
    <section id={props.id} className="@container px-4 pt-3" aria-label={`Part: ${fragment.label}`} role="tabpanel">
      <div
        data-slot="compare-columns"
        className={cn('grid gap-2', props.columns === 'fixed' ? 'grid-cols-2' : 'grid-cols-1 @md:grid-cols-2')}
      >
        <div className="min-w-0">
          <h4 className="eyebrow">From the source</h4>
          <Verbatim className="mt-1.5" label="Source of this part">
            {source.length > 0 ? source : '(no quotable span)'}
          </Verbatim>
        </div>
        <div className="min-w-0">
          <h4 className="eyebrow">{fragment.kind === 'revision' ? 'Correction' : 'Rewritten instruction'}</h4>
          <Verbatim className="mt-1.5" label="Rewritten instruction">
            {fragment.rewrittenText}
          </Verbatim>
        </div>
      </div>

      <dl className="mt-2.5 text-xs leading-relaxed">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <dt className="text-muted-foreground">{fragment.kind === 'revision' ? 'Corrects work on' : 'Handled by'}</dt>
          <dd className="min-w-0">
            <ChainName chainId={fragment.chainId} />
          </dd>
        </div>
        {fragment.kind === 'revision' ? (
          <p className="mt-1 text-muted-foreground">
            This part corrects earlier work{section ? ` (${section.title})` : ''}. It started no new work of its own.
          </p>
        ) : null}
      </dl>

      <h4 className="eyebrow mt-3">Inherited requirements</h4>
      {fragment.requirements.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">None. This part carries only its own instruction.</p>
      ) : (
        <ul className="mt-1.5 flex flex-col gap-1.5" data-testid="requirements">
          {fragment.requirements.map((requirement) => (
            <RequirementItem
              key={requirement.id}
              requirement={requirement}
              originalMessageId={decomposition.originalMessageId}
              originalText={decomposition.originalText}
              sharedWith={decomposition.fragments
                .filter(
                  (other) =>
                    other.fragmentId !== fragment.fragmentId &&
                    other.requirements.some((candidate) => sameRequirement(candidate, requirement)),
                )
                .map((other) => other.label)}
            />
          ))}
        </ul>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {fragment.sectionId ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (fragment.sectionId) revealSection(fragment.sectionId)
            }}
          >
            Show its answer
          </Button>
        ) : null}
        <Id>{fragment.fragmentId}</Id>
      </div>
    </section>
  )
}

const BARRIER_WORD = {
  'explicit-order': 'The message asks for its outputs in a set order',
  'integrated-presentation': 'The message asks for its outputs presented together',
} as const

/**
 * Everything under the heading and the source: the part tabs, the selected
 * part, the whole-request barrier, and who wrote the rewrites.
 */
export function FragmentDetail(props: {
  decomposition: DecompositionView
  selected: FragmentView | null
  onSelect(fragment: FragmentView): void
  columns: 'fixed' | 'responsive'
}) {
  const { decomposition, selected } = props
  const panelId = useId()
  return (
    <>
      <FragmentTabs decomposition={decomposition} selected={selected} onSelect={props.onSelect} panelId={panelId} />
      {selected ? <FragmentPanel id={panelId} decomposition={decomposition} fragment={selected} columns={props.columns} /> : null}

      {decomposition.barrier ? (
        <section className="px-4 pt-3" aria-label="Whole-request barrier">
          <h4 className="eyebrow">Whole-request barrier</h4>
          <p className="mt-1 text-xs leading-relaxed">
            {BARRIER_WORD[decomposition.barrier.reason]}: “{decomposition.barrier.qualifier}”. If one part is blocked, every
            part waits.
          </p>
        </section>
      ) : null}

      <p className="px-4 pt-3 pb-4 text-2xs leading-relaxed text-muted-foreground">
        Rewritten by the decomposition model <span className="font-mono">{decomposition.model}</span>. The decision model
        only selects among candidates; it writes none of this text.
      </p>
    </>
  )
}

/** The same requirement carried by another fragment: the same record, or the same words from the same place. */
function sameRequirement(a: Requirement, b: Requirement): boolean {
  if (a.id === b.id) return true
  const spanA = a.provenance.span
  const spanB = b.provenance.span
  return (
    a.shared &&
    b.shared &&
    a.provenance.messageId === b.provenance.messageId &&
    spanA !== null &&
    spanB !== null &&
    spanA.start === spanB.start &&
    spanA.end === spanB.end
  )
}

/** One requirement with its scope and where it came from (Q4, Q17, Q59). */
export function RequirementItem(props: {
  requirement: Requirement
  originalMessageId: MessageId
  originalText: string
  sharedWith?: readonly string[]
}) {
  const { requirement, originalMessageId, originalText, sharedWith = [] } = props
  const span = requirement.provenance.span
  const fromThisMessage = requirement.provenance.messageId === originalMessageId
  const quote = span && fromThisMessage ? originalText.slice(span.start, span.end) : null
  return (
    <li className="rounded-md border border-border bg-background px-2.5 py-2 text-xs leading-relaxed" data-requirement-id={requirement.id}>
      <p>{requirement.text}</p>
      <p className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <Pill tone={requirement.scope === 'session-wide' ? 'warning' : 'quiet'}>
          {requirement.scope === 'session-wide' ? 'Session-wide' : 'Local'}
        </Pill>
        {requirement.shared ? <Pill>Shared</Pill> : null}
      </p>
      <p className="mt-1.5 text-muted-foreground">
        {quote !== null ? (
          <>
            From the source: “<span className="text-foreground">{quote}</span>”
          </>
        ) : fromThisMessage ? (
          'From this message, not as a quotable span.'
        ) : (
          <>
            From an earlier message <Id>{requirement.provenance.messageId}</Id>
          </>
        )}
        {sharedWith.length > 0 ? ` Also applies to ${sharedWith.join(', ')}.` : ''}
        {requirement.scope === 'local'
          ? ' Applies to this request only.'
          : ' Applies to the whole conversation, because the user said so.'}
      </p>
    </li>
  )
}

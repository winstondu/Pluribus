import type { DecompositionView, FragmentId, FragmentView, MessageId, Requirement, TranscriptProjection } from '@committee/protocol'
import { XIcon } from 'lucide-react'
import { useState } from 'react'
import { useUiState } from '@/app/ui-state'
import { useApp, useGenealogy, useTranscript } from '@/backend'
import { Button } from '@/components/ui/button'
import { chainColor, chainTint } from '@/design/chains'
import { cn } from '@/lib/utils'
import { ChainName, EmptyState, Id, Pill, Verbatim } from '../parts'
import { segmentText, spanText } from './spans'

/**
 * The decompositions Compare can open. Split messages are always available
 * (Q53, Q87); an independent composite only behind its debug toggle (Q94).
 */
export function listDecompositions(
  transcript: TranscriptProjection,
  includeIndependent: boolean,
): { messageId: MessageId; decomposition: DecompositionView }[] {
  const found: { messageId: MessageId; decomposition: DecompositionView }[] = []
  const seen = new Set<string>()
  for (const item of transcript.order) {
    if (item.kind !== 'message') continue
    const message = transcript.messages[item.id]
    if (!message) continue
    const split = message.split ? transcript.splits[message.split.originalMessageId] : undefined
    if (split && !seen.has(split.originalMessageId)) {
      seen.add(split.originalMessageId)
      found.push({ messageId: split.originalMessageId, decomposition: split.decomposition })
    }
    if (message.decomposition && includeIndependent && !seen.has(message.id)) {
      seen.add(message.id)
      found.push({ messageId: message.id, decomposition: message.decomposition })
    }
  }
  return found
}

function findDecomposition(transcript: TranscriptProjection, messageId: MessageId): DecompositionView | null {
  return transcript.splits[messageId]?.decomposition ?? transcript.messages[messageId]?.decomposition ?? null
}

/**
 * The Compare decomposition inspector (09 §3): the exact original message
 * beside each fragment's rewritten instruction, and the requirements each
 * fragment inherited with where they came from. It exists so that a lost
 * constraint can be traced to decomposition.
 */
export function Compare() {
  const transcript = useTranscript()
  const compare = useUiState((state) => state.compare)
  const openCompare = useUiState((state) => state.openCompare)
  const includeIndependent = useApp()?.settings.debug.compareIndependent ?? false
  const decomposition = compare ? findDecomposition(transcript, compare) : null

  if (!decomposition) {
    const available = listDecompositions(transcript, includeIndependent)
    return (
      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto">
        {available.length === 0 ? (
          <EmptyState title="No decomposed message here">
            When a message is split into parts, this shows its exact text beside what each part was asked.
          </EmptyState>
        ) : (
          <div className="px-4 py-3">
            <p className="text-xs leading-relaxed text-muted-foreground">Choose a message to see how it was split.</p>
            <ul className="mt-2 flex flex-col gap-1.5">
              {available.map((entry) => (
                <li key={entry.messageId}>
                  <button
                    type="button"
                    className="pressable w-full rounded-md border border-border bg-background px-2.5 py-2 text-left text-xs leading-relaxed hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    onClick={() => openCompare(entry.messageId)}
                  >
                    <span className="line-clamp-2">{entry.decomposition.originalText}</span>
                    <span className="mt-1 block text-2xs text-muted-foreground">
                      {entry.decomposition.fragments.length} parts ·{' '}
                      {entry.decomposition.presentation === 'split-messages' ? 'split messages' : 'one reply with sections'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    )
  }

  return <CompareView key={decomposition.originalMessageId} decomposition={decomposition} onClose={() => openCompare(null)} />
}

type Mark =
  | { kind: 'fragment'; fragment: FragmentView }
  | { kind: 'requirement'; requirement: Requirement }

function CompareView({ decomposition, onClose }: { decomposition: DecompositionView; onClose(): void }) {
  const genealogy = useGenealogy()
  const [selectedId, setSelectedId] = useState<FragmentId | null>(decomposition.fragments[0]?.fragmentId ?? null)
  const selected = decomposition.fragments.find((fragment) => fragment.fragmentId === selectedId) ?? decomposition.fragments[0]
  const colorOf = (fragment: FragmentView) => genealogy.chains[fragment.chainId]?.colorIndex ?? 0

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
  const segments = segmentText(decomposition.originalText, marks)

  return (
    <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto" data-testid="compare">
      <div className="flex items-start justify-between gap-2 px-4 pt-3">
        <div>
          <h3 className="text-sm font-medium">How this message was split</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {decomposition.fragments.length} parts ·{' '}
            {decomposition.presentation === 'split-messages' ? 'shown as split messages' : 'shown as one reply with sections'}
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close Compare" onClick={onClose}>
          <XIcon />
        </Button>
      </div>

      <section className="px-4 pt-3" aria-label="Exact source">
        <h4 className="eyebrow">Exact source</h4>
        <p
          data-testid="compare-original"
          className="mt-1.5 rounded-md border border-border bg-background px-2.5 py-2 text-xs leading-[1.7] break-words whitespace-pre-wrap"
        >
          {segments.map((segment) => {
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
                className={cn('rounded-[3px] bg-transparent text-inherit', requirement && 'font-medium')}
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
          })}
        </p>
        <p className="mt-1.5 text-2xs leading-relaxed text-muted-foreground">
          The message exactly as sent. The selected part is underlined in its chain’s color; a requirement it inherited
          is shaded.
        </p>
      </section>

      <div role="tablist" aria-label="Parts" className="flex flex-wrap gap-1.5 px-4 pt-3">
        {decomposition.fragments.map((fragment) => {
          const active = fragment.fragmentId === selected?.fragmentId
          return (
            <button
              key={fragment.fragmentId}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setSelectedId(fragment.fragmentId)}
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

      {selected ? <FragmentPanel decomposition={decomposition} fragment={selected} /> : null}

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
    </div>
  )
}

const BARRIER_WORD = {
  'explicit-order': 'The message asks for its outputs in a set order',
  'combined-limit': 'The message sets a limit across its outputs together',
  'integrated-presentation': 'The message asks for its outputs presented together',
} as const

function FragmentPanel({ decomposition, fragment }: { decomposition: DecompositionView; fragment: FragmentView }) {
  const transcript = useTranscript()
  const revealSection = useUiState((state) => state.revealSection)
  const section = fragment.sectionId ? transcript.sections[fragment.sectionId] : undefined
  const source = spanText(decomposition.originalText, fragment.sourceSpans)

  return (
    <section className="px-4 pt-3" aria-label={`Part: ${fragment.label}`} role="tabpanel">
      <div className="grid grid-cols-2 gap-2">
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

import type {
  AttemptResultStatus,
  BudgetStopRecord,
  CandidateSourceRecord,
  ConsumedMessage,
  ContextOrigin,
  Decided,
  DirectiveState,
  GenealogyProjection,
  Placement,
  PointRef,
  PrerequisiteRef,
  RunInspection,
  SectionId,
  StrategyChoice,
  StrategySelectionRecord,
  TranscriptProjection,
  UnitRoutingDecision,
  WaitTargetView,
} from '@committee/protocol'
import type { ReactNode } from 'react'
import { useUiState } from '@/app/ui-state'
import { useGenealogy, useRunInspection, useTranscript } from '@/backend'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { RequirementItem } from '../compare/compare'
import { segmentText } from '../compare/spans'
import { ChainName, EmptyState, Id, Pill, Row, Verbatim } from '../parts'

/**
 * The run inspector (09 §5): the seven things selecting a run reveals. Item
 * 3 is the input recorded when the attempt started, shown exactly as it was
 * sent, never recomputed from the conversation as it stands now.
 */
export function RunInspector() {
  const inspected = useUiState((state) => state.inspected)
  const inspection = useRunInspection(inspected?.directiveId ?? null, inspected?.attemptId ?? null)

  if (!inspected) {
    return (
      <EmptyState title="No run selected">
        Choose “Inspect run” on an answer, a mini-map node or an operation to see what that run was given.
      </EmptyState>
    )
  }
  if (!inspection) {
    return <div className="min-h-0 flex-1" aria-busy="true" aria-label="Loading the run" />
  }
  return <Inspection inspection={inspection} />
}

const RESULT_WORD: Record<AttemptResultStatus, { text: string; tone: 'quiet' | 'warning' | 'bad' | 'good' }> = {
  'in-flight': { text: 'In flight', tone: 'quiet' },
  current: { text: 'Current', tone: 'good' },
  superseded: { text: 'Superseded', tone: 'warning' },
  failed: { text: 'Failed', tone: 'bad' },
  stopped: { text: 'Stopped', tone: 'quiet' },
  interrupted: { text: 'Interrupted', tone: 'warning' },
}

const DIRECTIVE_STATE_WORD: Record<DirectiveState, string> = {
  'dependency-queued': 'Waiting for results',
  paused: 'Paused',
  'waiting-for-capacity': 'Waiting for capacity',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  stopped: 'Stopped',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
  superseded: 'Superseded',
  ready: 'Waiting for a free slot',
  retrying: 'Retrying',
  'awaiting-elicitation': 'Waiting for your answer',
}

const ORIGIN_WORD = {
  initial: 'first attempt',
  'automatic-retry': 'automatic retry',
  'interruption-recovery': 'automatic retry after an interruption',
  'user-retry': 'retry you asked for',
  revision: 'replacement after a revision',
} as const

function originWord(origin: string): string {
  return (ORIGIN_WORD as Record<string, string>)[origin] ?? origin.replaceAll('-', ' ')
}

function Inspection({ inspection }: { inspection: RunInspection }) {
  const transcript = useTranscript()
  const genealogy = useGenealogy()
  const inspect = useUiState((state) => state.inspect)
  const revealSection = useUiState((state) => state.revealSection)
  const { attempt } = inspection
  const title = inspection.section?.title ?? transcript.sections[inspection.attempts.at(-1)?.sectionId ?? '']?.title ?? 'Run'

  return (
    <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto" data-testid="run-inspector">
      <header className="px-4 pt-3">
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>{DIRECTIVE_STATE_WORD[inspection.directiveState]}</span>
          {attempt ? <ChainName chainId={attempt.chainId} /> : null}
        </p>
        {inspection.attempts.length > 1 ? (
          <div role="group" aria-label="Attempts" className="mt-2 flex flex-wrap gap-1.5">
            {inspection.attempts.map((entry) => {
              const active = entry.attemptId === inspection.attemptId
              return (
                <button
                  key={entry.attemptId}
                  type="button"
                  aria-pressed={active}
                  onClick={() => inspect({ directiveId: inspection.directiveId, attemptId: entry.attemptId })}
                  className={cn(
                    'pressable inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                    active ? 'border-border-strong bg-background font-medium' : 'border-transparent bg-muted text-muted-foreground hover:text-foreground',
                  )}
                >
                  Attempt {entry.number}
                  <span className="text-faint-foreground">{RESULT_WORD[entry.resultStatus].text.toLowerCase()}</span>
                </button>
              )
            })}
          </div>
        ) : null}
      </header>

      <Item n={1} title="Original message and source fragment">
        <SourceText inspection={inspection} />
        {inspection.source.fragment ? (
          <>
            <p className="mt-2 text-2xs text-muted-foreground">Rewritten for this part by decomposition:</p>
            <Verbatim className="mt-1" label="Fragment as rewritten">
              {inspection.source.fragment.rewrittenText}
            </Verbatim>
          </>
        ) : (
          <p className="mt-1.5 text-2xs text-muted-foreground">Handled whole: the message was not split, so there is no fragment.</p>
        )}
      </Item>

      <Item n={2} title="Instruction and requirements">
        <Verbatim label="Resolved instruction">{inspection.instruction}</Verbatim>
        {inspection.requirements.length === 0 ? (
          <p className="mt-1.5 text-2xs text-muted-foreground">No requirements beyond the instruction.</p>
        ) : (
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {inspection.requirements.map((requirement) => (
              <RequirementItem
                key={requirement.id}
                requirement={requirement}
                originalMessageId={inspection.source.originalMessageId}
                originalText={inspection.source.originalText}
              />
            ))}
          </ul>
        )}
      </Item>

      <Item n={3} title="Exact model input">
        <ModelInput inspection={inspection} transcript={transcript} genealogy={genealogy} />
      </Item>

      <Item n={4} title="Still waiting for">
        <Waiting inspection={inspection} />
      </Item>

      <Item n={5} title="Routing decision">
        <Routing inspection={inspection} transcript={transcript} genealogy={genealogy} />
      </Item>

      <Item n={6} title="Attempt">
        {attempt ? (
          <dl>
            <Row label="Version">
              <span className="inline-flex flex-wrap items-center gap-1.5">
                Attempt {attempt.number} of {Math.max(attempt.number, inspection.attempts.length)}
                <Pill tone={RESULT_WORD[attempt.resultStatus].tone}>{RESULT_WORD[attempt.resultStatus].text}</Pill>
              </span>
            </Row>
            <Row label="Result">{RESULT_SENTENCE[attempt.resultStatus]}</Row>
            <Row label="Why it ran">{originWord(attempt.origin)}</Row>
            <Row label="Model">
              <span className="font-mono text-2xs">{attempt.model}</span> · {attempt.modelRole}
            </Row>
            <Row label="Ran on">
              <ChainName chainId={attempt.chainId} />
            </Row>
            <Row label="Started">
              <time className="tabular">{clock(attempt.startedAt)}</time>
              {attempt.endedAt !== null ? (
                <>
                  {' '}
                  · ended <time className="tabular">{clock(attempt.endedAt)}</time>
                </>
              ) : (
                ' · not ended'
              )}
            </Row>
            {attempt.failure ? (
              <Row label="Failure">
                <span className="text-destructive">{attempt.failure.message}</span>
                <span className="text-muted-foreground">
                  {' '}
                  · {attempt.failure.code}
                  {attempt.failure.httpStatus !== null ? ` · HTTP ${attempt.failure.httpStatus}` : ''}
                </span>
              </Row>
            ) : null}
            <Row label="IDs">
              <span className="flex flex-col gap-0.5">
                {inspection.attemptId ? <Id>{inspection.attemptId}</Id> : null}
                <Id>{inspection.directiveId}</Id>
                <Id>{attempt.nodeId}</Id>
              </span>
            </Row>
          </dl>
        ) : (
          <p className="text-xs leading-relaxed text-muted-foreground">
            No attempt yet. The work is {DIRECTIVE_STATE_WORD[inspection.directiveState].toLowerCase()}.
            <span className="mt-1 block">
              <Id>{inspection.directiveId}</Id>
            </span>
          </p>
        )}
      </Item>

      <Item n={7} title="Answer section">
        {inspection.section ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span>{inspection.section.title}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (inspection.section) revealSection(inspection.section.sectionId)
              }}
            >
              Show in transcript
            </Button>
            <Id>{inspection.section.sectionId}</Id>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No answer section is open for this work yet.</p>
        )}
      </Item>
      <div className="h-4" />
    </div>
  )
}

const RESULT_SENTENCE: Record<AttemptResultStatus, string> = {
  'in-flight': 'Still running. There is no result yet.',
  current: 'This is the result in force for its section.',
  superseded: 'Replaced by later work. Kept as it was, and no longer what follow-up work reads.',
  failed: 'Ended in an error. Nothing depends on its text.',
  stopped: 'Ended by you. Any text it showed stays as partial.',
  interrupted: 'Lost when what was running it stopped unexpectedly.',
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function Item({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="border-t border-border px-4 py-3 first-of-type:mt-3" aria-label={title} data-item={n}>
      <h4 className="mb-1.5 flex items-baseline gap-2 text-xs font-medium">
        <span className="tabular w-3 shrink-0 text-faint-foreground">{n}</span>
        {title}
      </h4>
      <div className="pl-5">{children}</div>
    </section>
  )
}

/** Item 1: the message exactly as typed, with the fragment's source spans marked. */
function SourceText({ inspection }: { inspection: RunInspection }) {
  const { originalText, fragment } = inspection.source
  const segments = segmentText(
    originalText,
    (fragment?.sourceSpans ?? []).map((span) => ({ span, mark: true as const })),
  )
  return (
    <p
      aria-label="Original message"
      className="rounded-md border border-border bg-background px-2.5 py-2 text-xs leading-[1.7] break-words whitespace-pre-wrap"
    >
      {segments.map((segment) =>
        segment.marks.length > 0 ? (
          <mark key={segment.start} className="rounded-[3px] bg-accent text-inherit shadow-[inset_0_-2px_0_var(--border-strong)]">
            {segment.text}
          </mark>
        ) : (
          <span key={segment.start}>{segment.text}</span>
        ),
      )}
    </p>
  )
}

function nodeLabel(genealogy: GenealogyProjection, inspection: RunInspection, nodeId: string): string {
  const fromRecord = inspection.ancestry.find((entry) => entry.nodeId === nodeId)?.label
  if (fromRecord) return fromRecord
  const node = genealogy.nodes[nodeId]
  return node ? (node.kind === 'join-back' ? 'join-back' : node.label) : nodeId
}

function originLabel(origin: ContextOrigin, inspection: RunInspection, genealogy: GenealogyProjection): string {
  switch (origin.kind) {
    case 'preamble':
      return 'Committee’s instructions'
    case 'session-requirement':
      return 'Session-wide requirement'
    case 'ancestor-request':
      return `Earlier request · ${nodeLabel(genealogy, inspection, origin.nodeId)}${origin.joinBackId ? ' · from a join-back' : ''}`
    case 'ancestor-answer':
      return `Earlier answer · ${nodeLabel(genealogy, inspection, origin.nodeId)}${origin.joinBackId ? ' · from a join-back' : ''}`
    case 'unfinished-exchange':
      return `Marker · ${nodeLabel(genealogy, inspection, origin.nodeId)} ${origin.outcome}, no text read`
    case 'correction':
      return 'Correction'
    case 'request':
      return 'This run’s request'
    case 'clarification-question':
      return 'Clarification question'
    case 'clarification-answer':
      return 'Your answer to the question'
  }
}

/** Item 3: every message of the recorded input, in order, verbatim. */
function ModelInput(props: { inspection: RunInspection; transcript: TranscriptProjection; genealogy: GenealogyProjection }) {
  const { inspection, genealogy } = props
  const input = inspection.input
  if (!input) {
    return (
      <p className="text-xs leading-relaxed text-muted-foreground">
        Not started, so nothing has been sent. The input is assembled and recorded when the attempt starts.
      </p>
    )
  }
  return (
    <>
      <p className="text-2xs leading-relaxed text-muted-foreground">
        As recorded when this attempt started, in the order sent. Later answers, revisions and retries do not change it.
      </p>
      <p className="tabular mt-1 text-2xs text-muted-foreground">
        {input.messages.length} {input.messages.length === 1 ? 'message' : 'messages'} · {input.inputTokens.toLocaleString('en-US')} tokens
        {input.tokenLimit !== null ? ` of ${input.tokenLimit.toLocaleString('en-US')}` : ''}
      </p>
      {inspection.ancestry.length > 0 ? (
        <div className="mt-2">
          <p className="text-2xs text-muted-foreground">Context ancestry, root first:</p>
          <ol className="mt-1 flex flex-wrap gap-1" aria-label="Context ancestry" data-testid="ancestry">
            {inspection.ancestry.map((entry) => (
              <li key={entry.nodeId} className="inline-flex h-5 items-center rounded-full bg-muted px-2 text-2xs" data-node-id={entry.nodeId}>
                <ChainName chainId={entry.chainId} className="[&>span:nth-child(n+2)]:hidden" />
                <span className="ml-1.5">{entry.label}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <p className="mt-2 text-2xs text-muted-foreground">No earlier exchange was read: this run started a chain.</p>
      )}
      <ol className="mt-2 flex flex-col gap-1.5" aria-label="Model input" data-testid="model-input">
        {input.messages.map((message, index) => (
          <InputMessage key={index} message={message} label={originLabel(message.origin, inspection, genealogy)} />
        ))}
      </ol>
    </>
  )
}

function InputMessage({ message, label }: { message: ConsumedMessage; label: string }) {
  return (
    <li data-role={message.role} data-origin={message.origin.kind}>
      <p className="mb-0.5 flex items-baseline gap-1.5 text-2xs">
        <span className="font-mono text-faint-foreground">{message.role}</span>
        <span className="text-muted-foreground">{label}</span>
      </p>
      <Verbatim className={cn(message.origin.kind === 'request' && 'border-border-strong')}>{message.content}</Verbatim>
    </li>
  )
}

/** Item 4: result dependencies, kept apart from the context above. */
function Waiting({ inspection }: { inspection: RunInspection }) {
  const nothing = inspection.waitingFor.length === 0 && (inspection.barrier === null || inspection.barrier.waitingFor.length === 0)
  return (
    <div className="text-xs leading-relaxed" data-testid="waiting-for">
      {inspection.waitingFor.length > 0 ? (
        <WaitList label="Needs these results before it can start" targets={inspection.waitingFor} />
      ) : null}
      {inspection.barrier && inspection.barrier.waitingFor.length > 0 ? (
        <div className={cn(inspection.waitingFor.length > 0 && 'mt-2')} data-testid="barrier-wait">
          <WaitList
            label={`Held with the rest of its message (“${inspection.barrier.barrier.qualifier}”), which waits for`}
            targets={inspection.barrier.waitingFor}
          />
          <p className="mt-1 text-2xs text-muted-foreground">It does not need these results itself.</p>
        </div>
      ) : null}
      {nothing ? <p className="text-muted-foreground">Nothing. No unfinished result is holding this work.</p> : null}
      <p className="mt-1.5 text-2xs text-muted-foreground">
        Waiting is about results that must finish first. It is separate from the context a run reads.
      </p>
    </div>
  )
}

function WaitList({ label, targets }: { label: string; targets: readonly WaitTargetView[] }) {
  return (
    <>
      <p className="text-muted-foreground">{label}:</p>
      <ul className="mt-1 flex flex-wrap gap-1">
        {targets.map((target, index) => (
          <li key={index}>
            <Pill>{target.label}</Pill>
          </li>
        ))}
      </ul>
    </>
  )
}

function confidence<T>(decided: Decided<T>): string {
  return decided.confidence === null ? 'no confidence recorded' : `confidence ${decided.confidence.toFixed(2)}`
}

const RELATION_WORD = {
  new: 'new, unrelated work',
  addition: 'an addition to existing context',
  'result-dependent': 'work that needs a result not available yet',
  revision: 'a revision of earlier work',
} as const

function pointWord(point: PointRef, genealogy: GenealogyProjection, inspection: RunInspection): string {
  if (point.kind === 'node') return nodeLabel(genealogy, inspection, point.nodeId)
  if (point.kind === 'sibling-group') return 'a sibling group’s join-back'
  return 'an earlier part of the same message'
}

function placementWord(placement: Placement, genealogy: GenealogyProjection, inspection: RunInspection): string {
  if (placement.kind === 'new-chain') return 'a new chain'
  if (placement.kind === 'continue') return `continue from ${pointWord(placement.buildsOn, genealogy, inspection)}`
  return `a join chain over ${placement.parents.map((parent) => pointWord(parent, genealogy, inspection)).join(' + ')}`
}

function prerequisiteWord(ref: PrerequisiteRef, transcript: TranscriptProjection): string {
  if (ref.kind === 'sibling-group') return 'a whole sibling group'
  const section = Object.values(transcript.sections).find((candidate) => candidate.directiveId === ref.directiveId)
  return section?.title ?? ref.directiveId
}

const FALLBACK_SENTENCE: { readonly [F in NonNullable<StrategySelectionRecord['fallback']>]: string } = {
  failed: 'the decision model could not be asked',
  'low-confidence': 'the decision model was not confident',
  'no-budget': 'the decision budget had no room to ask the decision model',
}

function strategyWord(choice: StrategyChoice): string {
  if (choice.strategy === 'one-pass') return 'One pass'
  const settings = [
    choice.searchLongRuns ? 'long runs searched' : 'runs listed',
    choice.startAtTrunkBase ? 'from the trunk base' : null,
    choice.hopBetweenBranchPoints ? 'hopping between branch points' : null,
  ].filter((text): text is string => text !== null)
  return `Tree walk (${settings.join(', ')})`
}

/** How the referent strategy was chosen for this routing, when a strategy selector was on. */
function StrategySelectionRow({ selection }: { selection: StrategySelectionRecord }) {
  const by = selection.selector === 'rules' ? 'the rules' : 'the decision model'
  const scores = selection.scores ? Object.entries(selection.scores) : []
  return (
    <Row label="Strategy">
      <span data-testid="strategy-selection">
        {strategyWord(selection.choice)} · <span className="text-muted-foreground">chosen by {by}</span>
        {selection.reused ? <span className="text-muted-foreground"> · reused for the same shape</span> : null}
        {selection.fallback ? <span className="text-muted-foreground"> · {FALLBACK_SENTENCE[selection.fallback]}</span> : null}
        <span className="mt-0.5 block text-muted-foreground">{selection.reason}</span>
        {scores.length > 0 ? (
          <span className="mt-0.5 block font-mono text-2xs text-muted-foreground">
            {scores.map(([name, value]) => `${name} ${value.toFixed(2)}`).join(' · ')}
          </span>
        ) : null}
      </span>
    </Row>
  )
}

const LIMIT_WORD: { readonly [L in BudgetStopRecord['limit']]: string } = {
  'token-budget': 'the token budget',
  'price-guard': 'the bound against the answer',
  requests: 'the limit on further requests',
  questions: 'the limit on questions',
}

/** That the decision budget stopped the search for referents, and the best node found so far where routing used one. */
function BudgetStopRow({ stop, unitKey, transcript }: { stop: BudgetStopRecord; unitKey: string | null; transcript: TranscriptProjection }) {
  const best = stop.bestFound.find((found) => found.unit === unitKey) ?? null
  const title = (sectionId: SectionId): string => transcript.sections[sectionId]?.title ?? sectionId
  return (
    <Row label="Decision budget">
      <span data-testid="budget-stop">
        Reached {LIMIT_WORD[stop.limit]} ·{' '}
        <span className="text-muted-foreground">
          {stop.fallback === 'one-pass' ? 'the remaining listed sections were asked about in one request' : 'nothing more was asked'}
        </span>
        <span className="mt-0.5 block text-muted-foreground">
          {best
            ? `The user was not asked which section is meant. The best node found so far was used: ${best.sectionIds.map(title).join(' + ')}, confidence ${best.confidence.toFixed(2)}.`
            : 'The best node found so far was not needed for this work.'}
        </span>
      </span>
    </Row>
  )
}

const SOURCE_WORD: { readonly [name: string]: string } = { lexical: 'the word index' }

/**
 * What the candidate source handed this routing: seed hints, places the tree walk starts at besides the roots. A
 * score is the source's own figure; no section is a target because it is listed here.
 */
function CandidateSourceRow({ record, unitKey, transcript }: { record: CandidateSourceRecord; unitKey: string | null; transcript: TranscriptProjection }) {
  const entry = record.units.find((u) => u.unit === unitKey) ?? (record.units.length === 1 ? record.units[0] : undefined)
  const candidates = entry?.candidates ?? []
  const title = (sectionId: SectionId): string => transcript.sections[sectionId]?.title ?? sectionId
  return (
    <Row label="Candidate sections">
      <span data-testid="candidate-source">
        {candidates.length === 0 ? 'None' : `${candidates.length}`} ·{' '}
        <span className="text-muted-foreground">from {SOURCE_WORD[record.source] ?? `the source “${record.source}”`}</span>
        {candidates.length > 0 ? (
          <span className="mt-0.5 block">
            {candidates.map((c, i) => (
              <span key={c.sectionId}>
                {i > 0 ? ' · ' : ''}
                {title(c.sectionId)}
                {c.score !== null ? <span className="font-mono text-2xs text-muted-foreground"> {c.score.toFixed(1)}</span> : null}
              </span>
            ))}
          </span>
        ) : null}
        <span className="mt-0.5 block text-muted-foreground">
          {candidates.length > 0
            ? 'Seed hints: places the tree walk may start at. Each is asked about by itself; none is a target because it is listed here, and the scores are the source’s own.'
            : 'It found no answer close enough to the message, so the search started at the roots.'}
        </span>
      </span>
    </Row>
  )
}

/** Item 5: what routing decided. A record, not a verdict. */
function Routing(props: { inspection: RunInspection; transcript: TranscriptProjection; genealogy: GenealogyProjection }) {
  const { inspection, transcript, genealogy } = props
  const routing = inspection.routing
  if (!routing) return <p className="text-xs text-muted-foreground">No routing decision is recorded for this work.</p>
  const { decision, unit } = routing
  return (
    <div data-testid="routing">
      <p className="text-2xs leading-relaxed text-muted-foreground">
        What routing decided and the reason it recorded. This is a record of the decision, not a judgement that it was
        right.
      </p>
      <dl className="mt-1.5">
        <Row label="Decided by">
          {decision.source === 'decision-model' ? (
            <>
              the decision model <span className="font-mono text-2xs">{decision.model ?? 'unknown'}</span>
            </>
          ) : (
            'supplied, not chosen by a model'
          )}
        </Row>
        <Row label="Message">
          {decision.composition.value} · <span className="text-muted-foreground">{confidence(decision.composition)}</span>
        </Row>
        {unit ? <UnitRows unit={unit} transcript={transcript} genealogy={genealogy} inspection={inspection} /> : null}
        {decision.strategySelection ? <StrategySelectionRow selection={decision.strategySelection} /> : null}
        {decision.candidateSource ? <CandidateSourceRow record={decision.candidateSource} unitKey={unit?.key ?? null} transcript={transcript} /> : null}
        {decision.budgetStop ? <BudgetStopRow stop={decision.budgetStop} unitKey={unit?.key ?? null} transcript={transcript} /> : null}
        <Row label="Explanation">{unit?.explanation || decision.explanation || 'None recorded.'}</Row>
      </dl>
      {decision.questions.length > 0 ? (
        <details className="mt-1.5 text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            Questions put to the decision model ({decision.questions.length})
          </summary>
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {decision.questions.map((question) => (
              <li key={question.id} className="rounded-md border border-border bg-background px-2.5 py-2 leading-relaxed">
                <p>{question.instructions}</p>
                <p className="mt-1 text-muted-foreground">
                  <span className="font-mono text-2xs">{question.type}</span> · answered{' '}
                  <span className="text-foreground">
                    {typeof question.answer === 'number' ? question.answer.toFixed(2) : question.answer}
                  </span>
                  {question.confidence !== null ? ` · confidence ${question.confidence.toFixed(2)}` : ''}
                </p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  )
}

function UnitRows(props: {
  unit: UnitRoutingDecision
  transcript: TranscriptProjection
  genealogy: GenealogyProjection
  inspection: RunInspection
}) {
  const { unit, transcript, genealogy, inspection } = props
  const targets = unit.targets.sectionIds.map((id) => transcript.sections[id]?.title ?? id)
  return (
    <>
      <Row label="Relation">
        {RELATION_WORD[unit.relation.value]} · <span className="text-muted-foreground">{confidence(unit.relation)}</span>
        {unit.correctiveConfidence !== null ? (
          <span className="block text-muted-foreground">
            clearly corrective wording: {unit.correctiveConfidence.toFixed(2)}
          </span>
        ) : null}
      </Row>
      <Row label="Reply target">
        {unit.targets.mode === 'none' ? 'none' : `${targets.join(', ')} · ${unit.targets.mode}`}
        {unit.targets.redirected.length > 0 ? (
          <span className="block text-muted-foreground">redirected to the revised version</span>
        ) : null}
        {unit.targets.candidates.length > 0 ? (
          <span className="block text-muted-foreground">
            scored:{' '}
            {unit.targets.candidates
              .map((candidate) => `${transcript.sections[candidate.sectionId]?.title ?? candidate.sectionId} ${candidate.confidence.toFixed(2)}`)
              .join(', ')}
          </span>
        ) : null}
      </Row>
      <Row label="Placement">
        {placementWord(unit.placement.value, genealogy, inspection)} ·{' '}
        <span className="text-muted-foreground">{confidence(unit.placement)}</span>
      </Row>
      <Row label="Must wait for">
        {unit.prerequisites.value.length === 0
          ? 'nothing'
          : unit.prerequisites.value.map((ref) => prerequisiteWord(ref, transcript)).join(', ')}{' '}
        · <span className="text-muted-foreground">{confidence(unit.prerequisites)}</span>
      </Row>
      {unit.needsClarification !== null ? (
        <Row label="Needs to ask">probability {unit.needsClarification.toFixed(2)}</Row>
      ) : null}
    </>
  )
}

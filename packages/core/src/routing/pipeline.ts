import {
  type BestNodeRecord,
  type RunEndRecord,
  type BudgetStopRecord,
  type CandidateSourceRecord,
  type DecisionBudget,
  type StrategySelectionRecord,
  type TreeWalkSettings,
  provisionalLabel,
  providerError,
  type Decided,
  type DecisionQuestionRecord,
  type DirectiveId,
  type ElicitationId,
  type FragmentId,
  type Placement,
  type ProviderError,
  type Requirement,
  type RequirementId,
  type RoutingDecision,
  type SectionId,
  type SiblingGroupId,
  type TextSpan,
  type UnitRoutingDecision,
  type WholeRequestBarrier,
} from '@pluribus/protocol'
import type {
  BestNodeFound,
  ScoredSection,
  CancelSignal,
  CandidateHit,
  CandidateSection,
  CandidateSource,
  DecisionProvider,
  CoreDependencies,
  DecomposedFragment,
  Decomposition,
  DecompositionCandidate,
  PlannedClarification,
  PlannedRevision,
  PlannedSessionRequirement,
  PlannedUnit,
  ReferentRequest,
  ReferentResult,
  ReferentStrategy,
  ReferentUnit,
  Router,
  RoutingInput,
  RoutingOutcome,
  RoutingPlan,
  SelectorAsk,
  UnitReferents,
} from '../ports'
import { Batch, ask, type Answers } from './batch'
import { createLexicalCandidateSource } from './candidates'
import { AMBIGUITY_FLOOR, derivePlacement, neededWork, placedWithoutTarget, referentCovered, resolveUnitTargets, selected, validatePlan, type TargetMode } from './derive'
import { askUnit, readUnit, sectionNumbers, withReferents, type UnitScope, type UnitSignals } from './questions'
import { createReferentAsk, estimateRequestTokens, firstPassQuestions, firstPassSectionIds, questionSubjects, referentStrategyFor, routingTokenBudget, type ReferentSpend, type RoutingTokenBudget } from './referents'
import { applyChoice, choiceText, selectStrategy, strategySelectorFor } from './selection'
import { MAX_SECTIONS, MIN_SECTIONS, answerOf, decisionContextOf, describeState, listedLine, numberedAnswerSections, showingFor, supply, type Supplied } from './supply'
import { chooseShown, recordLine, shownWords, type Showing, type ShownChoice, type ShownPoint } from './shown'

/**
 * The default router: the routing pipeline of 11 · "Routing".
 *
 * 1. Decision gate: one batched call to the decision model with bounded
 *    questions about the message as a whole: atomic or composite, whether
 *    a requirement is made conversation-wide, and the unit question set
 *    (corrective wording, relation, reply targets, handling chain, result
 *    dependencies, conversation-wide requirements it changes, whether it
 *    needs a clarification). The first message of an empty conversation
 *    has nothing to relate to, so only the questions about the message
 *    itself are asked.
 * 2. Generative decomposition, only when the gate judges the message
 *    composite (or it states a conversation-wide requirement, whose text
 *    only the decomposer may write). A message that sets one combined total
 *    output limit is atomic however separable its subjects: the gate asks,
 *    and it is not decomposed (Q102). While the ordered-message setting keeps
 *    ordered messages atomic, a message the decomposer finds an explicit
 *    output order in is routed as one request, with no barrier (Q104). Then a second batched call asks the
 *    unit question set per fragment over the same candidates, with the
 *    decomposer's candidate dependencies between fragments, the shared
 *    requirements, and its proposed whole-request barrier: this is the
 *    stage that assigns each fragment its chain and target.
 * 3. Deterministic validation (`validatePlan`).
 *
 * Which answer sections a unit refers to is decided by a referent strategy
 * (`referents/`, docs/build/dependency-decisioning.md): its questions ride
 * in the calls above, and any further call it makes is counted against the
 * routing's decision budget. The pipeline does not know which strategy it
 * has; thresholds, placement and validation are the same after any of them.
 * A tree walk may be given places to start besides the roots: what the
 * candidate source names for each unit (`startCandidatesFor`). The source
 * is the injected one, or the one `settings.routing.candidateSource` names;
 * what it returned is recorded with the decision.
 *
 * Every decision request of a routing draws from one token budget
 * (`routingTokenBudget`): the smaller of `settings.routing.tokenBudget` and
 * the price guard's allowance. The pipeline's own request comes first: when
 * it would not fit with the full window of answer sections it lists fewer,
 * the most recent ones, down to the first-pass sections alone
 * (`MIN_SECTIONS`). What is left is the referent strategy's. The budget is a
 * hard stop: a strategy it stops asks nothing more, the user is not asked
 * which section is meant, and the best node found so far is used.
 *
 * Which strategy runs, and with which tree-walk settings, is the settings'
 * unless a strategy selector is on (`selection/`): then it is chosen for
 * this routing from the shape of the genealogy, before the gate, and how it
 * was chosen is recorded with the decision. The pipeline is handed a
 * strategy and settings either way.
 *
 * Shared-requirement revisions take one more call over the brief's
 * consumers, to pre-select the work actually affected (Q44).
 *
 * The router never mints an ID except through `input.ids`, never reads the
 * clock, and never rejects: provider failures are a `failed` outcome.
 */
export function createRouter(dependencies: RouterDependencies): Router {
  // One lexical source for the router's lifetime: it keeps its index between routings.
  const deps: Deps = { ...dependencies, lexicalSource: createLexicalCandidateSource({ limit: MAX_START_CANDIDATES }) }
  return {
    async route(input, signal) {
      try {
        return await routeMessage(deps, input, signal)
      } catch (error) {
        return { kind: 'failed', error: providerError('malformed-response', error instanceof Error ? error.message : 'Routing failed') }
      }
    },
  }
}

type RouterDependencies = Pick<CoreDependencies, 'decisionProvider' | 'decomposer' | 'referentStrategy' | 'strategySelector' | 'candidateSource'>
type Deps = RouterDependencies & { readonly lexicalSource: CandidateSource }

const failed = (error: ProviderError): RoutingOutcome => ({ kind: 'failed', error })
const malformed = (message: string): RoutingOutcome => failed(providerError('malformed-response', message))

interface Given {
  readonly sectionIds: readonly SectionId[]
  readonly mode: 'explicit' | 'elicited'
}

/** Everything gathered while routing, for the decision record. */
class Record {
  readonly questions: DecisionQuestionRecord[] = []
  model: string | null = null
  /** What the referent strategy did beyond the pipeline's own calls, for the decision's explanation. Empty when nothing. */
  referentNote = ''
  /** Whether the decision model was shown stored summaries, for the decision's explanation. Empty when not. */
  contextNote = ''
  /** How the referent strategy was chosen, when a strategy selector was on. Null when the settings were used as they are. */
  selection: StrategySelectionRecord | null = null
  /** Why the pipeline's request listed fewer answer sections than its window, for the decision's explanation. Empty when it listed them all. */
  windowNote = ''
  /** Which candidate source was asked and what it returned for each unit. Null when none was asked. */
  candidates: CandidateSourceRecord | null = null
  /** Set when a limit of the decision budget stopped the referent strategy: the limit and what the strategy did instead. */
  budgetStop: Pick<BudgetStopRecord, 'limit' | 'fallback'> | null = null
  /** The units placed on the best node found so far, in place of a question to the user. */
  readonly bestFound: BestNodeRecord[] = []
  /** The units placed on the last section of a run without a search inside it (hop between branch points). */
  readonly runEnds: RunEndRecord[] = []
  /** Estimated input tokens of the pipeline's own decision requests so far: they are counted against the routing's token budget first. */
  pipelineTokens = 0

  /** One of the pipeline's own decision requests. */
  ask(provider: DecisionProvider, model: string, stateText: string, batch: Batch, signal: CancelSignal): ReturnType<typeof ask> {
    if (batch.size > 0) this.pipelineTokens += estimateRequestTokens(stateText, batch.questions)
    return ask(provider, model, stateText, batch, signal)
  }

  add(answers: Answers): void {
    this.model ??= answers.model
    this.questions.push(...answers.records())
  }
}

async function routeMessage(deps: Deps, input: RoutingInput, signal: CancelSignal): Promise<RoutingOutcome> {
  const t = input.settings.thresholds
  const forced = input.forcedComposition === 'atomic'
  const given: Given | null = input.chosenTargets
    ? { sectionIds: input.chosenTargets, mode: 'elicited' }
    : input.explicitTargets.length > 0
      ? { sectionIds: input.explicitTargets, mode: 'explicit' }
      : null
  const record = new Record()

  // A reply aimed at an open clarification question is its answer (Q98).
  const everything = supply(input, given?.sectionIds ?? [])
  const answered = given?.sectionIds.map((id) => everything.sectionById.get(id)?.asksElicitationId ?? null).find((id) => id !== null)
  if (answered) return answerPlan(input, answered, record, given?.mode ?? 'explicit', given?.sectionIds ?? [])

  const relate = input.candidates.sections.length > 0 || input.candidates.chains.length > 0
  // Explicit and chosen targets are used as given, so there is no strategy to choose for them.
  const { strategy, treeWalk } = await chooseStrategy(deps, input, given ? null : everything, record, signal)
  const messageUnit: ReferentUnit = { key: 'm', name: 'the new message' }
  const startCandidates = given ? {} : await startCandidatesFor(deps, input, [{ unit: messageUnit, text: input.text }], record)

  // ── 1. The decision gate ──
  const showing = showingFor(input)
  /** The gate's request when the pipeline lists at most `window` answer sections, each Point's answer in the form `choices` gives (the opening when left out). */
  const buildGate = (window: number, choices: ReadonlyMap<SectionId, ShownChoice> | null) => {
    const supplied = supply(input, given?.sectionIds ?? [], window)
    const numbers = sectionNumbers(supplied)
    const gate = new Batch()
    if (!forced) {
      gate.noul('composite', 'Does the new message contain two or more independent requests that could each be answered on its own? Several topics, a requested contrast, or one integrated output are one request.')
      // A combined total output limit keeps the message atomic, however separable its subjects (Q102).
      gate.noul('combinedlimit', COMBINED_LIMIT_QUESTION)
      gate.noul(
        'sessionwide',
        'Does the user explicitly say that a requirement in the new message applies to the whole conversation from now on ("from now on", "in this chat", "for all answers")? A requirement for this request alone does not count.',
      )
    }
    const messageScope: UnitScope = {
      key: 'm',
      name: 'the new message',
      sections: given ? [] : supplied.sections.map((section) => ({ n: numbers.get(section.sectionId) ?? 0, section })),
      corrective: relate,
      relation: relate,
      chain: relate,
      dependencies: relate,
      sessionRequirements: input.sessionRequirements.length > 0,
      clarify: true,
      after: [],
    }
    askUnit(gate, supplied, input, messageScope)
    const subject = [
      `New message: "${input.text}"`,
      ...(given ? [`The user replied to ${given.sectionIds.map((id) => `S${numbers.get(id) ?? '?'}`).join(' and ')}.`] : []),
    ].join('\n')
    // Explicit and chosen targets are used as given: nothing is asked about the message's referents.
    const request = referentRequestFor(input, supplied, given ? [] : [messageUnit], '', subject, treeWalk, startCandidates)
    addReferentQuestions(gate, strategy, request)
    const { stateText, points } = showRequest(input, supplied, gate, request, subject, showing, choices)
    return { supplied, batch: gate, messageScope, subject, stateText, referentRequest: { ...request, stateText }, points }
  }
  // The request lists as many answer sections as the routing's token budget has room for, then shows more of the Points' answers with what it has left.
  const fitted = fitWindow(input, buildGate, tokenBudgetFor(input, 1), record, { showing, share: shownShare(strategy) })
  const { supplied, batch: gate, messageScope, subject, stateText, referentRequest } = fitted
  // Which the decision model saw, for the run inspector: a stored summary and the section's own content, or the usual line.
  const summarised = supplied.sections.filter((s) => decisionContextOf(input, s) !== null).length
  if (summarised > 0) record.contextNote = ` Decision context: a stored summary was shown for ${summarised} of the ${supplied.sections.length} listed sections.`
  const gateResult = await record.ask(deps.decisionProvider, input.settings.models.decision, stateText, gate, signal)
  if (!gateResult.ok) return failed(gateResult.error)
  const g = gateResult.answers
  record.add(g)
  const gateSignals = readUnit(g, supplied, input, messageScope)
  let m = gateSignals
  const composite = g.noul('composite')
  const sessionWide = (g.noul('sessionwide') ?? 0) >= t.clearlyCorrective
  // Replacing or withdrawing a session-wide requirement is a revision, and a revision needs
  // corrective wording (05 · "Revision requires corrective wording", Q37, Q74). Without it a new
  // requirement is recorded beside the ones in force.
  const changedRequirements = (m.corrective ?? 0) >= t.clearlyCorrective ? selected(m.sessionRequirements, t.clearlyCorrective) : []

  // An untargeted message recognised as the answer to an open question (Q98).
  if (!given) {
    const question = m.targets
      .filter((s) => s.confidence >= t.targetChoice && supplied.sectionById.get(s.id)?.asksElicitationId)
      .sort((a, b) => b.confidence - a.confidence)[0]
    const elicitationId = question ? supplied.sectionById.get(question.id)?.asksElicitationId : null
    if (question && elicitationId) return answerPlan(input, elicitationId, record, 'inferred', [question.id], m)
  }

  // ── 2. Generative decomposition, only when needed ──
  // A combined total output limit makes the message one request: it is not decomposed (Q102).
  const keptAtomic: KeptAtomic | null = !forced && (g.noul('combinedlimit') ?? 0) >= t.composite ? 'combined-limit' : null
  const isComposite = !forced && keptAtomic === null && composite !== null && composite >= t.composite
  let decomposition: Decomposition | null = null
  if (!forced && (isComposite || sessionWide || changedRequirements.length > 0)) {
    const candidates: DecompositionCandidate[] = [
      ...supplied.inFlight.map((w) => ({ id: w.directiveId as string, label: w.label, description: w.instruction })),
      ...supplied.openGroups.map((gr) => ({ id: gr.groupId as string, label: gr.label, description: `The parallel requests ${gr.label}, together` })),
    ]
    const result = await deps.decomposer.decompose({ model: input.settings.models.decomposition, provider: input.settings.modelProviders?.decomposition ?? 'openrouter', text: input.text, candidates }, signal)
    if (!result.ok) return failed(result.error)
    const problem = checkDecomposition(input.text, result.decomposition, candidates)
    if (problem) return malformed(problem)
    decomposition = { ...result.decomposition, fragments: [...result.decomposition.fragments].sort((a, b) => firstStart(a) - firstStart(b)) }
  }

  // The gate said the message makes something conversation-wide; which of the requirements the
  // decomposer tagged so is asked of each one on its own, so a local "briefly" beside an explicit
  // "from now on" stays local (D1, Q17).
  const confirmed = new Set<string>()
  if (decomposition && sessionWide) {
    const tagged: { key: string; text: string }[] = []
    for (const f of decomposition.fragments) {
      for (const r of f.requirements) {
        const key = requirementKey(r)
        if (r.scope === 'session-wide' && !tagged.some((x) => x.key === key)) tagged.push({ key, text: r.text.trim() })
      }
    }
    if (tagged.length > 0) {
      const batch = new Batch()
      tagged.forEach((r, i) => {
        batch.noul(
          `rq${i + 1}_sessionwide`,
          `Does the user explicitly say that the requirement "${r.text}" applies to the whole conversation from now on, rather than only to this request?`,
        )
      })
      const result = await record.ask(deps.decisionProvider, input.settings.models.decision, describeState(input, supplied, subject), batch, signal)
      if (!result.ok) return failed(result.error)
      record.add(result.answers)
      tagged.forEach((r, i) => {
        if ((result.answers.noul(`rq${i + 1}_sessionwide`) ?? 0) >= t.clearlyCorrective) confirmed.add(r.key)
      })
    }
  }
  const requirements = new RequirementBook(input, decomposition, confirmed)
  const compositeDecided: Decided<'atomic' | 'composite'> = { value: 'atomic', confidence: composite }

  // What only the decomposer sees: a combined limit the gate missed (Q102), and an explicit output
  // order, which keeps the message one request while ordered messages are kept atomic (Q104). The
  // decomposer also proposes an order for a plain sequence of tasks ("…, and then …"), so the order
  // is confirmed with the decision model first, as the barrier is for a decomposed message.
  let seenByDecomposer: KeptAtomic | null = null
  if (isComposite && decomposition) {
    if (decomposition.combinedLimit !== null) seenByDecomposer = 'combined-limit'
    else if (input.settings.routing.orderedMessages === 'atomic' && decomposition.barrier?.reason === 'explicit-order' && !orderFollowsDependencies(decomposition)) {
      const batch = new Batch()
      batch.noul('ordered', orderedQuestion(decomposition.barrier.qualifier))
      const result = await record.ask(deps.decisionProvider, input.settings.models.decision, describeState(input, supplied, subject), batch, signal)
      if (!result.ok) return failed(result.error)
      record.add(result.answers)
      if ((result.answers.noul('ordered') ?? 0) >= t.dependency) seenByDecomposer = 'ordered'
    }
  }
  const atomicBecause = keptAtomic ?? seenByDecomposer
  if (isComposite && atomicBecause === null && decomposition && decomposition.fragments.length >= 2) {
    return routeComposite(deps, input, signal, { given, record, decomposition, requirements, composite, strategy, treeWalk })
  }

  // ── Atomic ──
  const referents = await resolveReferents(deps, input, signal, strategy, referentRequest, g, [gateSignals], record)
  if (!referents.ok) return failed(referents.error)
  m = withReferents(gateSignals, referents.units['m'])
  const resolution = resolveUnitTargets(m, given, t, {
    fragment: false,
    mayBeReply: m.relation?.value !== 'new' || (m.corrective ?? 0) >= t.clearlyCorrective,
    placedWithoutTarget: placedWithoutTarget(m, t),
    covered: (accepted, weak) => referentCovered(supplied, accepted, weak),
    budgetStop: referents.stop ? { best: referents.stop.best.get('m')?.sectionIds ?? [] } : null,
  })
  if (resolution.kind === 'ambiguous') return { kind: 'target-ambiguity', candidates: resolution.candidates }
  if (resolution.bestFound) record.bestFound.push({ unit: 'message', sectionIds: resolution.sectionIds, confidence: referents.stop?.best.get('m')?.confidence ?? 0 })
  noteRunEnds(record, 'message', referents.units['m'], resolution.sectionIds)
  const referred = answerTargets(supplied, resolution.sectionIds)
  const revision = revisionOf(m, referred, changedRequirements, input.text, null, supplied, t)
  const targets = withNeededGroups(supplied, referred, selected(m.needsGroups, t.dependency))
  const units: PlannedUnit[] = []
  const decisions: UnitRoutingDecision[] = []
  const clarifications: PlannedClarification[] = []
  // A correction of a session-wide requirement alone revises no piece of work, and the message may
  // still ask something ("…from now on keep answers short. What causes tides?"): the request is
  // planned beside the revision, never dropped (02 · "The original message is always preserved").
  const requestToo = revision !== null && revision.targetDirectiveIds.length === 0 && (m.asks ?? 0) >= t.composite
  if (revision) {
    decisions.push(revisionDecision(input, m, requestToo ? 'requirements' : 'message', null, revision, resolution.mode))
  }
  if (!revision || requestToo) {
    const directiveId = input.ids.next('directive')
    const placed = derivePlacement(supplied, {
      relation: m.relation,
      targets,
      needsWork: neededWork(m, targets, supplied, t),
      needsGroups: selected(m.needsGroups, t.dependency),
      needsUnits: [],
      chain: m.chain,
      chainThreshold: t.targetChoice,
      confidences: confidencesOf(m, targets, t),
    })
    units.push({
      directiveId,
      fragment: null,
      instruction: input.text,
      label: provisionalLabel(input.text),
      labelIsProvisional: true,
      requirements: [],
      relation: placed.relation,
      targets,
      placement: placed.placement,
      prerequisites: placed.prerequisites,
    })
    decisions.push(unitDecision(input, m, 'message', null, placed, targets, resolution.mode))
    if ((m.clarify ?? 0) >= t.clarification) {
      clarifications.push({
        questionDirectiveId: input.ids.next('directive'),
        reason: m.clarifyReason,
        about: aboutText(m.clarifyReason, null),
        blockedDirectiveIds: [directiveId],
      })
    }
  }
  const revisions = revision ? [revision] : []
  const affected = await affectedWork(deps, input, signal, supplied, revisions, record)
  if (!affected.ok) return failed(affected.error)
  const plan: RoutingPlan = {
    decision: decisionRecord(input, record, compositeDecided, decisions, units.length === 0 && revision ? 'A correction of earlier work.' : `One request${atomicBecause ? KEPT_ATOMIC_NOTE[atomicBecause] : ''}.`),
    composition: 'atomic',
    units,
    barrier: null,
    outputOrder: null,
    ...requirements.planned(changedRequirements),
    clarifications,
    revisions: affected.revisions,
    answersElicitationId: null,
    decompositionModel: decomposition ? input.settings.models.decomposition : null,
  }
  return finish(input, plan)
}

/** Why a message whose subjects could be answered separately is one request all the same. */
type KeptAtomic = 'combined-limit' | 'ordered'

const KEPT_ATOMIC_NOTE: { readonly [K in KeptAtomic]: string } = {
  'combined-limit': ': a combined total output limit keeps it atomic (Q102)',
  ordered: ': ordered messages are kept atomic by the decomposer setting (Q104)',
}

/**
 * Whether the output order the decomposer proposes says nothing the parts'
 * dependencies do not: each part in it needs the one before. That is a
 * sequence of tasks ("find X, then plan around it"), not an order of
 * presentation, and it does not keep the message atomic.
 */
function orderFollowsDependencies(decomposition: Decomposition): boolean {
  const order = decomposition.outputOrder ?? decomposition.fragments.map((f) => f.key)
  const byKey = new Map(decomposition.fragments.map((f) => [f.key, f]))
  return order.length >= 2 && order.slice(1).every((key, i) => byKey.get(key)?.dependsOnFragments.includes(order[i] ?? '') ?? false)
}

const orderedQuestion = (qualifier: string): string =>
  `Does the new message ask for its answers to be shown to the user in a set order (${qualifier ? `"${qualifier}"` : 'for example "put the translation first"'}), rather than describe a sequence of tasks in which one uses another's result?`

const COMBINED_LIMIT_QUESTION =
  'Does the new message set one limit on its answers taken together, such as a total length for all of them ("under 100 words total", "200 words altogether")? A limit that applies to each answer on its own ("each answer under 100 words") does not count.'


function finish(input: RoutingInput, plan: RoutingPlan): RoutingOutcome {
  const valid = validatePlan(input, plan)
  return valid.ok ? { kind: 'plan', plan: valid.plan } : malformed(valid.message)
}

// ───────────────────────────── composite ─────────────────────────────

interface CompositeContext {
  readonly given: Given | null
  readonly record: Record
  readonly decomposition: Decomposition
  readonly requirements: RequirementBook
  readonly composite: number | null
  readonly strategy: ReferentStrategy
  /** The tree-walk settings the strategy is handed: the configured ones, or a strategy selector's. */
  readonly treeWalk: TreeWalkSettings
}

async function routeComposite(deps: Deps, input: RoutingInput, signal: CancelSignal, c: CompositeContext): Promise<RoutingOutcome> {
  const t = input.settings.thresholds
  const { given, record, decomposition, requirements } = c
  const fragments = decomposition.fragments
  const startCandidates = await startCandidatesFor(
    deps,
    input,
    fragments.map((f, i) => ({ unit: { key: `f${i}`, name: `part F${i + 1}` }, text: f.instruction })),
    record,
  )
  const keyOf = new Map(fragments.map((f, i) => [f.key, `f${i}`]))
  const fragmentIds = new Map<string, FragmentId>()
  const relate = input.candidates.sections.length > 0 || input.candidates.chains.length > 0
  const shared = requirements.sharedRequirements()

  const showing = showingFor(input)
  /** The request about the parts when the pipeline lists at most `window` answer sections, each Point's answer in the form `choices` gives. */
  const buildParts = (window: number, choices: ReadonlyMap<SectionId, ShownChoice> | null) => {
    const supplied = supply(input, given?.sectionIds ?? [], window)
    const numbers = sectionNumbers(supplied)
    const batch = new Batch()
    const scopes: UnitScope[] = fragments.map((f, i) => ({
      key: `f${i}`,
      name: `part F${i + 1}`,
      // Every part is asked about every section, given ones included: a part that does not refer to
      // the given sections keeps its own clear target (T1).
      sections: supplied.sections.map((section) => ({ n: numbers.get(section.sectionId) ?? 0, section })),
      corrective: relate,
      relation: relate,
      chain: relate,
      dependencies: relate,
      sessionRequirements: input.sessionRequirements.length > 0,
      clarify: true,
      after: f.dependsOnFragments.flatMap((key) => {
        const other = keyOf.get(key)
        return other ? [{ key: other, name: `part F${Number(other.slice(1)) + 1}` }] : []
      }),
    }))
    for (const scope of scopes) askUnit(batch, supplied, input, scope)
    shared.forEach((r, i) => {
      batch.noul(
        `q${i + 1}_clarify`,
        `Is the requirement "${r.text}", which several parts share, ambiguous or missing information, so that the user must be asked before those parts can be answered?`,
      )
    })
    if (decomposition.barrier) {
      batch.noul(
        'barrier',
        `Does the message relate its parts' outputs to one another (${decomposition.barrier.qualifier ? `"${decomposition.barrier.qualifier}"` : 'an explicit order or one integrated presentation'}), rather than give requirements that apply to each part separately?`,
      )
    }
    const subject = [
      `New message: "${input.text}"`,
      'Its parts:',
      ...fragments.map((f, i) => `F${i + 1}. ${JSON.stringify(f.instruction)} (from ${JSON.stringify(f.sourceSpans.map((s) => input.text.slice(s.start, s.end)).join(' … '))})`),
      ...(given ? [`The user replied to ${given.sectionIds.map((id) => `S${numbers.get(id) ?? '?'}`).join(' and ')}.`] : []),
    ].join('\n')
    const request = referentRequestFor(input, supplied, scopes.map((scope) => ({ key: scope.key, name: scope.name })), '', subject, c.treeWalk, startCandidates)
    addReferentQuestions(batch, c.strategy, request)
    const { stateText, points } = showRequest(input, supplied, batch, request, subject, showing, choices)
    return { supplied, batch, scopes, stateText, referentRequest: { ...request, stateText }, points }
  }
  // Each part is a piece of work with an answer of its own, so the budget is that of as many answers.
  const { supplied, batch, scopes, stateText, referentRequest } = fitWindow(input, buildParts, tokenBudgetFor(input, fragments.length), record, {
    showing,
    share: shownShare(c.strategy),
  })
  const result = await record.ask(deps.decisionProvider, input.settings.models.decision, stateText, batch, signal)
  if (!result.ok) return failed(result.error)
  const a = result.answers
  record.add(a)

  // Targets, revisions and units per fragment.
  const fragmentSignals = scopes.map((scope) => readUnit(a, supplied, input, scope))
  const referred = await resolveReferents(deps, input, signal, c.strategy, referentRequest, a, fragmentSignals, record)
  if (!referred.ok) return failed(referred.error)
  const signals = fragmentSignals.map((s) => withReferents(s, referred.units[s.key]))
  const ambiguous = new Map<SectionId, number>()
  const plans: (
    | { readonly kind: 'unit'; readonly directiveId: DirectiveId; readonly targets: SectionId[]; readonly mode: TargetMode; readonly alsoRevision: PlannedRevision | null }
    | { readonly kind: 'revision'; readonly revision: PlannedRevision; readonly mode: TargetMode }
  )[] = []
  const changedByAny: RequirementId[] = []
  for (const [i, s] of signals.entries()) {
    const f = fragments[i]
    if (!f) continue
    const resolution = resolveUnitTargets(s, given, t, {
      fragment: true,
      mayBeReply: s.relation?.value !== 'new' || (s.corrective ?? 0) >= t.clearlyCorrective,
      placedWithoutTarget: placedWithoutTarget(s, t),
      covered: (accepted, weak) => referentCovered(supplied, accepted, weak),
      budgetStop: referred.stop ? { best: referred.stop.best.get(s.key)?.sectionIds ?? [] } : null,
    })
    if (resolution.kind === 'ambiguous') {
      for (const cand of resolution.candidates) ambiguous.set(cand.sectionId, Math.max(ambiguous.get(cand.sectionId) ?? 0, cand.confidence))
      continue
    }
    if (resolution.bestFound) record.bestFound.push({ unit: s.key, sectionIds: resolution.sectionIds, confidence: referred.stop?.best.get(s.key)?.confidence ?? 0 })
    noteRunEnds(record, s.key, referred.units[s.key], resolution.sectionIds)
    const targets = answerTargets(supplied, resolution.sectionIds)
    const changed = (s.corrective ?? 0) >= t.clearlyCorrective ? selected(s.sessionRequirements, t.clearlyCorrective) : []
    for (const id of changed) if (!changedByAny.includes(id)) changedByAny.push(id)
    const fragment = { fragmentId: input.ids.next('fragment') as FragmentId, sourceSpans: f.sourceSpans, rewrittenText: f.instruction }
    const revision = revisionOf(s, targets, changed, f.instruction, fragment, supplied, t)
    if (revision && (revision.targetDirectiveIds.length > 0 || (s.asks ?? 0) < t.composite)) plans.push({ kind: 'revision', revision, mode: resolution.mode })
    else {
      // A part that only changes a session-wide requirement is still a request: it is planned as
      // work, and the requirement revision rides beside it without a fragment of its own.
      const alsoRevision = revision ? { ...revision, fragment: null } : null
      plans.push({ kind: 'unit', directiveId: input.ids.next('directive'), targets: withNeededGroups(supplied, targets, selected(s.needsGroups, t.dependency)), mode: resolution.mode, alsoRevision })
    }
    fragmentIds.set(f.key, fragment.fragmentId)
  }
  // A section the user replied to explicitly, or chose, is never dropped because no part scored it
  // at the floor (T1): it goes to the part that refers to it most, preferring parts that are not new work.
  if (given) {
    const held = new Set(plans.flatMap((p) => (p.kind === 'unit' ? p.targets : [])))
    for (const p of plans) if (p.kind === 'revision') for (const id of p.revision.targetDirectiveIds) {
      const sectionId = supplied.workById.get(id)?.sectionId
      if (sectionId) held.add(sectionId)
    }
    for (const sectionId of answerTargets(supplied, given.sectionIds)) {
      if (held.has(sectionId)) continue
      const score = (i: number): number => signals[i]?.targets.find((x) => x.id === sectionId)?.confidence ?? 0
      const candidates = plans.map((p, i) => ({ p, i })).filter(({ p }) => p.kind === 'unit')
      const related = candidates.filter(({ i }) => signals[i]?.relation?.value !== 'new')
      const pool = related.length > 0 ? related : candidates
      const best = [...pool].sort((x, y) => score(y.i) - score(x.i) || x.i - y.i)[0]
      if (!best || best.p.kind !== 'unit') continue
      plans[best.i] = { ...best.p, targets: [...best.p.targets, sectionId], mode: given.mode }
      held.add(sectionId)
    }
  }
  if (ambiguous.size > 0 && !given) {
    return {
      kind: 'target-ambiguity',
      candidates: [...ambiguous].sort((x, y) => y[1] - x[1]).map(([sectionId, confidence]) => ({ sectionId, confidence })),
    }
  }

  const unitOfFragment = new Map<string, DirectiveId>()
  plans.forEach((p, i) => {
    if (p.kind === 'unit') unitOfFragment.set(`f${i}`, p.directiveId)
  })
  const units: PlannedUnit[] = []
  const decisions: UnitRoutingDecision[] = []
  const revisions: PlannedRevision[] = []
  for (const [i, p] of plans.entries()) {
    const f = fragments[i]
    const s = signals[i]
    const fragmentId = f ? fragmentIds.get(f.key) : undefined
    if (!f || !s || !fragmentId) continue
    if (p.kind === 'revision') {
      revisions.push(p.revision)
      decisions.push(revisionDecision(input, s, `f${i}`, fragmentId, p.revision, p.mode))
      continue
    }
    if (p.alsoRevision) {
      revisions.push(p.alsoRevision)
      decisions.push(revisionDecision(input, s, `f${i}-requirements`, null, p.alsoRevision, p.mode))
    }
    const needsUnits = selected(s.after, t.dependency).flatMap((key) => {
      const id = unitOfFragment.get(key)
      return id ? [id] : []
    })
    const placed = derivePlacement(supplied, {
      relation: s.relation,
      targets: p.targets,
      needsWork: neededWork(s, p.targets, supplied, t),
      needsGroups: selected(s.needsGroups, t.dependency),
      needsUnits,
      chain: s.chain,
      chainThreshold: t.targetChoice,
      confidences: confidencesOf(s, p.targets, t),
    })
    units.push({
      directiveId: p.directiveId,
      fragment: { fragmentId, sourceSpans: f.sourceSpans, rewrittenText: f.instruction },
      instruction: f.instruction,
      label: f.label.trim() || provisionalLabel(f.instruction),
      labelIsProvisional: f.label.trim() === '',
      requirements: requirements.forFragment(f),
      relation: placed.relation,
      targets: p.targets,
      placement: placed.placement,
      prerequisites: placed.prerequisites,
    })
    decisions.push(unitDecision(input, s, `f${i}`, fragmentId, placed, p.targets, p.mode))
  }

  // Clarifications: a shared requirement is asked once for every part it applies to (07).
  const clarifications: PlannedClarification[] = []
  const blocked = new Set<DirectiveId>()
  shared.forEach((r, i) => {
    if ((a.noul(`q${i + 1}_clarify`) ?? 0) < t.clarification) return
    const ids = units.filter((u) => u.requirements.some((q) => q.id === r.id) && !blocked.has(u.directiveId)).map((u) => u.directiveId)
    if (ids.length === 0) return
    for (const id of ids) blocked.add(id)
    clarifications.push({ questionDirectiveId: input.ids.next('directive'), reason: 'missing-information', about: aboutText('missing-information', r.text), blockedDirectiveIds: ids })
  })
  for (const [i, p] of plans.entries()) {
    const s = signals[i]
    if (p.kind !== 'unit' || !s || blocked.has(p.directiveId) || (s.clarify ?? 0) < t.clarification) continue
    blocked.add(p.directiveId)
    clarifications.push({ questionDirectiveId: input.ids.next('directive'), reason: s.clarifyReason, about: aboutText(s.clarifyReason, null), blockedDirectiveIds: [p.directiveId] })
  }

  // Whole-request barrier and explicit output order (Q18, Q19, Q25).
  const barrier: WholeRequestBarrier | null =
    decomposition.barrier && (a.noul('barrier') ?? 0) >= t.dependency ? decomposition.barrier : null
  const outputOrder =
    barrier?.reason === 'explicit-order' && decomposition.outputOrder
      ? decomposition.outputOrder.flatMap((key) => {
          const id = unitOfFragment.get(keyOf.get(key) ?? '')
          return id ? [id] : []
        })
      : null
  const sequential = units.some((u) => u.prerequisites.some((p) => p.kind === 'directive' && units.some((v) => v.directiveId === p.directiveId)))

  const affected = await affectedWork(deps, input, signal, supplied, revisions, record)
  if (!affected.ok) return failed(affected.error)
  const plan: RoutingPlan = {
    decision: decisionRecord(
      input,
      record,
      { value: 'composite', confidence: c.composite },
      decisions,
      `${fragments.length} parts${sequential ? ', shown as split messages because a later part needs an earlier one' : ', one reply group'}${barrier ? `; the whole request waits together (${barrier.reason})` : ''}.`,
    ),
    composition: sequential ? 'sequential-composite' : 'independent-composite',
    units,
    barrier,
    outputOrder: outputOrder && outputOrder.length >= 2 ? outputOrder : null,
    ...requirements.planned(changedByAny),
    clarifications,
    revisions: affected.revisions,
    answersElicitationId: null,
    decompositionModel: input.settings.models.decomposition,
  }
  return finish(input, plan)
}

// ───────────────────────────── referents ─────────────────────────────

/**
 * What a referent strategy is asked: the answer sections, numbered as the
 * state text names them. Sections beyond the pipeline's window keep
 * numbering after it and are marked as not listed; a strategy that reaches
 * them shows them in a state text of its own.
 */
function referentRequestFor(
  input: RoutingInput,
  supplied: Supplied,
  units: ReferentRequest['units'],
  stateText: string,
  subject: string,
  treeWalk: TreeWalkSettings,
  startCandidates: ReferentRequest['startCandidates'],
): ReferentRequest {
  const sections = numberedAnswerSections(input, supplied)
  return {
    units: sections.length > 0 ? units : [],
    sections,
    candidates: input.candidates,
    stateText,
    subject,
    relevance: { clear: input.settings.thresholds.targetChoice, floor: AMBIGUITY_FLOOR },
    useSummaryIfAvailable: input.settings.routing.useSummaryIfAvailable,
    decisionContext: (section) => decisionContextOf(input, section),
    answerOf: answerOf(input),
    words: shownWords(input.text),
    treeWalk,
    startCandidates,
  }
}

/** The most sections a candidate source may add to a walk's start set for one unit. */
export const MAX_START_CANDIDATES = 12

/** The candidate source of a routing: the injected one, else the one the settings name, else none. */
function candidateSourceFor(deps: Deps, input: RoutingInput): CandidateSource | null {
  if (deps.candidateSource) return deps.candidateSource
  return input.settings.routing.candidateSource === 'lexical' ? deps.lexicalSource : null
}

/**
 * Where a tree walk may start besides the roots, per unit: what the
 * candidate source suggests, as far as it names answer sections of this
 * conversation (invariant 9), at most `MAX_START_CANDIDATES` of them.
 * Nothing when there is no source, or when it fails: a candidate is only a
 * place to look. The units asked about replace those recorded before: for a
 * composite, the parts stand in place of the message.
 */
async function startCandidatesFor(
  deps: Deps,
  input: RoutingInput,
  units: readonly { readonly unit: ReferentUnit; readonly text: string }[],
  record: Record,
): Promise<ReferentRequest['startCandidates']> {
  const source = candidateSourceFor(deps, input)
  if (!source) return {}
  const sections = input.candidates.sections.filter((s) => !s.asksElicitationId)
  const known = new Set(sections.map((s) => s.sectionId))
  const firstPass = firstPassSectionIds(input.candidates)
  const answerText = (section: CandidateSection): string => input.answerText?.(section.sectionId) ?? section.excerpt
  const out: { [key: string]: readonly SectionId[] } = {}
  const recorded: CandidateSourceRecord['units'][number][] = []
  for (const { unit, text } of units) {
    let found: readonly CandidateHit[] = []
    try {
      found = await source.candidates({ conversationId: input.conversationId, unit, text, sections, answerText, firstPass })
    } catch {
      found = []
    }
    const seen = new Set<SectionId>()
    const kept = found.filter((hit) => known.has(hit.sectionId) && !seen.has(hit.sectionId) && seen.add(hit.sectionId)).slice(0, MAX_START_CANDIDATES)
    out[unit.key] = kept.map((hit) => hit.sectionId)
    recorded.push({ unit: unit.key === 'm' ? 'message' : unit.key, candidates: kept.map((hit) => ({ sectionId: hit.sectionId, score: hit.score })) })
  }
  record.candidates = { source: source.name, units: recorded }
  return out
}

/** The share of a routing's token budget a strategy selector's request may take: beyond it the rules choose. */
export const SELECTOR_BUDGET_SHARE = 0.15

/**
 * The referent strategy of this routing and the tree-walk settings it is
 * handed. The settings' own, unless a strategy selector is on: then the
 * selector chooses from the shape of the genealogy (`selection/`), its
 * request to the decision model is counted against the routing's token
 * budget like the pipeline's own, and what it chose and why goes into the
 * decision record. An injected referent strategy is used as it is.
 */
async function chooseStrategy(
  deps: Deps,
  input: RoutingInput,
  supplied: Supplied | null,
  record: Record,
  signal: CancelSignal,
): Promise<{ readonly strategy: ReferentStrategy; readonly treeWalk: TreeWalkSettings }> {
  const routing = input.settings.routing
  const configured = { strategy: deps.referentStrategy ?? referentStrategyFor(routing.referentStrategy), treeWalk: routing.treeWalk }
  const selector = deps.strategySelector ?? strategySelectorFor(routing.strategySelection)
  if (deps.referentStrategy || !selector || !supplied) return configured
  const sections = numberedAnswerSections(input, supplied)
  if (sections.length === 0) return configured
  const budget = tokenBudgetFor(input, 1)
  const ask: SelectorAsk = async (stateText, questions) => {
    const batch = new Batch()
    for (const [id, question] of Object.entries(questions)) {
      if (question.type === 'choice') batch.choice(id, question.instructions, question.options)
      else batch.noul(id, question.instructions)
    }
    if (batch.size === 0) return { kind: 'answered', noul: () => null, choice: () => null }
    // One small request, inside the routing's budget: the pipeline's own request still has to fit after it.
    const tokens = estimateRequestTokens(stateText, batch.questions)
    if (tokens > budget.total * SELECTOR_BUDGET_SHARE || tokens > budget.total - record.pipelineTokens) return { kind: 'refused' }
    const result = await record.ask(deps.decisionProvider, input.settings.models.decision, stateText, batch, signal)
    if (!result.ok) return { kind: 'failed', error: result.error }
    record.add(result.answers)
    return { kind: 'answered', noul: (id) => result.answers.noul(id), choice: (id) => result.answers.choice(id) }
  }
  const selection = await selectStrategy({
    selector,
    routing,
    sections,
    candidates: input.candidates,
    message: input.text,
    confidence: input.settings.thresholds.targetChoice,
    tokenBudget: budget.total,
    onRecord: input.strategySelectionOnRecord ?? null,
    ask,
  })
  record.selection = selection
  return applyChoice(selection.choice, routing.treeWalk)
}

function selectionNote(selection: StrategySelectionRecord | null): string {
  if (!selection) return ''
  const by = selection.selector === 'rules' ? 'the rules' : 'the decision model'
  const reused = selection.reused ? ', as chosen earlier for a conversation of this shape' : ''
  return ` Referent strategy chosen by ${by}${reused}: ${choiceText(selection.choice)}. ${selection.reason}`
}

/**
 * The strategy's questions ride in the pipeline's own request, and with
 * them the first pass, whichever strategy it is: the most recent answer
 * sections that no later one of them builds on, each asked about by itself
 * (`firstPassQuestions`). So every routing has scored a bounded set of
 * sections individually before a strategy asks anything further, and the
 * best node found so far has candidates when the budget stops it. A
 * question never replaces one the pipeline asks itself.
 */
function addReferentQuestions(batch: Batch, strategy: ReferentStrategy, request: ReferentRequest): void {
  if (request.units.length === 0) return
  for (const [id, question] of Object.entries({ ...strategy.questions(request), ...firstPassQuestions(request) })) {
    if (!batch.has(id)) batch.noul(id, question.instructions)
  }
}

/** The referents of every unit, and what the decision budget did to the search for them. */
type ResolvedReferents =
  | {
      readonly ok: true
      readonly units: { readonly [key: string]: UnitReferents }
      /** Set when a limit of the decision budget stopped the strategy: the best node found so far for each unit, null where there is none. */
      readonly stop: { readonly best: ReadonlyMap<string, BestNodeFound | null> } | null
    }
  | { readonly ok: false; readonly error: ProviderError }

/**
 * Runs the strategy over the answers of the pipeline's request. Further
 * requests it makes go through the budget guard (`createReferentAsk`) and
 * into the decision record. Only supplied sections come back (invariant 9).
 */
async function resolveReferents(
  deps: Deps,
  input: RoutingInput,
  signal: CancelSignal,
  strategy: ReferentStrategy,
  request: ReferentRequest,
  answers: Answers,
  signals: readonly UnitSignals[],
  record: Record,
): Promise<ResolvedReferents> {
  if (request.units.length === 0) return { ok: true, units: {}, stop: null }
  const clearlyCorrective = input.settings.thresholds.clearlyCorrective
  const corrective = new Set(signals.filter((s) => (s.corrective ?? 0) >= clearlyCorrective).map((s) => s.key))
  const asker = createReferentAsk({
    provider: deps.decisionProvider,
    model: input.settings.models.decision,
    budget: guardedBudget(input, request.units.length, record.pipelineTokens),
    signal,
    onAnswers: (a) => record.add(a),
  })
  const result = await strategy.resolve(request, { probability: (id) => answers.noul(id), corrective }, asker)
  if (!result.ok) return result
  record.referentNote = referentNote(strategy.name, asker.spent(), result.fallback)
  const known = new Set(request.sections.map((s) => s.section.sectionId))
  // The budget is a hard stop whoever noticed it: the strategy, which says what it did instead, or the guard, which refused a request.
  const limit = result.fallback?.limit ?? asker.refused()
  const best = new Map<string, BestNodeFound | null>()
  const units: { [key: string]: UnitReferents } = {}
  for (const [key, unit] of Object.entries(result.units)) {
    const sections = unit.sections.filter((s) => known.has(s.sectionId)).map((s) => ({ sectionId: s.sectionId, confidence: clamp01(s.confidence) }))
    const runEnds = (unit.runEnds ?? []).filter((end) => known.has(end.sectionId)).map((end) => ({ ...end, confidence: clamp01(end.confidence) }))
    units[key] = { several: unit.several === null ? null : clamp01(unit.several), sections, ...(runEnds.length > 0 ? { runEnds } : {}) }
    if (limit) best.set(key, bestOf(unit, sections, request))
  }
  if (!limit) return { ok: true, units, stop: null }
  record.budgetStop = {
    limit: limit === 'inputTokens' ? tokenBudgetFor(input, request.units.length).limitedBy : limit,
    fallback: result.fallback?.to ?? 'partial',
  }
  return { ok: true, units, stop: { best } }
}

/** Records the targets of a unit that are the last section of a run, taken without a search inside the run. */
function noteRunEnds(record: Record, unit: string, referents: UnitReferents | undefined, targets: readonly SectionId[]): void {
  for (const end of referents?.runEnds ?? []) if (targets.includes(end.sectionId)) record.runEnds.push({ unit, ...end })
}

/**
 * The best node found so far for one unit: the one the strategy names, as
 * far as its sections are supplied ones (invariant 9). A strategy that
 * names none has the highest-scoring section it returned taken, if that is
 * at least plausible; on equal scores the most recent.
 */
function bestOf(unit: UnitReferents, sections: readonly ScoredSection[], request: ReferentRequest): BestNodeFound | null {
  if (unit.best !== undefined) {
    const known = new Set(request.sections.map((s) => s.section.sectionId))
    const sectionIds = unit.best?.sectionIds.filter((id) => known.has(id)) ?? []
    return unit.best && sectionIds.length > 0 ? { sectionIds, confidence: clamp01(unit.best.confidence) } : null
  }
  const position = new Map(request.sections.map((s, i) => [s.section.sectionId, i]))
  const top = [...sections]
    .filter((s) => s.confidence >= request.relevance.floor)
    .sort((x, y) => y.confidence - x.confidence || (position.get(y.sectionId) ?? 0) - (position.get(x.sectionId) ?? 0))[0]
  return top ? { sectionIds: [top.sectionId], confidence: top.confidence } : null
}

/**
 * What one routing may use in decision input tokens, in every request it
 * makes: the smaller of the token budget and the price guard's allowance
 * for `units` pieces of work.
 */
function tokenBudgetFor(input: RoutingInput, units: number): RoutingTokenBudget {
  return routingTokenBudget(input.settings.routing, {
    sessionLogTokens: input.sessionLogTokens,
    messageLength: input.text.length,
    answerLengths: input.candidates.sections.filter((s) => s.state === 'completed' && !s.asksElicitationId).map((s) => s.answerLength),
    units,
  })
}

/**
 * What the strategy may add to this routing: the request and question caps
 * as they are set, and the input tokens the routing's budget has left after
 * the pipeline's own requests.
 */
function guardedBudget(input: RoutingInput, units: number, pipelineTokens: number): DecisionBudget {
  return { ...input.settings.routing.referentBudget, inputTokens: Math.max(0, Math.floor(tokenBudgetFor(input, units).total - pipelineTokens)) }
}

/**
 * The share of what the routing's budget has left that the routing request
 * may use once it shows more of the Points' answers, when the strategy may
 * send further requests: the rest is kept for them. A strategy that sends
 * none (one pass) lets it use the whole.
 */
export const ROUTING_REQUEST_SHOWN_SHARE = 0.5

function shownShare(strategy: ReferentStrategy): number {
  return strategy.furtherRequests === false ? 1 : ROUTING_REQUEST_SHOWN_SHARE
}

/**
 * The state text of a request whose questions are in `batch`, each Point's
 * answer in the form `choices` gives, and what each referent question was
 * shown of its sections, recorded on the batch. Also the Points: the
 * sections asked about by themselves, which may be shown at more length.
 */
function showRequest(
  input: RoutingInput,
  supplied: Supplied,
  batch: Batch,
  request: ReferentRequest,
  subject: string,
  showing: Showing,
  choices: ReadonlyMap<SectionId, ShownChoice> | null,
): { readonly stateText: string; readonly points: readonly ShownPoint[] } {
  const shown = { showing, choices: choices ?? new Map<SectionId, ShownChoice>() }
  const points: ShownPoint[] = []
  for (const [id, subjects] of questionSubjects(request)) {
    if (!batch.has(id)) continue
    batch.show(id, subjects.sections.map((entry) => recordLine(entry.section.sectionId, listedLine(input, entry.section, entry.n, shown))))
    for (const entry of subjects.kind === 'point' ? subjects.sections : []) points.push({ section: entry.section, n: entry.n, context: decisionContextOf(input, entry.section) })
  }
  return { stateText: describeState(input, supplied, subject, shown), points }
}

/**
 * The pipeline's request with as many answer sections listed as the
 * routing's token budget has room for, after what the routing has already
 * used. The full window when it fits; otherwise the widest that fits, found
 * by halving (a request only grows with its window), and never fewer than
 * `MIN_SECTIONS`: a request has to be sent for the message to be routed at
 * all, so below that the budget is exceeded by what the smallest request
 * costs, and the decision's explanation says so. The window is chosen with
 * every answer by its opening.
 *
 * Then the Points' answers are shown at more length (`chooseShown`) with
 * what is left of `shown.share` of the room: the whole answer where it
 * fits, else the opening and the best-matching passages, else the opening.
 * No listed section is dropped to make room, and the request never grows
 * past that share of what the budget has left.
 */
function fitWindow<T extends { readonly stateText: string; readonly batch: Batch; readonly points: readonly ShownPoint[] }>(
  input: RoutingInput,
  build: (window: number, choices: ReadonlyMap<SectionId, ShownChoice> | null) => T,
  budget: RoutingTokenBudget,
  record: Record,
  shown: { readonly showing: Showing; readonly share: number },
): T {
  const available = budget.total - record.pipelineTokens
  const cost = (built: T): number => estimateRequestTokens(built.stateText, built.batch.questions)
  const { built, window } = fitListing(input, (w) => build(w, null), cost, available, budget, record)
  const room = Math.floor(Math.min(available, shown.share * available)) - cost(built)
  if (built.points.length === 0 || !(room > 0)) return built
  const more = build(window, chooseShown(shown.showing, built.points, room))
  return cost(more) <= cost(built) + room ? more : built
}

/** The widest window whose request fits, every answer by its opening; the explanation says why it was cut. */
function fitListing<T>(
  input: RoutingInput,
  build: (window: number) => T,
  cost: (built: T) => number,
  available: number,
  budget: RoutingTokenBudget,
  record: Record,
): { readonly built: T; readonly window: number } {
  const full = build(MAX_SECTIONS)
  if (cost(full) <= available) return { built: full, window: MAX_SECTIONS }
  const listable = Math.max(input.candidates.sections.length, input.candidates.chains.length)
  const limit = budget.limitedBy === 'price-guard' ? 'the price guard on decision cost' : 'the decision token budget'
  let fitting: { readonly built: T; readonly window: number } | null = null
  let low = MIN_SECTIONS + 1
  let high = Math.min(MAX_SECTIONS, listable) - 1
  while (low <= high) {
    const window = Math.floor((low + high) / 2)
    const built = build(window)
    if (cost(built) <= available) {
      fitting = { built, window }
      low = window + 1
    } else high = window - 1
  }
  if (fitting) {
    record.windowNote = ` The routing request listed the ${fitting.window} most recent answer sections and lines of work, not ${MAX_SECTIONS}, to stay within ${limit}.`
    return fitting
  }
  // The smallest request: the first-pass sections, which every routing asks about by themselves, and nothing older.
  const smallest = build(MIN_SECTIONS)
  const first = firstPassSectionIds(input.candidates).length
  const sections = `the ${first === 1 ? 'most recent answer section' : `${first} most recent answer sections that no later one of them builds on`}`
  const left = Math.max(0, Math.floor(available))
  if (cost(smallest) >= cost(full)) record.windowNote = ` The routing request costs more than ${limit} allows (${left} tokens) and could not be made smaller.`
  else if (cost(smallest) <= available) record.windowNote = ` The routing request listed only ${sections}, the fewest it lists, to stay within ${limit}.`
  else record.windowNote = ` The routing request listed only ${sections}, the fewest it lists, and still costs more than ${limit} allows (${left} tokens).`
  return { built: smallest, window: MIN_SECTIONS }
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
}

function referentNote(name: string, spent: ReferentSpend, fallback: Extract<ReferentResult, { ok: true }>['fallback']): string {
  if (spent.requests === 0 && !fallback) return ''
  const requests = spent.requests === 1 ? 'one further decision request' : `${spent.requests} further decision requests`
  const limit = fallback ? { requests: 'request', questions: 'question', inputTokens: 'input-token' }[fallback.limit] : ''
  const stopped = !fallback
    ? ''
    : fallback.to === 'one-pass'
      ? `; its ${limit} budget was reached, so the remaining candidates were asked about in one request`
      : `; its ${limit} budget was reached, so it kept what it had scored`
  return ` Referents by ${name}: ${requests}${stopped}.`
}

// ───────────────────────────── pieces ─────────────────────────────

function firstStart(f: DecomposedFragment): number {
  return f.sourceSpans[0]?.start ?? 0
}

/** Spans exact, non-empty and in bounds; keys unique; references known (Q59). */
function checkDecomposition(text: string, d: Decomposition, candidates: readonly DecompositionCandidate[]): string | null {
  const keys = new Set<string>()
  const validSpan = (s: TextSpan): boolean => Number.isInteger(s.start) && Number.isInteger(s.end) && s.start >= 0 && s.end > s.start && s.end <= text.length
  for (const f of d.fragments) {
    if (!f.key || keys.has(f.key)) return 'The decomposition repeats a fragment key'
    keys.add(f.key)
    if (f.sourceSpans.length === 0 || !f.sourceSpans.every(validSpan)) return `Fragment "${f.key}" has a source span outside the message`
    if (f.instruction.trim() === '') return `Fragment "${f.key}" has no instruction`
    for (const r of f.requirements) if (r.span && !validSpan(r.span)) return `A requirement of "${f.key}" points outside the message`
  }
  for (const f of d.fragments) {
    for (const key of f.dependsOnFragments) if (!keys.has(key) || key === f.key) return `Fragment "${f.key}" depends on an unknown fragment`
    for (const id of f.dependsOnCandidates) if (!candidates.some((c) => c.id === id)) return `Fragment "${f.key}" depends on work that was not supplied`
  }
  if (d.outputOrder) for (const key of d.outputOrder) if (!keys.has(key)) return 'The output order names an unknown fragment'
  return null
}

/** Answer sections among the resolved targets (a question section is answered, never built on). */
function answerTargets(supplied: Supplied, ids: readonly SectionId[]): SectionId[] {
  return ids.filter((id) => !supplied.sectionById.get(id)?.asksElicitationId)
}

/**
 * A unit that waits for a sibling group as a whole refers to every member of it: the targets name
 * all of them, as its context will read all of them (Q30, C9), not only the ones scored on their own.
 * For new work only: what a correction revises is what it refers to, not what that work waits for.
 */
function withNeededGroups(supplied: Supplied, targets: readonly SectionId[], groups: readonly SiblingGroupId[]): SectionId[] {
  const out = [...targets]
  for (const groupId of groups) {
    for (const directiveId of supplied.groupById.get(groupId)?.memberDirectiveIds ?? []) {
      const sectionId = supplied.workById.get(directiveId)?.sectionId
      if (sectionId && supplied.sectionById.has(sectionId) && !supplied.sectionById.get(sectionId)?.asksElicitationId && !out.includes(sectionId)) out.push(sectionId)
    }
  }
  return out
}

/**
 * A revision when the wording is clearly corrective (Q37, Q74) and names
 * something to correct: a target's work, or a conversation-wide
 * requirement. A correction of a brief several requests consumed, or of a
 * conversation-wide requirement, is a shared-requirement revision (Q42).
 */
function revisionOf(
  s: UnitSignals,
  targets: readonly SectionId[],
  changedRequirements: readonly RequirementId[],
  correction: string,
  fragment: PlannedRevision['fragment'],
  supplied: Supplied,
  t: RoutingInput['settings']['thresholds'],
): PlannedRevision | null {
  const corrective = (s.corrective ?? 0) >= t.clearlyCorrective
  let targetDirectiveIds = corrective
    ? [...new Set(targets.flatMap((id) => {
        const directiveId = supplied.sectionById.get(id)?.directiveId
        return directiveId && supplied.workById.has(directiveId) ? [directiveId] : []
      }))]
    : []
  if (targetDirectiveIds.length === 0 && changedRequirements.length === 0) return null
  // A brief is shared only when other work consumed it (Q42): a correction of work nothing else read is local to it.
  const consumers = (ids: readonly DirectiveId[]) =>
    [...supplied.workById.values()].filter((w) => !ids.includes(w.directiveId) && w.consumed.some((c) => ids.includes(c)))
  const sharedBrief = (s.shared ?? 0) >= t.clearlyCorrective && consumers(targetDirectiveIds).length > 0
  if (sharedBrief) {
    // The target is the work that established the brief; work that consumed another target is affected work, not a target.
    const roots = targetDirectiveIds.filter((id) => !supplied.workById.get(id)?.consumed.some((c) => c !== id && targetDirectiveIds.includes(c)))
    if (roots.length > 0) targetDirectiveIds = roots
  }
  const scope = changedRequirements.length > 0 || sharedBrief ? 'shared-requirement' : 'work'
  return { scope, correction, fragment, targetDirectiveIds, targetRequirementIds: [...changedRequirements], affected: [] }
}

/**
 * For each shared-requirement revision of a brief: every consumer of the
 * brief, pre-selected when the decision model judges it actually affected
 * (Q44). One batched call for every revision of the message.
 */
async function affectedWork(
  deps: Deps,
  input: RoutingInput,
  signal: CancelSignal,
  supplied: Supplied,
  revisions: readonly PlannedRevision[],
  record: Record,
): Promise<{ readonly ok: true; readonly revisions: PlannedRevision[] } | { readonly ok: false; readonly error: ProviderError }> {
  const batch = new Batch()
  const consumers = revisions.map((r, ri) => {
    if (r.scope !== 'shared-requirement') return []
    // The consumers of the brief: work that read a corrected target's result, or read a session-wide
    // requirement this message replaces or withdraws (06 · "Revising a shared requirement").
    const list = input.candidates.work.filter(
      (w) =>
        !r.targetDirectiveIds.includes(w.directiveId) &&
        (w.consumed.some((id) => r.targetDirectiveIds.includes(id)) || w.consumedRequirements.some((id) => r.targetRequirementIds.includes(id))),
    )
    list.forEach((w, i) => {
      batch.noul(`a${ri + 1}_${i + 1}`, `Would "${w.label}" (${JSON.stringify(w.instruction.slice(0, 200))}) come out differently because of the correction ${JSON.stringify(r.correction)}?`)
    })
    return list
  })
  if (batch.size === 0) return { ok: true, revisions: [...revisions] }
  const subject = `Corrections in the new message "${input.text}":\n${revisions.map((r, i) => `C${i + 1}. ${JSON.stringify(r.correction)}`).join('\n')}`
  const result = await record.ask(deps.decisionProvider, input.settings.models.decision, describeState(input, supplied, subject), batch, signal)
  if (!result.ok) return result
  record.add(result.answers)
  return {
    ok: true,
    revisions: revisions.map((r, ri) => {
      const list = consumers[ri] ?? []
      if (list.length === 0) return r
      return {
        ...r,
        affected: list.map((w, i) => ({
          directiveId: w.directiveId,
          preselected: (result.answers.noul(`a${ri + 1}_${i + 1}`) ?? 0) >= input.settings.thresholds.dependency,
        })),
      }
    }),
  }
}

/** What the clarification question asks about. Core composes the question's instruction from this and the blocked requests. */
function aboutText(reason: PlannedClarification['reason'], requirement: string | null): string {
  if (requirement) return `the requirement "${requirement}", which is ambiguous or incomplete`
  return reason === 'incompatible-requirements' ? 'requirements that contradict each other' : 'information the request needs and does not give'
}

/** The confidences a placement rests on: its targets, and the handling chain when no target placed it. */
function confidencesOf(s: UnitSignals, targets: readonly SectionId[], t: RoutingInput['settings']['thresholds']): number[] {
  const out: number[] = []
  for (const id of targets) {
    const c = s.targets.find((x) => x.id === id)?.confidence
    if (c !== undefined) out.push(c)
  }
  for (const w of s.needsWork) if (w.confidence >= t.dependency) out.push(w.confidence)
  for (const g of s.needsGroups) if (g.confidence >= t.dependency) out.push(g.confidence)
  if (out.length === 0 && s.chain) out.push(s.chain.confidence)
  return out
}

function targetRecord(input: RoutingInput, s: UnitSignals, targets: readonly SectionId[], mode: TargetMode): UnitRoutingDecision['targets'] {
  return {
    sectionIds: targets,
    // Targets that came only from a group the unit waits for were inferred, not given.
    mode: targets.length === 0 ? 'none' : mode === 'none' ? 'inferred' : mode,
    candidates: s.targets.map((x) => ({ sectionId: x.id, confidence: x.confidence })),
    redirected: input.redirects.filter((r) => targets.includes(r.to)),
  }
}

function unitDecision(
  input: RoutingInput,
  s: UnitSignals,
  key: string,
  fragmentId: FragmentId | null,
  placed: ReturnType<typeof derivePlacement>,
  targets: readonly SectionId[],
  mode: TargetMode,
): UnitRoutingDecision {
  const relationConfidence = s.relation?.probabilities[placed.relation] ?? s.relation?.confidence ?? null
  return {
    key,
    fragmentId,
    relation: { value: placed.relation, confidence: relationConfidence },
    correctiveConfidence: s.corrective,
    targets: targetRecord(input, s, targets, mode),
    placement: { value: placed.placement, confidence: placed.confidence },
    prerequisites: { value: placed.prerequisites, confidence: placed.prerequisites.length > 0 ? placed.confidence : null },
    needsClarification: s.clarify,
    explanation: `${relationText(placed.relation)} ${placed.explanation}`.trim(),
  }
}

function revisionDecision(
  input: RoutingInput,
  s: UnitSignals,
  key: string,
  fragmentId: FragmentId | null,
  revision: PlannedRevision,
  mode: TargetMode,
): UnitRoutingDecision {
  const first = revision.targetDirectiveIds[0]
  const node = first ? input.candidates.work.find((w) => w.directiveId === first)?.nodeId : undefined
  const placement: Placement = node ? { kind: 'continue', buildsOn: { kind: 'node', nodeId: node } } : { kind: 'new-chain' }
  const sectionIds = input.candidates.sections.filter((x) => revision.targetDirectiveIds.includes(x.directiveId)).map((x) => x.sectionId)
  return {
    key,
    fragmentId,
    relation: { value: 'revision', confidence: s.corrective },
    correctiveConfidence: s.corrective,
    targets: targetRecord(input, s, sectionIds, mode),
    placement: { value: placement, confidence: null },
    prerequisites: { value: [], confidence: null },
    needsClarification: s.clarify,
    explanation:
      revision.scope === 'work'
        ? 'Corrective wording: revises the work it targets.'
        : 'Corrective wording: revises a requirement that several requests relied on.',
  }
}

function relationText(relation: string): string {
  switch (relation) {
    case 'new':
      return 'New work.'
    case 'result-dependent':
      return 'Needs a result that is not available yet.'
    default:
      return 'Additional related work.'
  }
}

/** What the hard stop of the decision budget meant for the units that would otherwise have been put to the user. */
function bestFoundNote(input: RoutingInput, record: Record): string {
  if (!record.budgetStop || record.bestFound.length === 0) return ''
  const title = (id: SectionId): string => `"${input.candidates.sections.find((s) => s.sectionId === id)?.title ?? id}"`
  const placed = record.bestFound.map((b) => {
    const unit = b.unit === 'message' ? 'the message' : `part F${Number(b.unit.slice(1)) + 1}`
    return `${unit} on ${b.sectionIds.map(title).join(' and ')} (${b.confidence.toFixed(2)})`
  })
  return ` The decision budget is a hard stop, so the user was not asked which section is meant: the best node found so far was used, ${placed.join('; ')}.`
}

/** Which targets are the last section of a run the unit refers to, taken without asking about them by themselves, and on what evidence. */
function runEndNote(input: RoutingInput, record: Record): string {
  if (record.runEnds.length === 0) return ''
  const section = (id: SectionId): CandidateSection | undefined => input.candidates.sections.find((s) => s.sectionId === id)
  const title = (id: SectionId): string => `"${section(id)?.title ?? id}"`
  const placed = record.runEnds.map((end) => {
    const unit = end.unit === 'message' ? 'the message' : `part F${Number(end.unit.slice(1)) + 1}`
    const asked = end.evidence.sections === 1 ? `a question about ${title(end.evidence.firstSectionId)} by itself` : `a question about ${end.evidence.sections} of its answers together, ${title(end.evidence.firstSectionId)} to ${title(end.evidence.lastSectionId)},`
    const where = end.limitedByContext ? 'the deepest answer a run can continue from' : 'the last answer'
    return `${unit} on ${title(end.sectionId)}, ${where} of a run of ${end.run.sections} (${title(end.run.firstSectionId)} to ${title(end.run.lastSectionId)}): ${asked} scored ${end.confidence.toFixed(2)}`
  })
  return ` Hop between branch points is on, so no answer inside a run was searched for: ${placed.join('; ')}. That answer was not asked about by itself; its context holds the whole run.`
}

function decisionRecord(
  input: RoutingInput,
  record: Record,
  composition: Decided<'atomic' | 'composite'>,
  units: readonly UnitRoutingDecision[],
  explanation: string,
): RoutingDecision {
  return {
    source: 'decision-model',
    model: record.model,
    composition,
    units,
    thresholds: { ...input.settings.thresholds, ambiguityFloor: AMBIGUITY_FLOOR },
    explanation: `${explanation}${selectionNote(record.selection)}${record.windowNote}${record.referentNote}${runEndNote(input, record)}${bestFoundNote(input, record)}${record.contextNote}`,
    questions: record.questions,
    shownRecorded: true,
    ...(record.selection ? { strategySelection: record.selection } : {}),
    ...(record.budgetStop ? { budgetStop: { ...record.budgetStop, bestFound: record.bestFound } } : {}),
    ...(record.candidates ? { candidateSource: record.candidates } : {}),
    ...(record.runEnds.length > 0 ? { runEnds: record.runEnds } : {}),
  }
}

/** The whole message answers an open clarification question (Q98): no directive, the blocked work is released. */
function answerPlan(
  input: RoutingInput,
  elicitationId: ElicitationId,
  record: Record,
  mode: TargetMode,
  targets: readonly SectionId[],
  s?: UnitSignals,
): RoutingOutcome {
  const question = input.candidates.sections.find((x) => x.asksElicitationId === elicitationId)
  const decision: UnitRoutingDecision = {
    key: 'message',
    fragmentId: null,
    relation: { value: 'addition', confidence: null },
    correctiveConfidence: s?.corrective ?? null,
    targets: {
      sectionIds: targets,
      mode,
      candidates: s ? s.targets.map((x) => ({ sectionId: x.id, confidence: x.confidence })) : [],
      redirected: input.redirects.filter((r) => targets.includes(r.to)),
    },
    placement: { value: question ? { kind: 'continue', buildsOn: { kind: 'node', nodeId: question.nodeId } } : { kind: 'new-chain' }, confidence: null },
    prerequisites: { value: [], confidence: null },
    needsClarification: null,
    explanation: 'The answer to the clarification question; it releases the work that was waiting for it.',
  }
  return finish(input, {
    decision: decisionRecord(input, record, { value: 'atomic', confidence: null }, [decision], 'The answer to an open clarification question.'),
    composition: 'atomic',
    units: [],
    barrier: null,
    outputOrder: null,
    sessionRequirements: [],
    withdrawnSessionRequirementIds: [],
    clarifications: [],
    revisions: [],
    answersElicitationId: elicitationId,
    decompositionModel: null,
  })
}

// ───────────────────────────── requirements ─────────────────────────────

/**
 * Requirements from decomposition, with provenance (Q59). Local unless the
 * gate confirmed that the user made one conversation-wide (Q17, D1): a
 * decomposer that calls a requirement session-wide is not enough. A
 * requirement stated once and applied to several fragments is one shared
 * requirement with one ID (Q4).
 */
class RequirementBook {
  private readonly byKey = new Map<string, Requirement>()
  private readonly uses = new Map<string, number>()

  private readonly confirmed: ReadonlySet<string>

  /** `confirmed`: keys of the requirements the decision model confirmed the user made conversation-wide. */
  constructor(input: RoutingInput, decomposition: Decomposition | null, confirmed: ReadonlySet<string>) {
    this.confirmed = confirmed
    for (const f of decomposition?.fragments ?? []) {
      const seen = new Set<string>()
      for (const r of f.requirements) {
        const key = requirementKey(r)
        if (seen.has(key)) continue
        seen.add(key)
        this.uses.set(key, (this.uses.get(key) ?? 0) + 1)
      }
    }
    for (const f of decomposition?.fragments ?? []) {
      for (const r of f.requirements) {
        const key = requirementKey(r)
        if (this.byKey.has(key)) continue
        this.byKey.set(key, {
          id: input.ids.next('requirement'),
          text: r.text.trim(),
          scope: r.scope === 'session-wide' && confirmed.has(key) ? 'session-wide' : 'local',
          shared: (this.uses.get(key) ?? 0) >= 2,
          provenance: { messageId: input.messageId, span: r.span },
        })
      }
    }
  }

  forFragment(f: DecomposedFragment): Requirement[] {
    const out: Requirement[] = []
    for (const r of f.requirements) {
      const req = this.byKey.get(requirementKey(r))
      if (req && !out.includes(req)) out.push(req)
    }
    return out
  }

  sharedRequirements(): Requirement[] {
    return [...this.byKey.values()].filter((r) => r.shared && r.scope === 'local')
  }

  /** New conversation-wide requirements, each replacing a changed one in order; changed ones left over are withdrawn. */
  planned(changed: readonly RequirementId[]): Pick<RoutingPlan, 'sessionRequirements' | 'withdrawnSessionRequirementIds'> {
    const fresh = this.confirmed.size > 0 ? [...this.byKey.values()].filter((r) => r.scope === 'session-wide') : []
    const sessionRequirements: PlannedSessionRequirement[] = fresh.map((requirement, i) => ({ requirement, replacesRequirementId: changed[i] ?? null }))
    return { sessionRequirements, withdrawnSessionRequirementIds: changed.slice(fresh.length) }
  }
}

function requirementKey(r: { readonly text: string; readonly span: TextSpan | null }): string {
  return r.span ? `${r.span.start}:${r.span.end}` : r.text.trim().toLowerCase()
}

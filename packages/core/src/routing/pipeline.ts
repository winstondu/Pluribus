import {
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
} from '@committee/protocol'
import type {
  CancelSignal,
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
  Router,
  RoutingInput,
  RoutingOutcome,
  RoutingPlan,
  UnitReferents,
} from '../ports'
import { Batch, ask, type Answers } from './batch'
import { AMBIGUITY_FLOOR, derivePlacement, neededWork, placedWithoutTarget, referentCovered, resolveUnitTargets, selected, validatePlan, type TargetMode } from './derive'
import { askUnit, readUnit, sectionNumbers, withReferents, type UnitScope, type UnitSignals } from './questions'
import { createReferentAsk, referentStrategyFor, type ReferentSpend } from './referents'
import { describeState, numberedAnswerSections, supply, type Supplied } from './supply'

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
 *    only the decomposer may write). Then a second batched call asks the
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
 *
 * Shared-requirement revisions take one more call over the brief's
 * consumers, to pre-select the work actually affected (Q44).
 *
 * The router never mints an ID except through `input.ids`, never reads the
 * clock, and never rejects: provider failures are a `failed` outcome.
 */
export function createRouter(deps: Deps): Router {
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

type Deps = Pick<CoreDependencies, 'decisionProvider' | 'decomposer' | 'referentStrategy'>

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
  const supplied = supply(input, given?.sectionIds ?? [])
  const record = new Record()

  // A reply aimed at an open clarification question is its answer (Q98).
  const answered = given?.sectionIds.map((id) => supplied.sectionById.get(id)?.asksElicitationId ?? null).find((id) => id !== null)
  if (answered) return answerPlan(input, answered, record, given?.mode ?? 'explicit', given?.sectionIds ?? [])

  const relate = input.candidates.sections.length > 0 || input.candidates.chains.length > 0
  const numbers = sectionNumbers(supplied)

  // ── 1. The decision gate ──
  const gate = new Batch()
  if (!forced) {
    gate.noul('composite', 'Does the new message contain two or more independent requests that could each be answered on its own? Several topics, a requested contrast, or one integrated output are one request.')
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
  const stateText = describeState(input, supplied, subject)
  const strategy = deps.referentStrategy ?? referentStrategyFor(input.settings.routing.referentStrategy)
  // Explicit and chosen targets are used as given: nothing is asked about the message's referents.
  const referentRequest = referentRequestFor(input, supplied, given ? [] : [{ key: 'm', name: 'the new message' }], stateText, subject)
  addReferentQuestions(gate, strategy, referentRequest)
  const gateResult = await ask(deps.decisionProvider, input.settings.models.decision, stateText, gate, signal)
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
  const isComposite = !forced && composite !== null && composite >= t.composite
  let decomposition: Decomposition | null = null
  if (!forced && (isComposite || sessionWide || changedRequirements.length > 0)) {
    const candidates: DecompositionCandidate[] = [
      ...supplied.inFlight.map((w) => ({ id: w.directiveId as string, label: w.label, description: w.instruction })),
      ...supplied.openGroups.map((gr) => ({ id: gr.groupId as string, label: gr.label, description: `The parallel requests ${gr.label}, together` })),
    ]
    const result = await deps.decomposer.decompose({ model: input.settings.models.decomposition, text: input.text, candidates }, signal)
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
      const result = await ask(deps.decisionProvider, input.settings.models.decision, describeState(input, supplied, subject), batch, signal)
      if (!result.ok) return failed(result.error)
      record.add(result.answers)
      tagged.forEach((r, i) => {
        if ((result.answers.noul(`rq${i + 1}_sessionwide`) ?? 0) >= t.clearlyCorrective) confirmed.add(r.key)
      })
    }
  }
  const requirements = new RequirementBook(input, decomposition, confirmed)
  const compositeDecided: Decided<'atomic' | 'composite'> = { value: 'atomic', confidence: composite }

  if (isComposite && decomposition && decomposition.fragments.length >= 2) {
    return routeComposite(deps, input, signal, { supplied, given, record, decomposition, requirements, composite, strategy })
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
  })
  if (resolution.kind === 'ambiguous') return { kind: 'target-ambiguity', candidates: resolution.candidates }
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
    decision: decisionRecord(input, record, compositeDecided, decisions, units.length === 0 && revision ? 'A correction of earlier work.' : 'One request.'),
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

function finish(input: RoutingInput, plan: RoutingPlan): RoutingOutcome {
  const valid = validatePlan(input, plan)
  return valid.ok ? { kind: 'plan', plan: valid.plan } : malformed(valid.message)
}

// ───────────────────────────── composite ─────────────────────────────

interface CompositeContext {
  readonly supplied: Supplied
  readonly given: Given | null
  readonly record: Record
  readonly decomposition: Decomposition
  readonly requirements: RequirementBook
  readonly composite: number | null
  readonly strategy: ReferentStrategy
}

async function routeComposite(deps: Deps, input: RoutingInput, signal: CancelSignal, c: CompositeContext): Promise<RoutingOutcome> {
  const t = input.settings.thresholds
  const { supplied, given, record, decomposition, requirements } = c
  const fragments = decomposition.fragments
  const numbers = sectionNumbers(supplied)
  const keyOf = new Map(fragments.map((f, i) => [f.key, `f${i}`]))
  const fragmentIds = new Map<string, FragmentId>()
  const relate = input.candidates.sections.length > 0 || input.candidates.chains.length > 0

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
  const shared = requirements.sharedRequirements()
  shared.forEach((r, i) => {
    batch.noul(
      `q${i + 1}_clarify`,
      `Is the requirement "${r.text}", which several parts share, ambiguous or missing information, so that the user must be asked before those parts can be answered?`,
    )
  })
  if (decomposition.barrier) {
    batch.noul(
      'barrier',
      `Does the message relate its parts' outputs to one another (${decomposition.barrier.qualifier ? `"${decomposition.barrier.qualifier}"` : 'an explicit order, a combined limit, or one integrated presentation'}), rather than give requirements that apply to each part separately?`,
    )
  }
  const subject = [
    `New message: "${input.text}"`,
    'Its parts:',
    ...fragments.map((f, i) => `F${i + 1}. ${JSON.stringify(f.instruction)} (from ${JSON.stringify(f.sourceSpans.map((s) => input.text.slice(s.start, s.end)).join(' … '))})`),
    ...(given ? [`The user replied to ${given.sectionIds.map((id) => `S${numbers.get(id) ?? '?'}`).join(' and ')}.`] : []),
  ].join('\n')
  const stateText = describeState(input, supplied, subject)
  const referentRequest = referentRequestFor(input, supplied, scopes.map((scope) => ({ key: scope.key, name: scope.name })), stateText, subject)
  addReferentQuestions(batch, c.strategy, referentRequest)
  const result = await ask(deps.decisionProvider, input.settings.models.decision, stateText, batch, signal)
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
    })
    if (resolution.kind === 'ambiguous') {
      for (const cand of resolution.candidates) ambiguous.set(cand.sectionId, Math.max(ambiguous.get(cand.sectionId) ?? 0, cand.confidence))
      continue
    }
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
): ReferentRequest {
  const sections = numberedAnswerSections(input, supplied)
  return {
    units: sections.length > 0 ? units : [],
    sections,
    candidates: input.candidates,
    stateText,
    subject,
    relevance: { clear: input.settings.thresholds.targetChoice, floor: AMBIGUITY_FLOOR },
  }
}

/** The strategy's questions ride in the pipeline's own request. A question never replaces one the pipeline asks itself. */
function addReferentQuestions(batch: Batch, strategy: ReferentStrategy, request: ReferentRequest): void {
  if (request.units.length === 0) return
  for (const [id, question] of Object.entries(strategy.questions(request))) {
    if (!batch.has(id)) batch.noul(id, question.instructions)
  }
}

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
): Promise<ReferentResult> {
  if (request.units.length === 0) return { ok: true, units: {}, fallback: null }
  const clearlyCorrective = input.settings.thresholds.clearlyCorrective
  const corrective = new Set(signals.filter((s) => (s.corrective ?? 0) >= clearlyCorrective).map((s) => s.key))
  const asker = createReferentAsk({
    provider: deps.decisionProvider,
    model: input.settings.models.decision,
    budget: input.settings.routing.referentBudget,
    signal,
    onAnswers: (a) => record.add(a),
  })
  const result = await strategy.resolve(request, { probability: (id) => answers.noul(id), corrective }, asker)
  if (!result.ok) return result
  record.referentNote = referentNote(strategy.name, asker.spent(), result.fallback)
  const known = new Set(request.sections.map((s) => s.section.sectionId))
  const units: { [key: string]: UnitReferents } = {}
  for (const [key, unit] of Object.entries(result.units)) {
    units[key] = {
      several: unit.several === null ? null : clamp01(unit.several),
      sections: unit.sections.filter((s) => known.has(s.sectionId)).map((s) => ({ sectionId: s.sectionId, confidence: clamp01(s.confidence) })),
    }
  }
  return { ok: true, units, fallback: result.fallback }
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
  const result = await ask(deps.decisionProvider, input.settings.models.decision, describeState(input, supplied, subject), batch, signal)
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
    explanation: `${explanation}${record.referentNote}`,
    questions: record.questions,
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

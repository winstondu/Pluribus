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
  Router,
  RoutingInput,
  RoutingOutcome,
  RoutingPlan,
} from '../ports'
import { Batch, ask, type Answers } from './batch'
import { AMBIGUITY_FLOOR, derivePlacement, resolveUnitTargets, selected, validatePlan, type TargetMode } from './derive'
import { askUnit, readUnit, sectionNumbers, type UnitScope, type UnitSignals } from './questions'
import { describeState, supply, type Supplied } from './supply'

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
 * Shared-requirement revisions take one more call over the brief's
 * consumers, to pre-select the work actually affected (Q44).
 *
 * The router never mints an ID except through `input.ids`, never reads the
 * clock, and never rejects: provider failures are a `failed` outcome.
 */
export function createRouter(deps: Pick<CoreDependencies, 'decisionProvider' | 'decomposer'>): Router {
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

type Deps = Pick<CoreDependencies, 'decisionProvider' | 'decomposer'>

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
  const gateResult = await ask(deps.decisionProvider, input.settings.models.decision, describeState(input, supplied, subject), gate, signal)
  if (!gateResult.ok) return failed(gateResult.error)
  const g = gateResult.answers
  record.add(g)
  const m = readUnit(g, supplied, input, messageScope)
  const composite = g.noul('composite')
  const sessionWide = (g.noul('sessionwide') ?? 0) >= t.clearlyCorrective
  const changedRequirements = selected(m.sessionRequirements, t.clearlyCorrective)

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

  const requirements = new RequirementBook(input, decomposition, sessionWide)
  const compositeDecided: Decided<'atomic' | 'composite'> = { value: 'atomic', confidence: composite }

  if (isComposite && decomposition && decomposition.fragments.length >= 2) {
    return routeComposite(deps, input, signal, { supplied, given, record, decomposition, requirements, composite, m })
  }

  // ── Atomic ──
  const resolution = resolveUnitTargets(m, given, t, { fragment: false, mayBeReply: m.relation?.value !== 'new' || (m.corrective ?? 0) >= t.clearlyCorrective })
  if (resolution.kind === 'ambiguous') return { kind: 'target-ambiguity', candidates: resolution.candidates }
  const targets = answerTargets(supplied, resolution.sectionIds)
  const revision = revisionOf(m, targets, changedRequirements, input.text, null, supplied, t)
  const units: PlannedUnit[] = []
  const decisions: UnitRoutingDecision[] = []
  const clarifications: PlannedClarification[] = []
  if (revision) {
    decisions.push(revisionDecision(input, m, 'message', null, revision, resolution.mode))
  } else {
    const directiveId = input.ids.next('directive')
    const placed = derivePlacement(supplied, {
      relation: m.relation,
      targets,
      needsWork: selected(m.needsWork, t.dependency),
      needsGroups: selected(m.needsGroups, t.dependency),
      needsUnits: [],
      chain: m.chain,
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
  readonly m: UnitSignals
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
    sections: (given ? supplied.sections.filter((s) => given.sectionIds.includes(s.sectionId)) : supplied.sections).map((section) => ({
      n: numbers.get(section.sectionId) ?? 0,
      section,
    })),
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
  const result = await ask(deps.decisionProvider, input.settings.models.decision, describeState(input, supplied, subject), batch, signal)
  if (!result.ok) return failed(result.error)
  const a = result.answers
  record.add(a)

  // Targets, revisions and units per fragment.
  const signals = scopes.map((scope) => readUnit(a, supplied, input, scope))
  const ambiguous = new Map<SectionId, number>()
  const plans: (
    | { readonly kind: 'unit'; readonly directiveId: DirectiveId; readonly targets: SectionId[]; readonly mode: TargetMode }
    | { readonly kind: 'revision'; readonly revision: PlannedRevision; readonly mode: TargetMode }
  )[] = []
  const changedByAny: RequirementId[] = []
  for (const [i, s] of signals.entries()) {
    const f = fragments[i]
    if (!f) continue
    const resolution = resolveUnitTargets(s, given, t, { fragment: true, mayBeReply: s.relation?.value !== 'new' || (s.corrective ?? 0) >= t.clearlyCorrective })
    if (resolution.kind === 'ambiguous') {
      for (const cand of resolution.candidates) ambiguous.set(cand.sectionId, Math.max(ambiguous.get(cand.sectionId) ?? 0, cand.confidence))
      continue
    }
    const targets = answerTargets(supplied, resolution.sectionIds)
    const changed = selected(s.sessionRequirements, t.clearlyCorrective)
    for (const id of changed) if (!changedByAny.includes(id)) changedByAny.push(id)
    const fragment = { fragmentId: input.ids.next('fragment') as FragmentId, sourceSpans: f.sourceSpans, rewrittenText: f.instruction }
    const revision = revisionOf(s, targets, changed, f.instruction, fragment, supplied, t)
    if (revision) plans.push({ kind: 'revision', revision, mode: resolution.mode })
    else plans.push({ kind: 'unit', directiveId: input.ids.next('directive'), targets, mode: resolution.mode })
    fragmentIds.set(f.key, fragment.fragmentId)
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
    const needsUnits = selected(s.after, t.dependency).flatMap((key) => {
      const id = unitOfFragment.get(key)
      return id ? [id] : []
    })
    const placed = derivePlacement(supplied, {
      relation: s.relation,
      targets: p.targets,
      needsWork: selected(s.needsWork, t.dependency),
      needsGroups: selected(s.needsGroups, t.dependency),
      needsUnits,
      chain: s.chain,
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
    if (r.scope !== 'shared-requirement' || r.targetDirectiveIds.length === 0) return []
    const list = input.candidates.work.filter(
      (w) => !r.targetDirectiveIds.includes(w.directiveId) && w.consumed.some((id) => r.targetDirectiveIds.includes(id)),
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
    mode: targets.length === 0 ? 'none' : mode,
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
    explanation,
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

  private readonly sessionWide: boolean

  constructor(input: RoutingInput, decomposition: Decomposition | null, sessionWide: boolean) {
    this.sessionWide = sessionWide
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
          scope: sessionWide && r.scope === 'session-wide' ? 'session-wide' : 'local',
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
    const fresh = this.sessionWide ? [...this.byKey.values()].filter((r) => r.scope === 'session-wide') : []
    const sessionRequirements: PlannedSessionRequirement[] = fresh.map((requirement, i) => ({ requirement, replacesRequirementId: changed[i] ?? null }))
    return { sessionRequirements, withdrawnSessionRequirementIds: changed.slice(fresh.length) }
  }
}

function requirementKey(r: { readonly text: string; readonly span: TextSpan | null }): string {
  return r.span ? `${r.span.start}:${r.span.end}` : r.text.trim().toLowerCase()
}

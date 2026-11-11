import {
  deepEqual,
  type DecisionThresholds,
  type DirectiveId,
  type NodeId,
  type Placement,
  type PointRef,
  type PrerequisiteRef,
  type ReplyRelation,
  type SectionId,
  type SiblingGroupId,
} from '@committee/protocol'
import type { CandidateGroup, CandidateWork, PlannedUnit, RoutingInput, RoutingPlan } from '../ports'
import type { BaseRelation, Scored, UnitSignals } from './questions'
import type { Supplied } from './supply'

/**
 * Stage 3 of 11 · "Routing": everything after the decision model has
 * answered is deterministic. Thresholds turn confidences into selections
 * (Q74); placement and dependencies follow mechanically from what was
 * selected; validation repairs what has one correct reading and refuses the
 * rest (`RoutingPlan`).
 */

/**
 * Below the target-choice threshold a section is not inferred as a target.
 * When a reply has one or more sections at this floor and none reaches the
 * threshold, its target is not clear and the user is asked (11 · "Below the
 * target-choice confidence threshold, Committee elicits the target", Q20,
 * Q74): a weak candidate is never silently dropped in favour of the
 * handling chain. When the model says the message refers to several
 * sections and one is clear, every section at the floor is a target too.
 * Set from the first live corpus run (PLAN §7, core-routing).
 */
export const AMBIGUITY_FLOOR = 0.25

export type TargetMode = 'explicit' | 'inferred' | 'elicited' | 'none'

export type TargetResolution =
  | { readonly kind: 'resolved'; readonly sectionIds: readonly SectionId[]; readonly mode: TargetMode }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly { readonly sectionId: SectionId; readonly confidence: number }[] }

/**
 * Reply targets of one unit (05, Q20, Q43). Explicit and chosen targets are
 * used as given (for a fragment: those of them it refers to). Otherwise a
 * section is inferred at or above `targetChoice`, several sections may be
 * inferred, and sections that only reach the ambiguity floor are a
 * question to the user, never a guess.
 */
export function resolveUnitTargets(
  signals: UnitSignals,
  given: { readonly sectionIds: readonly SectionId[]; readonly mode: 'explicit' | 'elicited' } | null,
  thresholds: DecisionThresholds,
  options: { readonly fragment: boolean; readonly mayBeReply: boolean },
): TargetResolution {
  const ranked = [...signals.targets].sort((a, b) => b.confidence - a.confidence)
  if (given) {
    if (!options.fragment) return { kind: 'resolved', sectionIds: given.sectionIds, mode: given.mode }
    // A fragment takes the given sections it refers to, and keeps any other section it clearly
    // refers to on its own: a choice made for one ambiguous part never strips another part of its
    // clear target (T1, 07 · target ambiguity is about the ambiguous reply only).
    const mine = given.sectionIds.filter((id) => (signals.targets.find((t) => t.id === id)?.confidence ?? 0) >= AMBIGUITY_FLOOR)
    const own = ranked.filter((t) => t.confidence >= thresholds.targetChoice && !given.sectionIds.includes(t.id)).map((t) => t.id)
    if (mine.length > 0) return { kind: 'resolved', sectionIds: [...mine, ...own], mode: given.mode }
    return { kind: 'resolved', sectionIds: own, mode: own.length > 0 ? 'inferred' : 'none' }
  }
  const inferred = ranked.filter((t) => t.confidence >= thresholds.targetChoice).map((t) => t.id)
  if (inferred.length > 0) {
    // A message that plainly refers to several sections names a clear one and further ones the model scores lower (Q20).
    if ((signals.several ?? 0) >= thresholds.targetChoice) {
      for (const t of ranked) if (t.confidence >= AMBIGUITY_FLOOR && !inferred.includes(t.id)) inferred.push(t.id)
    }
    return { kind: 'resolved', sectionIds: inferred, mode: 'inferred' }
  }
  const weak = ranked.filter((t) => t.confidence >= AMBIGUITY_FLOOR)
  if (options.mayBeReply && weak.length >= 1) {
    return { kind: 'ambiguous', candidates: weak.map((t) => ({ sectionId: t.id, confidence: t.confidence })) }
  }
  return { kind: 'resolved', sectionIds: [], mode: 'none' }
}

/**
 * The results a unit waits for: those selected at the dependency threshold,
 * and, when the decision model says the unit needs a result that is not
 * available yet (relation `dependent` at the threshold) but selected none,
 * the in-flight work it targets, or else the one in-flight result it scored
 * plausible. Two answers never resolve silently in the direction that runs
 * (05 · "Result-dependent work", C2).
 */
export function neededWork(signals: UnitSignals, targets: readonly SectionId[], supplied: Supplied, thresholds: DecisionThresholds): DirectiveId[] {
  const chosen = selected(signals.needsWork, thresholds.dependency)
  if (chosen.length > 0 || selected(signals.needsGroups, thresholds.dependency).length > 0) return chosen
  const relation = signals.relation
  if (!relation || relation.value !== 'result-dependent' || relation.confidence < thresholds.dependency) return chosen
  const inFlight = new Set(supplied.inFlight.map((w) => w.directiveId))
  const targeted = targets.flatMap((id) => {
    const directiveId = supplied.sectionById.get(id)?.directiveId
    return directiveId && inFlight.has(directiveId) ? [directiveId] : []
  })
  if (targeted.length > 0) return [...new Set(targeted)]
  const plausible = signals.needsWork.filter((w) => w.confidence >= AMBIGUITY_FLOOR)
  const only = plausible.length === 1 ? plausible[0] : undefined
  return only ? [only.id] : chosen
}

export function selected<T>(scored: readonly Scored<T>[], threshold: number): T[] {
  return scored.filter((s) => s.confidence >= threshold).map((s) => s.id)
}

export interface DerivedPlacement {
  readonly placement: Placement
  readonly prerequisites: readonly PrerequisiteRef[]
  readonly relation: Exclude<ReplyRelation, 'revision'>
  /** The confidence behind the placement: the weakest selection it rests on, or null when it follows deterministically. */
  readonly confidence: number | null
  readonly explanation: string
}

/**
 * Placement and result dependencies of one unit, from its selections
 * (Q76). Context and dependency stay separate relationships (invariant 1):
 * a dependency is a selected unfinished result; context is every point the
 * unit refers to or needs.
 *
 * - Nothing referred to, nothing needed, relation `new`: a new chain.
 * - The points it builds on: each target section's node, each needed
 *   result, each earlier fragment it needs. With none, the handling
 *   chain's settled head (its tip when nothing on it has settled, which the
 *   engine repairs to the chain's starting context).
 * - Two or more members of one sibling group are that group (Q30), and an
 *   open group is also waited for (C9, C15).
 * - A point already in another point's ancestry is dropped (Q97).
 * - One point: continue it. Two or more: a join chain (Q86, Q88).
 */
export function derivePlacement(
  supplied: Supplied,
  unit: {
    readonly relation: UnitSignals['relation']
    readonly targets: readonly SectionId[]
    readonly needsWork: readonly DirectiveId[]
    readonly needsGroups: readonly SiblingGroupId[]
    /** Earlier units of the same plan this one needs. */
    readonly needsUnits: readonly DirectiveId[]
    readonly chain: UnitSignals['chain']
    /**
     * The confidence the handling-chain choice needs to place the unit. Below it the choice is a
     * guess, and a guess never decides what a run reads: the unit starts a new chain instead.
     */
    readonly chainThreshold: number
    readonly confidences: readonly number[]
  },
): DerivedPlacement {
  const prerequisites: PrerequisiteRef[] = []
  const addPrerequisite = (ref: PrerequisiteRef): void => {
    if (!prerequisites.some((p) => deepEqual(p, ref))) prerequisites.push(ref)
  }
  for (const id of unit.needsWork) addPrerequisite({ kind: 'directive', directiveId: id })
  for (const id of unit.needsGroups) addPrerequisite({ kind: 'sibling-group', groupId: id })
  for (const id of unit.needsUnits) addPrerequisite({ kind: 'directive', directiveId: id })
  const base: BaseRelation = unit.relation?.value ?? 'new'
  const weakest = unit.confidences.length > 0 ? Math.min(...unit.confidences) : null

  const points: PointRef[] = []
  const addPoint = (p: PointRef): void => {
    if (!points.some((q) => deepEqual(q, p))) points.push(p)
  }
  for (const id of unit.targets) {
    const section = supplied.sectionById.get(id)
    if (section && !section.asksElicitationId) addPoint({ kind: 'node', nodeId: section.nodeId })
  }
  for (const id of unit.needsWork) {
    const work = supplied.workById.get(id)
    if (work) addPoint({ kind: 'node', nodeId: work.nodeId })
  }
  for (const id of unit.needsGroups) addPoint({ kind: 'sibling-group', groupId: id })
  for (const id of unit.needsUnits) addPoint({ kind: 'directive', directiveId: id })

  let explanation: string
  if (points.length === 0) {
    const chain = unit.chain && unit.chain.confidence >= unit.chainThreshold ? supplied.chains.find((c) => c.chainId === unit.chain?.id) : undefined
    if (base === 'new' || !chain) {
      return { placement: { kind: 'new-chain' }, prerequisites: [], relation: 'new', confidence: weakest, explanation: 'Unrelated to existing work: a new chain.' }
    }
    addPoint({ kind: 'node', nodeId: chain.headNodeId ?? chain.tipNodeId })
    explanation = `Continues the line "${chain.label}".`
  } else {
    explanation = ''
  }

  // Two or more members of one sibling group are the whole group (Q30), whether a point is a member
  // itself or reaches one through its ancestry (a branch from one sibling): work that reads two
  // members reads the full join-back, never a subset of it (04 · "No subset bypass").
  const direct = (p: PointRef): SiblingGroupId | null => {
    if (p.kind === 'sibling-group') return p.groupId
    if (p.kind !== 'node') return null
    return supplied.workByNode.get(p.nodeId)?.groupId ?? null
  }
  const promoted = new Set(groupsReachedTwice(supplied.workByNode, supplied.groupById, points))
  let merged: PointRef[] = []
  for (const p of points) {
    const g = direct(p)
    const ref: PointRef = g && promoted.has(g) ? { kind: 'sibling-group', groupId: g } : p
    if (!merged.some((q) => deepEqual(q, ref))) merged.push(ref)
  }
  for (const g of promoted) {
    if (supplied.groupById.get(g)?.open) addPrerequisite({ kind: 'sibling-group', groupId: g })
  }
  for (const p of merged) {
    if (p.kind === 'sibling-group' && supplied.groupById.get(p.groupId)?.open) addPrerequisite({ kind: 'sibling-group', groupId: p.groupId })
  }
  const finalPrerequisites = prerequisites.filter((ref) => {
    if (ref.kind !== 'directive') return true
    const g = supplied.workById.get(ref.directiveId)?.groupId
    return !(g && promoted.has(g))
  })

  // A point already in another's ancestry is read through it.
  merged = merged.filter((p) => !merged.some((q) => q !== p && isAncestorPoint(supplied, p, q)))

  const relation: Exclude<ReplyRelation, 'revision'> = finalPrerequisites.length > 0 ? 'result-dependent' : 'addition'
  const placement: Placement =
    merged.length === 1 && merged[0] ? { kind: 'continue', buildsOn: merged[0] } : { kind: 'join-chain', parents: merged }
  if (explanation === '') {
    explanation =
      placement.kind === 'join-chain'
        ? `Needs lines that have diverged: a join chain over ${merged.length} leaves.`
        : 'Continues from the work it refers to.'
  }
  if (finalPrerequisites.length > 0) explanation += ` Waits for ${finalPrerequisites.length === 1 ? 'one result' : `${finalPrerequisites.length} results`}.`
  return { placement, prerequisites: finalPrerequisites, relation, confidence: weakest, explanation }
}

/** True when `p` is an ancestor of `q` as far as the candidates show it. */
function isAncestorPoint(supplied: Supplied, p: PointRef, q: PointRef): boolean {
  if (p.kind !== 'node') return false
  let start: NodeId | null = null
  if (q.kind === 'node') start = supplied.workByNode.get(q.nodeId)?.startNodeId ?? null
  else if (q.kind === 'sibling-group') start = supplied.groupById.get(q.groupId)?.startNodeId ?? null
  const seen = new Set<NodeId>()
  while (start !== null && !seen.has(start)) {
    if (start === p.nodeId) return true
    seen.add(start)
    start = supplied.workByNode.get(start)?.startNodeId ?? null
  }
  return false
}

/**
 * The sibling groups whose members, two or more of them, the points reach:
 * a member point reaches its own group; any node point reaches the groups
 * of the members in its ancestry (as far as the candidates show it); a
 * group point reaches every member. Two points that reach the same member
 * (a sibling and a branch from it) count once.
 */
export function groupsReachedTwice(
  workByNode: ReadonlyMap<NodeId, CandidateWork>,
  groupById: ReadonlyMap<SiblingGroupId, CandidateGroup>,
  points: readonly PointRef[],
): SiblingGroupId[] {
  const members = new Map<SiblingGroupId, Set<DirectiveId>>()
  const note = (g: SiblingGroupId, d: DirectiveId): void => {
    const set = members.get(g) ?? new Set<DirectiveId>()
    set.add(d)
    members.set(g, set)
  }
  for (const p of points) {
    if (p.kind === 'sibling-group') {
      for (const d of groupById.get(p.groupId)?.memberDirectiveIds ?? []) note(p.groupId, d)
      continue
    }
    if (p.kind !== 'node') continue
    const seen = new Set<NodeId>()
    let node: NodeId | null = p.nodeId
    while (node !== null && !seen.has(node)) {
      seen.add(node)
      const work = workByNode.get(node)
      if (!work) break
      if (work.groupId) note(work.groupId, work.directiveId)
      node = work.startNodeId
    }
  }
  return [...members].filter(([, set]) => set.size >= 2).map(([g]) => g)
}

// ───────────────────────────── validation ─────────────────────────────

export type Validation = { readonly ok: true; readonly plan: RoutingPlan } | { readonly ok: false; readonly message: string }

/**
 * Deterministic validation of a plan against the supplied candidates
 * (11 · "Routing", stage 3; the rules listed on `RoutingPlan`):
 * - every target, dependency and placement names a supplied candidate or a
 *   unit of this plan, or the plan is refused;
 * - two or more members of one sibling group become the whole group (Q30),
 *   and a `sibling-group` point on an open group gains its prerequisite;
 * - dependencies are acyclic: units are ordered topologically, ties in
 *   original text order, and a cycle refuses the plan (Q53).
 */
export function validatePlan(input: RoutingInput, plan: RoutingPlan): Validation {
  const sections = new Set(input.candidates.sections.map((s) => s.sectionId))
  for (const id of input.explicitTargets) sections.add(id)
  const work = new Map(input.candidates.work.map((w) => [w.directiveId, w]))
  const groups = new Map(input.candidates.groups.map((g) => [g.groupId, g]))
  const workByNode = new Map(input.candidates.work.map((w) => [w.nodeId, w]))
  const nodes = new Set<NodeId>()
  for (const w of input.candidates.work) nodes.add(w.nodeId)
  for (const c of input.candidates.chains) {
    nodes.add(c.tipNodeId)
    if (c.headNodeId) nodes.add(c.headNodeId)
  }
  for (const g of input.candidates.groups) nodes.add(g.startNodeId)
  for (const s of input.candidates.sections) nodes.add(s.nodeId)
  for (const w of input.candidates.work) if (w.startNodeId) nodes.add(w.startNodeId)

  const own = new Set(plan.units.map((u) => u.directiveId))
  if (own.size !== plan.units.length) return { ok: false, message: 'Two units share a directive ID' }
  for (const id of own) if (work.has(id)) return { ok: false, message: `Unit ${id} is not new` }

  const point = (p: PointRef): string | null => {
    if (p.kind === 'node') return nodes.has(p.nodeId) ? null : `Unknown node ${p.nodeId}`
    if (p.kind === 'sibling-group') return groups.has(p.groupId) ? null : `Unknown group ${p.groupId}`
    return own.has(p.directiveId) ? null : `Unknown directive ${p.directiveId}`
  }

  const repaired: PlannedUnit[] = []
  for (const unit of plan.units) {
    for (const t of unit.targets) if (!sections.has(t)) return { ok: false, message: `Target ${t} was not a supplied candidate` }
    const points = unit.placement.kind === 'continue' ? [unit.placement.buildsOn] : unit.placement.kind === 'join-chain' ? unit.placement.parents : []
    for (const p of points) {
      const problem = point(p)
      if (problem) return { ok: false, message: problem }
    }
    if (unit.placement.kind === 'join-chain' && unit.placement.parents.length < 2) return { ok: false, message: 'A join chain needs two or more parents (Q88)' }
    // Subset of a sibling group → the whole group (Q30).
    const byGroup = new Map<SiblingGroupId, number>()
    for (const ref of unit.prerequisites) {
      if (ref.kind === 'directive') {
        if (!work.has(ref.directiveId) && !own.has(ref.directiveId)) return { ok: false, message: `Unknown prerequisite ${ref.directiveId}` }
        const g = work.get(ref.directiveId)?.groupId
        if (g) byGroup.set(g, (byGroup.get(g) ?? 0) + 1)
      } else if (!groups.has(ref.groupId)) return { ok: false, message: `Unknown group ${ref.groupId}` }
    }
    const prerequisites: PrerequisiteRef[] = []
    const add = (ref: PrerequisiteRef): void => {
      if (!prerequisites.some((p) => deepEqual(p, ref))) prerequisites.push(ref)
    }
    for (const ref of unit.prerequisites) {
      const g = ref.kind === 'directive' ? work.get(ref.directiveId)?.groupId : undefined
      if (g && (byGroup.get(g) ?? 0) >= 2) add({ kind: 'sibling-group', groupId: g })
      else add(ref)
    }
    for (const p of points) if (p.kind === 'sibling-group' && groups.get(p.groupId)?.open) add({ kind: 'sibling-group', groupId: p.groupId })
    // Points that reach two members of one open group, directly or through a branch, wait for all of it (C9).
    const reachedTwice = groupsReachedTwice(workByNode, groups, points)
    for (const g of reachedTwice) if (groups.get(g)?.open) add({ kind: 'sibling-group', groupId: g })
    const kept = prerequisites.filter((ref) => ref.kind !== 'directive' || !reachedTwice.includes(work.get(ref.directiveId)?.groupId ?? ('' as SiblingGroupId)))
    repaired.push(deepEqual(kept, unit.prerequisites) ? unit : { ...unit, prerequisites: kept })
  }

  // Acyclic, topological, ties in original text order (Q53).
  const ordered = topological(repaired)
  if (!ordered) return { ok: false, message: 'The dependencies between the parts form a cycle' }
  for (const c of plan.clarifications) {
    if (own.has(c.questionDirectiveId) || work.has(c.questionDirectiveId)) return { ok: false, message: 'A clarification question needs a directive of its own' }
    if (c.blockedDirectiveIds.length === 0 || c.blockedDirectiveIds.some((id) => !own.has(id))) return { ok: false, message: 'A clarification blocks an unknown unit' }
  }
  const blocked = plan.clarifications.flatMap((c) => c.blockedDirectiveIds)
  if (new Set(blocked).size !== blocked.length) return { ok: false, message: 'A unit is blocked by two clarifications' }
  for (const r of plan.revisions) {
    if (r.targetDirectiveIds.length === 0 && r.targetRequirementIds.length === 0) return { ok: false, message: 'A revision names nothing it corrects' }
    for (const id of r.targetDirectiveIds) if (!work.has(id)) return { ok: false, message: `Revision of unknown work ${id}` }
    for (const id of r.targetRequirementIds) {
      if (!input.sessionRequirements.some((q) => q.id === id)) return { ok: false, message: `Revision of unknown requirement ${id}` }
    }
  }
  if (plan.answersElicitationId !== null && !input.candidates.sections.some((s) => s.asksElicitationId === plan.answersElicitationId)) {
    return { ok: false, message: 'The message answers a question that is not open' }
  }
  if (input.forcedComposition === 'atomic' && (plan.composition !== 'atomic' || plan.units.length > 1)) {
    return { ok: false, message: 'Undo split needs one atomic request' }
  }
  return { ok: true, plan: { ...plan, units: ordered } }
}

/** Kahn's order over in-plan `directive` prerequisites and placements; ties by first source position. Null on a cycle. */
export function topological(units: readonly PlannedUnit[]): PlannedUnit[] | null {
  const ids = new Set(units.map((u) => u.directiveId))
  const position = (u: PlannedUnit): number => u.fragment?.sourceSpans[0]?.start ?? units.indexOf(u)
  const needs = new Map<DirectiveId, Set<DirectiveId>>()
  for (const u of units) {
    const set = new Set<DirectiveId>()
    for (const p of u.prerequisites) if (p.kind === 'directive' && ids.has(p.directiveId)) set.add(p.directiveId)
    const points = u.placement.kind === 'continue' ? [u.placement.buildsOn] : u.placement.kind === 'join-chain' ? u.placement.parents : []
    for (const p of points) if (p.kind === 'directive' && ids.has(p.directiveId)) set.add(p.directiveId)
    set.delete(u.directiveId)
    needs.set(u.directiveId, set)
  }
  const out: PlannedUnit[] = []
  const done = new Set<DirectiveId>()
  while (out.length < units.length) {
    const ready = units
      .filter((u) => !done.has(u.directiveId) && [...(needs.get(u.directiveId) ?? [])].every((id) => done.has(id)))
      .sort((a, b) => position(a) - position(b))
    const next = ready[0]
    if (!next) return null
    out.push(next)
    done.add(next.directiveId)
  }
  return out
}

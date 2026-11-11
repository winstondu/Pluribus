import {
  deepEqual,
  provisionalLabel,
  type ChainId,
  type ChainKind,
  type ConversationEventBody,
  type DirectiveId,
  type FragmentRecord,
  type MessageId,
  type NodeId,
  type NodeRechaining,
  type PointRef,
  type PrerequisiteRef,
  type ResponseId,
  type SiblingGroupId,
  type SiblingMember,
  type SplitMessageRecord,
} from '@committee/protocol'
import type { PlannedUnit, RoutingPlan } from '../ports'
import { resolveTargets } from './candidates'
import type { PlanApplier, PlanTarget, StepContext } from './module'
import {
  activeMembers,
  chainTip,
  childrenInFlight,
  countsAlongChain,
  descendsFrom,
  groupOfDirective,
  nodeInFlight,
  openGroupAt,
  resolvePoint,
  currentJoinBack,
  nodeParents,
} from './queries'
import type { ConversationState, GroupRow } from './state'

/**
 * Carrying out a routing plan's units (PLAN §2 "Genealogy, mechanically";
 * "Who builds each behaviour"): chains, nodes, sibling groups, directives,
 * prerequisites, responses, sections, the repairs and the three placement
 * cases, composite presentation and split messages.
 */

export type PlanCheck = { readonly ok: true; readonly plan: RoutingPlan } | { readonly ok: false; readonly message: string }

/**
 * Checks a plan against the rules of `RoutingPlan` and applies the repairs
 * that have one correct reading. A plan that still breaks a rule is
 * refused; the engine then records `routing-failed` (malformed-response).
 * The repairs that depend on earlier units of the same plan (repair 0, a
 * join-chain parent that is not a leaf) are applied while placing.
 */
export function checkPlan(state: ConversationState, routed: RoutingPlan): PlanCheck {
  const plan = redirectSuperseded(state, routed)
  const seen = new Set<DirectiveId>()
  const units: PlannedUnit[] = []
  for (const unit of plan.units) {
    if (seen.has(unit.directiveId) || state.directives[unit.directiveId]) {
      return { ok: false, message: `Directive ${unit.directiveId} is not new` }
    }
    const earlier = (id: DirectiveId): boolean => seen.has(id) || state.directives[id] !== undefined
    // References: existing things, or earlier units of this plan (topological order, so no cycle).
    for (const ref of unit.prerequisites) {
      if (ref.kind === 'directive' && !earlier(ref.directiveId)) {
        return { ok: false, message: `Unit ${unit.directiveId} waits for ${ref.directiveId}, which is unknown or later in the plan` }
      }
      if (ref.kind === 'sibling-group' && !state.groups[ref.groupId]) {
        return { ok: false, message: `Unit ${unit.directiveId} waits for unknown group ${ref.groupId}` }
      }
    }
    const points: PointRef[] =
      unit.placement.kind === 'continue'
        ? [unit.placement.buildsOn]
        : unit.placement.kind === 'join-chain'
          ? [...unit.placement.parents]
          : []
    for (const point of points) {
      if (point.kind === 'node' && !state.nodes[point.nodeId]) return { ok: false, message: `Unknown node ${point.nodeId}` }
      if (point.kind === 'directive' && !earlier(point.directiveId)) {
        return { ok: false, message: `Unit ${unit.directiveId} builds on ${point.directiveId}, which is unknown or later in the plan` }
      }
      if (point.kind === 'sibling-group' && !state.groups[point.groupId]) {
        return { ok: false, message: `Unknown group ${point.groupId}` }
      }
    }
    if (unit.placement.kind === 'join-chain' && distinctPoints(unit.placement.parents) < 2) {
      return { ok: false, message: 'A join chain needs two or more parents (Q88)' }
    }
    units.push(repairPrerequisites(state, unit))
    seen.add(unit.directiveId)
  }
  if (plan.outputOrder) {
    for (const id of plan.outputOrder) {
      if (!plan.units.some((u) => u.directiveId === id)) return { ok: false, message: `Output order names unknown unit ${id}` }
    }
  }
  for (const clarification of plan.clarifications) {
    for (const id of clarification.blockedDirectiveIds) {
      if (!plan.units.some((u) => u.directiveId === id)) return { ok: false, message: `Clarification blocks unknown unit ${id}` }
    }
  }
  return { ok: true, plan: { ...plan, units } }
}

/**
 * A section or node can be superseded between the moment a message's
 * routing input was built and the moment its plan is applied (Regenerate, a
 * default redo). A target on a superseded section resolves to its current
 * replacement and the redirect is recorded, so the message says "Replying to
 * the revised version" (Q43, T3); a point on a replaced node moves to the
 * node that replaced it, so new work never hangs under superseded work.
 */
export function redirectSuperseded(state: ConversationState, plan: RoutingPlan): RoutingPlan {
  let changed = false
  let decisionUnits = plan.decision.units
  const current = (nodeId: NodeId): NodeId => {
    let id = nodeId
    const seen = new Set<NodeId>()
    for (;;) {
      const next = state.nodes[id]?.replacedByNodeId ?? null
      if (next === null || seen.has(next)) return id
      seen.add(id)
      id = next
    }
  }
  const point = (p: PointRef): PointRef => {
    if (p.kind !== 'node') return p
    const nodeId = current(p.nodeId)
    return nodeId === p.nodeId ? p : { kind: 'node', nodeId }
  }
  const units = plan.units.map((unit) => {
    let next = unit
    const { sectionIds, redirects } = resolveTargets(state, unit.targets)
    if (redirects.length > 0) {
      next = { ...next, targets: sectionIds }
      const fragmentId = unit.fragment?.fragmentId ?? null
      decisionUnits = decisionUnits.map((d) =>
        d.fragmentId === fragmentId
          ? { ...d, targets: { ...d.targets, sectionIds: [...sectionIds], redirected: [...d.targets.redirected, ...redirects] } }
          : d,
      )
    }
    const placement = next.placement
    if (placement.kind === 'continue') {
      const buildsOn = point(placement.buildsOn)
      if (buildsOn !== placement.buildsOn) next = { ...next, placement: { kind: 'continue', buildsOn } }
    } else if (placement.kind === 'join-chain') {
      const parents = placement.parents.map(point)
      if (parents.some((p, i) => p !== placement.parents[i])) next = { ...next, placement: { kind: 'join-chain', parents } }
    }
    if (next !== unit) changed = true
    return next
  })
  if (!changed) return plan
  return { ...plan, units, decision: { ...plan.decision, units: decisionUnits } }
}

function distinctPoints(points: readonly PointRef[]): number {
  return new Set(points.map((p) => JSON.stringify(p))).size
}

/** Two or more members of one sibling group become the whole group (Q30); an open group point gains its prerequisite (C9, C15). */
function repairPrerequisites(state: ConversationState, unit: PlannedUnit): PlannedUnit {
  const prerequisites: PrerequisiteRef[] = []
  const byGroup = new Map<string, DirectiveId[]>()
  for (const ref of unit.prerequisites) {
    if (ref.kind === 'directive') {
      const group = groupOfDirective(state, ref.directiveId)
      if (group) byGroup.set(group.id, [...(byGroup.get(group.id) ?? []), ref.directiveId])
    }
  }
  const promoted = new Set<string>([...byGroup].filter(([, ids]) => ids.length >= 2).map(([id]) => id))
  const add = (ref: PrerequisiteRef): void => {
    if (!prerequisites.some((p) => JSON.stringify(p) === JSON.stringify(ref))) prerequisites.push(ref)
  }
  for (const ref of unit.prerequisites) {
    if (ref.kind === 'directive') {
      const group = groupOfDirective(state, ref.directiveId)
      if (group && promoted.has(group.id)) add({ kind: 'sibling-group', groupId: group.id })
      else add(ref)
    } else add(ref)
  }
  const points =
    unit.placement.kind === 'continue' ? [unit.placement.buildsOn] : unit.placement.kind === 'join-chain' ? unit.placement.parents : []
  for (const point of points) {
    if (point.kind === 'sibling-group' && state.groups[point.groupId]?.state === 'open') {
      add({ kind: 'sibling-group', groupId: point.groupId })
    }
  }
  return prerequisites.length === unit.prerequisites.length &&
    prerequisites.every((p, i) => JSON.stringify(p) === JSON.stringify(unit.prerequisites[i]))
    ? unit
    : { ...unit, prerequisites }
}

/** The engine's plan applier: units, session-wide requirements, presentation. */
export const unitsApplier: PlanApplier = {
  parts: ['units', 'sessionRequirements'],
  apply(_state, plan, target, ctx) {
    applySessionRequirements(plan, target.messageId, ctx)
    applyUnits(plan, target, ctx)
  },
}

function applySessionRequirements(plan: RoutingPlan, messageId: MessageId, ctx: StepContext): void {
  for (const entry of plan.sessionRequirements) {
    ctx.emit({ type: 'session-requirement-recorded', requirement: entry.requirement, replacesRequirementId: entry.replacesRequirementId })
  }
  for (const requirementId of plan.withdrawnSessionRequirementIds) {
    ctx.emit({ type: 'session-requirement-withdrawn', requirementId, messageId })
  }
}

function fragmentText(text: string, spans: readonly { readonly start: number; readonly end: number }[]): string {
  return spans.map((s) => text.slice(s.start, s.end)).join(' … ')
}

function applyUnits(plan: RoutingPlan, target: PlanTarget, ctx: StepContext): void {
  const message = ctx.state.messages[target.messageId]
  if (!message) return
  const blocked = new Set(plan.clarifications.flatMap((c) => c.blockedDirectiveIds))
  const sequential = plan.composition === 'sequential-composite'

  // Composite presentation: message-decomposed with every fragment, work and revision.
  const splitIds = new Map<DirectiveId, MessageId>()
  const hasFragments = plan.units.some((u) => u.fragment !== null) || plan.revisions.some((r) => r.fragment !== null)
  if (hasFragments || sequential) {
    const fragments: FragmentRecord[] = []
    for (const unit of plan.units) {
      if (!unit.fragment) continue
      fragments.push({
        fragmentId: unit.fragment.fragmentId,
        index: 0,
        sourceSpans: unit.fragment.sourceSpans,
        rewrittenText: unit.fragment.rewrittenText,
        label: unit.label,
        requirements: unit.requirements,
        kind: 'work',
        directiveId: unit.directiveId,
      })
    }
    for (const revision of plan.revisions) {
      const first = revision.targetDirectiveIds[0]
      if (!revision.fragment || first === undefined) continue
      fragments.push({
        fragmentId: revision.fragment.fragmentId,
        index: 0,
        sourceSpans: revision.fragment.sourceSpans,
        rewrittenText: revision.fragment.rewrittenText,
        label: provisionalLabel(revision.correction),
        requirements: [],
        kind: 'revision',
        directiveId: first,
      })
    }
    const startOf = (f: FragmentRecord): number => f.sourceSpans[0]?.start ?? 0
    const ordered = [...fragments].sort((a, b) => startOf(a) - startOf(b)).map((f, index) => ({ ...f, index }))
    const splitMessages: SplitMessageRecord[] = []
    if (sequential) {
      for (const unit of plan.units) {
        const messageId = ctx.ids.next('message')
        splitIds.set(unit.directiveId, messageId)
        if (unit.fragment) {
          splitMessages.push({
            messageId,
            fragmentId: unit.fragment.fragmentId,
            text: fragmentText(message.text, unit.fragment.sourceSpans),
          })
        }
      }
    }
    ctx.emit({
      type: 'message-decomposed',
      messageId: target.messageId,
      presentation: sequential ? 'split-messages' : 'reply-group',
      fragments: ordered,
      barrier: plan.barrier,
      outputOrder: plan.outputOrder
        ? plan.outputOrder
            .map((id) => plan.units.find((u) => u.directiveId === id)?.fragment?.fragmentId)
            .filter((id): id is NonNullable<typeof id> => id !== undefined)
        : null,
      splitMessages,
      model: plan.decompositionModel ?? '',
    })
  }

  // Responses. The initial response is the provisional bubble minted on submission.
  const answered = plan.units.filter((u) => !blocked.has(u.directiveId))
  const grouped = !sequential && plan.composition === 'independent-composite' && answered.length >= 2
  const explicit = plan.outputOrder !== null && grouped
  let initialResponse: ResponseId | null = null
  const responseFor = (unit: PlannedUnit): ResponseId => {
    const split = splitIds.get(unit.directiveId)
    if (split) {
      const responseId = ctx.ids.next('response')
      ctx.emit({ type: 'response-opened', responseId, messageId: split, reason: 'answer', grouped: false, sectionOrder: 'first-output' })
      return responseId
    }
    if (initialResponse === null) {
      initialResponse = message.initialResponseId ?? ctx.ids.next('response')
      ctx.emit({
        type: 'response-opened',
        responseId: initialResponse,
        messageId: target.messageId,
        reason: 'answer',
        grouped,
        sectionOrder: explicit ? 'explicit' : 'first-output',
      })
    }
    return initialResponse
  }

  for (const planned of plan.units) {
    // Earlier units of this plan may have formed or joined a sibling group: repair against the state as it is now (Q30).
    const unit = repairPrerequisites(ctx.state, planned)
    const placed = placeUnit(unit, ctx)
    const messageId = splitIds.get(unit.directiveId) ?? target.messageId
    ctx.emit({
      type: 'directive-created',
      directiveId: unit.directiveId,
      kind: 'answer',
      messageId,
      originalMessageId: target.messageId,
      fragmentId: unit.fragment?.fragmentId ?? null,
      instruction: unit.instruction,
      label: unit.label,
      requirements: unit.requirements,
      relation: unit.relation,
      targets: unit.targets,
      nodeId: placed.nodeId,
      chainId: placed.chainId,
      prerequisites: placed.prerequisites,
      asksElicitationId: null,
    })
    for (const body of placed.after) ctx.emit(body)
    if (!blocked.has(unit.directiveId)) {
      const responseId = responseFor(unit)
      const position = explicit && plan.outputOrder ? plan.outputOrder.indexOf(unit.directiveId) : -1
      ctx.emit({
        type: 'section-opened',
        sectionId: ctx.ids.next('section'),
        directiveId: unit.directiveId,
        responseId,
        title: unit.label,
        replacesSectionId: null,
        operationId: ctx.ids.next('operation'),
        explicitPosition: position >= 0 ? position : null,
      })
    }
    if (unit.labelIsProvisional) ctx.requestLabel(unit.directiveId)
  }
  // First states (directive-waiting / directive-ready) follow from the engine's wait reaction,
  // which sees the whole plan, so the whole-request barrier applies to every unit at once.
}

// ───────────────────────────── placement ─────────────────────────────

interface Placed {
  readonly nodeId: NodeId
  readonly chainId: ChainId
  /** Events that name the directive and so follow `directive-created`. */
  readonly after: readonly ConversationEventBody[]
  /** The unit's prerequisites, with any the placement adds (an open group it now builds on). */
  readonly prerequisites: readonly PrerequisiteRef[]
}

/** A new chain, named after `namedFor`'s label: it follows that directive's label from then on. */
function newChain(ctx: StepContext, kind: ChainKind, baseChainId: ChainId | null, namedFor: { readonly directiveId: DirectiveId; readonly label: string }): ChainId {
  const chainId = ctx.ids.next('chain')
  ctx.emit({
    type: 'chain-created',
    chainId,
    kind,
    colorIndex: ctx.state.chainOrder.length,
    baseChainId,
    label: namedFor.label,
    labelDirectiveId: namedFor.directiveId,
  })
  return chainId
}

function namedAfter(d: { readonly id: DirectiveId; readonly label: string } | undefined): { readonly directiveId: DirectiveId; readonly label: string } | null {
  return d ? { directiveId: d.id, label: d.label } : null
}

function newNode(ctx: StepContext, unit: PlannedUnit, chainId: ChainId, plannedParents: readonly PointRef[]): NodeId {
  const nodeId = ctx.ids.next('node')
  ctx.emit({
    type: 'node-created',
    nodeId,
    chainId,
    directiveId: unit.directiveId,
    reason: 'initial',
    plannedParents,
    replacesNodeId: null,
  })
  return nodeId
}

function withPrerequisite(unit: PlannedUnit, ref: PrerequisiteRef): PlannedUnit {
  return unit.prerequisites.some((p) => deepEqual(p, ref)) ? unit : { ...unit, prerequisites: [...unit.prerequisites, ref] }
}

function waitsForDirective(unit: PlannedUnit, directiveId: DirectiveId): boolean {
  return unit.prerequisites.some((p) => p.kind === 'directive' && p.directiveId === directiveId)
}

/** One of the three placements (Q76), with the repairs and the ordered cases of PLAN §2. */
export function placeUnit(unit: PlannedUnit, ctx: StepContext): Placed {
  const placement = unit.placement
  if (placement.kind === 'new-chain') return placeNewChain(unit, ctx)
  if (placement.kind === 'join-chain') return placeJoinChain(unit, placement.parents, ctx)

  const point = placement.buildsOn
  if (point.kind === 'sibling-group') return placeOnGroup(unit, point.groupId, ctx)
  let start = resolvePoint(ctx.state, point)
  if (start === null) return placeNewChain(unit, ctx)

  // Work that waits for a whole group builds on that group, never beside or below one of its members.
  const covering = coveringGroup(ctx.state, unit, start)
  if (covering) return placeOnGroup(unit, covering, ctx)
  // Work that builds on one member and waits for another needs two members: it depends on the whole
  // group, never a subset (Q30, C9).
  const spanned = groupSpannedFrom(ctx.state, unit, start)
  if (spanned) return placeOnGroup(withPrerequisite(unit, { kind: 'sibling-group', groupId: spanned }), spanned, ctx)

  // Repair 0: a node still in flight can be built on only by work that waits for it.
  const startNode = ctx.state.nodes[start]
  if (startNode?.directiveId && nodeInFlight(ctx.state, start) && !waitsForDirective(unit, startNode.directiveId)) {
    const settled = nearestSettledAncestor(ctx.state, start)
    // Nothing settled to fork from: the work in flight starts its line, so a fork beside it would read
    // nothing of what the unit refers to (05 · "A target identifies the context being referred to").
    // The only context to build on is that work's result: the unit waits for it and continues from it
    // (PLAN §2, repair 0, the empty-start case).
    if (settled.kind === 'none') return placeConsumer(withPrerequisite(unit, { kind: 'directive', directiveId: startNode.directiveId }), start, ctx)
    if (settled.kind === 'join') return placeJoinChain(unit, settled.parents, ctx)
    start = settled.nodeId
  }
  return placeConsumer(unit, start, ctx)
}

/**
 * The open group that `unit` waits for as a whole and whose starting node,
 * or one of whose members, is `start`. Such work continues from the group's
 * join-back; admitted beside the members it would wait for itself.
 */
function coveringGroup(state: ConversationState, unit: PlannedUnit, start: NodeId): SiblingGroupId | null {
  for (const ref of unit.prerequisites) {
    if (ref.kind !== 'sibling-group') continue
    const group = state.groups[ref.groupId]
    if (!group || group.state === 'dissolved') continue
    if (group.startNodeId === start || activeMembers(group).some((m) => m.nodeId === start)) return group.id
  }
  return null
}

/** The group of which `start` is a member while the unit waits for another of its members. */
function groupSpannedFrom(state: ConversationState, unit: PlannedUnit, start: NodeId): SiblingGroupId | null {
  const group = memberGroupOf(state, start)
  if (!group) return null
  const startDirective = state.nodes[start]?.directiveId ?? null
  return activeMembers(group).some((m) => m.directiveId !== startDirective && waitsForDirective(unit, m.directiveId)) ? group.id : null
}

/** Continue from a sibling group: the base chain from its join-back (Q78); while open, the unit waits for it (C9, C15). */
function placeOnGroup(unit: PlannedUnit, groupId: SiblingGroupId, ctx: StepContext): Placed {
  const group = ctx.state.groups[groupId]
  if (!group) return placeNewChain(unit, ctx)
  if (group.state === 'open') {
    const waiting = withPrerequisite(unit, { kind: 'sibling-group', groupId })
    return { nodeId: newNode(ctx, waiting, group.baseChainId, [{ kind: 'sibling-group', groupId }]), chainId: group.baseChainId, after: [], prerequisites: waiting.prerequisites }
  }
  const start = resolvePoint(ctx.state, { kind: 'sibling-group', groupId })
  if (start === null) return placeNewChain(unit, ctx)
  return placeConsumer(unit, start, ctx)
}

/**
 * A request that consumes one member's result is that member's descendant,
 * not a member (01 · "Sibling groups"), and dependencies stay acyclic (04):
 * work that waits for work in flight beneath P is placed on that work, or
 * on the group it belongs to, instead of beside it.
 */
function placeConsumer(unit: PlannedUnit, start: NodeId, ctx: StepContext): Placed {
  const state = ctx.state
  const awaited: NodeId[] = []
  for (const c of childrenInFlight(state, start)) {
    if (waitsForDirective(unit, c.id) && !awaited.includes(c.nodeId)) awaited.push(c.nodeId)
  }
  // A member of a group that started at P, finished or not, is consumed from its own node: the
  // consumer is its descendant and reads the result it waits for, never a sibling beside it (C11).
  for (const group of Object.values(state.groups)) {
    if (group.state === 'dissolved' || group.startNodeId !== start) continue
    for (const m of activeMembers(group)) {
      const nodeId = state.directives[m.directiveId]?.nodeId
      if (nodeId && waitsForDirective(unit, m.directiveId) && !awaited.includes(nodeId)) awaited.push(nodeId)
    }
  }
  const only = awaited[0]
  if (awaited.length === 1 && only) return placeOn(unit, only, ctx)
  if (awaited.length > 1) {
    const open = openGroupAt(state, start)
    if (open) return placeOnGroup(unit, open.id, ctx)
    return placeJoinChain(unit, awaited.map((nodeId) => ({ kind: 'node', nodeId })), ctx)
  }
  return placeOn(unit, start, ctx)
}

type Settled = { readonly kind: 'node'; readonly nodeId: NodeId } | { readonly kind: 'join'; readonly parents: readonly PointRef[] } | { readonly kind: 'none' }

/** A node's starting context: its nearest ancestor that is not in flight. */
export function nearestSettledAncestor(state: ConversationState, nodeId: NodeId): Settled {
  let current: NodeId | null = nodeId
  const seen = new Set<NodeId>()
  while (current !== null && !seen.has(current)) {
    seen.add(current)
    if (!nodeInFlight(state, current)) return { kind: 'node', nodeId: current }
    const node: ConversationState['nodes'][string] | undefined = state.nodes[current]
    if (!node) return { kind: 'none' }
    const planned: readonly PointRef[] = node.plannedParents
    if (planned.length === 0) return { kind: 'none' }
    if (planned.length >= 2) return { kind: 'join', parents: planned }
    const parent: PointRef | undefined = planned[0]
    if (!parent) return { kind: 'none' }
    if (parent.kind === 'sibling-group') {
      const group: ConversationState['groups'][string] | undefined = state.groups[parent.groupId]
      current = group ? (group.state === 'open' ? group.startNodeId : resolvePoint(state, parent)) : null
    } else {
      current = resolvePoint(state, parent)
    }
  }
  return { kind: 'none' }
}

function placeNewChain(unit: PlannedUnit, ctx: StepContext): Placed {
  const chainId = newChain(ctx, 'root', null, unit)
  return { nodeId: newNode(ctx, unit, chainId, []), chainId, after: [], prerequisites: unit.prerequisites }
}

/** The open or closed, not dissolved, group whose member's exchange is this node. */
function memberGroupOf(state: ConversationState, nodeId: NodeId): GroupRow | null {
  for (const group of Object.values(state.groups)) {
    if (group.state === 'dissolved') continue
    if (activeMembers(group).some((m) => m.nodeId === nodeId)) return group
  }
  return null
}

/**
 * A join chain (Q5, Q86, Q88), after the repairs that have one correct reading:
 * - a parent that is not a leaf becomes its chain's leaf (Q97);
 * - two or more parents from one sibling group become that group's
 *   join-back, never a subset of it (Q30, invariant 4);
 * - a parent still in flight stays the parent (a non-leaf cannot be one,
 *   Q86, C20) and the join chain waits for it, so no run reads an
 *   unfinished answer (C3, Q29);
 * - a parent that is an ancestor of another parent is already read through
 *   it and is dropped (Q97).
 * Parents that collapse onto one line are a continuation, not a join (Q3).
 */
function placeJoinChain(unit: PlannedUnit, parents: readonly PointRef[], ctx: StepContext): Placed {
  const state = ctx.state
  let current = unit
  let points: PointRef[] = []
  const add = (list: PointRef[], ref: PointRef): void => {
    if (!list.some((r) => deepEqual(r, ref))) list.push(ref)
  }
  // Leaves. A parent named as a sibling, or whose leaf is one, stands for that member of its group.
  const memberOf = new Map<string, SiblingGroupId>()
  for (const parent of parents) {
    if (parent.kind === 'sibling-group') {
      const group = state.groups[parent.groupId]
      if (group?.state === 'open') add(points, parent)
      else {
        const id = resolvePoint(state, parent)
        if (id) add(points, { kind: 'node', nodeId: leafOf(state, id) })
      }
      continue
    }
    const id = resolvePoint(state, parent)
    if (!id) continue
    const leaf: PointRef = { kind: 'node', nodeId: leafOf(state, id) }
    const group = memberGroupOf(state, id) ?? memberGroupOf(state, leaf.nodeId)
    if (group) memberOf.set(JSON.stringify(leaf), group.id)
    add(points, leaf)
  }
  // No subset of a sibling group: two members reached, by member points or through a branch from
  // one sibling, are the whole group (Q30, C9).
  const groupOfPoint = (p: PointRef): SiblingGroupId | null =>
    p.kind === 'sibling-group' ? p.groupId : (memberOf.get(JSON.stringify(p)) ?? null)
  const reachedTwice = new Set(groupsReachedTwice(state, points))
  for (const g of reachedTwice) {
    if (state.groups[g]?.state === 'open') current = withPrerequisite(current, { kind: 'sibling-group', groupId: g })
  }
  const merged: PointRef[] = []
  for (const p of points) {
    const g = groupOfPoint(p)
    if (g && reachedTwice.has(g)) {
      add(merged, { kind: 'sibling-group', groupId: g })
      if (state.groups[g]?.state === 'open') current = withPrerequisite(current, { kind: 'sibling-group', groupId: g })
    } else add(merged, p)
  }
  // Its parents are leaves (Q86, C20), and nothing in flight is read without waiting for it (C3,
  // Q29): a leaf whose work is still in flight stays the parent, and the join chain waits for it.
  points = []
  for (const p of merged) {
    if (p.kind === 'node') {
      const node = state.nodes[p.nodeId]
      if (node?.directiveId && nodeInFlight(state, p.nodeId)) {
        current = withPrerequisite(current, { kind: 'directive', directiveId: node.directiveId })
      }
    }
    if (p.kind === 'sibling-group' && state.groups[p.groupId]?.state === 'open') {
      current = withPrerequisite(current, { kind: 'sibling-group', groupId: p.groupId })
    }
    add(points, p)
  }
  // A parent already in another parent's ancestry is read through it.
  const nodeOf = (p: PointRef): NodeId | null => (p.kind === 'node' ? p.nodeId : p.kind === 'sibling-group' ? startOfGroup(state, p.groupId) : null)
  points = points.filter((p) => {
    const id = p.kind === 'node' ? p.nodeId : null
    if (id === null) return true
    return !points.some((q) => q !== p && (() => {
      const other = q.kind === 'node' ? q.nodeId : null
      if (other !== null) return descendsFrom(state, other, id)
      const start = nodeOf(q)
      return start !== null && (start === id || descendsFrom(state, start, id))
    })())
  })
  if (points.length < 2) {
    const only = points[0]
    if (only?.kind === 'sibling-group') return placeOnGroup(current, only.groupId, ctx)
    if (only?.kind === 'node') return placeConsumer(current, only.nodeId, ctx)
    return placeNewChain(current, ctx)
  }
  const chainId = newChain(ctx, 'join', null, current)
  return { nodeId: newNode(ctx, current, chainId, points), chainId, after: [], prerequisites: current.prerequisites }
}

/**
 * The groups of which the points reach two or more members: a member node
 * reaches its own group, any node the members in its ancestry, a join-back
 * every member of its record, a group point all its members.
 */
function groupsReachedTwice(state: ConversationState, points: readonly PointRef[]): SiblingGroupId[] {
  const reached = new Map<SiblingGroupId, Set<DirectiveId>>()
  const note = (g: SiblingGroupId, d: DirectiveId): void => {
    const set = reached.get(g) ?? new Set<DirectiveId>()
    set.add(d)
    reached.set(g, set)
  }
  for (const p of points) {
    if (p.kind === 'sibling-group') {
      const group = state.groups[p.groupId]
      if (group) for (const m of activeMembers(group)) note(group.id, m.directiveId)
      continue
    }
    if (p.kind !== 'node') continue
    const seen = new Set<NodeId>()
    const stack: NodeId[] = [p.nodeId]
    while (stack.length > 0) {
      const id = stack.pop()
      if (id === undefined || seen.has(id)) continue
      seen.add(id)
      const node = state.nodes[id]
      if (!node) continue
      if (node.kind === 'join-back' && node.joinGroupId) {
        const group = state.groups[node.joinGroupId]
        if (group) {
          for (const m of activeMembers(group)) note(group.id, m.directiveId)
          stack.push(group.startNodeId)
        }
        continue
      }
      const group = memberGroupOf(state, id)
      if (group && node.directiveId) note(group.id, node.directiveId)
      for (const parent of nodeParents(state, node)) stack.push(parent)
    }
  }
  return [...reached].filter(([, set]) => set.size >= 2).map(([g]) => g)
}

function startOfGroup(state: ConversationState, groupId: SiblingGroupId): NodeId | null {
  return state.groups[groupId]?.startNodeId ?? null
}

function leafOf(state: ConversationState, nodeId: NodeId): NodeId {
  const node = state.nodes[nodeId]
  if (!node) return nodeId
  return chainTip(state, node.chainId) ?? nodeId
}

/** The ordered cases 1–3 on a settled point P. */
function placeOn(unit: PlannedUnit, start: NodeId, ctx: StepContext): Placed {
  const state = ctx.state
  const node = state.nodes[start]
  if (!node) return placeNewChain(unit, ctx)

  // Case 1: P has a child in flight. A fork.
  const children = childrenInFlight(state, start)
  if (children.length > 0) return placeFork(unit, start, children.map((c) => c.id), ctx)
  const prerequisites = unit.prerequisites

  // Case 2: P is a member of a sibling group, or not its chain's last node. A branch.
  const isMember = node.groupId !== null
  if (isMember || chainTip(state, node.chainId) !== start) {
    const chainId = newChain(ctx, 'branch', node.chainId, unit)
    return { nodeId: newNode(ctx, unit, chainId, [{ kind: 'node', nodeId: start }]), chainId, after: [], prerequisites }
  }

  // Case 3: the same chain continues.
  return { nodeId: newNode(ctx, unit, node.chainId, [{ kind: 'node', nodeId: start }]), chainId: node.chainId, after: [], prerequisites }
}

function placeFork(unit: PlannedUnit, start: NodeId, childIds: readonly DirectiveId[], ctx: StepContext): Placed {
  const open = openGroupAt(ctx.state, start)
  if (open) {
    const chainId = newChain(ctx, 'fork', open.baseChainId, unit)
    const nodeId = newNode(ctx, unit, chainId, [{ kind: 'node', nodeId: start }])
    return {
      nodeId,
      chainId,
      after: [{ type: 'sibling-admitted', groupId: open.id, member: { directiveId: unit.directiveId, nodeId, chainId } }],
      prerequisites: unit.prerequisites,
    }
  }
  const startNode = ctx.state.nodes[start]
  if (!startNode) return placeNewChain(unit, ctx)
  // The join-back extends the line the siblings forked from (Q78, Q90). When P's chain has already
  // moved on past P (later work continued it), the join-back cannot sit on that chain: work
  // continuing the chain from its head would read the siblings' record in place of the later
  // exchanges (01 · "Following a node's parents back to the root gives exactly the context").
  // The group's base is then a new branch chain from P, in its own color, as for any later branch.
  const ownChainId = startNode.chainId
  const continuing = childIds.filter((id) => ctx.state.directives[id]?.chainId === ownChainId)
  const baseChainId = chainMovedOn(ctx.state, start, continuing)
    ? newChain(ctx, 'branch', ownChainId, namedAfter(ctx.state.directives[startNode.directiveId ?? '']) ?? unit)
    : ownChainId
  const members: SiblingMember[] = []
  const rechained: NodeRechaining[] = []
  for (const childId of childIds) {
    const child = ctx.state.directives[childId]
    if (!child) continue
    if (child.chainId === ownChainId) {
      // It was continuing P's chain: it moves to a fork chain of its own, with what is queued behind it.
      const forkChainId = newChain(ctx, 'fork', baseChainId, namedAfter(child) ?? unit)
      const chain = ctx.state.chains[ownChainId]
      const index = chain ? chain.nodeIds.indexOf(child.nodeId) : -1
      const behind = chain && index >= 0 ? chain.nodeIds.slice(index + 1) : []
      rechained.push({ nodeId: child.nodeId, fromChainId: ownChainId, toChainId: forkChainId })
      for (const id of behind) {
        if (descendsFrom(ctx.state, id, child.nodeId)) rechained.push({ nodeId: id, fromChainId: ownChainId, toChainId: forkChainId })
      }
      members.push({ directiveId: child.id, nodeId: child.nodeId, chainId: forkChainId })
    } else {
      members.push({ directiveId: child.id, nodeId: child.nodeId, chainId: child.chainId })
    }
  }
  const chainId = newChain(ctx, 'fork', baseChainId, unit)
  const nodeId = newNode(ctx, unit, chainId, [{ kind: 'node', nodeId: start }])
  members.push({ directiveId: unit.directiveId, nodeId, chainId })
  return {
    nodeId,
    chainId,
    after: [
      {
        type: 'sibling-group-opened',
        groupId: ctx.ids.next('siblingGroup'),
        startNodeId: start,
        baseChainId,
        members,
        rechained,
        joinBackOperationId: ctx.ids.next('operation'),
      },
    ],
    prerequisites: unit.prerequisites,
  }
}

/**
 * True when P's chain holds a node after P that is not one of the children
 * being forked or queued behind them: the chain has moved on past P.
 */
function chainMovedOn(state: ConversationState, start: NodeId, continuing: readonly DirectiveId[]): boolean {
  const node = state.nodes[start]
  const chain = node ? state.chains[node.chainId] : undefined
  if (!chain) return false
  const index = chain.nodeIds.indexOf(start)
  if (index < 0) return false
  const childNodes = continuing.flatMap((id) => {
    const d = state.directives[id]
    return d ? [d.nodeId] : []
  })
  return chain.nodeIds
    .slice(index + 1)
    .some((id) => countsAlongChain(state, id) && !childNodes.some((c) => c === id || descendsFrom(state, id, c)))
}

/** The point a sibling group's dependents resolve to when they start: its current join-back node. */
export function joinBackNodeOf(state: ConversationState, groupId: Parameters<typeof currentJoinBack>[1]): NodeId | null {
  return currentJoinBack(state, groupId)?.nodeId ?? null
}

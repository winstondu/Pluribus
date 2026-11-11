import {
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
  type SiblingMember,
  type SplitMessageRecord,
} from '@committee/protocol'
import type { PlannedUnit, RoutingPlan } from '../ports'
import type { PlanApplier, PlanTarget, StepContext } from './module'
import {
  chainTip,
  childrenInFlight,
  descendsFrom,
  groupOfDirective,
  nodeInFlight,
  openGroupAt,
  resolvePoint,
  currentJoinBack,
} from './queries'
import type { ConversationState } from './state'

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
export function checkPlan(state: ConversationState, plan: RoutingPlan): PlanCheck {
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

  for (const unit of plan.units) {
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
      prerequisites: unit.prerequisites,
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
}

function newChain(ctx: StepContext, kind: ChainKind, baseChainId: ChainId | null, label: string): ChainId {
  const chainId = ctx.ids.next('chain')
  ctx.emit({ type: 'chain-created', chainId, kind, colorIndex: ctx.state.chainOrder.length, baseChainId, label })
  return chainId
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

/** One of the three placements (Q76), with the repairs and the ordered cases of PLAN §2. */
export function placeUnit(unit: PlannedUnit, ctx: StepContext): Placed {
  const placement = unit.placement
  if (placement.kind === 'new-chain') return placeNewChain(unit, ctx)
  if (placement.kind === 'join-chain') return placeJoinChain(unit, placement.parents, ctx)

  const point = placement.buildsOn
  let start: NodeId | null
  if (point.kind === 'sibling-group') {
    const group = ctx.state.groups[point.groupId]
    if (group && group.state === 'open') {
      // The join-back does not exist yet: the work continues the base chain from it (Q78).
      return { nodeId: newNode(ctx, unit, group.baseChainId, [point]), chainId: group.baseChainId, after: [] }
    }
    start = resolvePoint(ctx.state, point)
  } else {
    start = resolvePoint(ctx.state, point)
  }
  if (start === null) return placeNewChain(unit, ctx)

  // Repair 0: a node still in flight can be built on only by work that waits for it.
  const startNode = ctx.state.nodes[start]
  if (startNode && nodeInFlight(ctx.state, start)) {
    const waitsForIt = unit.prerequisites.some((p) => p.kind === 'directive' && p.directiveId === startNode.directiveId)
    if (!waitsForIt) {
      const settled = nearestSettledAncestor(ctx.state, start)
      if (settled.kind === 'none') return placeNewChain(unit, ctx)
      if (settled.kind === 'join') return placeJoinChain(unit, settled.parents, ctx)
      start = settled.nodeId
    }
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
  const chainId = newChain(ctx, 'root', null, unit.label)
  return { nodeId: newNode(ctx, unit, chainId, []), chainId, after: [] }
}

/** A join chain: parents are leaves of their chains when it is created (Q86); a non-leaf becomes its chain's leaf (Q97). */
function placeJoinChain(unit: PlannedUnit, parents: readonly PointRef[], ctx: StepContext): Placed {
  const resolved: PointRef[] = []
  const add = (ref: PointRef): void => {
    if (!resolved.some((r) => JSON.stringify(r) === JSON.stringify(ref))) resolved.push(ref)
  }
  for (const parent of parents) {
    if (parent.kind === 'sibling-group') {
      const group = ctx.state.groups[parent.groupId]
      if (group?.state === 'open') add(parent)
      else {
        const id = resolvePoint(ctx.state, parent)
        if (id) add({ kind: 'node', nodeId: leafOf(ctx.state, id) })
      }
      continue
    }
    const id = resolvePoint(ctx.state, parent)
    if (id) add({ kind: 'node', nodeId: leafOf(ctx.state, id) })
  }
  if (resolved.length < 2) {
    // The parents collapsed onto one line: that is a continuation, not a join (Q3).
    const only = resolved[0]
    if (only?.kind === 'node') return placeOn(unit, only.nodeId, ctx)
    return placeNewChain(unit, ctx)
  }
  const chainId = newChain(ctx, 'join', null, unit.label)
  return { nodeId: newNode(ctx, unit, chainId, resolved), chainId, after: [] }
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

  // Case 2: P is a member of a sibling group, or not its chain's last node. A branch.
  const isMember = node.groupId !== null
  if (isMember || chainTip(state, node.chainId) !== start) {
    const chainId = newChain(ctx, 'branch', node.chainId, unit.label)
    return { nodeId: newNode(ctx, unit, chainId, [{ kind: 'node', nodeId: start }]), chainId, after: [] }
  }

  // Case 3: the same chain continues.
  return { nodeId: newNode(ctx, unit, node.chainId, [{ kind: 'node', nodeId: start }]), chainId: node.chainId, after: [] }
}

function placeFork(unit: PlannedUnit, start: NodeId, childIds: readonly DirectiveId[], ctx: StepContext): Placed {
  const open = openGroupAt(ctx.state, start)
  if (open) {
    const chainId = newChain(ctx, 'fork', open.baseChainId, unit.label)
    const nodeId = newNode(ctx, unit, chainId, [{ kind: 'node', nodeId: start }])
    return {
      nodeId,
      chainId,
      after: [{ type: 'sibling-admitted', groupId: open.id, member: { directiveId: unit.directiveId, nodeId, chainId } }],
    }
  }
  const startNode = ctx.state.nodes[start]
  if (!startNode) return placeNewChain(unit, ctx)
  const baseChainId = startNode.chainId
  const members: SiblingMember[] = []
  const rechained: NodeRechaining[] = []
  for (const childId of childIds) {
    const child = ctx.state.directives[childId]
    if (!child) continue
    if (child.chainId === baseChainId) {
      // It was continuing P's chain: it moves to a fork chain of its own, with what is queued behind it.
      const forkChainId = newChain(ctx, 'fork', baseChainId, child.label)
      const chain = ctx.state.chains[baseChainId]
      const index = chain ? chain.nodeIds.indexOf(child.nodeId) : -1
      const behind = chain && index >= 0 ? chain.nodeIds.slice(index + 1) : []
      rechained.push({ nodeId: child.nodeId, fromChainId: baseChainId, toChainId: forkChainId })
      for (const id of behind) {
        if (descendsFrom(ctx.state, id, child.nodeId)) rechained.push({ nodeId: id, fromChainId: baseChainId, toChainId: forkChainId })
      }
      members.push({ directiveId: child.id, nodeId: child.nodeId, chainId: forkChainId })
    } else {
      members.push({ directiveId: child.id, nodeId: child.nodeId, chainId: child.chainId })
    }
  }
  const chainId = newChain(ctx, 'fork', baseChainId, unit.label)
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
  }
}

/** The point a sibling group's dependents resolve to when they start: its current join-back node. */
export function joinBackNodeOf(state: ConversationState, groupId: Parameters<typeof currentJoinBack>[1]): NodeId | null {
  return currentJoinBack(state, groupId)?.nodeId ?? null
}

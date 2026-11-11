import {
  IN_FLIGHT_STATES,
  NOT_STARTED_STATES,
  joinLabels,
  type AttemptId,
  type ChainId,
  type DirectiveId,
  type DirectiveState,
  type JoinBackId,
  type MessageId,
  type NodeId,
  type PointRef,
  type PrerequisiteRef,
  type ResponseId,
  type SectionId,
  type SectionState,
  type SiblingGroupId,
  type UnfinishedOutcome,
} from '@committee/protocol'
import type { ConversationState, DirectiveRow, GroupRow, JoinBackRow, NodeRow, SectionRow } from './state'

/**
 * Reading the state. Pure functions shared by the engine, the projections
 * and the later slices of core. Each answers one domain question exactly as
 * docs/build/PLAN.md section 2 states it.
 */

export function isInFlightState(state: DirectiveState): boolean {
  return IN_FLIGHT_STATES.includes(state)
}

export function isNotStartedState(state: DirectiveState): boolean {
  return NOT_STARTED_STATES.includes(state)
}

/** States in which a directive's work has ended without completing and is not retrying on its own. */
export function unfinishedOutcome(state: DirectiveState): UnfinishedOutcome | null {
  switch (state) {
    case 'failed':
    case 'stopped':
    case 'interrupted':
    case 'cancelled':
      return state
    default:
      return null
  }
}

/** Started work that has not settled: Stop applies to it (PLAN §2 "Stopping"). */
export function isStartedUnsettled(state: DirectiveState): boolean {
  return state === 'running' || state === 'retrying' || state === 'waiting-for-capacity'
}

export function directive(state: ConversationState, id: DirectiveId): DirectiveRow | undefined {
  return state.directives[id]
}

/** The directive's current result: the completed attempt of its current section, or null. */
export function currentResult(state: ConversationState, id: DirectiveId): AttemptId | null {
  const d = state.directives[id]
  if (!d || d.state !== 'completed') return null
  return d.resultAttemptId
}

// ───────────────────────────── genealogy ─────────────────────────────

/** True when the node is its directive's current node and that directive is in flight. */
export function nodeInFlight(state: ConversationState, nodeId: NodeId): boolean {
  const node = state.nodes[nodeId]
  if (!node || node.kind !== 'exchange' || node.directiveId === null) return false
  const d = state.directives[node.directiveId]
  if (!d || d.nodeId !== nodeId) return false
  return isInFlightState(d.state)
}

export function isLateRetryNode(state: ConversationState, nodeId: NodeId): boolean {
  return state.nodes[nodeId]?.reason === 'retry-after-closure'
}

export function currentJoinBack(state: ConversationState, groupId: SiblingGroupId): JoinBackRow | null {
  const group = state.groups[groupId]
  if (!group) return null
  const id = group.joinBackIds[group.joinBackIds.length - 1]
  return id ? (state.joinBacks[id] ?? null) : null
}

/**
 * Where a point stands now: a node ID, or null while it does not exist yet
 * (an open sibling group has no join-back). A dissolved group resolves to
 * its starting node, from which the base chain continues.
 */
export function resolvePoint(state: ConversationState, point: PointRef): NodeId | null {
  switch (point.kind) {
    case 'node':
      return currentJoinBackNode(state, point.nodeId)
    case 'directive':
      return state.directives[point.directiveId]?.nodeId ?? null
    case 'sibling-group': {
      const group = state.groups[point.groupId]
      if (!group) return null
      if (group.state === 'dissolved') return group.startNodeId
      if (group.state === 'open') return null
      return currentJoinBack(state, point.groupId)?.nodeId ?? null
    }
  }
}

/**
 * A node point as it stands now. A join-back node replaced by a later
 * formation of its group (a member was revised) resolves to the current
 * formation: work that has not started yet reads the group's current record,
 * so it descends from that record, never from the one holding the superseded
 * member (09 §1, C10). Any other node is itself.
 */
export function currentJoinBackNode(state: ConversationState, nodeId: NodeId): NodeId | null {
  let node = state.nodes[nodeId]
  if (!node) return null
  const seen = new Set<NodeId>()
  while (node.kind === 'join-back' && node.replacedByNodeId !== null && !seen.has(node.id)) {
    seen.add(node.id)
    const next: NodeRow | undefined = state.nodes[node.replacedByNodeId]
    if (!next) break
    node = next
  }
  return node.id
}

/** A node's parents: exact once an attempt ran on it, otherwise its placement resolved as far as it can be. */
export function nodeParents(state: ConversationState, node: NodeRow): readonly NodeId[] {
  if (node.startedParents) return node.startedParents
  const out: NodeId[] = []
  for (const point of node.plannedParents) {
    const id = resolvePoint(state, point)
    if (id !== null && !out.includes(id)) out.push(id)
  }
  return out
}

/**
 * A node's placement resolved as it stands now, ignoring earlier attempts:
 * what an attempt starting now descends from. A `sibling-group` point
 * resolves to the group's current join-back node and nothing else.
 */
export function resolvePlannedParents(state: ConversationState, node: NodeRow): NodeId[] {
  const out: NodeId[] = []
  for (const point of node.plannedParents) {
    const id = resolvePoint(state, point)
    if (id !== null && !out.includes(id)) out.push(id)
  }
  return out
}

/** Nodes that count for a chain's head and tip: no late-retry tail, nothing replaced. */
export function countsAlongChain(state: ConversationState, nodeId: NodeId): boolean {
  const node = state.nodes[nodeId]
  if (!node) return false
  if (node.replacedByNodeId !== null) return false
  if (node.reason === 'retry-after-closure') return false
  if (node.kind === 'exchange' && node.directiveId !== null) {
    const d = state.directives[node.directiveId]
    if (d && (d.state === 'superseded' || d.nodeId !== nodeId)) return false
  }
  return true
}

/** The chain's last node, in flight or not (CandidateChain.tipNodeId). */
export function chainTip(state: ConversationState, chainId: ChainId): NodeId | null {
  const chain = state.chains[chainId]
  if (!chain) return null
  for (let i = chain.nodeIds.length - 1; i >= 0; i--) {
    const id = chain.nodeIds[i]
    if (id !== undefined && countsAlongChain(state, id)) return id
  }
  return chain.nodeIds[chain.nodeIds.length - 1] ?? null
}

/** The chain's last node whose own work is not in flight (CandidateChain.headNodeId). */
export function chainHead(state: ConversationState, chainId: ChainId): NodeId | null {
  const chain = state.chains[chainId]
  if (!chain) return null
  for (let i = chain.nodeIds.length - 1; i >= 0; i--) {
    const id = chain.nodeIds[i]
    if (id === undefined || !countsAlongChain(state, id)) continue
    if (!nodeInFlight(state, id)) return id
  }
  return null
}

/** True while any work on the chain is in flight. */
export function chainBusy(state: ConversationState, chainId: ChainId): boolean {
  return state.directiveOrder.some((id) => {
    const d = state.directives[id]
    return d !== undefined && d.chainId === chainId && isInFlightState(d.state)
  })
}

/**
 * Directives in flight that are children of `nodeId` for the placement table:
 * their current node's planned parent names the node exactly, or they started
 * with it among their parents. Late retries and clarification questions are
 * nobody's child; queued work on an unresolved sibling-group point is not
 * either (PLAN §2).
 */
export function childrenInFlight(state: ConversationState, nodeId: NodeId): DirectiveRow[] {
  const out: DirectiveRow[] = []
  for (const id of state.directiveOrder) {
    const d = state.directives[id]
    if (!d || d.kind !== 'answer' || !isInFlightState(d.state)) continue
    const node = state.nodes[d.nodeId]
    if (!node || node.reason === 'retry-after-closure') continue
    // A join chain's node is not a continuation of any one source: its sources stay independently continuable (04).
    if (node.plannedParents.length !== 1) continue
    const named =
      node.plannedParents.some((p) => p.kind === 'node' && resolvePoint(state, p) === nodeId) ||
      (node.startedParents?.length === 1 && node.startedParents[0] === nodeId)
    if (named) out.push(d)
  }
  return out
}

/** The members that count: every member not withdrawn by Undo split. */
export function activeMembers(group: GroupRow): GroupRow['members'] {
  return group.members.filter((m) => !group.withdrawn.includes(m.directiveId))
}

/** The open group whose starting node is `nodeId`, if any. */
export function openGroupAt(state: ConversationState, nodeId: NodeId): GroupRow | null {
  for (const group of Object.values(state.groups)) {
    if (group.state === 'open' && group.startNodeId === nodeId) return group
  }
  return null
}

/** The group a directive is a member of (not withdrawn). */
export function groupOfDirective(state: ConversationState, id: DirectiveId): GroupRow | null {
  for (const group of Object.values(state.groups)) {
    if (group.members.some((m) => m.directiveId === id) && !group.withdrawn.includes(id)) return group
  }
  return null
}

/** True when every counting member has settled: the closing rule (Q49, Q92). */
export function groupCanClose(state: ConversationState, group: GroupRow): boolean {
  if (group.state !== 'open') return false
  const members = activeMembers(group)
  if (members.length === 0) return false
  return members.every((m) => {
    const d = state.directives[m.directiveId]
    return d !== undefined && !isInFlightState(d.state)
  })
}

/** Descendant test along planned and started parents. */
export function descendsFrom(state: ConversationState, nodeId: NodeId, ancestorId: NodeId): boolean {
  const seen = new Set<NodeId>()
  const stack: NodeId[] = [nodeId]
  while (stack.length > 0) {
    const id = stack.pop()
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    const node = state.nodes[id]
    if (!node) continue
    for (const parent of nodeParents(state, node)) {
      if (parent === ancestorId) return true
      stack.push(parent)
    }
  }
  return false
}

// ───────────────────────────── dependencies ─────────────────────────────

/**
 * Whether one prerequisite is satisfied (invariant 4). A directive is
 * satisfied by its current result only; a sibling group once it has closed,
 * its join-back has formed and every member completed or was waived. A
 * dissolved group has nothing left to wait for.
 */
export function prerequisiteSatisfied(state: ConversationState, dependent: DirectiveRow, ref: PrerequisiteRef): boolean {
  if (ref.kind === 'directive') {
    if (dependent.waived.includes(ref.directiveId)) return true
    return currentResult(state, ref.directiveId) !== null
  }
  const group = state.groups[ref.groupId]
  if (!group) return false
  if (group.state === 'dissolved') return true
  if (group.state !== 'closed' || currentJoinBack(state, group.id) === null) return false
  return activeMembers(group).every(
    (m) => dependent.waived.includes(m.directiveId) || currentResult(state, m.directiveId) !== null,
  )
}

export function unsatisfiedPrerequisites(state: ConversationState, dependent: DirectiveRow): PrerequisiteRef[] {
  return dependent.prerequisites.filter((ref) => !prerequisiteSatisfied(state, dependent, ref))
}

/** The directives still unfinished behind a prerequisite. */
export function unfinishedBehind(state: ConversationState, dependent: DirectiveRow, ref: PrerequisiteRef): DirectiveId[] {
  if (ref.kind === 'directive') {
    return prerequisiteSatisfied(state, dependent, ref) ? [] : [ref.directiveId]
  }
  const group = state.groups[ref.groupId]
  if (!group) return []
  return activeMembers(group)
    .map((m) => m.directiveId)
    .filter((id) => !dependent.waived.includes(id) && currentResult(state, id) === null)
}

/** "neighborhoods", or "neighborhoods + activities" for a whole group (03 · "Composer queue"). */
export function prerequisiteLabel(state: ConversationState, ref: PrerequisiteRef): string {
  if (ref.kind === 'directive') return state.directives[ref.directiveId]?.label ?? 'earlier work'
  const group = state.groups[ref.groupId]
  if (!group) return 'earlier work'
  return groupLabel(state, group)
}

export function groupLabel(state: ConversationState, group: GroupRow): string {
  return joinLabels(activeMembers(group).map((m) => state.directives[m.directiveId]?.label ?? 'work'))
}

/** The directives a prerequisite names, for walking the dependency DAG. */
export function prerequisiteDirectives(state: ConversationState, ref: PrerequisiteRef): DirectiveId[] {
  if (ref.kind === 'directive') return [ref.directiveId]
  const group = state.groups[ref.groupId]
  return group ? activeMembers(group).map((m) => m.directiveId) : []
}

// ───────────────────────────── transcript ─────────────────────────────

/** A superseded section that had shown nothing is dropped without a trace (Q38). */
export function sectionDropped(section: SectionRow): boolean {
  return section.supersession !== null && !section.supersession.hadVisibleOutput
}

/** The latest attempt of a section. */
export function latestAttemptOf(section: SectionRow): AttemptId | null {
  return section.attemptIds[section.attemptIds.length - 1] ?? null
}

/** The state a section shows (10 · "States a section can show"). */
export function sectionState(state: ConversationState, sectionId: SectionId): SectionState {
  const section = state.sections[sectionId]
  if (!section) return 'pending'
  if (section.supersession) return 'superseded'
  const d = state.directives[section.directiveId]
  if (!d) return 'pending'
  if (d.sectionId !== sectionId) return 'superseded'
  switch (d.state) {
    case 'completed':
      return 'completed'
    case 'failed':
    case 'stopped':
    case 'interrupted':
    case 'cancelled':
    case 'superseded':
      return d.state
    case 'running': {
      const latest = latestAttemptOf(section)
      const attempt = latest ? state.attempts[latest] : undefined
      return attempt && attempt.state === 'streaming' ? 'streaming' : 'pending'
    }
    default:
      return 'pending'
  }
}

/** Whether a response is shown: a provisional bubble while routing, or an opened response with a section left. */
export function responseVisible(state: ConversationState, responseId: ResponseId): boolean {
  const response = state.responses[responseId]
  if (!response) return false
  const message = state.messages[response.messageId]
  if (!message || !messageVisible(state, message.id)) return false
  if (!response.opened) return message.routing !== 'routed'
  return response.sectionIds.some((id) => {
    const section = state.sections[id]
    return section !== undefined && !sectionDropped(section)
  })
}

/** A user bubble is shown unless it is an original currently shown as split messages, or a withdrawn split message. */
export function messageVisible(state: ConversationState, messageId: MessageId): boolean {
  const message = state.messages[messageId]
  if (!message) return false
  if (message.kind === 'split') {
    if (message.withdrawn) return false
    return state.messages[message.originalMessageId]?.splitActive ?? false
  }
  return !message.splitActive
}

/** The join-back IDs a directive's member node appears in, for context reading. */
export function joinBacksOfGroup(state: ConversationState, groupId: SiblingGroupId): JoinBackId[] {
  return [...(state.groups[groupId]?.joinBackIds ?? [])]
}

/** The barrier of a message's decomposition and the directives it covers, if any. */
export function barrierOf(
  state: ConversationState,
  originalMessageId: MessageId,
): { readonly directiveIds: DirectiveId[]; readonly decomposition: NonNullable<ConversationState['decompositions'][string]> } | null {
  const decomposition = state.decompositions[originalMessageId]
  if (!decomposition || decomposition.barrier === null || decomposition.undone) return null
  const directiveIds = decomposition.fragments
    .filter((f) => f.kind === 'work')
    .map((f) => f.directiveId)
    .filter((id) => {
      const d = state.directives[id]
      return d !== undefined && d.kind === 'answer'
    })
  return { directiveIds, decomposition }
}

/**
 * What a message is routed again with, from its record: the sections the
 * user chose in its latest answered target-ambiguity elicitation, and
 * `atomic` after Undo split (Q53, Q85). Used when a lost routing is redone
 * on start and when Retry routes a failed one again.
 */
export function routeOptionsFor(
  state: ConversationState,
  messageId: MessageId,
): { readonly chosenTargets?: readonly SectionId[]; readonly forcedComposition?: 'atomic' } {
  let chosenTargets: readonly SectionId[] | undefined
  for (const id of state.elicitationOrder) {
    const row = state.elicitations[id]
    if (row?.record.kind !== 'target-ambiguity' || row.record.messageId !== messageId) continue
    if (row.status === 'answered' && row.resolution?.kind === 'target-ambiguity') chosenTargets = row.resolution.sectionIds
  }
  const undone = state.decompositions[messageId]?.undone === true
  return { ...(chosenTargets ? { chosenTargets } : {}), ...(undone ? { forcedComposition: 'atomic' as const } : {}) }
}

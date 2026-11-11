import {
  WORDING,
  pausedText,
  waitingText,
  type AttemptId,
  type ChainId,
  type DirectiveId,
  type OperationGraphProjection,
  type OperationId,
  type OperationStatus,
  type OperationView,
  type PrerequisiteRef,
} from '@committee/protocol'
import { activeMembers, groupLabel, prerequisiteLabel, prerequisiteSatisfied, sectionState, unfinishedBehind } from '../queries'
import type { ConversationState, DirectiveRow } from '../state'
import type { Memo } from './tracking'

/**
 * Result dependencies and live work (09 §4). Edges are the true
 * prerequisites; a whole-request barrier hold is a separate list of edges,
 * never merged with them (invariant 1).
 */
export function operationGraphProjection(s: ConversationState, m: Memo): OperationGraphProjection {
  const operations: { [id: string]: OperationView } = {}
  for (const id of s.operationOrder) {
    operations[id] = m.get('operation', id, (st) => operationView(st, id))
  }
  const active: OperationId[] = []
  const retired: OperationId[] = []
  for (const id of s.operationOrder) {
    const op = operations[id]
    if (!op) continue
    if (op.retired) retired.push(id)
    else active.push(id)
  }
  // Depth among active operations: 0 for one that waits on no active operation.
  const depth = new Map<OperationId, number>()
  const activeSet = new Set(active)
  const depthOf = (id: OperationId, seen: Set<OperationId>): number => {
    const known = depth.get(id)
    if (known !== undefined) return known
    if (seen.has(id)) return 0
    seen.add(id)
    const op = operations[id]
    let d = 0
    for (const dep of op?.dependsOn ?? []) if (activeSet.has(dep)) d = Math.max(d, depthOf(dep, seen) + 1)
    depth.set(id, d)
    return d
  }
  const withDepth: { [id: string]: OperationView } = {}
  for (const id of s.operationOrder) {
    const op = operations[id]
    if (!op) continue
    const d = activeSet.has(id) ? depthOf(id, new Set()) : 0
    withDepth[id] = op.depth === d ? op : { ...op, depth: d }
  }
  return { operations: withDepth, active, retired }
}

/** The chain of a section's latest run: its node's chain, which follows a member that became a fork (Q89). */
function latestChain(s: ConversationState, attemptId: AttemptId | null): ChainId | null {
  const attempt = attemptId ? s.attempts[attemptId] : undefined
  if (!attempt) return null
  return s.nodes[attempt.nodeId]?.chainId ?? attempt.chainId
}

function directiveOperation(s: ConversationState, directiveId: DirectiveId): OperationId | null {
  const d = s.directives[directiveId]
  const section = d?.sectionId ? s.sections[d.sectionId] : undefined
  return section?.operationId ?? null
}

/**
 * The operations a prerequisite points at. An open group is its join-back
 * operation. A closed group the dependent still waits for is the operations
 * of its unfinished members — a failed member, or its late retry running in
 * the member's section — because the join-back has formed and is retired:
 * the edge goes to the work actually waited for (09 §4).
 */
function prerequisiteOperations(s: ConversationState, dependent: DirectiveRow, ref: PrerequisiteRef): OperationId[] {
  if (ref.kind === 'directive') {
    const op = directiveOperation(s, ref.directiveId)
    return op ? [op] : []
  }
  const group = s.groups[ref.groupId]
  if (!group) return []
  if (group.state === 'closed' && !prerequisiteSatisfied(s, dependent, ref)) {
    const ops = unfinishedBehind(s, dependent, ref).flatMap((id) => {
      const op = directiveOperation(s, id)
      return op ? [op] : []
    })
    if (ops.length > 0) return ops
  }
  return [group.joinBackOperationId]
}

/**
 * True while current work waits on this directive's result, paused or
 * queued: its operation stays on the graph so the edge to it is drawn.
 */
function awaitedByDependent(s: ConversationState, directiveId: DirectiveId): boolean {
  for (const id of s.directiveOrder) {
    const other = s.directives[id]
    if (!other || (other.state !== 'paused' && other.state !== 'dependency-queued')) continue
    for (const ref of other.prerequisites) {
      if (unfinishedBehind(s, other, ref).includes(directiveId)) return true
    }
  }
  return false
}

function sectionStatus(s: ConversationState, d: DirectiveRow, sectionId: string, current: boolean): { status: OperationStatus; text: string } {
  if (!current) return { status: 'superseded', text: WORDING.supersededFinished }
  const shown = sectionState(s, sectionId as never)
  switch (d.state) {
    case 'dependency-queued':
      return { status: 'waiting-for-results', text: waitingText(d.waitingFor.map((r) => prerequisiteLabel(s, r)), d.revised) }
    case 'paused':
      return { status: 'paused', text: d.pause ? pausedText(d.pause.cause) : 'Paused' }
    case 'awaiting-elicitation':
      return { status: 'awaiting-answer', text: WORDING.awaitingAnswer }
    case 'ready':
      return d.slotHeld ? { status: 'waiting-for-slot', text: WORDING.waitingForSlot } : { status: 'running', text: WORDING.responding }
    case 'waiting-for-capacity':
      return { status: 'waiting-for-capacity', text: WORDING.waitingForCapacity }
    case 'retrying':
      return { status: 'retrying', text: WORDING.retrying }
    case 'running':
      return shown === 'streaming' ? { status: 'streaming', text: 'Streaming' } : { status: 'running', text: WORDING.responding }
    case 'completed':
      return { status: 'completed', text: 'Completed' }
    case 'failed':
      return { status: 'failed', text: WORDING.failed }
    case 'stopped':
      return { status: 'stopped', text: WORDING.stopped }
    case 'interrupted':
      return { status: 'interrupted', text: WORDING.interrupted }
    case 'cancelled':
      return { status: 'cancelled', text: WORDING.cancelled }
    case 'superseded':
      return { status: 'superseded', text: WORDING.supersededFinished }
  }
}

function operationView(s: ConversationState, id: OperationId): OperationView {
  const row = s.operations[id]
  if (!row) throw new Error(`No operation ${id}`)
  if (row.kind === 'join-back' && row.groupId) {
    const group = s.groups[row.groupId]
    const members = group ? activeMembers(group) : []
    const dependsOn: OperationId[] = []
    const waitingFor: OperationId[] = []
    for (const member of members) {
      const d = s.directives[member.directiveId]
      const section = d?.sectionId ? s.sections[d.sectionId] : undefined
      if (!section) continue
      dependsOn.push(section.operationId)
      if (d && d.state !== 'completed') waitingFor.push(section.operationId)
    }
    const formed = group?.state === 'closed'
    const dissolved = group?.state === 'dissolved'
    const joinBackId = group ? (group.joinBackIds[group.joinBackIds.length - 1] ?? null) : null
    return {
      id,
      kind: 'join-back',
      label: group ? groupLabel(s, group) : '',
      chainId: group?.baseChainId ?? ('' as never),
      status: dissolved ? 'cancelled' : formed ? 'formed' : 'group-open',
      statusText: dissolved ? WORDING.cancelled : formed ? 'Joined back' : 'Group open',
      dependsOn,
      waitingFor: formed || dissolved ? [] : waitingFor,
      heldByBarrier: false,
      barrierWaitingFor: [],
      depth: 0,
      directiveId: null,
      sectionId: null,
      messageId: null,
      attemptId: null,
      attemptCount: 0,
      groupId: row.groupId,
      joinBackId,
      retired: formed || dissolved,
    }
  }
  const section = row.sectionId ? s.sections[row.sectionId] : undefined
  const d = section ? s.directives[section.directiveId] : undefined
  if (!section || !d) throw new Error(`Operation ${id} has no section`)
  const current = d.sectionId === section.id && section.supersession === null
  const { status, text } = sectionStatus(s, d, section.id, current)
  const dependsOn: OperationId[] = []
  const waitingFor: OperationId[] = []
  for (const ref of d.prerequisites) {
    const waiting = !prerequisiteSatisfied(s, d, ref) && current && ['dependency-queued', 'paused'].includes(d.state)
    for (const op of prerequisiteOperations(s, d, ref)) {
      if (!dependsOn.includes(op)) dependsOn.push(op)
      if (waiting && !waitingFor.includes(op)) waitingFor.push(op)
    }
  }
  const barrierWaitingFor: OperationId[] = []
  if (current && d.heldByBarrier) {
    for (const ref of d.waitingFor) {
      for (const op of prerequisiteOperations(s, d, ref)) if (!barrierWaitingFor.includes(op)) barrierWaitingFor.push(op)
    }
  }
  const chain = s.chains[d.chainId]
  const latest = section.attemptIds[section.attemptIds.length - 1] ?? null
  // Cancelled work leaves the graph like completed work, unless a dependent is paused or queued on
  // it: then the prerequisite of that recovery choice stays drawn, as a failed one does (09 §4).
  const retired = !current || d.state === 'completed' || d.state === 'superseded' || (d.state === 'cancelled' && !awaitedByDependent(s, d.id))
  return {
    id,
    kind: chain?.kind === 'join' ? 'synthesis' : 'answer',
    label: d.label,
    chainId: current ? d.chainId : latestChain(s, latest) ?? section.openedOnChainId,
    status,
    statusText: text,
    dependsOn,
    waitingFor: current && d.heldByBarrier ? [] : waitingFor,
    heldByBarrier: current && d.heldByBarrier,
    barrierWaitingFor,
    depth: 0,
    directiveId: d.id,
    sectionId: section.id,
    messageId: d.messageId,
    attemptId: latest,
    attemptCount: section.attemptIds.length,
    groupId: null,
    joinBackId: null,
    retired,
  }
}

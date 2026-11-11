import {
  WORDING,
  pausedText,
  waitingText,
  type OperationGraphProjection,
  type OperationId,
  type OperationStatus,
  type OperationView,
  type PrerequisiteRef,
} from '@committee/protocol'
import { activeMembers, groupLabel, prerequisiteLabel, prerequisiteSatisfied, sectionState } from '../queries'
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

function prerequisiteOperation(s: ConversationState, ref: PrerequisiteRef): OperationId | null {
  if (ref.kind === 'sibling-group') return s.groups[ref.groupId]?.joinBackOperationId ?? null
  const d = s.directives[ref.directiveId]
  const section = d?.sectionId ? s.sections[d.sectionId] : undefined
  return section?.operationId ?? null
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
      return { status: 'waiting-for-slot', text: WORDING.waitingForSlot }
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
    const op = prerequisiteOperation(s, ref)
    if (!op || dependsOn.includes(op)) continue
    dependsOn.push(op)
    if (!prerequisiteSatisfied(s, d, ref) && current && ['dependency-queued', 'paused'].includes(d.state)) waitingFor.push(op)
  }
  const barrierWaitingFor: OperationId[] = []
  if (current && d.heldByBarrier) {
    for (const ref of d.waitingFor) {
      const op = prerequisiteOperation(s, ref)
      if (op && !barrierWaitingFor.includes(op)) barrierWaitingFor.push(op)
    }
  }
  const chain = s.chains[d.chainId]
  const latest = section.attemptIds[section.attemptIds.length - 1] ?? null
  const retired = !current || d.state === 'completed' || d.state === 'cancelled' || d.state === 'superseded'
  return {
    id,
    kind: chain?.kind === 'join' ? 'synthesis' : 'answer',
    label: d.label,
    chainId: current ? d.chainId : (latest ? (s.attempts[latest]?.chainId ?? d.chainId) : section.openedOnChainId),
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

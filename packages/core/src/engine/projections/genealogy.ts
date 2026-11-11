import {
  type ChainView,
  type GenealogyProjection,
  type NodeId,
  type NodeState,
  type NodeView,
  type SiblingGroupView,
} from '@committee/protocol'
import { currentJoinBack, nodeParents, resolvePoint } from '../queries'
import type { ConversationState, NodeRow } from '../state'
import type { Memo } from './tracking'

/** Context ancestry: the trees of chains (01). Nothing about display order or waiting is in it. */
export function genealogyProjection(s: ConversationState, m: Memo): GenealogyProjection {
  const chains: { [id: string]: ChainView } = {}
  for (const id of s.chainOrder) {
    const chain = s.chains[id]
    if (!chain) continue
    chains[id] = {
      id,
      kind: chain.kind,
      colorIndex: chain.colorIndex,
      label: chain.label,
      baseChainId: chain.baseChainId,
      nodeIds: chain.nodeIds,
    }
  }
  const nodes: { [id: string]: NodeView } = {}
  for (const id of s.nodeOrder) {
    nodes[id] = m.get('genealogy.node', id, (st) => nodeView(st, id))
  }
  const groups: { [id: string]: SiblingGroupView } = {}
  for (const group of Object.values(s.groups)) {
    groups[group.id] = {
      id: group.id,
      startNodeId: group.startNodeId,
      baseChainId: group.baseChainId,
      memberNodeIds: group.members.map((mm) => mm.nodeId),
      withdrawnNodeIds: group.members.filter((mm) => group.withdrawn.includes(mm.directiveId)).map((mm) => mm.nodeId),
      state: group.state,
      joinBackNodeId: currentJoinBack(s, group.id)?.nodeId ?? null,
    }
  }
  return { chains, chainIds: s.chainOrder, nodes, nodeIds: s.nodeOrder, groups }
}

function exchangeState(s: ConversationState, node: NodeRow): NodeState {
  if (node.replacedByNodeId !== null) return 'superseded'
  const d = node.directiveId ? s.directives[node.directiveId] : undefined
  if (!d) return 'pending'
  if (d.state === 'superseded') return 'superseded'
  if (d.nodeId === node.id) {
    switch (d.state) {
      case 'running':
      case 'retrying':
      case 'waiting-for-capacity':
        return 'running'
      case 'completed':
      case 'failed':
      case 'stopped':
      case 'interrupted':
      case 'cancelled':
        return d.state
      default:
        return 'pending'
    }
  }
  // A node the directive has moved on from (a late retry runs elsewhere): how its own last attempt ended.
  const last = node.attemptIds[node.attemptIds.length - 1]
  const attempt = last ? s.attempts[last] : undefined
  if (!attempt) return 'cancelled'
  switch (attempt.state) {
    case 'running':
    case 'streaming':
      return 'running'
    default:
      return attempt.state
  }
}

function nodeView(s: ConversationState, id: NodeId): NodeView {
  const node = s.nodes[id]
  if (!node) throw new Error(`No node ${id}`)
  if (node.kind === 'join-back' && node.joinBackId && node.joinGroupId) {
    const record = s.joinBacks[node.joinBackId]
    const group = s.groups[node.joinGroupId]
    return {
      kind: 'join-back',
      id,
      chainId: node.chainId,
      joinBackId: node.joinBackId,
      groupId: node.joinGroupId,
      parents: (record?.members ?? []).map((mm) => mm.nodeId),
      members: (record?.members ?? []).map((mm) => ({ ...mm, label: s.directives[mm.directiveId]?.label ?? '' })),
      lateRetryNodeIds: group?.lateRetryNodeIds ?? [],
      replacedByNodeId: node.replacedByNodeId,
    }
  }
  const d = node.directiveId ? s.directives[node.directiveId] : undefined
  const lastAttempt = node.attemptIds[node.attemptIds.length - 1]
  const sectionId = lastAttempt ? (s.attempts[lastAttempt]?.sectionId ?? null) : d && d.nodeId === id ? d.sectionId : null
  return {
    kind: 'exchange',
    id,
    chainId: node.chainId,
    directiveId: node.directiveId ?? ('' as never),
    label: d?.label ?? '',
    parents: nodeParents(s, node),
    parentsExact: node.startedParents !== null,
    // Planned on a group with no join-back yet: drawn as a planned edge from the group, never a root.
    plannedGroupIds:
      node.startedParents !== null
        ? []
        : node.plannedParents.flatMap((p) => (p.kind === 'sibling-group' && resolvePoint(s, p) === null ? [p.groupId] : [])),
    state: exchangeState(s, node),
    reason: node.reason ?? 'initial',
    groupId: node.groupId,
    replacesNodeId: node.replacesNodeId,
    replacedByNodeId: node.replacedByNodeId,
    messageId: d?.messageId ?? ('' as never),
    sectionId,
    attemptIds: node.attemptIds,
  }
}

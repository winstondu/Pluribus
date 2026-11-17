import type { AttemptId, DirectiveId, NodeId, RunInspection } from '@pluribus/protocol'
import { barrierOf, nodeParents, sectionTitle, unsatisfiedPrerequisites } from '../queries'
import { computeWait } from '../lifecycle'
import type { ConversationState } from '../state'
import { waitTarget } from './queue'
import { attemptResultStatus } from './transcript'

/**
 * What the run inspector shows for one directive and one of its attempts
 * (09 §5). Item 3 is the attempt's recorded input, never a recomputation.
 * Null when the directive does not exist or the attempt is not one of its.
 */
export function runInspection(s: ConversationState, directiveId: DirectiveId, attemptId: AttemptId | null): RunInspection | null {
  const d = s.directives[directiveId]
  if (!d) return null
  const chosen = attemptId ?? d.attemptIds[d.attemptIds.length - 1] ?? null
  if (chosen !== null && !d.attemptIds.includes(chosen)) return null
  const attempt = chosen ? s.attempts[chosen] : undefined
  const original = s.messages[d.originalMessageId]
  const decomposition = s.decompositions[d.originalMessageId]
  const fragment = d.fragmentId ? decomposition?.fragments.find((f) => f.fragmentId === d.fragmentId) : undefined
  const notStarted = ['dependency-queued', 'paused', 'ready', 'awaiting-elicitation'].includes(d.state)
  const waitingFor = notStarted ? unsatisfiedPrerequisites(s, d).map((ref) => waitTarget(s, d, ref)) : []
  const barrier = barrierOf(s, d.originalMessageId)
  let barrierView: RunInspection['barrier'] = null
  if (barrier && barrier.decomposition.barrier && barrier.directiveIds.includes(d.id)) {
    const decision = notStarted ? computeWait(s, d) : null
    barrierView = {
      barrier: barrier.decomposition.barrier,
      waitingFor:
        decision && decision.kind === 'waiting' && decision.heldByBarrier ? decision.waitingFor.map((ref) => waitTarget(s, d, ref)) : [],
    }
  }
  const decision = original?.decision ?? null
  const unit = decision ? (decision.units.find((u) => (d.fragmentId ? u.fragmentId === d.fragmentId : u.fragmentId === null)) ?? null) : null
  const sectionId = attempt?.sectionId ?? d.sectionId
  const section = sectionId ? s.sections[sectionId] : undefined
  return {
    directiveId,
    attemptId: chosen,
    source: {
      originalMessageId: d.originalMessageId,
      originalText: original?.text ?? '',
      fragment: fragment ? { fragmentId: fragment.fragmentId, sourceSpans: fragment.sourceSpans, rewrittenText: fragment.rewrittenText } : null,
    },
    instruction: d.revisedInstruction?.instruction ?? d.instruction,
    requirements: d.revisedInstruction?.requirements ?? d.requirements,
    input: attempt?.context ?? null,
    waitingFor,
    barrier: barrierView,
    ancestry: rootFirst(s, attempt?.context.nodeIds ?? []).map((nodeId) => {
      const node = s.nodes[nodeId]
      const label = node?.kind === 'join-back' ? 'join-back' : node?.directiveId ? (s.directives[node.directiveId]?.label ?? '') : ''
      return { nodeId, chainId: node?.chainId ?? d.chainId, label }
    }),
    routing: decision ? { decision, unit } : null,
    attempt: attempt
      ? {
          number: attempt.number,
          origin: attempt.origin,
          state: attempt.state,
          resultStatus: attemptResultStatus(s, attempt.id),
          model: attempt.model,
          modelRole: attempt.modelRole,
          chainId: attempt.chainId,
          nodeId: attempt.nodeId,
          startedAt: attempt.startedAt,
          endedAt: attempt.endedAt,
          failure: attempt.failure,
        }
      : null,
    directiveState: d.state,
    attempts: d.attemptIds.map((id) => {
      const a = s.attempts[id]
      return { attemptId: id, number: a?.number ?? 0, resultStatus: attemptResultStatus(s, id), sectionId: a?.sectionId ?? (d.sectionId as never) }
    }),
    section: section ? { sectionId: section.id, responseId: section.responseId, title: sectionTitle(s, section) } : null,
  }
}

/**
 * The consumed nodes with every node after its parents among them, otherwise
 * in recorded order. Attempts recorded before the context builder listed a
 * join-back after its members still read root first.
 */
function rootFirst(s: ConversationState, nodeIds: readonly NodeId[]): NodeId[] {
  const parentsOf = (id: NodeId): readonly NodeId[] => {
    const node = s.nodes[id]
    if (!node) return []
    if (node.kind === 'join-back') {
      const record = node.joinBackId ? s.joinBacks[node.joinBackId] : undefined
      return (record?.members ?? []).map((m) => m.nodeId)
    }
    // A late retry's node is a child of its group's join-back (Q92).
    const group = Object.values(s.groups).find((g) => g.lateRetryNodeIds.includes(id))
    if (group) {
      const latest = group.joinBackIds[group.joinBackIds.length - 1]
      const joinNode = latest ? s.joinBacks[latest]?.nodeId : undefined
      return joinNode ? [...nodeParents(s, node), joinNode] : nodeParents(s, node)
    }
    return nodeParents(s, node)
  }
  const out: NodeId[] = []
  const placed = new Set<NodeId>()
  const visiting = new Set<NodeId>()
  const place = (id: NodeId): void => {
    if (placed.has(id) || visiting.has(id)) return
    visiting.add(id)
    for (const parent of parentsOf(id)) if (nodeIds.includes(parent)) place(parent)
    visiting.delete(id)
    placed.add(id)
    out.push(id)
  }
  for (const id of nodeIds) place(id)
  return out
}

import type {
  AttemptId,
  ConsumedContext,
  ConsumedInput,
  ConsumedMessage,
  DirectiveId,
  JoinBackId,
  MessageId,
  NodeId,
  Requirement,
  RequirementId,
  UnfinishedOutcome,
} from '@committee/protocol'
import type { ContextChain } from '../ports'
import { currentResult, nodeParents, unfinishedOutcome } from './queries'
import type { ConversationState, Correction, DirectiveRow } from './state'

/**
 * Mechanical context assembly (04 · "Context for a run", Q76), written
 * against the whole `ContextOrigin` union. There is no relevance scoring:
 * the input is the preamble, the session-wide requirements in force, the
 * ancestry root first, the run's own request, and the clarification it was
 * blocked by, in that order (PLAN §2 "Context assembly").
 *
 * The result is the exact record `attempt-started` carries (invariant 2).
 * It is computed once, when the attempt starts (Q29), and never again.
 */

/** Committee's fixed instructions to the model. */
export const PREAMBLE =
  'You are one participant in a chat that answers several requests at once. ' +
  'Answer only the last request, using the conversation before it as its context. ' +
  'Reply in plain text.'

export type AssembledContext = Omit<ConsumedContext, 'inputTokens' | 'tokenLimit'>

export function requestText(instruction: string, requirements: readonly Requirement[]): string {
  const local = requirements.filter((r) => r.scope === 'local')
  if (local.length === 0) return instruction
  return `${instruction}\n\nRequirements:\n${local.map((r) => `- ${r.text}`).join('\n')}`
}

export function markerText(outcome: UnfinishedOutcome): string {
  return outcome === 'cancelled'
    ? '[No answer: this request was cancelled before it started.]'
    : `[No answer: this request ${outcome} before it completed.]`
}

export function correctionText(text: string): string {
  return `Correction: ${text}`
}

export function sessionRequirementText(text: string): string {
  return `Requirement for this whole conversation: ${text}`
}

/** Session-wide requirements in force, in the order recorded. Replaced and withdrawn ones are not sent. */
export function sessionRequirementsInForce(state: ConversationState): Requirement[] {
  const out: Requirement[] = []
  for (const id of state.sessionRequirementOrder) {
    const row = state.sessionRequirements[id]
    if (row && row.replacedBy === null && row.withdrawnByMessageId === null) out.push(row.requirement)
  }
  return out
}

/**
 * The ancestry of a run with these parents, root first. For several parents
 * (a join chain), each parent's ancestry in the order of `parents`, every
 * node once. A join-back's ancestry is its group's starting context; its
 * members and its completed late retries are read inside its record, not as
 * nodes of their own. So a line that reaches a member some other way (a
 * branch from one sibling, joined with work on the join-back) reads the
 * record at that point, once, and never the member's exchange a second time.
 */
export function ancestryOf(state: ConversationState, parents: readonly NodeId[]): NodeId[] {
  const recordOf = recordedNodes(state, parents)
  const seen = new Set<NodeId>()
  const ordered: NodeId[] = []
  const visit = (id: NodeId): void => {
    if (seen.has(id)) return
    const joinBack = recordOf.get(id)
    if (joinBack !== undefined && joinBack !== id) {
      seen.add(id)
      visit(joinBack)
      return
    }
    seen.add(id)
    const node = state.nodes[id]
    if (!node) return
    if (node.kind === 'join-back') {
      const group = node.joinGroupId ? state.groups[node.joinGroupId] : undefined
      if (group) visit(group.startNodeId)
    } else {
      for (const parent of nodeParents(state, node)) visit(parent)
    }
    ordered.push(id)
  }
  for (const parent of parents) visit(parent)
  return ordered
}

/**
 * For every join-back reachable from `parents`: its record's member nodes
 * and its late-retry tail, each mapped to the first join-back node of that
 * group that was reached.
 */
function recordedNodes(state: ConversationState, parents: readonly NodeId[]): Map<NodeId, NodeId> {
  const out = new Map<NodeId, NodeId>()
  const groups = new Set<string>()
  const seen = new Set<NodeId>()
  const stack = [...parents].reverse()
  while (stack.length > 0) {
    const id = stack.pop()
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    const node = state.nodes[id]
    if (!node) continue
    if (node.kind === 'join-back') {
      const group = node.joinGroupId ? state.groups[node.joinGroupId] : undefined
      if (!group) continue
      if (!groups.has(group.id)) {
        groups.add(group.id)
        const latest = group.joinBackIds[group.joinBackIds.length - 1]
        const record = latest ? state.joinBacks[latest] : undefined
        for (const member of record?.members ?? []) if (!out.has(member.nodeId)) out.set(member.nodeId, id)
        for (const tail of group.lateRetryNodeIds) if (!out.has(tail)) out.set(tail, id)
      }
      stack.push(group.startNodeId)
    } else {
      for (const parent of nodeParents(state, node)) stack.push(parent)
    }
  }
  return out
}

class Builder {
  readonly messages: ConsumedMessage[] = []
  readonly nodeIds: NodeId[] = []
  readonly inputs: ConsumedInput[] = []
  readonly corrections: MessageId[] = []
  readonly sessionRequirementIds: RequirementId[] = []

  node(id: NodeId): void {
    if (!this.nodeIds.includes(id)) this.nodeIds.push(id)
  }

  /** Inputs keep the order they were first read in; a directive is listed once. */
  input(input: ConsumedInput): void {
    const existing = this.inputs.findIndex((i) => i.directiveId === input.directiveId)
    if (existing >= 0) this.inputs.splice(existing, 1, input)
    else this.inputs.push(input)
  }

  correction(directiveId: DirectiveId, correction: Correction): void {
    this.messages.push({
      role: 'user',
      content: correctionText(correction.text),
      origin: { kind: 'correction', revisionMessageId: correction.revisionMessageId, directiveId },
    })
    if (!this.corrections.includes(correction.revisionMessageId)) this.corrections.push(correction.revisionMessageId)
  }
}

/**
 * The exact input for an attempt of `directiveId` running on `nodeId` with
 * these resolved parents.
 */
export function assembleContext(
  state: ConversationState,
  directiveId: DirectiveId,
  nodeId: NodeId,
  parents: readonly NodeId[],
): AssembledContext {
  return assemble(state, directiveId, nodeId, parents)
}

/**
 * The context chain of a node: what a run that continues from it reads
 * before its own request. The same assembly as a run's (steps 1 to 3), for
 * a run that does not exist yet, so the two cannot drift apart. Read by the
 * context summary provider and the summariser (ports/context-summary.ts);
 * never recorded and never a run's input.
 */
export function contextChainOf(state: ConversationState, nodeId: NodeId): ContextChain {
  const assembled = assemble(state, null, null, [nodeId])
  return { nodeId, messages: assembled.messages, nodeIds: assembled.nodeIds }
}

function assemble(state: ConversationState, directiveId: DirectiveId | null, nodeId: NodeId | null, parents: readonly NodeId[]): AssembledContext {
  const b = new Builder()
  const self = directiveId === null ? undefined : state.directives[directiveId]

  // 1. The preamble.
  b.messages.push({ role: 'system', content: PREAMBLE, origin: { kind: 'preamble' } })

  // 2. Session-wide requirements in force when the run starts.
  for (const requirement of sessionRequirementsInForce(state)) {
    b.messages.push({
      role: 'system',
      content: sessionRequirementText(requirement.text),
      origin: { kind: 'session-requirement', requirementId: requirement.id },
    })
    b.sessionRequirementIds.push(requirement.id)
  }

  // 3. The ancestry, root first. A group's record is read once, whichever of its formations was reached.
  const groupsRead = new Set<string>()
  for (const id of ancestryOf(state, parents)) {
    const node = state.nodes[id]
    if (!node) continue
    if (node.kind === 'join-back') {
      if (node.joinGroupId === null || groupsRead.has(node.joinGroupId)) continue
      groupsRead.add(node.joinGroupId)
      readJoinBack(state, b, id, nodeId)
    } else if (node.directiveId !== null) {
      const d = state.directives[node.directiveId]
      if (d) readExchange(state, b, d, id, null)
    }
  }

  // 4. The run's own request.
  if (self) readOwnRequest(state, b, self)

  // 5. The clarification that blocked it: the question, then the answer.
  if (self?.clarification) {
    const { elicitationId, answerMessageId } = self.clarification
    const elicitation = state.elicitations[elicitationId]
    if (elicitation?.record.kind === 'clarification') {
      const questionId = elicitation.record.questionDirectiveId
      const questionAttempt = currentResult(state, questionId)
      if (questionAttempt) {
        b.messages.push({
          role: 'assistant',
          content: state.attemptText[questionAttempt] ?? '',
          origin: { kind: 'clarification-question', elicitationId, directiveId: questionId, attemptId: questionAttempt },
        })
      }
      b.messages.push({
        role: 'user',
        content: state.messages[answerMessageId]?.text ?? '',
        origin: { kind: 'clarification-answer', elicitationId, messageId: answerMessageId },
      })
    }
  }

  return {
    messages: b.messages,
    nodeIds: b.nodeIds,
    inputs: b.inputs,
    corrections: b.corrections,
    sessionRequirementIds: b.sessionRequirementIds,
  }
}

function pushRequest(b: Builder, d: DirectiveRow, nodeId: NodeId, joinBackId: JoinBackId | null): void {
  b.messages.push({
    role: 'user',
    content: requestText(d.instruction, d.requirements),
    origin: { kind: 'ancestor-request', nodeId, directiveId: d.id, messageId: d.messageId, joinBackId },
  })
}

function pushMarker(b: Builder, d: DirectiveRow, nodeId: NodeId, joinBackId: JoinBackId | null, outcome: UnfinishedOutcome): void {
  b.messages.push({
    role: 'assistant',
    content: markerText(outcome),
    origin: { kind: 'unfinished-exchange', nodeId, directiveId: d.id, joinBackId, outcome },
  })
}

function pushAnswer(
  state: ConversationState,
  b: Builder,
  d: DirectiveRow,
  nodeId: NodeId,
  attemptId: AttemptId,
  joinBackId: JoinBackId | null,
): void {
  const attempt = state.attempts[attemptId]
  if (!attempt) return
  // Corrections recorded before the result was produced lead to it; later ones follow it (06, Q39).
  const before = d.corrections.filter((c) => c.seq < attempt.startedSeq)
  const after = d.corrections.filter((c) => c.seq >= attempt.startedSeq)
  for (const c of before) b.correction(d.id, c)
  b.messages.push({
    role: 'assistant',
    content: state.attemptText[attemptId] ?? '',
    origin: { kind: 'ancestor-answer', nodeId, directiveId: d.id, attemptId, sectionId: attempt.sectionId, joinBackId },
  })
  for (const c of after) b.correction(d.id, c)
  b.node(attempt.nodeId)
}

/**
 * An exchange node is read by its directive as it stands when the run
 * starts (Q39, Q96): request, corrections, current answer; or request and
 * marker when its work ended without completing; or request and corrections
 * while a replacement is still running.
 */
function readExchange(state: ConversationState, b: Builder, d: DirectiveRow, nodeId: NodeId, joinBackId: JoinBackId | null): void {
  b.node(nodeId)
  pushRequest(b, d, nodeId, joinBackId)
  const result = currentResult(state, d.id)
  if (result) {
    pushAnswer(state, b, d, nodeId, result, joinBackId)
    b.input({ directiveId: d.id, attemptId: result, marker: null })
    return
  }
  const outcome = unfinishedOutcome(d.state)
  if (outcome) {
    pushMarker(b, d, nodeId, joinBackId, outcome)
    b.input({ directiveId: d.id, attemptId: null, marker: outcome })
    return
  }
  for (const c of d.corrections) b.correction(d.id, c)
  b.input({ directiveId: d.id, attemptId: null, marker: null })
}

/**
 * A join-back is read as recorded in its latest formation: each member in
 * submission order, as its exchange or as its request and marker; then the
 * exchange of every late retry that had completed, in the order requested
 * (Q49, Q92). A member's marker stays in the record after a late retry.
 */
function readJoinBack(state: ConversationState, b: Builder, joinNodeId: NodeId, runNodeId: NodeId | null): void {
  const node = state.nodes[joinNodeId]
  const group = node?.joinGroupId ? state.groups[node.joinGroupId] : undefined
  if (!node || !group) return
  const latestId = group.joinBackIds[group.joinBackIds.length - 1]
  const record = latestId ? state.joinBacks[latestId] : undefined
  if (!record) return
  for (const member of record.members) {
    const d = state.directives[member.directiveId]
    if (!d) continue
    // A member replaced since this formation (a revision whose replacement has not settled yet) is
    // read as its directive stands: never the superseded body (Q39, R5).
    const recorded = member.attemptId ? state.attempts[member.attemptId] : undefined
    if (recorded && recorded.sectionId !== d.sectionId) {
      readExchange(state, b, d, member.nodeId, record.id)
      continue
    }
    b.node(member.nodeId)
    pushRequest(b, d, member.nodeId, record.id)
    if (member.outcome === 'completed' && member.attemptId !== null) {
      pushAnswer(state, b, d, member.nodeId, member.attemptId, record.id)
      b.input({ directiveId: d.id, attemptId: member.attemptId, marker: null })
    } else if (member.outcome !== 'completed') {
      pushMarker(b, d, member.nodeId, record.id, member.outcome)
      b.input({ directiveId: d.id, attemptId: null, marker: member.outcome })
    }
  }
  // The join-back is a child of its member nodes, and the late-retry tail of the join-back: root first.
  b.node(joinNodeId)
  if (record.nodeId !== joinNodeId) b.node(record.nodeId)
  for (const tailId of group.lateRetryNodeIds) {
    if (tailId === runNodeId) continue
    const tail = state.nodes[tailId]
    // A late retry whose work was replaced since (its member was revised) is read through the record.
    if (!tail || tail.directiveId === null || tail.replacedByNodeId !== null) continue
    const d = state.directives[tail.directiveId]
    if (!d) continue
    const completed = [...tail.attemptIds].reverse().find((id) => state.attempts[id]?.state === 'completed')
    if (!completed) continue
    b.node(tailId)
    pushRequest(b, d, tailId, record.id)
    pushAnswer(state, b, d, tailId, completed, record.id)
    b.input({ directiveId: d.id, attemptId: completed, marker: null })
  }
}

/**
 * The run's own request. For the replacement of finished work the old
 * exchange comes first: the request, the superseded answer, then the
 * correction (06). Otherwise the original instruction and then every
 * correction; no earlier text of the directive is read (invariant 7).
 */
function readOwnRequest(state: ConversationState, b: Builder, d: DirectiveRow): void {
  const request: ConsumedMessage = {
    role: 'user',
    content: requestText(d.instruction, d.requirements),
    origin: { kind: 'request', directiveId: d.id, messageId: d.messageId, fragmentId: d.fragmentId },
  }
  const replaced = lastFinishedRevised(state, d)
  if (replaced) {
    const old = [...replaced.attemptIds].reverse().find((id) => state.attempts[id]?.state === 'completed')
    const oldAttempt = old ? state.attempts[old] : undefined
    if (old && oldAttempt) {
      // Corrections recorded before that answer was produced lead to it; later ones follow it (06, Q39).
      b.messages.push(request)
      for (const c of d.corrections) if (c.seq < oldAttempt.startedSeq) b.correction(d.id, c)
      b.messages.push({
        role: 'assistant',
        content: state.attemptText[old] ?? '',
        origin: {
          kind: 'ancestor-answer',
          nodeId: oldAttempt.nodeId,
          directiveId: d.id,
          attemptId: old,
          sectionId: oldAttempt.sectionId,
          joinBackId: null,
        },
      })
      b.node(oldAttempt.nodeId)
      for (const c of d.corrections) if (c.seq >= oldAttempt.startedSeq) b.correction(d.id, c)
      return
    }
  }
  b.messages.push(request)
  for (const c of d.corrections) b.correction(d.id, c)
}

/**
 * The finished section a revision's replacement rewinds to: walking back
 * through replaced sections, past replacements that ended or were revised
 * before they finished (their text is never read, invariant 7), to the last
 * section that had finished when a revision superseded it. A finished
 * section redone for any other cause (Regenerate, a redo) ends the walk:
 * redone work is done again against the new inputs, not as a follow-up.
 */
function lastFinishedRevised(state: ConversationState, d: DirectiveRow): ConversationState['sections'][string] | null {
  const current = d.sectionId ? state.sections[d.sectionId] : undefined
  let id = current?.replacesSectionId ?? null
  const seen = new Set<string>()
  while (id !== null && !seen.has(id)) {
    seen.add(id)
    const section = state.sections[id]
    const supersession = section?.supersession
    if (!section || !supersession) return null
    if (supersession.wasFinished) return supersession.cause.kind === 'revision' ? section : null
    id = section.replacesSectionId
  }
  return null
}

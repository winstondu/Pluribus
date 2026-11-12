import type {
  AttemptId,
  ChainId,
  ConversationEvent,
  ConversationEventType,
  DirectiveId,
  EventOfType,
  MessageId,
  NodeId,
  ResponseId,
  SectionId,
  TranscriptItemRef,
} from '@pluribus/protocol'
import { IN_FLIGHT_STATES } from '@pluribus/protocol'
import type {
  AttemptRow,
  ConversationState,
  DirectiveRow,
  MessageRow,
  NodeRow,
  ResponseRow,
  SectionRow,
  Table,
} from './state'

/**
 * What each event means: one reducer per conversation event type, total
 * over `events.ts`. A reducer is pure, never fails on an event it does not
 * understand the context of (it leaves the state as it is), and replaces
 * only the rows it changes.
 *
 * Later slices never add a reducer: every event type already has one here.
 * They decide when to emit events.
 */
export type Reducer<T extends ConversationEventType> = (state: ConversationState, event: EventOfType<T>) => ConversationState

type ReducerTable = { readonly [T in ConversationEventType]: Reducer<T> }

/** Folds one event. Sets `throughSeq`. */
export function reduce(state: ConversationState, event: ConversationEvent): ConversationState {
  const reducer = REDUCERS[event.type] as Reducer<ConversationEventType>
  const next = reducer(state, event as never)
  return { ...next, throughSeq: event.seq }
}

/** Folds a sequence of events. */
export function fold(state: ConversationState, events: readonly ConversationEvent[]): ConversationState {
  let current = state
  for (const event of events) current = reduce(current, event)
  return current
}

// ───────────────────────────── helpers ─────────────────────────────

function put<T>(table: Table<T>, id: string, row: T): Table<T> {
  return { ...table, [id]: row }
}

function patch<T>(table: Table<T>, id: string, change: (row: T) => T): Table<T> {
  const row = table[id]
  if (row === undefined) return table
  const next = change(row)
  return next === row ? table : { ...table, [id]: next }
}

function append<T>(list: readonly T[], item: T): readonly T[] {
  return list.includes(item) ? list : [...list, item]
}

function withMessage(state: ConversationState, id: MessageId, change: (row: MessageRow) => MessageRow): ConversationState {
  const messages = patch(state.messages, id, change)
  return messages === state.messages ? state : { ...state, messages }
}

function withDirective(state: ConversationState, id: DirectiveId, change: (row: DirectiveRow) => DirectiveRow): ConversationState {
  const directives = patch(state.directives, id, change)
  return directives === state.directives ? state : { ...state, directives }
}

function withSection(state: ConversationState, id: SectionId, change: (row: SectionRow) => SectionRow): ConversationState {
  const sections = patch(state.sections, id, change)
  return sections === state.sections ? state : { ...state, sections }
}

function withAttempt(state: ConversationState, id: AttemptId, change: (row: AttemptRow) => AttemptRow): ConversationState {
  const attempts = patch(state.attempts, id, change)
  return attempts === state.attempts ? state : { ...state, attempts }
}

function withResponse(state: ConversationState, id: ResponseId, change: (row: ResponseRow) => ResponseRow): ConversationState {
  const responses = patch(state.responses, id, change)
  return responses === state.responses ? state : { ...state, responses }
}

function withNode(state: ConversationState, id: NodeId, change: (row: NodeRow) => NodeRow): ConversationState {
  const nodes = patch(state.nodes, id, change)
  return nodes === state.nodes ? state : { ...state, nodes }
}

/** The attempt's directive, when the attempt belongs to the directive's current section. */
function forCurrentSection(state: ConversationState, attemptId: AttemptId): { attempt: AttemptRow; directive: DirectiveRow } | null {
  const attempt = state.attempts[attemptId]
  if (!attempt) return null
  const directive = state.directives[attempt.directiveId]
  if (!directive || directive.sectionId !== attempt.sectionId) return null
  return { attempt, directive }
}

/** Marks a section as having shown visible output (text, a failure notice, or an end mark). */
function markVisible(state: ConversationState, sectionId: SectionId | null): ConversationState {
  if (sectionId === null) return state
  return withSection(state, sectionId, (s) => (s.visibleOutput ? s : { ...s, visibleOutput: true }))
}

/** Inserts `nodeId` into a chain's node list right after `afterId` (or at the end). */
function insertIntoChain(state: ConversationState, chainId: ChainId, nodeId: NodeId, afterIds: readonly NodeId[]): ConversationState {
  const chain = state.chains[chainId]
  if (!chain) return state
  const without = chain.nodeIds.filter((id) => id !== nodeId)
  let index = -1
  for (const after of afterIds) index = Math.max(index, without.indexOf(after))
  const nodeIds = index < 0 ? [...without, nodeId] : [...without.slice(0, index + 1), nodeId, ...without.slice(index + 1)]
  return { ...state, chains: put(state.chains, chainId, { ...chain, nodeIds }) }
}

function sameRef(a: TranscriptItemRef, b: TranscriptItemRef): boolean {
  return a.kind === b.kind && a.id === b.id
}

// ───────────────────────────── reducers ─────────────────────────────

const REDUCERS: ReducerTable = {
  // ── submissions and routing ──
  'message-submitted': (state, e) => {
    const message: MessageRow = {
      id: e.messageId,
      kind: 'original',
      text: e.text,
      submittedAt: e.at,
      explicitTargets: e.explicitTargets,
      originalMessageId: e.messageId,
      initialResponseId: e.responseId,
      routing: 'routing',
      routingFailure: null,
      decision: null,
      splitActive: false,
      split: null,
      withdrawn: false,
      directiveIds: [],
      responseIds: [e.responseId],
      revisedDirectiveIds: [],
      releasedDirectiveIds: [],
    }
    const response: ResponseRow = {
      id: e.responseId,
      messageId: e.messageId,
      opened: false,
      reason: 'answer',
      grouped: false,
      sectionOrder: 'first-output',
      placed: false,
      sectionIds: [],
      placedSectionIds: [],
    }
    return {
      ...state,
      messages: put(state.messages, e.messageId, message),
      messageOrder: [...state.messageOrder, e.messageId],
      responses: put(state.responses, e.responseId, response),
      responseOrder: [...state.responseOrder, e.responseId],
      fixedOrder: [...state.fixedOrder, { kind: 'message', id: e.messageId }],
    }
  },

  'routing-decided': (state, e) =>
    withMessage(state, e.messageId, (m) => ({ ...m, routing: 'routed', routingFailure: null, decision: e.decision })),

  'routing-failed': (state, e) => withMessage(state, e.messageId, (m) => ({ ...m, routing: 'failed', routingFailure: e.error })),

  'routing-retried': (state, e) => withMessage(state, e.messageId, (m) => ({ ...m, routing: 'routing', routingFailure: null })),

  'message-decomposed': (state, e) => {
    let next: ConversationState = {
      ...state,
      decompositions: put(state.decompositions, e.messageId, {
        messageId: e.messageId,
        presentation: e.presentation,
        fragments: e.fragments,
        barrier: e.barrier,
        outputOrder: e.outputOrder,
        splitMessages: e.splitMessages,
        model: e.model,
        undone: false,
      }),
    }
    if (e.presentation !== 'split-messages') return next
    const original = state.messages[e.messageId]
    if (!original) return next
    let messages = next.messages
    e.splitMessages.forEach((split, index) => {
      messages = put(messages, split.messageId, {
        id: split.messageId,
        kind: 'split',
        text: split.text,
        submittedAt: original.submittedAt,
        explicitTargets: [],
        originalMessageId: e.messageId,
        initialResponseId: null,
        routing: 'routed',
        routingFailure: null,
        decision: null,
        splitActive: false,
        split: { index, count: e.splitMessages.length },
        withdrawn: false,
        directiveIds: [],
        responseIds: [],
        revisedDirectiveIds: [],
        releasedDirectiveIds: [],
      } satisfies MessageRow)
    })
    messages = patch(messages, e.messageId, (m) => ({ ...m, splitActive: true }))
    next = { ...next, messages }
    return next
  },

  'split-undone': (state, e) => {
    let next = withMessage(state, e.originalMessageId, (m) => ({
      ...m,
      splitActive: false,
      routing: 'routing',
      routingFailure: null,
    }))
    for (const id of e.splitMessageIds) next = withMessage(next, id, (m) => ({ ...m, withdrawn: true }))
    for (const id of e.withdrawnDirectiveIds) {
      next = withDirective(next, id, (d) => ({ ...d, state: 'superseded', queueItemId: null, waitingFor: [], retry: null }))
    }
    const decompositions = patch(next.decompositions, e.originalMessageId, (d) => ({ ...d, undone: true }))
    return { ...next, decompositions }
  },

  'session-requirement-recorded': (state, e) => {
    let sessionRequirements = put(state.sessionRequirements, e.requirement.id, {
      requirement: e.requirement,
      replacesRequirementId: e.replacesRequirementId,
      replacedBy: null,
      withdrawnByMessageId: null,
    })
    if (e.replacesRequirementId !== null) {
      sessionRequirements = patch(sessionRequirements, e.replacesRequirementId, (r) => ({ ...r, replacedBy: e.requirement.id }))
    }
    return {
      ...state,
      sessionRequirements,
      sessionRequirementOrder: append(state.sessionRequirementOrder, e.requirement.id),
    }
  },

  'session-requirement-withdrawn': (state, e) => ({
    ...state,
    sessionRequirements: patch(state.sessionRequirements, e.requirementId, (r) => ({ ...r, withdrawnByMessageId: e.messageId })),
  }),

  // ── genealogy ──
  'chain-created': (state, e) => ({
    ...state,
    chains: put(state.chains, e.chainId, {
      id: e.chainId,
      kind: e.kind,
      colorIndex: e.colorIndex,
      baseChainId: e.baseChainId,
      label: e.label,
      labelDirectiveId: e.labelDirectiveId ?? null,
      nodeIds: [],
    }),
    chainOrder: append(state.chainOrder, e.chainId),
  }),

  'node-created': (state, e) => {
    const node: NodeRow = {
      id: e.nodeId,
      kind: 'exchange',
      chainId: e.chainId,
      directiveId: e.directiveId,
      reason: e.reason,
      plannedParents: e.plannedParents,
      replacesNodeId: e.replacesNodeId,
      replacedByNodeId: null,
      groupId: null,
      joinBackId: null,
      joinGroupId: null,
      attemptIds: [],
      startedParents: null,
    }
    let next: ConversationState = {
      ...state,
      nodes: put(state.nodes, e.nodeId, node),
      nodeOrder: append(state.nodeOrder, e.nodeId),
    }
    if (e.replacesNodeId !== null) {
      next = withNode(next, e.replacesNodeId, (n) => ({ ...n, replacedByNodeId: e.nodeId }))
      // Redone work (Regenerate, redo, a restart for a revised prerequisite, its own revision) is
      // redone against the new version of what it depends on (06, R8): a "Continue without" waiver
      // of work that is running again no longer applies, so the new run waits for that work's new
      // version and never reads its failure marker in place of it (F5).
      if (e.directiveId !== null) {
        next = withDirective(next, e.directiveId, (d) => {
          const waived = d.waived.filter((id) => {
            const other = next.directives[id]
            return !other || !IN_FLIGHT_STATES.includes(other.state)
          })
          return waived.length === d.waived.length ? d : { ...d, waived }
        })
      }
    }
    // Where it sits along its chain.
    if (e.reason === 'retry-after-closure') {
      const parent = e.plannedParents[0]
      const joinNode = parent?.kind === 'node' ? next.nodes[parent.nodeId] : undefined
      const group = joinNode?.joinGroupId ? next.groups[joinNode.joinGroupId] : undefined
      if (group && joinNode) {
        next = insertIntoChain(next, e.chainId, e.nodeId, [joinNode.id, ...group.lateRetryNodeIds])
        next = {
          ...next,
          groups: put(next.groups, group.id, { ...group, lateRetryNodeIds: append(group.lateRetryNodeIds, e.nodeId) }),
        }
      } else {
        next = insertIntoChain(next, e.chainId, e.nodeId, [])
      }
    } else if (e.replacesNodeId !== null) {
      next = insertIntoChain(next, e.chainId, e.nodeId, [e.replacesNodeId])
    } else {
      next = insertIntoChain(next, e.chainId, e.nodeId, [])
    }
    // A replacement of a sibling member's work (a revision, a redo) is that member's exchange from now
    // on: the join-back formed or re-formed after it is a child of the replacement (01, 06). A late
    // retry is not: it follows the join-back (Q92).
    if (e.replacesNodeId !== null && e.reason !== 'retry-after-closure') {
      for (const group of Object.values(next.groups)) {
        if (group.withdrawn.includes(e.directiveId) || !group.members.some((m) => m.directiveId === e.directiveId)) continue
        next = {
          ...next,
          groups: put(next.groups, group.id, {
            ...group,
            members: group.members.map((m) => (m.directiveId === e.directiveId ? { ...m, nodeId: e.nodeId } : m)),
          }),
        }
        next = withNode(next, e.nodeId, (n) => ({ ...n, groupId: group.id }))
      }
    }
    // A re-placement of an existing directive: it now runs here.
    next = withDirective(next, e.directiveId, (d) => ({ ...d, nodeId: e.nodeId, chainId: e.chainId }))
    return next
  },

  'sibling-group-opened': (state, e) => {
    let next: ConversationState = state
    for (const move of e.rechained) {
      const from = next.chains[move.fromChainId]
      if (from) {
        next = { ...next, chains: put(next.chains, from.id, { ...from, nodeIds: from.nodeIds.filter((id) => id !== move.nodeId) }) }
      }
      next = insertIntoChain(next, move.toChainId, move.nodeId, [])
      next = withNode(next, move.nodeId, (n) => ({ ...n, chainId: move.toChainId }))
      const node = next.nodes[move.nodeId]
      if (node?.directiveId) {
        const directiveId = node.directiveId
        next = withDirective(next, directiveId, (d) => (d.nodeId === move.nodeId ? { ...d, chainId: move.toChainId } : d))
      }
    }
    for (const member of e.members) {
      next = withNode(next, member.nodeId, (n) => ({ ...n, groupId: e.groupId }))
    }
    return {
      ...next,
      groups: put(next.groups, e.groupId, {
        id: e.groupId,
        startNodeId: e.startNodeId,
        baseChainId: e.baseChainId,
        members: e.members,
        withdrawn: [],
        state: 'open',
        joinBackIds: [],
        joinBackOperationId: e.joinBackOperationId,
        lateRetryNodeIds: [],
      }),
      operations: put(next.operations, e.joinBackOperationId, {
        id: e.joinBackOperationId,
        kind: 'join-back',
        sectionId: null,
        groupId: e.groupId,
      }),
      operationOrder: append(next.operationOrder, e.joinBackOperationId),
    }
  },

  'sibling-admitted': (state, e) => {
    const group = state.groups[e.groupId]
    if (!group || group.state !== 'open') return state
    const next = withNode(state, e.member.nodeId, (n) => ({ ...n, groupId: e.groupId }))
    return { ...next, groups: put(next.groups, group.id, { ...group, members: [...group.members, e.member] }) }
  },

  'siblings-withdrawn': (state, e) => {
    const group = state.groups[e.groupId]
    if (!group) return state
    let withdrawn = group.withdrawn
    for (const id of e.directiveIds) withdrawn = append(withdrawn, id)
    return {
      ...state,
      groups: put(state.groups, group.id, { ...group, withdrawn, state: e.dissolved ? 'dissolved' : group.state }),
    }
  },

  'join-back-formed': (state, e) => {
    const group = state.groups[e.groupId]
    if (!group) return state
    const previous = e.replacesJoinBackId ? state.joinBacks[e.replacesJoinBackId] : undefined
    let joinBacks = put(state.joinBacks, e.joinBackId, {
      id: e.joinBackId,
      nodeId: e.nodeId,
      groupId: e.groupId,
      chainId: e.chainId,
      members: e.members,
      replacesJoinBackId: e.replacesJoinBackId,
      replacedByJoinBackId: null,
    })
    if (previous) joinBacks = patch(joinBacks, previous.id, (j) => ({ ...j, replacedByJoinBackId: e.joinBackId }))
    let next: ConversationState = {
      ...state,
      joinBacks,
      groups: put(state.groups, group.id, { ...group, state: 'closed', joinBackIds: append(group.joinBackIds, e.joinBackId) }),
      nodes: put(state.nodes, e.nodeId, {
        id: e.nodeId,
        kind: 'join-back',
        chainId: e.chainId,
        directiveId: null,
        reason: null,
        plannedParents: e.members.map((m) => ({ kind: 'node' as const, nodeId: m.nodeId })),
        replacesNodeId: previous ? previous.nodeId : null,
        replacedByNodeId: null,
        groupId: null,
        joinBackId: e.joinBackId,
        joinGroupId: e.groupId,
        attemptIds: [],
        startedParents: null,
      }),
      nodeOrder: append(state.nodeOrder, e.nodeId),
    }
    if (previous) {
      next = withNode(next, previous.nodeId, (n) => ({ ...n, replacedByNodeId: e.nodeId }))
      next = insertIntoChain(next, e.chainId, e.nodeId, [previous.nodeId])
    } else {
      // Before the first node that waits on the group as its starting point, so the chain reads in order.
      const chain = next.chains[e.chainId]
      const waiting = chain?.nodeIds.find((id) =>
        next.nodes[id]?.plannedParents.some((p) => p.kind === 'sibling-group' && p.groupId === e.groupId),
      )
      if (chain && waiting) {
        const index = chain.nodeIds.indexOf(waiting)
        const nodeIds = [...chain.nodeIds.slice(0, index), e.nodeId, ...chain.nodeIds.slice(index)]
        next = { ...next, chains: put(next.chains, chain.id, { ...chain, nodeIds }) }
      } else {
        next = insertIntoChain(next, e.chainId, e.nodeId, [])
      }
    }
    return next
  },

  // ── directives ──
  'directive-created': (state, e) => {
    const directive: DirectiveRow = {
      id: e.directiveId,
      kind: e.kind,
      messageId: e.messageId,
      originalMessageId: e.originalMessageId,
      fragmentId: e.fragmentId,
      instruction: e.instruction,
      requirements: e.requirements,
      revisedInstruction: null,
      label: e.label,
      relation: e.relation,
      targets: e.targets,
      nodeId: e.nodeId,
      chainId: e.chainId,
      prerequisites: e.prerequisites,
      asksElicitationId: e.asksElicitationId,
      // Its first state (waiting, held or ready) follows in the same step.
      state: 'dependency-queued',
      createdAt: e.at,
      order: state.directiveOrder.length,
      sectionId: null,
      sectionIds: [],
      attemptIds: [],
      resultAttemptId: null,
      queueItemId: null,
      waitingFor: [],
      heldByBarrier: false,
      revised: false,
      pause: null,
      readiness: null,
      heldBy: null,
      waived: [],
      corrections: [],
      nextOrigin: 'initial',
      retry: null,
      clarification: null,
      slotHeld: false,
    }
    const next: ConversationState = {
      ...state,
      directives: put(state.directives, e.directiveId, directive),
      directiveOrder: append(state.directiveOrder, e.directiveId),
    }
    return withMessage(next, e.messageId, (m) => ({ ...m, directiveIds: append(m.directiveIds, e.directiveId) }))
  },

  'directive-waiting': (state, e) =>
    withDirective(state, e.directiveId, (d) => ({
      ...d,
      state: 'dependency-queued',
      queueItemId: e.queueItemId,
      waitingFor: e.waitingFor,
      heldByBarrier: e.heldByBarrier,
      revised: e.revised,
      pause: null,
      // A choice-with-default hold outlives a change of what the work waits for (07); it lapses
      // once the elicitation is no longer open.
      heldBy: d.heldBy && state.elicitations[d.heldBy.elicitationId]?.status === 'open' ? d.heldBy : null,
    })),

  'directive-paused': (state, e) =>
    withDirective(state, e.directiveId, (d) => ({
      ...d,
      state: 'paused',
      queueItemId: e.queueItemId,
      pause: { reason: 'dependency-recovery', cause: e.cause, elicitationId: e.elicitationId },
      heldByBarrier: false,
    })),

  'directive-readiness-established': (state, e) =>
    withDirective(state, e.directiveId, (d) => ({
      ...d,
      readiness: { readiness: e.readiness, source: e.source, awaitingResults: e.awaitingResults, basis: e.basis, model: e.model },
    })),

  'directive-held': (state, e) =>
    withDirective(state, e.directiveId, (d): DirectiveRow => {
      const heldBy = { elicitationId: e.elicitationId, reason: e.reason }
      // Queued work that a choice with default holds keeps its queue item, what it waits for, and a
      // pause with its recovery choice (07 · "affected queued work holds", P6): the hold is recorded
      // beside them. It is held for the answer alone once nothing else is left to wait for (a second
      // hold for the same elicitation, from `settleWait`).
      const queued =
        (d.state === 'paused' && d.pause?.reason === 'dependency-recovery') ||
        (d.state === 'dependency-queued' && d.queueItemId !== null && d.heldBy?.elicitationId !== e.elicitationId)
      if (e.reason === 'choice-with-default' && queued) {
        return { ...d, heldBy }
      }
      // Waiting for the answer to a clarification question is a pause for user input (glossary · "Paused"),
      // before the work starts or after a run stopped to ask (Q106). It has no queue item: the question is
      // in the transcript.
      if (e.reason === 'clarification') {
        return {
          ...d,
          state: 'paused',
          heldBy,
          pause: { reason: 'awaiting-input', elicitationId: e.elicitationId },
          queueItemId: null,
          waitingFor: [],
          heldByBarrier: false,
          retry: null,
        }
      }
      return { ...d, state: 'awaiting-elicitation', heldBy, queueItemId: null, waitingFor: [], heldByBarrier: false }
    }),

  'directive-ready': (state, e) =>
    withDirective(state, e.directiveId, (d) => ({
      ...d,
      state: 'ready',
      waitingFor: [],
      heldByBarrier: false,
      pause: null,
      heldBy: null,
      retry: null,
      slotHeld: false,
    })),

  'directive-slot-held': (state, e) =>
    withDirective(state, e.directiveId, (d) => (d.state === 'ready' && !d.slotHeld ? { ...d, slotHeld: true } : d)),

  'directive-cancelled': (state, e) => {
    const directive = state.directives[e.directiveId]
    if (!directive) return state
    const next = withDirective(state, e.directiveId, (d) => ({
      ...d,
      state: 'cancelled',
      queueItemId: null,
      waitingFor: [],
      heldByBarrier: false,
      pause: null,
      heldBy: null,
      retry: null,
    }))
    return markVisible(next, directive.sectionId)
  },

  'directive-stopped': (state, e) => {
    const next = withDirective(state, e.directiveId, (d) => ({ ...d, state: 'stopped', retry: null, pause: null, heldBy: null }))
    return markVisible(next, e.sectionId)
  },

  'directive-revised-in-place': (state, e) =>
    withDirective(state, e.directiveId, (d) => ({
      ...d,
      revised: true,
      // The request changed: a `ready` finding was about the old one, so it is established again before the
      // run (Q103). A question already asked stays asked.
      readiness: d.readiness?.readiness.kind === 'ready' ? null : d.readiness,
      revisedInstruction: { instruction: e.instruction, requirements: e.requirements },
    })),

  'directive-labeled': (state, e) => withDirective(state, e.directiveId, (d) => ({ ...d, label: e.label })),

  'prerequisites-changed': (state, e) => withDirective(state, e.directiveId, (d) => ({ ...d, prerequisites: e.prerequisites })),

  'prerequisite-waived': (state, e) =>
    withDirective(state, e.directiveId, (d) => ({ ...d, waived: append(d.waived, e.waivedDirectiveId) })),

  'retry-requested': (state, e) => withDirective(state, e.directiveId, (d) => ({ ...d, nextOrigin: 'user-retry' })),

  'stop-requested': (state) => state,

  // ── attempts ──
  'attempt-started': (state, e) => {
    const attempt: AttemptRow = {
      id: e.attemptId,
      directiveId: e.directiveId,
      sectionId: e.sectionId,
      nodeId: e.nodeId,
      chainId: e.chainId,
      operationId: e.operationId,
      number: e.number,
      origin: e.origin,
      modelRole: e.modelRole,
      model: e.model,
      parents: e.parents,
      context: e.context,
      state: 'running',
      startedAt: e.at,
      startedSeq: e.seq,
      endedAt: null,
      failure: null,
      retry: null,
      chunks: 0,
      finishReason: null,
      usage: null,
      pausedFor: null,
    }
    let next: ConversationState = {
      ...state,
      attempts: put(state.attempts, e.attemptId, attempt),
      attemptText: put(state.attemptText, e.attemptId, ''),
    }
    next = withDirective(next, e.directiveId, (d) => ({
      ...d,
      state: 'running',
      attemptIds: append(d.attemptIds, e.attemptId),
      queueItemId: null,
      waitingFor: [],
      heldByBarrier: false,
      retry: null,
      nextOrigin: 'initial',
    }))
    next = withSection(next, e.sectionId, (s) => ({ ...s, attemptIds: append(s.attemptIds, e.attemptId) }))
    next = withNode(next, e.nodeId, (n) =>
      n.directiveId === e.directiveId
        ? { ...n, attemptIds: append(n.attemptIds, e.attemptId), startedParents: e.parents }
        : n,
    )
    return next
  },

  'attempt-output': (state, e) => {
    const attempt = state.attempts[e.attemptId]
    if (!attempt) return state
    let next: ConversationState = {
      ...state,
      attemptText: put(state.attemptText, e.attemptId, (state.attemptText[e.attemptId] ?? '') + e.text),
    }
    next = withAttempt(next, e.attemptId, (a) => ({
      ...a,
      chunks: a.chunks + 1,
      state: a.state === 'running' ? 'streaming' : a.state,
    }))
    next = withSection(next, attempt.sectionId, (s) =>
      s.visibleOutput && s.hasText ? s : { ...s, visibleOutput: true, hasText: true },
    )
    return next
  },

  'attempt-completed': (state, e) => {
    let next = withAttempt(state, e.attemptId, (a) => ({
      ...a,
      state: 'completed',
      endedAt: e.at,
      finishReason: e.finishReason,
      usage: e.usage,
    }))
    const current = forCurrentSection(next, e.attemptId)
    if (current) {
      next = withDirective(next, current.directive.id, (d) => ({ ...d, state: 'completed', resultAttemptId: e.attemptId }))
    }
    return next
  },

  'attempt-failed': (state, e) => {
    let next = withAttempt(state, e.attemptId, (a) => ({ ...a, state: 'failed', endedAt: e.at, failure: e.error, retry: e.retry }))
    const current = forCurrentSection(next, e.attemptId)
    if (!current) return next
    const plan = e.retry
    if (plan.kind === 'none') {
      next = withDirective(next, current.directive.id, (d) => ({ ...d, state: 'failed', retry: null }))
      next = markVisible(next, current.attempt.sectionId)
    } else {
      next = withDirective(next, current.directive.id, (d) => ({
        ...d,
        state: plan.wait === 'rate-limit' ? 'waiting-for-capacity' : 'retrying',
        retry: { at: plan.at, wait: plan.wait, retryNumber: plan.retryNumber },
        nextOrigin: 'automatic-retry',
      }))
    }
    return next
  },

  // The directive's own pause follows in the same step (`directive-held`, reason `clarification`).
  // A run that stopped to ask before writing anything leaves a status-only bubble, which is dropped
  // when the answer opens its own response; one that wrote text keeps it as labeled partial text.
  'attempt-paused': (state, e) =>
    withAttempt(state, e.attemptId, (a) => ({
      ...a,
      state: 'paused',
      endedAt: e.at,
      usage: e.usage,
      pausedFor: { reason: e.reason, question: e.question },
    })),

  'attempt-stopped': (state, e) => {
    let next = withAttempt(state, e.attemptId, (a) => ({ ...a, state: 'stopped', endedAt: e.at }))
    const current = forCurrentSection(next, e.attemptId)
    if (!current) return next
    next = withDirective(next, current.directive.id, (d) => ({ ...d, state: 'stopped', retry: null }))
    return markVisible(next, current.attempt.sectionId)
  },

  'attempt-interrupted': (state, e) => {
    let next = withAttempt(state, e.attemptId, (a) => ({ ...a, state: 'interrupted', endedAt: e.at, retry: e.retry }))
    const current = forCurrentSection(next, e.attemptId)
    if (!current) return next
    const plan = e.retry
    if (plan.kind === 'none') {
      next = withDirective(next, current.directive.id, (d) => ({ ...d, state: 'interrupted', retry: null }))
      next = markVisible(next, current.attempt.sectionId)
    } else {
      next = withDirective(next, current.directive.id, (d) => ({
        ...d,
        state: plan.wait === 'rate-limit' ? 'waiting-for-capacity' : 'retrying',
        retry: { at: plan.at, wait: plan.wait, retryNumber: plan.retryNumber },
        nextOrigin: 'interruption-recovery',
      }))
    }
    return next
  },

  'context-limit-warned': (state, e) => {
    const attempt = state.attempts[e.attemptId]
    if (!attempt) return state
    return withSection(state, attempt.sectionId, (s) => ({
      ...s,
      contextWarning: { attemptId: e.attemptId, inputTokens: e.inputTokens, tokenLimit: e.tokenLimit },
    }))
  },

  // ── responses, sections, placement ──
  'response-opened': (state, e) => {
    const existing = state.responses[e.responseId]
    const row: ResponseRow = {
      id: e.responseId,
      messageId: e.messageId,
      opened: true,
      reason: e.reason,
      grouped: e.grouped,
      sectionOrder: e.sectionOrder,
      placed: existing?.placed ?? false,
      sectionIds: existing?.sectionIds ?? [],
      placedSectionIds: existing?.placedSectionIds ?? [],
    }
    const next: ConversationState = {
      ...state,
      responses: put(state.responses, e.responseId, row),
      responseOrder: existing ? state.responseOrder : [...state.responseOrder, e.responseId],
    }
    return withMessage(next, e.messageId, (m) => ({ ...m, responseIds: append(m.responseIds, e.responseId) }))
  },

  'section-opened': (state, e) => {
    const directive = state.directives[e.directiveId]
    const section: SectionRow = {
      id: e.sectionId,
      directiveId: e.directiveId,
      responseId: e.responseId,
      title: e.title,
      replacesSectionId: e.replacesSectionId,
      operationId: e.operationId,
      explicitPosition: e.explicitPosition,
      openedOnChainId: directive ? directive.chainId : ('' as ChainId),
      placed: false,
      visibleOutput: false,
      hasText: false,
      attemptIds: [],
      supersession: null,
      supersededInputs: null,
      contextWarning: null,
    }
    let next: ConversationState = {
      ...state,
      sections: put(state.sections, e.sectionId, section),
      operations: put(state.operations, e.operationId, {
        id: e.operationId,
        kind: 'section',
        sectionId: e.sectionId,
        groupId: null,
      }),
      operationOrder: append(state.operationOrder, e.operationId),
    }
    next = withResponse(next, e.responseId, (r) => ({ ...r, sectionIds: append(r.sectionIds, e.sectionId) }))
    next = withDirective(next, e.directiveId, (d) => ({
      ...d,
      sectionId: e.sectionId,
      sectionIds: append(d.sectionIds, e.sectionId),
      resultAttemptId: d.sectionId === e.sectionId ? d.resultAttemptId : null,
    }))
    return next
  },

  'response-placed': (state, e) => {
    const response = state.responses[e.responseId]
    if (!response || response.placed) return state
    return {
      ...state,
      responses: put(state.responses, e.responseId, { ...response, placed: true }),
      fixedOrder: state.fixedOrder.some((r) => sameRef(r, { kind: 'response', id: e.responseId }))
        ? state.fixedOrder
        : [...state.fixedOrder, { kind: 'response', id: e.responseId }],
    }
  },

  'section-placed': (state, e) => {
    const section = state.sections[e.sectionId]
    if (!section || section.placed) return state
    const next = withSection(state, e.sectionId, (s) => ({ ...s, placed: true }))
    return withResponse(next, section.responseId, (r) => ({ ...r, placedSectionIds: append(r.placedSectionIds, e.sectionId) }))
  },

  'section-superseded': (state, e) => {
    let next = withSection(state, e.sectionId, (s) => ({
      ...s,
      supersession: {
        cause: e.cause,
        endedAttemptId: e.endedAttemptId,
        hadVisibleOutput: e.hadVisibleOutput,
        wasFinished: e.wasFinished,
        replacementSectionId: e.replacementSectionId,
      },
    }))
    if (e.endedAttemptId !== null) {
      next = withAttempt(next, e.endedAttemptId, (a) =>
        a.state === 'running' || a.state === 'streaming' ? { ...a, state: 'superseded', endedAt: e.at } : a,
      )
    }
    const cause = e.cause
    next = withDirective(next, e.directiveId, (d) => {
      if (cause.kind === 'undo-split') return { ...d, state: 'superseded', queueItemId: null, waitingFor: [], retry: null }
      const origin =
        cause.kind === 'revision'
          ? 'revision'
          : cause.kind === 'prerequisite-revised'
            ? 'prerequisite-revised'
            : cause.kind === 'regenerate'
              ? 'regenerate'
              : cause.kind === 'clarified'
                ? 'clarified'
                : 'redo'
      return {
        ...d,
        nextOrigin: origin,
        retry: null,
        resultAttemptId: d.sectionId === e.sectionId ? null : d.resultAttemptId,
      }
    })
    return next
  },

  'superseded-input-noted': (state, e) =>
    withSection(state, e.sectionId, (s) => ({ ...s, supersededInputs: { attemptId: e.attemptId, inputs: e.inputs } })),

  // ── revisions ──
  'revision-recorded': (state, e) => {
    let next: ConversationState = {
      ...state,
      revisions: [
        ...state.revisions,
        {
          messageId: e.messageId,
          scope: e.scope,
          correction: e.correction,
          fragmentId: e.fragmentId,
          targets: e.targets,
          requirementIds: e.requirementIds,
          seq: e.seq,
        },
      ],
    }
    for (const target of e.targets) {
      next = withDirective(next, target.directiveId, (d) => ({
        ...d,
        corrections: [...d.corrections, { revisionMessageId: e.messageId, text: e.correction, seq: e.seq }],
      }))
      next = withMessage(next, e.messageId, (m) => ({ ...m, revisedDirectiveIds: append(m.revisedDirectiveIds, target.directiveId) }))
    }
    return next
  },

  'regenerate-requested': (state) => state,

  // ── elicitations ──
  'elicitation-raised': (state, e) => {
    const record = e.elicitation
    const selected =
      record.kind === 'choice-with-default' ? record.options.filter((o) => o.preselected || o.locked).map((o) => o.directiveId) : []
    let next: ConversationState = {
      ...state,
      elicitations: put(state.elicitations, record.elicitationId, {
        id: record.elicitationId,
        record,
        raisedAt: e.at,
        status: 'open',
        selected,
        resolution: null,
        defaulted: null,
      }),
      elicitationOrder: append(state.elicitationOrder, record.elicitationId),
    }
    if (record.kind === 'target-ambiguity') {
      next = withMessage(next, record.messageId, (m) => ({ ...m, routing: 'awaiting-target' }))
    }
    return next
  },

  'elicitation-edited': (state, e) => ({
    ...state,
    elicitations: patch(state.elicitations, e.elicitationId, (el) => {
      if (el.record.kind !== 'choice-with-default') return el
      const locked = el.record.options.filter((o) => o.locked).map((o) => o.directiveId)
      return { ...el, selected: [...new Set([...locked, ...e.redo])] }
    }),
  }),

  'elicitation-answered': (state, e) => {
    const elicitation = state.elicitations[e.elicitationId]
    if (!elicitation) return state
    let next: ConversationState = {
      ...state,
      elicitations: put(state.elicitations, e.elicitationId, { ...elicitation, status: 'answered', resolution: e.resolution }),
    }
    const record = elicitation.record
    if (record.kind === 'target-ambiguity') {
      next = withMessage(next, record.messageId, (m) => ({ ...m, routing: 'routing' }))
    }
    if (record.kind === 'clarification' && e.resolution.kind === 'clarification') {
      const answerMessageId = e.resolution.answerMessageId
      for (const id of record.blockedDirectiveIds) {
        next = withDirective(next, id, (d) => ({ ...d, clarification: { elicitationId: e.elicitationId, answerMessageId } }))
      }
      next = withMessage(next, answerMessageId, (m) => {
        let released = m.releasedDirectiveIds
        for (const id of record.blockedDirectiveIds) released = append(released, id)
        return { ...m, releasedDirectiveIds: released }
      })
    }
    if (record.kind === 'choice-with-default' && e.resolution.kind === 'choice-with-default') {
      const locked = record.options.filter((o) => o.locked).map((o) => o.directiveId)
      const selected = [...new Set([...locked, ...e.resolution.redo])]
      next = { ...next, elicitations: patch(next.elicitations, e.elicitationId, (el) => ({ ...el, selected })) }
    }
    return next
  },

  'elicitation-defaulted': (state, e) => ({
    ...state,
    elicitations: patch(state.elicitations, e.elicitationId, (el) => ({
      ...el,
      status: 'defaulted',
      defaulted: { trigger: e.trigger, redo: e.redo },
      selected: el.record.kind === 'choice-with-default'
        ? [...new Set([...el.record.options.filter((o) => o.locked).map((o) => o.directiveId), ...e.redo])]
        : el.selected,
    })),
  }),

  'elicitation-withdrawn': (state, e) => ({
    ...state,
    elicitations: patch(state.elicitations, e.elicitationId, (el) => ({ ...el, status: 'withdrawn' })),
  }),
}

export { REDUCERS }

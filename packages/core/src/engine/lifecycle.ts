import {
  deepEqual,
  type AttemptId,
  type ConversationEvent,
  type DirectiveId,
  type MessageId,
  type PlacementCause,
  type PrerequisiteRef,
  type ProviderError,
  type RetryPlan,
  type SectionId,
  type SiblingGroupId,
  type SupersessionCause,
} from '@committee/protocol'
import type { JsonValue } from '../ports'
import type { CommandHandlers, Reaction, RetryPlanner, RouteOptions, RoutingRetryPlanner, StartupReaction, StepContext, TimerHandler } from './module'
import {
  activeMembers,
  awaitingInput,
  barrierOf,
  currentJoinBack,
  currentResult,
  groupCanClose,
  groupOfDirective,
  isLateRetryNode,
  isStartedUnsettled,
  messageVisible,
  routeOptionsFor,
  sectionState,
  unfinishedOutcome,
  unsatisfiedPrerequisites,
} from './queries'
import type { ConversationState, DirectiveRow } from './state'

/**
 * The attempt lifecycle and the engine's reactions: first states and
 * releases, the whole-request barrier, the closing rule, placement at first
 * visible output, scheduled retries, stop, retry, interruption on start.
 * The primitives at the top are exported for the later slices.
 */

export const RETRY_TIMER = 'engine.retry'
export const ROUTE_RETRY_TIMER = 'engine.route-retry'

// ───────────────────────────── routing retries ─────────────────────────────

/** The engine's routing retry planner until a slice supplies the policies: never retry; Retry is offered. */
export const defaultRoutingRetryPlanner: RoutingRetryPlanner = () => null

/** Schedules the next try of a message's routing after a transient failure; false when none is due. */
export function scheduleRoutingRetry(ctx: StepContext, messageId: MessageId, error: ProviderError, options: RouteOptions): boolean {
  const used = options.routingRetry ?? 0
  const at = ctx.routingRetryAt(error, used)
  if (at === null) return false
  const payload: RouteRetryPayload = {
    messageId,
    routingRetry: used + 1,
    chosenTargets: options.chosenTargets ? [...options.chosenTargets] : null,
    forcedComposition: options.forcedComposition ?? null,
  }
  ctx.setTimer(ROUTE_RETRY_TIMER, `route:${messageId}`, at, payload)
  return true
}

interface RouteRetryPayload {
  readonly messageId: MessageId
  readonly routingRetry: number
  readonly chosenTargets: SectionId[] | null
  readonly forcedComposition: 'atomic' | null
  readonly [key: string]: JsonValue
}

/** The next try of a routing that failed transiently is due: route again, if the message still waits. */
const routeRetryTimer: TimerHandler = (state, payload, ctx) => {
  const p = payload as unknown as RouteRetryPayload
  if (state.messages[p.messageId]?.routing !== 'routing') return
  ctx.route(p.messageId, {
    routingRetry: p.routingRetry,
    ...(p.chosenTargets ? { chosenTargets: p.chosenTargets } : {}),
    ...(p.forcedComposition ? { forcedComposition: p.forcedComposition } : {}),
  })
}

// ───────────────────────────── waiting and release ─────────────────────────────

export type WaitDecision =
  | { readonly kind: 'ready' }
  | { readonly kind: 'waiting'; readonly waitingFor: readonly PrerequisiteRef[]; readonly heldByBarrier: boolean }

/**
 * Whether a directive that has not started may run now. Its own unsatisfied
 * prerequisites first (released only by success, invariant 4); then the
 * whole-request barrier of its message: if another part is blocked, it
 * waits for what that part waits for (Q19, Q25). Clarification questions
 * are never held by the barrier (Q26, E1).
 */
export function computeWait(state: ConversationState, d: DirectiveRow): WaitDecision {
  const own = unsatisfiedPrerequisites(state, d)
  if (own.length > 0) return { kind: 'waiting', waitingFor: own, heldByBarrier: false }
  if (d.kind !== 'answer') return { kind: 'ready' }
  const barrier = barrierOf(state, d.originalMessageId)
  if (!barrier || !barrier.directiveIds.includes(d.id)) return { kind: 'ready' }
  const refs: PrerequisiteRef[] = []
  let blocked = false
  // A part that waits only on other parts of its own request is not blocked: those parts run, and
  // holding them for it would make the first part wait for itself (02 · "A fragment that needs
  // nothing unavailable proceeds at once"). Only a wait outside the request, a pause or a
  // clarification blocks the whole request.
  const inRequest = new Set(barrier.directiveIds)
  const external = (ref: PrerequisiteRef): boolean => !(ref.kind === 'directive' && inRequest.has(ref.directiveId))
  for (const id of barrier.directiveIds) {
    if (id === d.id) continue
    const other = state.directives[id]
    if (!other) continue
    const notStarted = other.attemptIds.length === 0
    if (other.state === 'awaiting-elicitation' || awaitingInput(other)) {
      // Held for the user's answer: the queue item names the part it waits on (Q19).
      blocked = true
      pushRef(refs, { kind: 'directive', directiveId: other.id })
      for (const ref of unsatisfiedPrerequisites(state, other).filter(external)) pushRef(refs, ref)
    } else if (other.state === 'paused') {
      blocked = true
      for (const ref of unsatisfiedPrerequisites(state, other)) pushRef(refs, ref)
    } else if (notStarted && (other.state === 'dependency-queued' || other.state === 'ready')) {
      const theirs = unsatisfiedPrerequisites(state, other).filter(external)
      if (theirs.length > 0) {
        blocked = true
        for (const ref of theirs) pushRef(refs, ref)
      }
    }
  }
  return blocked ? { kind: 'waiting', waitingFor: refs, heldByBarrier: true } : { kind: 'ready' }
}

function pushRef(list: PrerequisiteRef[], ref: PrerequisiteRef): void {
  if (!list.some((r) => deepEqual(r, ref))) list.push(ref)
}

/**
 * Emits `directive-ready` or `directive-waiting` for a directive that has not
 * started, when that differs from what it is (or always, with `force`). The
 * queue item keeps one ID for as long as the directive waits.
 */
export function settleWait(ctx: StepContext, directiveId: DirectiveId, force = false): void {
  const d = ctx.state.directives[directiveId]
  if (!d) return
  const decision = computeWait(ctx.state, d)
  if (decision.kind === 'ready') {
    // Held for an elicitation still open: it waits for the answer alone (07).
    if (d.heldBy && ctx.state.elicitations[d.heldBy.elicitationId]?.status === 'open') {
      const held = d.heldBy.reason === 'clarification' ? awaitingInput(d) : d.state === 'awaiting-elicitation'
      if (!held) {
        ctx.emit({ type: 'directive-held', directiveId, elicitationId: d.heldBy.elicitationId, reason: d.heldBy.reason })
      }
      return
    }
    if (force || d.state !== 'ready') ctx.emit({ type: 'directive-ready', directiveId })
    return
  }
  const same =
    d.state === 'dependency-queued' &&
    d.queueItemId !== null &&
    d.heldByBarrier === decision.heldByBarrier &&
    deepEqual(d.waitingFor, decision.waitingFor)
  if (!force && same) return
  ctx.emit({
    type: 'directive-waiting',
    directiveId,
    queueItemId: d.queueItemId ?? ctx.ids.next('queueItem'),
    waitingFor: decision.waitingFor,
    heldByBarrier: decision.heldByBarrier,
    revised: d.revised,
  })
}

/** True when the directive's current section has no attempt yet: it is queued work, not a pending retry. */
export function notStartedInSection(state: ConversationState, d: DirectiveRow): boolean {
  const section = d.sectionId ? state.sections[d.sectionId] : undefined
  return (section?.attemptIds.length ?? 0) === 0
}

/**
 * Started work that has not settled: running, between automatic retries,
 * waiting for capacity, or ready again for a retry that has not started yet
 * (its section already holds attempts). Stop marks such work stopped, never
 * cancelled (08 · "Four ways work ends").
 */
export function startedInSection(state: ConversationState, d: DirectiveRow): boolean {
  if (isStartedUnsettled(d.state)) return true
  // Ready again for a retry, or paused for input after a run stopped to ask (Q106): the section holds attempts.
  return (d.state === 'ready' || awaitingInput(d)) && d.sectionId !== null && !notStartedInSection(state, d)
}

/** First states, releases and refreshed waits, for every directive that has not started. */
const waitReaction: Reaction = (_state, event, ctx) => {
  // Streamed text never changes what anything waits for (C13), and it is by far the most frequent event.
  if (event.type === 'attempt-output') return
  for (const id of ctx.state.directiveOrder) {
    const d = ctx.state.directives[id]
    if (!d) continue
    // Work released but not started yet (held by the concurrency limit, say) is still queued: a
    // prerequisite that stops being satisfied (its result was replaced) makes it wait again (06, R3).
    if (d.state === 'dependency-queued' || (d.state === 'ready' && notStartedInSection(ctx.state, d))) settleWait(ctx, id)
  }
}

// ───────────────────────────── sibling groups ─────────────────────────────

/**
 * Forms the group's join-back from its counting members in submission order
 * (C4): completed members with their result, the others with their marker
 * (Q49, Q92). With `replacing`, records a new formation for a group that had
 * closed already (a member was revised); members are never added.
 */
export function formJoinBack(ctx: StepContext, groupId: SiblingGroupId, replacing = false): void {
  const group = ctx.state.groups[groupId]
  if (!group) return
  const previous = currentJoinBack(ctx.state, groupId)
  if (replacing && !previous) return
  const members = activeMembers(group).map((m) => {
    const d = ctx.state.directives[m.directiveId]
    // A member whose work now runs on a late-retry node keeps its entry (its marker): the retry's
    // exchange follows the record as its tail, never inside it (08, Q92).
    const kept = replacing && d && d.nodeId !== m.nodeId && isLateRetryNode(ctx.state, d.nodeId)
      ? previous?.members.find((pm) => pm.directiveId === m.directiveId)
      : undefined
    if (kept) return kept
    const result = currentResult(ctx.state, m.directiveId)
    const outcome = result ? ('completed' as const) : d ? (unfinishedOutcome(d.state) ?? 'failed') : 'failed'
    return { directiveId: m.directiveId, nodeId: m.nodeId, outcome, attemptId: result }
  })
  ctx.emit({
    type: 'join-back-formed',
    joinBackId: ctx.ids.next('joinBack'),
    nodeId: ctx.ids.next('node'),
    groupId,
    chainId: group.baseChainId,
    members,
    replacesJoinBackId: replacing && previous ? previous.id : null,
  })
}

/** The closing rule: an open group closes once every counting member has settled (Q49, Q92). */
const groupClosingReaction: Reaction = (_state, event, ctx) => {
  if (event.type === 'attempt-output') return
  for (const group of Object.values(ctx.state.groups)) {
    if (groupCanClose(ctx.state, group)) formJoinBack(ctx, group.id)
  }
}

// ───────────────────────────── placement ─────────────────────────────

/**
 * Fixes a section, and its response, at first visible output: answer text,
 * a failure notice, or the mark of work that ended without output (Q14,
 * Q51). Status text never does (03).
 */
export function placeSection(ctx: StepContext, sectionId: SectionId, cause: PlacementCause): void {
  const section = ctx.state.sections[sectionId]
  if (!section || section.supersession) return
  const response = ctx.state.responses[section.responseId]
  if (!response) return
  if (response.grouped && response.sectionOrder === 'first-output' && !section.placed) {
    ctx.emit({ type: 'section-placed', sectionId, cause })
  }
  if (!response.placed) ctx.emit({ type: 'response-placed', responseId: response.id, cause })
}

const placementReaction: Reaction = (state, event, ctx) => {
  const at = (attemptId: AttemptId): SectionId | null => state.attempts[attemptId]?.sectionId ?? null
  let sectionId: SectionId | null = null
  let cause: PlacementCause = 'first-output'
  switch (event.type) {
    case 'attempt-output':
      sectionId = at(event.attemptId)
      break
    case 'attempt-failed':
      if (event.retry.kind === 'none') {
        sectionId = at(event.attemptId)
        cause = 'failure-notice'
      }
      break
    case 'attempt-stopped':
      sectionId = at(event.attemptId)
      cause = 'ended-without-output'
      break
    case 'attempt-interrupted':
      if (event.retry.kind === 'none') {
        sectionId = at(event.attemptId)
        cause = 'ended-without-output'
      }
      break
    case 'directive-cancelled':
      sectionId = state.directives[event.directiveId]?.sectionId ?? null
      cause = 'ended-without-output'
      break
    case 'directive-stopped':
      sectionId = event.sectionId
      cause = 'ended-without-output'
      break
    default:
      return
  }
  if (sectionId !== null && ctx.state.sections[sectionId]?.visibleOutput) placeSection(ctx, sectionId, cause)
}

// ───────────────────────────── scheduled retries ─────────────────────────────

function retryKey(directiveId: DirectiveId): string {
  return `retry:${directiveId}`
}

const retryTimerReaction: Reaction = (state, event, ctx) => {
  switch (event.type) {
    case 'attempt-failed':
    case 'attempt-interrupted': {
      const directiveId = state.attempts[event.attemptId]?.directiveId
      if (directiveId && event.retry.kind === 'scheduled') {
        ctx.setTimer(RETRY_TIMER, retryKey(directiveId), event.retry.at, { directiveId, at: event.retry.at })
      }
      return
    }
    case 'directive-stopped':
    case 'directive-cancelled':
    case 'directive-ready':
    case 'section-superseded':
      ctx.cancelTimer(retryKey(event.directiveId))
      return
    default:
      return
  }
}

/** A scheduled automatic retry is due: the directive is ready again, in the same section. */
const retryTimer: TimerHandler = (state, payload, ctx) => {
  const { directiveId, at } = payload as { directiveId: DirectiveId; at: number }
  const d = state.directives[directiveId]
  if (!d || (d.state !== 'retrying' && d.state !== 'waiting-for-capacity') || d.retry?.at !== at) return
  ctx.emit({ type: 'directive-ready', directiveId })
}

// ───────────────────────────── supersession ─────────────────────────────

/**
 * Replaces a section (Q35, Q38): ends a running attempt (superseded, not
 * stopped), and records whether anything had been visible, so the
 * transcript drops a status-only bubble and collapses partial text. The
 * caller opens the replacement in the same step (or, for Undo split,
 * withdraws the work).
 */
export function supersedeSection(
  ctx: StepContext,
  sectionId: SectionId,
  cause: SupersessionCause,
  replacementSectionId: SectionId | null,
): void {
  const section = ctx.state.sections[sectionId]
  if (!section || section.supersession) return
  const latest = section.attemptIds[section.attemptIds.length - 1]
  const live = latest && ['running', 'streaming'].includes(ctx.state.attempts[latest]?.state ?? '') ? latest : null
  if (live) ctx.flushOutput(live)
  const wasFinished = sectionState(ctx.state, sectionId) === 'completed'
  ctx.emit({
    type: 'section-superseded',
    sectionId,
    directiveId: section.directiveId,
    endedAttemptId: live,
    hadVisibleOutput: ctx.state.sections[sectionId]?.visibleOutput ?? section.visibleOutput,
    wasFinished,
    cause,
    replacementSectionId,
  })
  if (live) ctx.abortAttempt(live)
}

// ───────────────────────────── stop ─────────────────────────────

/** The live attempt of a directive's current section, if one is in flight. */
export function liveAttempt(state: ConversationState, d: DirectiveRow): AttemptId | null {
  const section = d.sectionId ? state.sections[d.sectionId] : undefined
  const latest = section?.attemptIds[section.attemptIds.length - 1]
  if (!latest) return null
  const attempt = state.attempts[latest]
  return attempt && (attempt.state === 'running' || attempt.state === 'streaming') ? latest : null
}

/**
 * Stop, by the table of PLAN §2: a live attempt is stopped; started work
 * between attempts is stopped; work that never started is cancelled; settled
 * work is untouched. Dependents outside the scope are never cancelled (Q48).
 */
export function stopWork(
  ctx: StepContext,
  target: { readonly kind: 'section'; readonly sectionId: SectionId } | { readonly kind: 'request'; readonly messageId: MessageId },
): void {
  const scope = target.kind
  let directives: DirectiveId[] = []
  if (target.kind === 'section') {
    const section = ctx.state.sections[target.sectionId]
    const d = section ? ctx.state.directives[section.directiveId] : undefined
    if (d && d.sectionId === target.sectionId) directives = [d.id]
  } else {
    directives = [...(ctx.state.messages[target.messageId]?.directiveIds ?? [])]
  }
  ctx.emit({ type: 'stop-requested', target })
  for (const id of directives) {
    const d = ctx.state.directives[id]
    if (!d) continue
    if (d.state === 'running') {
      const live = liveAttempt(ctx.state, d)
      if (!live) continue
      ctx.flushOutput(live)
      ctx.emit({ type: 'attempt-stopped', attemptId: live, scope })
      ctx.abortAttempt(live)
    } else if (startedInSection(ctx.state, d)) {
      // Started work always has a section; work held for a clarification may not, and is cancelled below.
      if (d.sectionId === null) continue
      ctx.emit({ type: 'directive-stopped', directiveId: id, sectionId: d.sectionId, scope })
    } else if (['dependency-queued', 'paused', 'ready', 'awaiting-elicitation'].includes(d.state)) {
      ctx.emit({ type: 'directive-cancelled', directiveId: id, cause: scope === 'request' ? 'request-stopped' : 'section-stopped' })
    }
  }
}

// ───────────────────────────── retry ─────────────────────────────

/** Failed, stopped, interrupted or cancelled, and not retrying on its own: Retry applies (Q50). */
export function isRetryable(d: DirectiveRow): boolean {
  return unfinishedOutcome(d.state) !== null
}

/**
 * A user retry of one directive in its same section (Q51, Q83). A member
 * whose sibling group has closed is retried as a descendant of the
 * join-back: its first such retry gets a node of its own on the base chain,
 * a child of the join-back node, and later retries reuse it (Q92).
 */
export function retryDirective(ctx: StepContext, directiveId: DirectiveId, scope: 'section' | 'request'): void {
  const d = ctx.state.directives[directiveId]
  if (!d || d.sectionId === null) return
  const group = groupOfDirective(ctx.state, directiveId)
  const node = ctx.state.nodes[d.nodeId]
  const late = group !== null && group.state === 'closed' && node?.reason !== 'retry-after-closure'
  ctx.emit({ type: 'retry-requested', directiveId, sectionId: d.sectionId, scope, placement: late ? 'after-join-back' : 'in-place' })
  if (late && group) {
    const joinBack = currentJoinBack(ctx.state, group.id)
    if (joinBack) {
      ctx.emit({
        type: 'node-created',
        nodeId: ctx.ids.next('node'),
        chainId: group.baseChainId,
        directiveId,
        reason: 'retry-after-closure',
        plannedParents: [{ kind: 'node', nodeId: joinBack.nodeId }],
        replacesNodeId: null,
      })
    }
  }
  settleWait(ctx, directiveId, true)
}

// ───────────────────────────── commands ─────────────────────────────

export const engineCommands: CommandHandlers = {
  'submit-message': (state, command, ctx) => {
    if (command.text.trim() === '') return { code: 'invalid', message: 'A message cannot be empty' }
    const targets = command.targets ?? []
    for (const id of targets) {
      if (!state.sections[id]) return { code: 'unknown-target', message: `Unknown section ${id}` }
    }
    const messageId = ctx.ids.next('message')
    ctx.emit({
      type: 'message-submitted',
      messageId,
      text: command.text,
      explicitTargets: targets,
      responseId: ctx.ids.next('response'),
    })
    ctx.route(messageId)
    return { events: [], output: { messageId } }
  },

  stop: (state, command, ctx) => {
    const target = command.target
    if (target.kind === 'section' && !state.sections[target.sectionId]) {
      return { code: 'unknown-target', message: `Unknown section ${target.sectionId}` }
    }
    if (target.kind === 'request' && !state.messages[target.messageId]) {
      return { code: 'unknown-target', message: `Unknown request ${target.messageId}` }
    }
    stopWork(ctx, target)
    return []
  },

  retry: (state, command, ctx) => {
    const target = command.target
    if (target.kind === 'request') {
      const message = state.messages[target.messageId]
      if (!message) return { code: 'unknown-target', message: `Unknown request ${target.messageId}` }
      if (message.routing === 'failed') {
        ctx.emit({ type: 'routing-retried', messageId: message.id })
        ctx.route(message.id, routeOptionsFor(ctx.state, message.id))
        return []
      }
      const retryable = message.directiveIds.filter((id) => {
        const d = state.directives[id]
        return d !== undefined && isRetryable(d)
      })
      if (retryable.length === 0) return { code: 'not-allowed', message: 'Nothing in this request is unfinished' }
      for (const id of retryable) retryDirective(ctx, id, 'request')
      return []
    }
    const section = state.sections[target.sectionId]
    if (!section) return { code: 'unknown-target', message: `Unknown section ${target.sectionId}` }
    const d = state.directives[section.directiveId]
    if (!d || d.sectionId !== section.id || !isRetryable(d)) {
      return { code: 'not-allowed', message: 'This section cannot be retried' }
    }
    retryDirective(ctx, d.id, 'section')
    return []
  },
}

// ───────────────────────────── start ─────────────────────────────

/**
 * What `start()` recovers for a conversation (invariant 8): attempts lost
 * with the previous executor are interrupted and retried or left with Retry
 * by the retry planner (Q52, Q54); messages that lost their routing are
 * routed again; pending retry timers are set again.
 */
export const engineStartup: StartupReaction = (state, ctx) => {
  for (const id of state.directiveOrder) {
    const d = state.directives[id]
    if (!d) continue
    for (const attemptId of d.attemptIds) {
      const attempt = state.attempts[attemptId]
      if (!attempt || (attempt.state !== 'running' && attempt.state !== 'streaming')) continue
      const current = attempt.sectionId === d.sectionId
      const retry: RetryPlan = current ? ctx.retryPlan(id, { kind: 'interrupted' }) : { kind: 'none', reason: 'manual-policy' }
      ctx.emit({ type: 'attempt-interrupted', attemptId, retry })
    }
    const after = ctx.state.directives[id]
    if (after?.retry && (after.state === 'retrying' || after.state === 'waiting-for-capacity')) {
      ctx.setTimer(RETRY_TIMER, retryKey(id), after.retry.at, { directiveId: id, at: after.retry.at } satisfies JsonValue)
    }
  }
  for (const id of state.messageOrder) {
    const message = state.messages[id]
    if (message && message.routing === 'routing' && messageVisible(state, id)) ctx.route(id, routeOptionsFor(state, id))
  }
}

/**
 * The engine's retry planner until a slice supplies the policies: no
 * automatic retry (`non-retryable` for a non-retryable error, `manual-policy`
 * otherwise). Failures go straight to Retry.
 */
export const defaultRetryPlanner: RetryPlanner = (_state, _directiveId, cause) => {
  if (cause.kind === 'failed' && cause.error.class === 'non-retryable') return { kind: 'none', reason: 'non-retryable' }
  return { kind: 'none', reason: 'manual-policy' }
}

export const engineReactions: readonly Reaction[] = [placementReaction, waitReaction, groupClosingReaction, retryTimerReaction]

export const engineTimers = { [RETRY_TIMER]: retryTimer, [ROUTE_RETRY_TIMER]: routeRetryTimer }

/** For tests and slices: is this event one that settles a directive? */
export function settlesDirective(event: ConversationEvent): boolean {
  // `attempt-paused` is not here: a run that stopped to ask leaves its directive paused, not settled (Q106).
  return [
    'attempt-completed',
    'attempt-failed',
    'attempt-stopped',
    'attempt-interrupted',
    'directive-cancelled',
    'directive-stopped',
  ].includes(event.type)
}

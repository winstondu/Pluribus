import {
  normalizeSettings,
  APP_LOG,
  CONTEXT_WARNING_RATIO,
  DEFAULT_SETTINGS,
  EVENT_SCHEMA_VERSION,
  applySettingsPatch,
  diffSnapshots,
  isConversationEvent,
  provisionalLabel,
  providerError,
  toStreamedEvent,
  upcastEvent,
  validateSettingsPatch,
  type AppEvent,
  type AppEventBody,
  type AppSnapshot,
  type AttemptId,
  type Command,
  type CommandError,
  type CommandResult,
  type ConversationEvent,
  type ConversationEventBody,
  type ConversationId,
  type ConversationSnapshot,
  type ConversationSummary,
  type DirectiveId,
  type MessageId,
  type NodeId,
  type Settings,
  type SnapshotQuery,
  type SnapshotResult,
  type StreamFrame,
  type SubscriptionFilter,
  type Unsubscribe,
} from '@committee/protocol'
import {
  DEFAULT_CORE_OPTIONS,
  createCancelSource,
  type Backend,
  type CancelSource,
  type CancelTimer,
  type ContextSummariser,
  type ContextSummaryProvider,
  type CoreDependencies,
  type CoreOptions,
  type JsonValue,
  type ModelRequest,
  type ModelStreamEvent,
  type Router,
  type RoutingInput,
  type RoutingOutcome,
  type RoutingPlan,
  type SummariseReason,
  type SummariseRequest,
} from '../ports'
import { resolveTargets, routingCandidates, sessionLogTokens, strategySelectionOnRecord } from './candidates'
import { assembleContext, contextChainOf, sessionRequirementsInForce, type AssembledContext } from './context'
import { defaultModules } from './engine-module'
import { defaultRetryPlanner, defaultRoutingRetryPlanner, notStartedInSection, scheduleRoutingRetry, settleWait } from './lifecycle'
import {
  isCommandError,
  type ConversationCommandType,
  type CoreModule,
  type PlanPart,
  type RetryPlanner,
  type RoutingRetryPlanner,
  type RouteOptions,
  type StepContext,
} from './module'
import { checkPlan, nearestSettledAncestor } from './plan'
import { Projector, projectSnapshot, runInspection } from './projections'
import { messageVisible, nodeInFlight, resolvePlannedParents, unsatisfiedPrerequisites } from './queries'
import { fold, reduce } from './reducers'
import { fullChainContextProvider, noContextSummariser } from './summaries'
import { STATE_VERSION, emptyConversationState, type ConversationState } from './state'

/**
 * The coordinator: accepts commands and provider, routing and timer inputs,
 * turns each into one step, and emits the ordered stream of events and
 * projection updates (11 · "Shared interface").
 *
 * A step is: input → events, each applied by its reducer at once →
 * reactions until quiet → append to the event store → projections → one
 * frame to subscribers → effects (model calls, timers, routing), which start
 * only after the step's events are stored. Steps run one at a time, in the
 * order their inputs arrived, across every conversation.
 */

/** What tests and the later slices may observe about a running engine. */
export interface EngineInternals {
  readonly modules: readonly CoreModule[]
  /** The folded state of a conversation, or null. */
  state(conversationId: ConversationId): ConversationState | null
  /** The conversations that are loaded. */
  conversationIds(): ConversationId[]
  /** True when no step is queued and no routing, token count, label or store call is pending. Live streams do not count. */
  isQuiet(): boolean
  /** Resolves when the step queue is empty. */
  drained(): Promise<void>
  /** Attempts with a live provider stream. */
  liveAttempts(): AttemptId[]
}

export interface Engine {
  readonly backend: Backend
  readonly internals: EngineInternals
}

/**
 * Builds the backend. `modules` defaults to the engine followed by every
 * module a slice has registered (`registerCoreModule`). Throws when there is
 * neither `deps.router` nor a module with `createRouter`.
 */
export function createBackend(deps: CoreDependencies, options?: Partial<CoreOptions>, modules?: readonly CoreModule[]): Backend {
  return createEngine(deps, options, modules).backend
}

interface Runtime {
  readonly id: ConversationId
  state: ConversationState
  readonly projector: Projector
  snapshot: ConversationSnapshot
  eventsSinceCache: number
  dirty: boolean
}

interface LiveRun {
  readonly conversationId: ConversationId
  readonly directiveId: DirectiveId
  readonly cancel: CancelSource
  buffer: string
  timer: CancelTimer | null
}

interface Prepared {
  readonly conversationId: ConversationId
  readonly directiveId: DirectiveId
  readonly nodeId: NodeId
  readonly parents: readonly NodeId[]
  readonly context: AssembledContext
  readonly request: ModelRequest
  readonly modelRole: 'answer' | 'synthesis'
}

type Effect =
  | { readonly kind: 'route'; readonly messageId: MessageId; readonly options: RouteOptions }
  | { readonly kind: 'timer'; readonly timerKind: string; readonly key: string; readonly at: number; readonly payload: JsonValue }
  | { readonly kind: 'cancel-timer'; readonly key: string }
  | { readonly kind: 'abort'; readonly attemptId: AttemptId }
  | { readonly kind: 'label'; readonly directiveId: DirectiveId }
  | { readonly kind: 'stream'; readonly attemptId: AttemptId; readonly directiveId: DirectiveId; readonly request: ModelRequest }

const PLAN_PARTS: readonly PlanPart[] = ['units', 'sessionRequirements', 'clarifications', 'revisions', 'answersElicitationId']

function planPartUsed(plan: RoutingPlan, part: PlanPart): boolean {
  switch (part) {
    case 'units':
      return plan.units.length > 0
    case 'sessionRequirements':
      return plan.sessionRequirements.length > 0 || plan.withdrawnSessionRequirementIds.length > 0
    case 'clarifications':
      return plan.clarifications.length > 0
    case 'revisions':
      return plan.revisions.length > 0
    case 'answersElicitationId':
      return plan.answersElicitationId !== null
  }
}

class StepAborted extends Error {
  readonly commandError: CommandError
  constructor(error: CommandError) {
    super(error.message)
    this.commandError = error
  }
}

/**
 * A clarification question runs on the node of the work it blocks, which
 * may wait for a result still being produced. The question reads what that
 * work could read now: each parent still in flight is replaced by its
 * starting context, so it never claims to have consumed an unfinished
 * answer (C3).
 */
function settledParents(state: ConversationState, parents: readonly NodeId[]): NodeId[] {
  const out: NodeId[] = []
  const add = (id: NodeId): void => {
    if (!out.includes(id)) out.push(id)
  }
  for (const parent of parents) {
    if (!nodeInFlight(state, parent)) {
      add(parent)
      continue
    }
    const settled = nearestSettledAncestor(state, parent)
    if (settled.kind === 'node') add(settled.nodeId)
    else if (settled.kind === 'join') for (const p of settled.parents) if (p.kind === 'node') add(p.nodeId)
  }
  return out
}

export function createEngine(deps: CoreDependencies, partialOptions?: Partial<CoreOptions>, moduleList?: readonly CoreModule[]): Engine {
  const options: CoreOptions = { ...DEFAULT_CORE_OPTIONS, ...partialOptions }
  const modules: readonly CoreModule[] = moduleList ?? defaultModules()
  const routerFactory = [...modules].reverse().find((m) => m.createRouter)?.createRouter
  const router: Router | null = deps.router ?? (routerFactory ? routerFactory(deps) : null)
  if (!router) throw new Error('createBackend needs deps.router or a module with createRouter')
  const activeRouter: Router = router
  const summaryProvider: ContextSummaryProvider = deps.contextSummaryProvider ?? fullChainContextProvider
  const summariser: ContextSummariser = deps.contextSummariser ?? noContextSummariser
  const retryPlanner: RetryPlanner = [...modules].reverse().find((m) => m.retryPlanner)?.retryPlanner ?? defaultRetryPlanner
  const routingRetryPlanner: RoutingRetryPlanner =
    [...modules].reverse().find((m) => m.routingRetryPlanner)?.routingRetryPlanner ?? defaultRoutingRetryPlanner

  const runtimes = new Map<ConversationId, Runtime>()
  const live = new Map<AttemptId, LiveRun>()
  const starting = new Map<string, Prepared | null>()
  /** Ready directives whose `directive-slot-held` step is queued but has not run yet. */
  const slotHeldPending = new Set<string>()
  const timers = new Map<string, CancelTimer>()
  const routeTokens = new Map<string, number>()
  /** Routings that wait for an earlier message of their conversation to have a routing outcome (C2). */
  const deferredRoutes = new Map<string, { readonly conversationId: ConversationId; readonly messageId: MessageId; readonly options: RouteOptions }>()
  const listeners = new Set<{ readonly listener: (frame: StreamFrame) => void; readonly filter: SubscriptionFilter }>()

  let settings: Settings = DEFAULT_SETTINGS
  let conversations: ConversationSummary[] = []
  let keyConfigured = false
  let appSeq = 0
  let started = false
  let disposed = false

  // ── the serial queue ──
  let tail: Promise<void> = Promise.resolve()
  let queued = 0
  let pendingEffects = 0

  function enqueue<T>(job: () => Promise<T> | T): Promise<T> {
    queued += 1
    const run = tail.then(async () => {
      try {
        return await job()
      } finally {
        queued -= 1
      }
    })
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  function track<T>(promise: Promise<T>): Promise<T> {
    pendingEffects += 1
    return promise.finally(() => {
      pendingEffects -= 1
    })
  }

  const startKey = (conversationId: ConversationId, directiveId: DirectiveId): string => `${conversationId}|${directiveId}`
  const timerKey = (conversationId: ConversationId, key: string): string => `${conversationId}|${key}`

  // ── app ──
  function appSnapshot(): AppSnapshot {
    return { conversations, settings, key: { configured: keyConfigured } }
  }

  async function appendApp(bodies: readonly AppEventBody[]): Promise<void> {
    if (bodies.length === 0) return
    const now = deps.clock.now()
    const events = bodies.map((body) => {
      appSeq += 1
      return { ...body, id: deps.ids.nextEventId(), log: APP_LOG, seq: appSeq, v: EVENT_SCHEMA_VERSION, at: now } as AppEvent
    })
    try {
      await deps.eventStore.append(APP_LOG, events)
    } catch (error) {
      appSeq -= events.length
      throw error
    }
    for (const event of events) foldApp(event)
    publish({ kind: 'app', events, app: appSnapshot() })
  }

  function foldApp(event: AppEvent): void {
    switch (event.type) {
      case 'conversation-created':
        conversations = [{ id: event.conversationId, title: event.title, createdAt: event.at }, ...conversations]
        break
      case 'conversation-titled':
        conversations = conversations.map((c) => (c.id === event.conversationId ? { ...c, title: event.title } : c))
        break
      case 'conversation-deleted':
        conversations = conversations.filter((c) => c.id !== event.conversationId)
        break
      case 'settings-changed':
        settings = normalizeSettings(event.settings)
        break
      case 'key-status-changed':
        keyConfigured = event.configured
        break
    }
  }

  function publish(frame: StreamFrame): void {
    for (const { listener, filter } of listeners) {
      if (frame.kind === 'conversation' && filter.conversationId !== undefined && filter.conversationId !== frame.conversationId) continue
      try {
        listener(frame)
      } catch {
        // A listener's failure is its own; the stream goes on.
      }
    }
  }

  // ── steps ──
  async function step<R>(runtime: Runtime, produce: (ctx: StepContext, effects: Effect[]) => R): Promise<R> {
    const before = runtime.snapshot
    const events: ConversationEvent[] = []
    const effects: Effect[] = []
    const now = deps.clock.now()
    let state = runtime.state
    const ctx: StepContext = {
      conversationId: runtime.id,
      now,
      settings,
      ids: deps.ids,
      get state() {
        return state
      },
      emit(body: ConversationEventBody): ConversationEvent {
        const event = {
          ...body,
          id: deps.ids.nextEventId(),
          log: runtime.id,
          seq: state.throughSeq + 1,
          v: EVENT_SCHEMA_VERSION,
          at: now,
        } as ConversationEvent
        state = reduce(state, event)
        events.push(event)
        return event
      },
      route(messageId, routeOptions = {}) {
        effects.push({ kind: 'route', messageId, options: routeOptions })
      },
      setTimer(timerKind, key, at, payload) {
        effects.push({ kind: 'timer', timerKind, key, at, payload })
      },
      cancelTimer(key) {
        effects.push({ kind: 'cancel-timer', key })
      },
      retryPlan(directiveId, cause) {
        return retryPlanner(state, directiveId, cause, now, settings)
      },
      routingRetryAt(error, retriesUsed) {
        return routingRetryPlanner(error, retriesUsed, now, settings)
      },
      abortAttempt(attemptId) {
        effects.push({ kind: 'abort', attemptId })
      },
      flushOutput(attemptId) {
        const run = live.get(attemptId)
        const attempt = state.attempts[attemptId]
        if (!run || !attempt || run.buffer === '') return
        const text = run.buffer
        run.buffer = ''
        run.timer?.()
        run.timer = null
        ctx.emit({ type: 'attempt-output', attemptId, index: attempt.chunks, text })
      },
      requestLabel(directiveId) {
        effects.push({ kind: 'label', directiveId })
      },
    }
    const result = produce(ctx, effects)

    // Reactions, in module order, for every event of the step, until quiet.
    for (let i = 0; i < events.length; i++) {
      if (i > 20_000) throw new Error('Reactions did not settle')
      const event = events[i]
      if (!event) continue
      for (const module of modules) {
        for (const reaction of module.reactions ?? []) {
          const out = reaction(state, event, ctx)
          if (out) for (const body of out) ctx.emit(body)
        }
      }
    }

    if (events.length > 0) {
      await track(deps.eventStore.append(runtime.id, events))
      runtime.state = state
      runtime.snapshot = projectSnapshot(runtime.projector, state)
      runtime.eventsSinceCache += events.length
      runtime.dirty = true
      publish({
        kind: 'conversation',
        conversationId: runtime.id,
        fromSeq: events[0]?.seq ?? state.throughSeq,
        throughSeq: state.throughSeq,
        events: events.map(toStreamedEvent),
        patches: diffSnapshots(before, runtime.snapshot),
      })
    }
    for (const effect of effects) runEffect(runtime, effect)
    releaseDeferredRoutes(runtime)
    if (runtime.eventsSinceCache >= options.cacheEveryEvents) void saveCache(runtime)
    else if (runtime.dirty && conversationIdle(runtime.id)) void saveCache(runtime)
    return result
  }

  /** Runs one step for a conversation from the queue, then schedules ready work everywhere. */
  function stepLater(conversationId: ConversationId, produce: (ctx: StepContext) => void): Promise<void> {
    return enqueue(async () => {
      const runtime = runtimes.get(conversationId)
      if (!runtime || disposed) return
      try {
        await step(runtime, produce)
      } catch {
        // A store failure is exceptional: the step is not committed and its effects never start.
      }
      schedule()
    })
  }

  function conversationIdle(conversationId: ConversationId): boolean {
    for (const run of live.values()) if (run.conversationId === conversationId) return false
    for (const key of starting.keys()) if (key.startsWith(`${conversationId}|`)) return false
    return true
  }

  async function saveCache(runtime: Runtime): Promise<void> {
    runtime.eventsSinceCache = 0
    runtime.dirty = false
    const state = runtime.state
    try {
      await track(
        deps.projectionCache.save(runtime.id, {
          throughSeq: state.throughSeq,
          stateVersion: STATE_VERSION,
          state: state as unknown as JsonValue,
        }),
      )
    } catch {
      // The cache is a speed-up; losing a save loses nothing.
      runtime.dirty = true
    }
  }

  // ── effects ──
  function runEffect(runtime: Runtime, effect: Effect): void {
    switch (effect.kind) {
      case 'route':
        startRouting(runtime.id, effect.messageId, effect.options)
        return
      case 'timer': {
        const key = timerKey(runtime.id, effect.key)
        timers.get(key)?.()
        const handlerModule = [...modules].reverse().find((m) => m.timers?.[effect.timerKind])
        const handler = handlerModule?.timers?.[effect.timerKind]
        if (!handler) return
        const cancel = deps.timers.setTimeout(
          () => {
            timers.delete(key)
            void stepLater(runtime.id, (ctx) => {
              const out = handler(ctx.state, effect.payload, ctx)
              if (out) for (const body of out) ctx.emit(body)
            })
          },
          Math.max(0, effect.at - deps.clock.now()),
        )
        timers.set(key, cancel)
        return
      }
      case 'cancel-timer': {
        const key = timerKey(runtime.id, effect.key)
        timers.get(key)?.()
        timers.delete(key)
        return
      }
      case 'abort': {
        const run = live.get(effect.attemptId)
        if (!run) return
        live.delete(effect.attemptId)
        run.timer?.()
        run.cancel.cancel()
        return
      }
      case 'label':
        startLabel(runtime.id, effect.directiveId)
        return
      case 'stream':
        startStream(runtime.id, effect.attemptId, effect.directiveId, effect.request)
        return
    }
  }

  function startLabel(conversationId: ConversationId, directiveId: DirectiveId): void {
    const label = deps.decomposer.label
    const d = runtimes.get(conversationId)?.state.directives[directiveId]
    if (!label || !d) return
    const source = createCancelSource()
    void track(
      label
        .call(deps.decomposer, { model: settings.models.decomposition, text: d.instruction }, source.signal)
        .then((result) => {
          if (!result.ok) return
          const text = result.label.trim()
          if (text === '') return
          return stepLater(conversationId, (ctx) => {
            const current = ctx.state.directives[directiveId]
            if (current && current.label !== text) ctx.emit({ type: 'directive-labeled', directiveId, label: text })
          })
        })
        .catch(() => undefined),
    )
  }

  // ── routing ──
  function routingInput(state: ConversationState, messageId: MessageId, routeOptions: RouteOptions): RoutingInput | null {
    const message = state.messages[messageId]
    if (!message) return null
    const { sectionIds, redirects } = resolveTargets(state, message.explicitTargets)
    return {
      conversationId: state.conversationId,
      messageId,
      text: message.text,
      explicitTargets: sectionIds,
      redirects,
      chosenTargets: routeOptions.chosenTargets ?? null,
      forcedComposition: routeOptions.forcedComposition ?? null,
      candidates: routingCandidates(state),
      sessionRequirements: sessionRequirementsInForce(state),
      sessionLogTokens: sessionLogTokens(state),
      strategySelectionOnRecord: strategySelectionOnRecord(state),
      settings: { models: settings.models, thresholds: settings.thresholds, routing: settings.routing },
      // Decisions may be shown a summary of a node's context; the chain comes from the same assembly a run uses.
      ...(settings.routing.useSummaryIfAvailable
        ? { decisionContext: (nodeId: NodeId) => summaryProvider.contextFor({ nodeId, chain: () => contextChainOf(state, nodeId) }) }
        : {}),
      ids: deps.ids,
    }
  }

  /**
   * Offers finished work to the context summariser, in the background, while the setting is on. Nothing waits
   * for it, and its outcome is not recorded yet: the event that would record a summary is specified in
   * docs/build/context-summaries.md.
   */
  function offerToSummariser(state: ConversationState, nodeId: NodeId, directiveId: DirectiveId | null, reason: SummariseReason): void {
    if (!settings.routing.backgroundSummaries) return
    const request: SummariseRequest = { conversationId: state.conversationId, nodeId, directiveId, reason, chain: () => contextChainOf(state, nodeId) }
    void summariser.consider(request).catch(() => undefined)
  }

  /**
   * True while a message earlier in the conversation still waits for its
   * routing outcome. A message is routed only after every earlier one has
   * an outcome, so that its routing sees their work: a follow-up that needs
   * a message still being routed waits for that message's result instead of
   * running at once with no context (C2, 05 · result-dependent work), and a
   * reply to a section that an earlier message revises resolves to the
   * replacement (T3). Routing still takes no slot.
   */
  function earlierStillRouting(state: ConversationState, messageId: MessageId): boolean {
    for (const id of state.messageOrder) {
      if (id === messageId) return false
      const message = state.messages[id]
      if (message && message.routing === 'routing' && messageVisible(state, id)) return true
    }
    return false
  }

  function releaseDeferredRoutes(runtime: Runtime): void {
    if (deferredRoutes.size === 0) return
    for (const id of runtime.state.messageOrder) {
      const key = `${runtime.id}|${id}`
      const deferred = deferredRoutes.get(key)
      if (!deferred) continue
      if (runtime.state.messages[id]?.routing !== 'routing') {
        deferredRoutes.delete(key)
        continue
      }
      if (earlierStillRouting(runtime.state, id)) return
      startRouting(runtime.id, id, deferred.options)
      // That message is now the earliest still routing: later ones keep waiting.
      return
    }
  }

  function startRouting(conversationId: ConversationId, messageId: MessageId, routeOptions: RouteOptions): void {
    const runtime = runtimes.get(conversationId)
    if (!runtime) return
    const key = `${conversationId}|${messageId}`
    const token = (routeTokens.get(key) ?? 0) + 1
    routeTokens.set(key, token)
    if (earlierStillRouting(runtime.state, messageId)) {
      deferredRoutes.set(key, { conversationId, messageId, options: routeOptions })
      return
    }
    deferredRoutes.delete(key)
    const input = routingInput(runtime.state, messageId, routeOptions)
    if (!input) return
    const source = createCancelSource()
    const settle = (outcome: RoutingOutcome): Promise<void> =>
      stepLater(conversationId, (ctx) => {
        if (routeTokens.get(key) !== token) return
        applyOutcome(ctx, messageId, outcome, routeOptions)
      })
    void track(
      activeRouter
        .route(input, source.signal)
        .then(settle, (error: unknown) =>
          settle({ kind: 'failed', error: providerError('malformed-response', error instanceof Error ? error.message : 'Routing failed') }),
        ),
    )
  }

  function applyOutcome(ctx: StepContext, messageId: MessageId, outcome: RoutingOutcome, routeOptions: RouteOptions): void {
    const message = ctx.state.messages[messageId]
    if (!message || message.routing !== 'routing') return
    const fail = (text: string): void => {
      ctx.emit({ type: 'routing-failed', messageId, error: providerError('malformed-response', text) })
    }
    if (outcome.kind === 'failed') {
      // A transient failure is retried by the retry setting, like an answer run; the bubble keeps
      // showing the routing status. Only what is not retried is recorded (08, 11).
      if (scheduleRoutingRetry(ctx, messageId, outcome.error, routeOptions)) return
      ctx.emit({ type: 'routing-failed', messageId, error: outcome.error })
      return
    }
    if (outcome.kind === 'target-ambiguity') {
      const handler = [...modules].reverse().find((m) => m.outcomeHandlers?.['target-ambiguity'])?.outcomeHandlers?.['target-ambiguity']
      if (!handler) {
        fail('The reply target is ambiguous and nothing can ask which section it means')
        return
      }
      const out = handler(ctx.state, outcome, { messageId }, ctx)
      if (out) for (const body of out) ctx.emit(body)
      return
    }
    const plan = outcome.plan
    if (routeOptions.forcedComposition === 'atomic' && plan.composition !== 'atomic') {
      fail('Undo split needs an atomic plan')
      return
    }
    for (const part of PLAN_PARTS) {
      if (!planPartUsed(plan, part)) continue
      if (!modules.some((m) => m.planAppliers?.some((a) => a.parts.includes(part)))) {
        fail(`No module carries out the plan's ${part}`)
        return
      }
    }
    const checked = checkPlan(ctx.state, plan)
    if (!checked.ok) {
      fail(checked.message)
      return
    }
    ctx.emit({ type: 'routing-decided', messageId, decision: checked.plan.decision })
    for (const module of modules) {
      for (const applier of module.planAppliers ?? []) {
        const out = applier.apply(ctx.state, checked.plan, { messageId }, ctx)
        if (out) for (const body of out) ctx.emit(body)
      }
    }
  }

  // ── scheduling ──
  /**
   * Starts ready work while slots are free (Q60): one pool for every answer
   * and synthesis run of every conversation, in submission order, then
   * split-message position. Routing, labels and join-backs take no slot.
   */
  function schedule(): void {
    if (disposed || !started) return
    const limit = Math.max(1, settings.concurrencyLimit)
    let used = live.size + starting.size
    // Submission order is the original message's, not the moment routing created the directive:
    // a message routed faster never jumps the queue (Q60).
    const ready: { runtime: Runtime; directiveId: DirectiveId; submittedAt: number; position: number; order: number }[] = []
    for (const runtime of runtimes.values()) {
      const state = runtime.state
      for (const id of state.directiveOrder) {
        const d = state.directives[id]
        if (!d || d.state !== 'ready' || starting.has(startKey(runtime.id, id))) continue
        if ([...live.values()].some((r) => r.conversationId === runtime.id && r.directiveId === id)) continue
        const original = state.messages[d.originalMessageId]
        ready.push({
          runtime,
          directiveId: id,
          submittedAt: original?.submittedAt ?? d.createdAt,
          position: state.messageOrder.indexOf(d.originalMessageId),
          order: d.order,
        })
      }
    }
    const byConversation = (a: Runtime, b: Runtime): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    ready.sort(
      (a, b) =>
        a.submittedAt - b.submittedAt ||
        byConversation(a.runtime, b.runtime) ||
        a.position - b.position ||
        a.order - b.order,
    )
    const held: (typeof ready)[number][] = []
    for (const item of ready) {
      if (used >= limit) {
        held.push(item)
        continue
      }
      used += 1
      prepareStart(item.runtime, item.directiveId)
    }
    for (const item of held) markSlotHeld(item.runtime.id, item.directiveId)
  }

  /**
   * Records that ready work is held only by the concurrency limit, once per
   * time it becomes ready, so that "Waiting for a free slot" is shown only
   * while every slot really is taken (Q60), never while the work is merely
   * about to start.
   */
  function markSlotHeld(conversationId: ConversationId, directiveId: DirectiveId): void {
    const key = startKey(conversationId, directiveId)
    const d = runtimes.get(conversationId)?.state.directives[directiveId]
    if (!d || d.state !== 'ready' || d.slotHeld || slotHeldPending.has(key)) return
    slotHeldPending.add(key)
    void stepLater(conversationId, (ctx) => {
      slotHeldPending.delete(key)
      const current = ctx.state.directives[directiveId]
      if (!current || current.state !== 'ready' || current.slotHeld || starting.has(key)) return
      if ([...live.values()].some((r) => r.conversationId === conversationId && r.directiveId === directiveId)) return
      if (live.size + starting.size < Math.max(1, settings.concurrencyLimit)) return
      ctx.emit({ type: 'directive-slot-held', directiveId })
    })
  }

  function prepare(runtime: Runtime, directiveId: DirectiveId): Prepared | null {
    const state = runtime.state
    const d = state.directives[directiveId]
    const node = d ? state.nodes[d.nodeId] : undefined
    if (!d || !node) return null
    const parents = d.kind === 'clarification-question' ? settledParents(state, resolvePlannedParents(state, node)) : resolvePlannedParents(state, node)
    const context = assembleContext(state, directiveId, d.nodeId, parents)
    // Synthesis is for answers on a join chain; a clarification question is always the answer model's (PLAN §2).
    const modelRole = state.chains[d.chainId]?.kind === 'join' && d.kind === 'answer' ? 'synthesis' : 'answer'
    const request: ModelRequest = {
      model: settings.models[modelRole],
      messages: context.messages.map((message) => ({ role: message.role, content: message.content })),
    }
    return { conversationId: runtime.id, directiveId, nodeId: d.nodeId, parents, context, request, modelRole }
  }

  function prepareStart(runtime: Runtime, directiveId: DirectiveId): void {
    const key = startKey(runtime.id, directiveId)
    const prepared = prepare(runtime, directiveId)
    if (!prepared) return
    starting.set(key, prepared)
    void track(
      deps.modelProvider
        .countTokens(prepared.request)
        .catch(() => ({ inputTokens: 0, contextLimit: null, exact: false }))
        .then((count) =>
          enqueue(async () => {
            const current = runtimes.get(runtime.id)
            if (!current || disposed) {
              starting.delete(key)
              return
            }
            await step(current, (ctx, effects) => beginAttempt(ctx, effects, prepared, count.inputTokens, count.contextLimit, count.exact))
            schedule()
          }),
        ),
    )
  }

  /**
   * The attempt starts with the context assembled when it was scheduled
   * (Q29). If anything it would read changed while its tokens were counted,
   * it is prepared again so the record is exact.
   */
  function beginAttempt(
    ctx: StepContext,
    effects: Effect[],
    prepared: Prepared,
    inputTokens: number,
    tokenLimit: number | null,
    exact: boolean,
  ): void {
    const key = startKey(prepared.conversationId, prepared.directiveId)
    const d = ctx.state.directives[prepared.directiveId]
    if (!d || d.state !== 'ready' || d.nodeId !== prepared.nodeId) {
      starting.delete(key)
      return
    }
    // Released only by success (invariant 4): a prerequisite whose result was replaced since the
    // release (a revision) sends queued work back to waiting, never into a run (06, R3).
    if (notStartedInSection(ctx.state, d) && unsatisfiedPrerequisites(ctx.state, d).length > 0) {
      starting.delete(key)
      settleWait(ctx, d.id)
      return
    }
    const runtime = runtimes.get(prepared.conversationId)
    const again = runtime ? prepare(runtime, prepared.directiveId) : null
    if (!again || JSON.stringify(again.context) !== JSON.stringify(prepared.context) || again.request.model !== prepared.request.model) {
      starting.delete(key)
      return
    }
    starting.delete(key)
    const section = d.sectionId ? ctx.state.sections[d.sectionId] : undefined
    if (!section) return
    const attemptId = ctx.ids.next('attempt')
    const chainId = d.chainId
    ctx.emit({
      type: 'attempt-started',
      attemptId,
      directiveId: d.id,
      sectionId: section.id,
      nodeId: d.nodeId,
      chainId,
      operationId: section.operationId,
      number: d.attemptIds.length + 1,
      origin: d.nextOrigin,
      modelRole: prepared.modelRole,
      model: prepared.request.model,
      parents: prepared.parents,
      context: { ...prepared.context, inputTokens, tokenLimit },
    })
    if (exact && tokenLimit !== null && inputTokens > tokenLimit) {
      // Over the limit: non-retryable, never truncated (Q67, Q82). Only an exact count fails a run
      // before it starts; an estimate may count high, so a run it puts over the limit is sent and
      // the provider's own `context_length_exceeded` fails it, non-retryable, if it really is over.
      ctx.emit({
        type: 'attempt-failed',
        attemptId,
        error: providerError('context-length-exceeded', `The input is ${inputTokens} tokens, over the model's limit of ${tokenLimit}`),
        retry: { kind: 'none', reason: 'non-retryable' },
      })
      return
    }
    if (tokenLimit !== null && inputTokens >= tokenLimit * CONTEXT_WARNING_RATIO) {
      ctx.emit({ type: 'context-limit-warned', attemptId, directiveId: d.id, chainId, inputTokens, tokenLimit })
    }
    effects.push({ kind: 'stream', attemptId, directiveId: d.id, request: prepared.request })
  }

  // ── streams and chunking ──
  function startStream(conversationId: ConversationId, attemptId: AttemptId, directiveId: DirectiveId, request: ModelRequest): void {
    const cancel = createCancelSource()
    const run: LiveRun = { conversationId, directiveId, cancel, buffer: '', timer: null }
    live.set(attemptId, run)
    const deliver = (event: ModelStreamEvent): Promise<void> => stepLater(conversationId, (ctx) => onModelEvent(ctx, attemptId, event))
    void (async () => {
      try {
        for await (const event of deps.modelProvider.stream(request, cancel.signal)) {
          if (live.get(attemptId) !== run) return
          await deliver(event)
          if (event.type !== 'text') return
        }
        if (live.get(attemptId) === run) {
          await deliver({ type: 'failed', error: providerError('network', 'The response ended without finishing') })
        }
      } catch (error) {
        if (live.get(attemptId) === run) {
          await deliver({ type: 'failed', error: providerError('network', error instanceof Error ? error.message : 'Network error') })
        }
      }
    })()
  }

  function onModelEvent(ctx: StepContext, attemptId: AttemptId, event: ModelStreamEvent): void {
    const run = live.get(attemptId)
    const attempt = ctx.state.attempts[attemptId]
    if (!run || !attempt || (attempt.state !== 'running' && attempt.state !== 'streaming')) return
    switch (event.type) {
      case 'text': {
        if (event.text === '') return
        if (attempt.chunks === 0 && run.buffer === '') {
          // The first text fixes the reply's position: it is recorded at once.
          ctx.emit({ type: 'attempt-output', attemptId, index: 0, text: event.text })
          return
        }
        run.buffer += event.text
        if (run.buffer.length >= options.outputChunk.maxChars) {
          ctx.flushOutput(attemptId)
        } else if (run.timer === null) {
          run.timer = deps.timers.setTimeout(() => {
            run.timer = null
            void stepLater(run.conversationId, (c) => {
              if (live.get(attemptId) === run) c.flushOutput(attemptId)
            })
          }, options.outputChunk.maxDelayMs)
        }
        return
      }
      case 'completed':
        ctx.flushOutput(attemptId)
        live.delete(attemptId)
        ctx.emit({ type: 'attempt-completed', attemptId, finishReason: event.finishReason, usage: event.usage })
        offerToSummariser(ctx.state, attempt.nodeId, attempt.directiveId, 'run-completed')
        return
      case 'failed': {
        ctx.flushOutput(attemptId)
        live.delete(attemptId)
        const retry = ctx.retryPlan(attempt.directiveId, { kind: 'failed', error: event.error })
        ctx.emit({ type: 'attempt-failed', attemptId, error: event.error, retry })
        return
      }
      case 'cancelled': {
        // A cancellation Committee asked for was recorded by whoever asked, and the run is no longer live.
        // One it did not ask for is the provider ending the run: a transient failure, never a silent hang.
        ctx.flushOutput(attemptId)
        live.delete(attemptId)
        const error = providerError('network', 'The provider ended the run')
        ctx.emit({ type: 'attempt-failed', attemptId, error, retry: ctx.retryPlan(attempt.directiveId, { kind: 'failed', error }) })
        return
      }
    }
  }

  // ── loading ──
  async function loadConversation(id: ConversationId): Promise<Runtime> {
    const cached = await deps.projectionCache.load(id).catch(() => null)
    const lastSeq = await deps.eventStore.lastSeq(id)
    let state = emptyConversationState(id)
    let afterSeq = 0
    if (cached && cached.stateVersion === STATE_VERSION && cached.throughSeq <= lastSeq) {
      state = cached.state as unknown as ConversationState
      afterSeq = cached.throughSeq
    }
    const stored = await deps.eventStore.read(id, afterSeq)
    const events = stored.map(upcastEvent).filter(isConversationEvent)
    state = fold(state, events)
    const projector = new Projector()
    return { id, state, projector, snapshot: projectSnapshot(projector, state), eventsSinceCache: events.length, dirty: events.length > 0 }
  }

  // ── commands ──
  async function handleConversationCommand(command: Extract<Command, { readonly conversationId: ConversationId }>): Promise<CommandResult> {
    const runtime = runtimes.get(command.conversationId)
    if (!runtime) return { ok: false, error: { code: 'unknown-conversation', message: `Unknown conversation ${command.conversationId}` } }
    const type = command.type as ConversationCommandType
    let output: unknown = {}
    try {
      await step(runtime, (ctx) => {
        for (const module of [...modules].reverse()) {
          const handler = module.commands?.[type] as
            | ((state: ConversationState, command: Command, ctx: StepContext) => unknown)
            | undefined
          if (!handler) continue
          const result = handler(ctx.state, command, ctx)
          if (result === null || result === undefined) continue
          if (isCommandError(result)) throw new StepAborted(result)
          if (Array.isArray(result)) {
            for (const body of result as ConversationEventBody[]) ctx.emit(body)
          } else {
            const withOutput = result as { events: readonly ConversationEventBody[]; output: unknown }
            for (const body of withOutput.events) ctx.emit(body)
            output = withOutput.output
          }
          return
        }
        throw new StepAborted({ code: 'not-allowed', message: `Nothing handles "${command.type}" yet` })
      })
    } catch (error) {
      if (error instanceof StepAborted) return { ok: false, error: error.commandError }
      return { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : 'Internal error' } }
    }
    schedule()
    if (command.type === 'submit-message') {
      const summary = conversations.find((c) => c.id === command.conversationId)
      if (summary && summary.title === 'New conversation') {
        await appendApp([{ type: 'conversation-titled', conversationId: command.conversationId, title: provisionalLabel(command.text, 8) }])
      }
    }
    return { ok: true, output } as CommandResult
  }

  async function handleAppCommand(command: Command): Promise<CommandResult> {
    switch (command.type) {
      case 'create-conversation': {
        // A conversation with no message yet is opened instead of storing another empty one (10 ·
        // "Conversation list"): the newest such conversation, whichever button asked.
        for (const summary of conversations) {
          const runtime = runtimes.get(summary.id)
          if (runtime && runtime.state.throughSeq === 0 && runtime.state.messageOrder.length === 0) {
            return { ok: true, output: { conversation: summary } }
          }
        }
        const conversationId = deps.ids.next('conversation')
        await appendApp([{ type: 'conversation-created', conversationId, title: 'New conversation' }])
        const state = emptyConversationState(conversationId)
        const projector = new Projector()
        runtimes.set(conversationId, { id: conversationId, state, projector, snapshot: projectSnapshot(projector, state), eventsSinceCache: 0, dirty: false })
        const conversation = conversations.find((c) => c.id === conversationId)
        if (!conversation) return { ok: false, error: { code: 'internal', message: 'Conversation was not created' } }
        return { ok: true, output: { conversation } }
      }
      case 'list-conversations':
        return { ok: true, output: { conversations } }
      case 'delete-conversation': {
        const id = command.conversationId
        if (!runtimes.has(id)) return { ok: false, error: { code: 'unknown-conversation', message: `Unknown conversation ${id}` } }
        for (const [attemptId, run] of live) {
          if (run.conversationId !== id) continue
          live.delete(attemptId)
          run.timer?.()
          run.cancel.cancel()
        }
        for (const [key, cancel] of timers) {
          if (key.startsWith(`${id}|`)) {
            cancel()
            timers.delete(key)
          }
        }
        for (const key of [...starting.keys()]) if (key.startsWith(`${id}|`)) starting.delete(key)
        runtimes.delete(id)
        await deps.eventStore.deleteLog(id)
        await deps.projectionCache.delete(id).catch(() => undefined)
        await appendApp([{ type: 'conversation-deleted', conversationId: id }])
        schedule()
        return { ok: true, output: {} }
      }
      case 'change-settings': {
        const bodies: AppEventBody[] = []
        if (command.changes) {
          const invalid = validateSettingsPatch(command.changes)
          if (invalid) return { ok: false, error: { code: 'invalid', message: invalid } }
          const next = applySettingsPatch(settings, command.changes)
          if (next !== settings) bodies.push({ type: 'settings-changed', settings: next })
        }
        const key = command.openRouterKey
        if (key?.action === 'set') {
          if (key.key.trim() === '') return { ok: false, error: { code: 'invalid', message: 'The key cannot be empty' } }
          await deps.secretsStore.set('openrouter-key', key.key)
          if (!keyConfigured) bodies.push({ type: 'key-status-changed', configured: true })
        } else if (key?.action === 'clear') {
          await deps.secretsStore.delete('openrouter-key')
          if (keyConfigured) bodies.push({ type: 'key-status-changed', configured: false })
        }
        await appendApp(bodies)
        schedule()
        return { ok: true, output: {} }
      }
      default:
        return { ok: false, error: { code: 'invalid', message: `Unknown command` } }
    }
  }

  // ── the backend ──
  const backend: Backend = {
    async start() {
      if (started) return
      const appEvents = (await deps.eventStore.read(APP_LOG)).map(upcastEvent)
      for (const event of appEvents) {
        if (isConversationEvent(event)) continue
        appSeq = event.seq
        foldApp(event)
      }
      keyConfigured = (await deps.secretsStore.get('openrouter-key')) !== null
      for (const summary of conversations) runtimes.set(summary.id, await loadConversation(summary.id))
      started = true
      for (const runtime of runtimes.values()) {
        await enqueue(async () => {
          await step(runtime, (ctx) => {
            for (const module of modules) {
              for (const reaction of module.startupReactions ?? []) {
                const out = reaction(ctx.state, ctx)
                if (out) for (const body of out) ctx.emit(body)
              }
            }
          })
        })
      }
      await enqueue(() => schedule())
    },

    async dispose() {
      if (disposed) return
      disposed = true
      for (const run of live.values()) {
        run.timer?.()
        run.cancel.cancel()
      }
      live.clear()
      for (const cancel of timers.values()) cancel()
      timers.clear()
      starting.clear()
      await tail
      for (const runtime of runtimes.values()) if (runtime.dirty) await saveCache(runtime)
    },

    send<C extends Command>(command: C): Promise<CommandResult<C['type']>> {
      if (disposed) {
        return Promise.resolve({ ok: false, error: { code: 'internal', message: 'The backend has been disposed' } })
      }
      return enqueue(async () => {
        if ('conversationId' in command && command.type !== 'delete-conversation') {
          return (await handleConversationCommand(command as Extract<Command, { readonly conversationId: ConversationId }>)) as CommandResult<C['type']>
        }
        return (await handleAppCommand(command)) as CommandResult<C['type']>
      })
    },

    subscribe(listener, filter = {}): Unsubscribe {
      const entry = { listener, filter }
      listeners.add(entry)
      return () => {
        listeners.delete(entry)
      }
    },

    async snapshot<Q extends SnapshotQuery>(query: Q): Promise<SnapshotResult<Q['kind']>> {
      const answer = await enqueue(async (): Promise<SnapshotResult> => {
        switch (query.kind) {
          case 'app':
            return { ok: true, value: appSnapshot() }
          case 'conversation': {
            const runtime = runtimes.get(query.conversationId)
            if (!runtime) return { ok: false, error: { code: 'unknown-conversation', message: `Unknown conversation ${query.conversationId}` } }
            return { ok: true, value: runtime.snapshot }
          }
          case 'run': {
            const runtime = runtimes.get(query.conversationId)
            if (!runtime) return { ok: false, error: { code: 'unknown-conversation', message: `Unknown conversation ${query.conversationId}` } }
            const inspection = runInspection(runtime.state, query.directiveId, query.attemptId)
            if (!inspection) return { ok: false, error: { code: 'unknown-target', message: `Unknown run ${query.directiveId}` } }
            return { ok: true, value: inspection }
          }
          case 'events': {
            if (!runtimes.has(query.conversationId)) {
              return { ok: false, error: { code: 'unknown-conversation', message: `Unknown conversation ${query.conversationId}` } }
            }
            const stored = await deps.eventStore.read(query.conversationId, query.afterSeq)
            return { ok: true, value: { events: stored.map(upcastEvent).filter(isConversationEvent) } }
          }
        }
      })
      return answer as SnapshotResult<Q['kind']>
    },
  }

  const internals: EngineInternals = {
    modules,
    state: (id) => runtimes.get(id)?.state ?? null,
    conversationIds: () => [...runtimes.keys()],
    isQuiet: () => queued === 0 && pendingEffects === 0,
    drained: () => tail,
    liveAttempts: () => [...live.keys()],
  }
  return { backend, internals }
}

import { STATE_VERSION, buildLogExport } from '@committee/core'
import {
  DEFAULT_SETTINGS,
  EVENT_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  applySettingsPatch,
  diffSnapshots,
  anthropicFallbackPatch,
  completeSettingsPatch,
  describeModelRoles,
  rolesOnAnthropic,
  validateSettingsPatch,
  type AppSnapshot,
  type Command,
  type CommandResult,
  type ConversationFrame,
  type ConversationId,
  type ConversationSnapshot,
  type ConversationSummary,
  type SnapshotQuery,
  type SnapshotResult,
  type StreamFrame,
  type SubscriptionFilter,
} from '@committee/protocol'
import { fx, isBuilt, withThroughSeq } from './builder'
import type { Fixture, FixtureBackend, FixtureResponse, FixtureStep } from './types'

const BASE_TIME = Date.UTC(2026, 10, 11, 9, 0, 0)

function ok<T extends Command['type']>(output: object = {}): CommandResult<T> {
  return { ok: true, output } as CommandResult<T>
}

/**
 * An in-memory `BackendClient` that replays a fixture.
 *
 * - Each step becomes one `ConversationFrame` with
 *   `diffSnapshots(previous, next)`, no events, and an increasing `throughSeq`.
 * - Tests drive it with `step()` and `playAll()`. Timers run only when
 *   `timers` is true (the browser), starting with the first subscriber.
 * - It keeps its own `AppSnapshot` and answers the app commands itself, each
 *   with an `AppFrame`. `fixture.respond` is asked first and may override.
 * - `submit-message` with no `respond` adds the message and its provisional
 *   responding bubble, then a short scripted reply, so the shell can be
 *   exercised without a model.
 */
export function createFixtureBackend(fixture: Fixture, options: { timers?: boolean } = {}): FixtureBackend {
  const timers = options.timers ?? false
  const listeners = new Set<{ listener: (frame: StreamFrame) => void; filter?: SubscriptionFilter }>()
  const progressListeners = new Set<() => void>()
  const sent: Command[] = []

  const conversations = new Map<ConversationId, ConversationSnapshot>()
  conversations.set(fixture.initial.conversationId, fixture.initial)
  for (const other of fixture.others ?? []) conversations.set(other.conversationId, other)
  const fixtureConversationId = fixture.initial.conversationId

  const summaries: ConversationSummary[] = [fixture.initial, ...(fixture.others ?? [])].map((snapshot, index) => ({
    id: snapshot.conversationId,
    title: fixture.titles?.[snapshot.conversationId] ?? (index === 0 ? fixture.title : `Conversation ${index + 1}`),
    createdAt: BASE_TIME - index * 3_600_000,
  }))
  const modelsEditable = fixture.modelsEditable ?? true
  /** The app state with the description of each role's model choice, which follows from the rest. */
  const described = (state: Omit<AppSnapshot, 'modelRoles'>): AppSnapshot => ({
    ...state,
    modelRoles: describeModelRoles(state.settings, { anthropicKeyConfigured: state.anthropicKey.configured, editable: modelsEditable }),
  })
  let app: AppSnapshot = described({
    conversations: summaries,
    settings: DEFAULT_SETTINGS,
    key: { configured: true },
    anthropicKey: { configured: false },
    ...fixture.app,
  })

  let queue: FixtureStep[] = [...(fixture.steps ?? [])]
  let played = 0
  let created = 0
  let submitted = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  function emit(frame: StreamFrame): void {
    for (const { listener, filter } of [...listeners]) {
      if (frame.kind === 'conversation' && filter?.conversationId && filter.conversationId !== frame.conversationId) {
        continue
      }
      listener(frame)
    }
  }

  function emitApp(): void {
    emit({ kind: 'app', events: [], app })
  }

  function notifyProgress(): void {
    for (const listener of [...progressListeners]) listener()
  }

  function current(): ConversationSnapshot {
    const snapshot = conversations.get(fixtureConversationId)
    if (!snapshot) throw new Error(`Fixture "${fixture.id}" lost its conversation`)
    return snapshot
  }

  function advance(conversationId: ConversationId, next: ConversationSnapshot): void {
    const previous = conversations.get(conversationId)
    if (!previous) return
    const throughSeq = previous.throughSeq + 1
    const stored = withThroughSeq(next.conversationId === conversationId ? next : { ...next, conversationId }, throughSeq)
    conversations.set(conversationId, stored)
    const frame: ConversationFrame = {
      kind: 'conversation',
      conversationId,
      fromSeq: throughSeq,
      throughSeq,
      events: [],
      patches: diffSnapshots(previous, stored),
    }
    emit(frame)
  }

  function schedule(): void {
    if (!timers || disposed || timer !== null || listeners.size === 0) return
    const next = queue[0]
    if (!next) return
    timer = setTimeout(() => {
      timer = null
      step()
      schedule()
    }, next.delayMs)
  }

  function step(): boolean {
    const next = queue.shift()
    if (!next) return false
    const previous = current()
    advance(fixtureConversationId, typeof next.next === 'function' ? next.next(previous) : next.next)
    played++
    notifyProgress()
    return true
  }

  function enqueue(steps: readonly FixtureStep[]): void {
    if (steps.length === 0) return
    queue = [...queue, ...steps]
    notifyProgress()
    schedule()
  }

  /** The default reply to `submit-message`: the message, its provisional bubble, then a scripted answer. */
  function scriptedSubmit(command: Extract<Command, { type: 'submit-message' }>): CommandResult<'submit-message'> {
    const snapshot = conversations.get(command.conversationId)
    if (!snapshot) return { ok: false, error: { code: 'unknown-conversation', message: 'No such conversation' } }
    const name = `sent-${++submitted}`
    const messageId = fx.id('message', name)
    if (!isBuilt(snapshot)) return ok({ messageId })
    const chain = `chain-${name}`
    const reply = 'This reply is scripted by the fixture backend. No model was called.'
    const routed = fx
      .from(snapshot)
      .message(name, command.text, { at: BASE_TIME + 3_600_000 + submitted * 45_000 })
      .response(name, { message: name, routing: 'routing' })
      .build()
    advance(command.conversationId, routed)
    if (command.conversationId !== fixtureConversationId) return ok({ messageId })
    enqueue([
      {
        label: `Scripted reply to "${command.text.slice(0, 24)}" starts`,
        delayMs: 500,
        next: (previous) =>
          fx
            .from(previous)
            .chain(chain, { label: 'scripted reply' })
            .patch('response', name, { routing: null })
            .section(name, { response: name, chain, state: 'streaming', title: 'Scripted reply' })
            .attempt(name, { section: name, state: 'streaming', text: reply.slice(0, 28) })
            .build(),
      },
      {
        label: 'Scripted reply completes',
        delayMs: 600,
        next: (previous) =>
          fx
            .from(previous)
            .patch('section', name, { state: 'completed' })
            .patch('attempt', name, { state: 'completed', text: reply })
            .build(),
      },
    ])
    return ok({ messageId })
  }

  function builtIn(command: Command): CommandResult {
    switch (command.type) {
      case 'change-settings': {
        // The same rules as core's backend: the configuration is the backend's to validate.
        if (!command.changes) return ok()
        if (!modelsEditable && (command.changes.models || command.changes.modelProviders)) {
          return { ok: false, error: { code: 'not-allowed', message: 'Models are set by the server' } }
        }
        const changes = completeSettingsPatch(app.settings, command.changes)
        const invalid = validateSettingsPatch(changes, app.settings)
        if (invalid) return { ok: false, error: { code: 'invalid', message: invalid } }
        const settings = applySettingsPatch(app.settings, changes)
        if (!app.anthropicKey.configured && rolesOnAnthropic(settings).length > 0) {
          return { ok: false, error: { code: 'invalid', message: 'Add an Anthropic key before choosing the Claude API for a role' } }
        }
        app = described({ ...app, settings })
        emitApp()
        return ok()
      }
      case 'create-conversation': {
        const name = `new-${++created}`
        const snapshot = fx.conversation(name).build()
        conversations.set(snapshot.conversationId, snapshot)
        const conversation: ConversationSummary = {
          id: snapshot.conversationId,
          title: 'New conversation',
          createdAt: BASE_TIME + created * 60_000,
        }
        app = { ...app, conversations: [conversation, ...app.conversations] }
        emitApp()
        return ok({ conversation })
      }
      case 'list-conversations':
        return ok({ conversations: app.conversations })
      case 'delete-conversation': {
        if (!app.conversations.some((conversation) => conversation.id === command.conversationId)) {
          return { ok: false, error: { code: 'unknown-conversation', message: 'No such conversation' } }
        }
        if (command.conversationId !== fixtureConversationId) conversations.delete(command.conversationId)
        app = {
          ...app,
          conversations: app.conversations.filter((conversation) => conversation.id !== command.conversationId),
        }
        emitApp()
        return ok()
      }
      case 'submit-message':
        return scriptedSubmit(command)
      default:
        return ok()
    }
  }

  function applyResponse(response: FixtureResponse): CommandResult {
    if (response.app) {
      app = response.app
      emitApp()
    }
    if (response.steps) enqueue(response.steps)
    return response.result ?? ok()
  }

  return {
    fixture,
    get sent() {
      return sent
    },
    get current() {
      return current()
    },
    get app() {
      return app
    },
    get remaining() {
      return queue
    },
    get played() {
      return played
    },
    step,
    playAll() {
      while (step()) {
        // Play every queued step, including ones a step's responder adds.
      }
    },
    onProgress(listener) {
      progressListeners.add(listener)
      return () => {
        progressListeners.delete(listener)
      }
    },
    setKeyConfigured(provider, configured) {
      let settings = app.settings
      if (provider === 'anthropic' && !configured) {
        const fallback = anthropicFallbackPatch(settings)
        if (fallback) settings = applySettingsPatch(settings, fallback)
      }
      app = described({ ...app, settings, ...(provider === 'anthropic' ? { anthropicKey: { configured } } : { key: { configured } }) })
      emitApp()
    },
    dispose() {
      disposed = true
      if (timer !== null) clearTimeout(timer)
      timer = null
      listeners.clear()
      progressListeners.clear()
    },

    async send<C extends Command>(command: C): Promise<CommandResult<C['type']>> {
      sent.push(command)
      const response = fixture.respond?.(command, current()) ?? null
      const result = response ? applyResponse(response) : builtIn(command)
      return result as CommandResult<C['type']>
    },

    subscribe(listener, filter) {
      const entry = { listener, filter }
      listeners.add(entry)
      schedule()
      return () => {
        listeners.delete(entry)
      }
    },

    async snapshot<Q extends SnapshotQuery>(query: Q): Promise<SnapshotResult<Q['kind']>> {
      const fail = (message: string): SnapshotResult<Q['kind']> => ({
        ok: false,
        error: { code: 'unknown-target', message },
      })
      const value = (result: unknown): SnapshotResult<Q['kind']> =>
        ({ ok: true, value: result }) as SnapshotResult<Q['kind']>
      switch (query.kind) {
        case 'app':
          return value(app)
        case 'conversation': {
          const snapshot = conversations.get(query.conversationId)
          return snapshot
            ? value(snapshot)
            : { ok: false, error: { code: 'unknown-conversation', message: 'No such conversation' } }
        }
        case 'run': {
          const runs = fixture.runs?.[query.directiveId]
          if (!runs) return fail(`Fixture "${fixture.id}" has no run for ${query.directiveId}`)
          return value(query.attemptId ? (runs.byAttempt?.[query.attemptId] ?? runs.latest) : runs.latest)
        }
        case 'events':
          return value({ events: [] })
        case 'log-export': {
          // A fixture has no log: the export carries its projections and runs, and no events.
          const snapshot = conversations.get(query.conversationId)
          const summary = app.conversations.find((c) => c.id === query.conversationId)
          if (!snapshot || !summary) return { ok: false, error: { code: 'unknown-conversation', message: 'No such conversation' } }
          return value(
            buildLogExport({
              conversation: summary,
              createdAt: BASE_TIME,
              versions: { protocol: PROTOCOL_VERSION, eventSchema: EVENT_SCHEMA_VERSION, state: STATE_VERSION },
              settings: app.settings,
              keyConfigured: app.key.configured,
              appEvents: [],
              events: [],
              projections: snapshot,
              runs: Object.values(fixture.runs ?? {}).map((run) => run.latest),
              secrets: [],
            }),
          )
        }
      }
    },
  }
}

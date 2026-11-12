import {
  createIdFactory,
  createSeededRandom,
  createUlidFactory,
  type Command,
  type CommandResult,
  type ConversationId,
  type ConversationSnapshot,
  type IdFactory,
  type MessageId,
  type SectionId,
  type SettingsPatch,
  type StreamFrame,
} from '@committee/protocol'
import type { Backend, CandidateSource, ContextSummariser, ContextSummaryProvider, CoreOptions, ReferentStrategy } from '../ports'
import { createEngine, type EngineInternals } from '../engine/backend'
import { defaultModules } from '../engine/engine-module'
import type { CoreModule } from '../engine/module'
import type { ConversationState } from '../engine/state'
import { FakeClock } from './fake-clock'
import { MemoryEventStore, MemoryProjectionCache, MemorySecretsStore } from './memory-stores'
import { ScriptedModelProvider } from './scripted-model-provider'
import { ScriptedPreparer } from './scripted-preparer'
import { ScriptedDecisionProvider, ScriptedDecomposer } from './scripted-providers'
import { ScriptedRouter } from './scripted-router'

export interface TestBackendOverrides {
  /** The modules, engine first. Default: every module registered at this point. */
  readonly modules?: readonly CoreModule[]
  /** Appended to `modules`, e.g. a scripted retry planner. */
  readonly extraModules?: readonly CoreModule[]
  readonly options?: Partial<CoreOptions>
  /** Applied with `change-settings` after start. */
  readonly settings?: SettingsPatch
  /** Seed of the ID factory. */
  readonly seed?: number
  /** Whether an OpenRouter key is configured. Default true. */
  readonly key?: boolean
  /** False to leave `deps.router` out, so a module's `createRouter` is used. */
  readonly useScriptedRouter?: boolean
  /** Injected in place of the referent strategy that settings name (routing pipeline only). */
  readonly referentStrategy?: ReferentStrategy
  readonly candidateSource?: CandidateSource
  /** Injected in place of the provider that returns a node's context chain unchanged. */
  readonly contextSummaryProvider?: ContextSummaryProvider
  /** Injected in place of the summariser that produces nothing. */
  readonly contextSummariser?: ContextSummariser
  // Reused across a simulated interruption:
  readonly clock?: FakeClock
  readonly model?: ScriptedModelProvider
  readonly preparer?: ScriptedPreparer
  readonly router?: ScriptedRouter
  readonly decisions?: ScriptedDecisionProvider
  readonly decomposer?: ScriptedDecomposer
  readonly eventStore?: MemoryEventStore
  readonly projectionCache?: MemoryProjectionCache
  readonly secretsStore?: MemorySecretsStore
  readonly ids?: IdFactory
}

export interface TestBackend {
  readonly backend: Backend
  readonly internals: EngineInternals
  readonly clock: FakeClock
  readonly model: ScriptedModelProvider
  readonly preparer: ScriptedPreparer
  readonly router: ScriptedRouter
  readonly decisions: ScriptedDecisionProvider
  readonly decomposer: ScriptedDecomposer
  readonly eventStore: MemoryEventStore
  readonly projectionCache: MemoryProjectionCache
  readonly secretsStore: MemorySecretsStore
  readonly ids: IdFactory
  /** Every frame delivered since start. */
  readonly frames: StreamFrame[]
  /** Waits until no step is queued and nothing but live streams is pending. */
  settle(): Promise<void>
  /** Runs the queued steps without waiting for pending effects (for a test that holds routing in flight). */
  flush(): Promise<void>
  /** Moves the fake clock forward, firing timers one at a time and settling after each. */
  advance(ms: number): Promise<void>
  createConversation(): Promise<ConversationId>
  /** Submits a message and settles; returns its ID. Throws when rejected. */
  submit(conversationId: ConversationId, text: string, targets?: readonly SectionId[]): Promise<MessageId>
  /** Sends a command and settles. */
  send<C extends Command>(command: C): Promise<CommandResult<C['type']>>
  snapshot(conversationId: ConversationId): Promise<ConversationSnapshot>
  state(conversationId: ConversationId): ConversationState
  /** A simulated interruption: dispose this backend, build a new one over the same stores and fakes, start it. */
  restart(overrides?: TestBackendOverrides): Promise<TestBackend>
}

function macrotask(): Promise<void> {
  const host = globalThis as unknown as { setTimeout?: (callback: () => void, ms: number) => unknown }
  if (host.setTimeout) {
    const schedule = host.setTimeout
    return new Promise((resolve) => {
      schedule(resolve, 0)
    })
  }
  return Promise.resolve()
}

/** A started backend over every fake, with a seeded ID factory. */
export async function createTestBackend(overrides: TestBackendOverrides = {}): Promise<TestBackend> {
  const clock = overrides.clock ?? new FakeClock()
  const model = overrides.model ?? new ScriptedModelProvider(clock)
  const preparer = overrides.preparer ?? new ScriptedPreparer()
  const router = overrides.router ?? new ScriptedRouter()
  const decisions = overrides.decisions ?? new ScriptedDecisionProvider()
  const decomposer = overrides.decomposer ?? new ScriptedDecomposer()
  const eventStore = overrides.eventStore ?? new MemoryEventStore()
  const projectionCache = overrides.projectionCache ?? new MemoryProjectionCache()
  const secretsStore = overrides.secretsStore ?? new MemorySecretsStore()
  const ids = overrides.ids ?? createIdFactory(createUlidFactory(() => clock.now(), createSeededRandom(overrides.seed ?? 7)))
  if ((overrides.key ?? true) && !overrides.secretsStore) await secretsStore.set('openrouter-key', 'test-key-not-real')

  const modules = [...(overrides.modules ?? defaultModules()), ...(overrides.extraModules ?? [])]
  const { backend, internals } = createEngine(
    {
      modelProvider: model,
      preparer,
      decisionProvider: decisions,
      decomposer,
      eventStore,
      projectionCache,
      secretsStore,
      clock,
      timers: clock,
      ids,
      ...(overrides.useScriptedRouter === false ? {} : { router }),
      ...(overrides.referentStrategy ? { referentStrategy: overrides.referentStrategy } : {}),
      ...(overrides.candidateSource ? { candidateSource: overrides.candidateSource } : {}),
      ...(overrides.contextSummaryProvider ? { contextSummaryProvider: overrides.contextSummaryProvider } : {}),
      ...(overrides.contextSummariser ? { contextSummariser: overrides.contextSummariser } : {}),
    },
    overrides.options,
    modules,
  )
  const frames: StreamFrame[] = []
  backend.subscribe((frame) => frames.push(frame))
  await backend.start()

  const settle = async (): Promise<void> => {
    for (let round = 0; round < 10_000; round++) {
      await internals.drained()
      await macrotask()
      if (internals.isQuiet()) {
        await macrotask()
        if (internals.isQuiet()) return
      }
    }
    throw new Error('The backend did not settle')
  }

  const test: TestBackend = {
    backend,
    internals,
    clock,
    model,
    preparer,
    router,
    decisions,
    decomposer,
    eventStore,
    projectionCache,
    secretsStore,
    ids,
    frames,
    settle,
    async flush() {
      for (let i = 0; i < 3; i++) {
        await internals.drained()
        await macrotask()
      }
    },
    async advance(ms) {
      const target = clock.now() + ms
      await settle()
      while (clock.fireNext(target)) await settle()
      clock.set(Math.max(clock.now(), target))
      await settle()
    },
    async createConversation() {
      const result = await backend.send({ type: 'create-conversation' })
      if (!result.ok) throw new Error(result.error.message)
      await settle()
      return result.output.conversation.id
    },
    async submit(conversationId, text, targets) {
      const result = await backend.send({ type: 'submit-message', conversationId, text, ...(targets ? { targets } : {}) })
      if (!result.ok) throw new Error(result.error.message)
      await settle()
      return result.output.messageId
    },
    async send(command) {
      const result = await backend.send(command)
      await settle()
      return result
    },
    async snapshot(conversationId) {
      const result = await backend.snapshot({ kind: 'conversation', conversationId })
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    },
    state(conversationId) {
      const state = internals.state(conversationId)
      if (!state) throw new Error(`No conversation ${conversationId}`)
      return state
    },
    async restart(next = {}) {
      await backend.dispose()
      return createTestBackend({
        modules: overrides.modules,
        extraModules: overrides.extraModules,
        options: overrides.options,
        useScriptedRouter: overrides.useScriptedRouter,
        ...next,
        clock,
        model,
        preparer,
        router,
        decisions,
        decomposer,
        eventStore,
        projectionCache,
        secretsStore,
        ids,
      } as TestBackendOverrides)
    },
  }
  if (overrides.settings) {
    const result = await backend.send({ type: 'change-settings', changes: overrides.settings })
    if (!result.ok) throw new Error(result.error.message)
  }
  await settle()
  return test
}

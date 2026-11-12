import type { BackendClient, IdFactory } from '@pluribus/protocol'
import type { Clock, Timers } from './clock'
import type { DecisionProvider } from './decision-provider'
import type { Decomposer } from './decomposer'
import type { ModelProvider } from './model-provider'
import type { ContextSummariser, ContextSummaryProvider } from './context-summary'
import type { ReferentStrategy } from './referent-strategy'
import type { Router } from './router'
import type { StrategySelector } from './strategy-selector'
import type { EventStore, ProjectionCache, SecretsStore } from './stores'

/**
 * Everything core needs from outside. Core has no I/O of its own (Q71): it
 * is given these and is otherwise a deterministic function of its inputs.
 */
export interface CoreDependencies {
  readonly modelProvider: ModelProvider
  readonly decisionProvider: DecisionProvider
  readonly decomposer: Decomposer
  readonly eventStore: EventStore
  readonly projectionCache: ProjectionCache
  readonly secretsStore: SecretsStore
  readonly clock: Clock
  readonly timers: Timers
  readonly ids: IdFactory
  /**
   * Replaces the routing pipeline. Tests supply a scripted router to state
   * routing outcomes directly; the application leaves it out and gets the
   * pipeline that the routing slice's module builds from the decision
   * provider and the decomposer. With neither a router here nor a module
   * that supplies one, `createBackend` throws.
   */
  readonly router?: Router
  /**
   * Replaces the referent strategy the routing pipeline would take from
   * `settings.routing.referentStrategy`. Left out by the application.
   */
  readonly referentStrategy?: ReferentStrategy
  /**
   * Replaces the strategy selector the routing pipeline would take from
   * `settings.routing.strategySelection`. Left out by the application. An
   * injected referent strategy is used as it is: nothing is selected.
   */
  readonly strategySelector?: StrategySelector
  /**
   * What the decision model is shown for a node while
   * `settings.routing.useSummaryIfAvailable` is on. Left out, the backend
   * uses the provider that returns the node's context chain unchanged.
   */
  readonly contextSummaryProvider?: ContextSummaryProvider
  /**
   * Offered finished work while `settings.routing.backgroundSummaries` is
   * on. Left out, the backend uses the summariser that produces nothing.
   */
  readonly contextSummariser?: ContextSummariser
}

/** Tunables that are build choices, not user settings. */
export interface CoreOptions {
  /**
   * How streamed text is grouped into stored chunks (Q69). The first text of
   * an attempt is always recorded at once, because it fixes the reply's
   * position; after that, text is held until `maxChars` have accumulated or
   * `maxDelayMs` have passed since the oldest held character, and always
   * flushed before the attempt's terminal event.
   */
  readonly outputChunk: { readonly maxChars: number; readonly maxDelayMs: number }
  /** The projection cache is saved after this many events, and whenever a conversation goes idle. */
  readonly cacheEveryEvents: number
  /**
   * Whether a client may change the per-role models. False in
   * a deployment whose models are set by its environment (Q65): the backend
   * then rejects such a change and reports every role as not editable.
   */
  readonly modelsEditable: boolean
}

export const DEFAULT_CORE_OPTIONS: CoreOptions = {
  outputChunk: { maxChars: 96, maxDelayMs: 80 },
  cacheEveryEvents: 200,
  modelsEditable: true,
}

/**
 * The backend core builds: the protocol's client interface plus a lifecycle.
 * `createBackend(dependencies, options?)` returns one. The Web Worker serves
 * it with `servePort`; tests call it directly.
 */
export interface Backend extends BackendClient {
  /**
   * Loads the app log and every conversation, and recovers what was lost
   * with the previous executor (invariant 8):
   * - an attempt with no terminal event is recorded as interrupted, then
   *   retried or left with Retry per the retry setting (Q52, Q54);
   * - a message still waiting for a routing outcome (see `routing-retried`
   *   in the protocol for the exact test) is routed again, under every
   *   retry policy. Routing records nothing before `routing-decided`, so
   *   nothing is done twice;
   * - timers that were pending are set again from the log: scheduled
   *   retries and the deadlines of choices with default.
   *
   * Must be awaited before any other call. The caller guarantees that this
   * backend is the only executor over its stores: in the browser the Worker
   * holds the `pluribus-backend` Web Lock before it calls `start()`.
   * Starting a second backend over the same stores would record the first
   * one's live attempts as interrupted.
   */
  start(): Promise<void>

  /**
   * Tells the backend that the deployment stored or removed a provider key.
   * Keys never travel in a command: the deployment's key service writes the
   * secrets store and then calls this. The backend reads which keys are
   * present (never their values), and records a `key-status-changed` for each
   * change.
   */
  refreshKeyStatus(): Promise<void>

  /**
   * Stops accepting calls, aborts in-flight runs without recording an
   * outcome for them (they will be found interrupted on the next start),
   * cancels timers, and waits for pending writes.
   */
  dispose(): Promise<void>
}

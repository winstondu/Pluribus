import type { BackendClient, IdFactory } from '@committee/protocol'
import type { Clock, Timers } from './clock'
import type { DecisionProvider } from './decision-provider'
import type { Decomposer } from './decomposer'
import type { ModelProvider } from './model-provider'
import type { Router } from './router'
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
   * pipeline built from the decision provider and the decomposer.
   */
  readonly router?: Router
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
}

export const DEFAULT_CORE_OPTIONS: CoreOptions = {
  outputChunk: { maxChars: 96, maxDelayMs: 80 },
  cacheEveryEvents: 200,
}

/**
 * The backend core builds: the protocol's client interface plus a lifecycle.
 * `createBackend(dependencies, options?)` returns one. The Web Worker serves
 * it with `servePort`; tests call it directly.
 */
export interface Backend extends BackendClient {
  /**
   * Loads the app log and every conversation, and recovers: an attempt with
   * no terminal event was lost with its executor and is recorded as
   * interrupted, then retried or left with Retry per the retry setting
   * (Q52, Q54). Must be awaited before any other call.
   */
  start(): Promise<void>

  /**
   * Stops accepting calls, aborts in-flight runs without recording an
   * outcome for them (they will be found interrupted on the next start),
   * cancels timers, and waits for pending writes.
   */
  dispose(): Promise<void>
}

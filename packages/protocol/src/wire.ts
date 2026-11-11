import type {
  BackendClient,
  SnapshotQuery,
  SnapshotResult,
  StreamFrame,
  SubscriptionFilter,
  Unsubscribe,
} from './backend'
import { PROTOCOL_VERSION } from './backend'
import type { Command, CommandResult } from './commands'

/**
 * Wire messages for a message-passing transport, and the two small adapters
 * that put a {@link BackendClient} on either end of one. Used for the Web
 * Worker now; the same messages fit a WebSocket later (Q62).
 *
 * Messages are plain JSON and safe for `postMessage`.
 */

export type ClientMessage =
  | { readonly kind: 'command'; readonly requestId: number; readonly command: Command }
  | { readonly kind: 'snapshot'; readonly requestId: number; readonly query: SnapshotQuery }
  | { readonly kind: 'subscribe'; readonly subscriptionId: number; readonly filter: SubscriptionFilter }
  | { readonly kind: 'unsubscribe'; readonly subscriptionId: number }

export type BackendMessage =
  /** Sent once when the backend is able to serve. Requests sent earlier are answered after it. */
  | { readonly kind: 'ready'; readonly protocolVersion: number }
  | { readonly kind: 'command-result'; readonly requestId: number; readonly result: CommandResult }
  | { readonly kind: 'snapshot-result'; readonly requestId: number; readonly result: SnapshotResult }
  | { readonly kind: 'frame'; readonly subscriptionId: number; readonly frame: StreamFrame }
  /** The backend cannot continue. Every pending request is failed with this message. */
  | { readonly kind: 'fault'; readonly message: string }

/**
 * The part of a `Worker`, `DedicatedWorkerGlobalScope` or `MessagePort` the
 * adapters need. All three satisfy it as they are.
 */
export interface WirePort<Incoming, Outgoing> {
  postMessage(message: Outgoing): void
  addEventListener(type: 'message', listener: (event: { readonly data: Incoming }) => void): void
  removeEventListener(type: 'message', listener: (event: { readonly data: Incoming }) => void): void
}

export interface PortClient extends BackendClient {
  /** Resolves when the backend announced it is ready; rejects on a version mismatch or a fault before that. */
  readonly ready: Promise<void>
  /** Stops listening and fails every pending request. */
  dispose(): void
}

/** Client side: a {@link BackendClient} that forwards over a port. */
export function createPortClient(port: WirePort<BackendMessage, ClientMessage>): PortClient {
  let nextId = 1
  let fault: string | null = null
  const commands = new Map<number, (result: CommandResult) => void>()
  const snapshots = new Map<number, (result: SnapshotResult) => void>()
  const listeners = new Map<number, (frame: StreamFrame) => void>()

  let resolveReady: () => void = () => {}
  let rejectReady: (reason: Error) => void = () => {}
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  // A caller that never awaits `ready` must not get an unhandled rejection.
  ready.catch(() => {})

  const failAll = (message: string): void => {
    fault = message
    const error = { code: 'internal', message } as const
    for (const resolve of commands.values()) resolve({ ok: false, error })
    for (const resolve of snapshots.values()) resolve({ ok: false, error })
    commands.clear()
    snapshots.clear()
    rejectReady(new Error(message))
  }

  const onMessage = (event: { readonly data: BackendMessage }): void => {
    const message = event.data
    switch (message.kind) {
      case 'ready':
        if (message.protocolVersion === PROTOCOL_VERSION) resolveReady()
        else failAll(`Backend speaks protocol ${message.protocolVersion}, client speaks ${PROTOCOL_VERSION}`)
        break
      case 'command-result': {
        const resolve = commands.get(message.requestId)
        commands.delete(message.requestId)
        resolve?.(message.result)
        break
      }
      case 'snapshot-result': {
        const resolve = snapshots.get(message.requestId)
        snapshots.delete(message.requestId)
        resolve?.(message.result)
        break
      }
      case 'frame':
        listeners.get(message.subscriptionId)?.(message.frame)
        break
      case 'fault':
        failAll(message.message)
        break
    }
  }
  port.addEventListener('message', onMessage)

  const faulted = <T>(): T => ({ ok: false, error: { code: 'internal', message: fault ?? 'Backend unavailable' } }) as T

  return {
    ready,
    send<C extends Command>(command: C): Promise<CommandResult<C['type']>> {
      if (fault !== null) return Promise.resolve(faulted<CommandResult<C['type']>>())
      const requestId = nextId++
      return new Promise((resolve) => {
        commands.set(requestId, resolve as (result: CommandResult) => void)
        port.postMessage({ kind: 'command', requestId, command })
      })
    },
    snapshot<Q extends SnapshotQuery>(query: Q): Promise<SnapshotResult<Q['kind']>> {
      if (fault !== null) return Promise.resolve(faulted<SnapshotResult<Q['kind']>>())
      const requestId = nextId++
      return new Promise((resolve) => {
        snapshots.set(requestId, resolve as (result: SnapshotResult) => void)
        port.postMessage({ kind: 'snapshot', requestId, query })
      })
    },
    subscribe(listener: (frame: StreamFrame) => void, filter: SubscriptionFilter = {}): Unsubscribe {
      const subscriptionId = nextId++
      listeners.set(subscriptionId, listener)
      port.postMessage({ kind: 'subscribe', subscriptionId, filter })
      return () => {
        if (!listeners.delete(subscriptionId)) return
        port.postMessage({ kind: 'unsubscribe', subscriptionId })
      }
    },
    dispose(): void {
      port.removeEventListener('message', onMessage)
      listeners.clear()
      failAll('Backend client disposed')
    },
  }
}

/**
 * Backend side: serves a {@link BackendClient} (core's backend) over a port.
 * Attaches its listener at once, so requests that arrive while the backend
 * is still starting are held and reach it in arrival order once it is ready.
 *
 * @returns a function that stops serving and drops every subscription
 */
export function servePort(
  backend: BackendClient | Promise<BackendClient>,
  port: WirePort<ClientMessage, BackendMessage>,
): () => void {
  const subscriptions = new Map<number, Unsubscribe>()
  let stopped = false

  const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

  // Callbacks registered on one promise run in registration order, so the
  // backend sees requests in arrival order. Replies are not serialized: a
  // slow request never holds up a later Stop.
  const whenReady = Promise.resolve(backend)
  whenReady.then(
    () => {
      if (!stopped) port.postMessage({ kind: 'ready', protocolVersion: PROTOCOL_VERSION })
    },
    (error: unknown) => {
      if (!stopped) port.postMessage({ kind: 'fault', message: describe(error) })
    },
  )

  const handle = async (target: BackendClient, message: ClientMessage): Promise<void> => {
    switch (message.kind) {
      case 'command': {
        const result = await target.send(message.command)
        if (!stopped) port.postMessage({ kind: 'command-result', requestId: message.requestId, result })
        break
      }
      case 'snapshot': {
        const result = await target.snapshot(message.query)
        if (!stopped) port.postMessage({ kind: 'snapshot-result', requestId: message.requestId, result })
        break
      }
      case 'subscribe': {
        const { subscriptionId } = message
        const unsubscribe = target.subscribe((frame) => {
          if (!stopped) port.postMessage({ kind: 'frame', subscriptionId, frame })
        }, message.filter)
        subscriptions.set(subscriptionId, unsubscribe)
        break
      }
      case 'unsubscribe': {
        subscriptions.get(message.subscriptionId)?.()
        subscriptions.delete(message.subscriptionId)
        break
      }
    }
  }

  const onMessage = (event: { readonly data: ClientMessage }): void => {
    const message = event.data
    whenReady
      .then((target) => (stopped ? undefined : handle(target, message)))
      .catch((error: unknown) => {
        if (stopped) return
        const failure = { ok: false, error: { code: 'internal', message: describe(error) } } as const
        if (message.kind === 'command') {
          port.postMessage({ kind: 'command-result', requestId: message.requestId, result: failure })
        } else if (message.kind === 'snapshot') {
          port.postMessage({ kind: 'snapshot-result', requestId: message.requestId, result: failure })
        }
      })
  }
  port.addEventListener('message', onMessage)

  return () => {
    stopped = true
    port.removeEventListener('message', onMessage)
    for (const unsubscribe of subscriptions.values()) unsubscribe()
    subscriptions.clear()
  }
}

import type { KeyCheck, KeyProviderName } from '@pluribus/protocol'
import type { KeyProvision, KeyProvisionResult } from '@/backend/key-provision'

/**
 * The embedded deployment's key provision: a small request/reply pair on
 * the backend Worker's port, beside the backend protocol and apart from it.
 * A key travels page → Worker in one `key-request` and never comes back:
 * replies carry a verdict or an acknowledgement only. It is never part of a
 * backend command, so it cannot reach the event log, a projection, the
 * stream, an export or a log line.
 *
 * `createWorkerKeyProvision` is the page's side; `serveKeys` is the
 * Worker's, over a {@link KeyService} that holds the secrets store.
 */

export type KeyRequest =
  | { readonly op: 'check'; readonly provider: KeyProviderName; readonly key: string }
  | { readonly op: 'set'; readonly provider: KeyProviderName; readonly key: string }
  | { readonly op: 'remove'; readonly provider: KeyProviderName }

export type KeyClientMessage =
  | { readonly kind: 'key-request'; readonly requestId: number; readonly request: KeyRequest }
  /** Abandons a check whose answer is no longer wanted. */
  | { readonly kind: 'key-cancel'; readonly requestId: number }

export type KeyReply =
  | { readonly op: 'check'; readonly check: KeyCheck }
  | { readonly op: 'done'; readonly result: KeyProvisionResult }
  | { readonly op: 'cancelled' }

export interface KeyWorkerMessage {
  readonly kind: 'key-result'
  readonly requestId: number
  readonly reply: KeyReply
}

/** What the Worker does with keys. Implemented in `key-service.ts`. */
export interface KeyService {
  check(provider: KeyProviderName, key: string, signal: AbortSignal): Promise<KeyCheck>
  set(provider: KeyProviderName, key: string): Promise<KeyProvisionResult>
  remove(provider: KeyProviderName): Promise<KeyProvisionResult>
}

/** The part of a `Worker` or a Worker's global scope the two sides need. */
export interface KeyPort {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Page side: a {@link KeyProvision} that forwards to the Worker. */
export function createWorkerKeyProvision(port: KeyPort): KeyProvision {
  let nextId = 1
  const pending = new Map<number, (reply: KeyReply) => void>()
  port.addEventListener('message', (event) => {
    const message = event.data
    if (!isRecord(message) || message['kind'] !== 'key-result') return
    const { requestId, reply } = message as unknown as KeyWorkerMessage
    const resolve = pending.get(requestId)
    pending.delete(requestId)
    resolve?.(reply)
  })
  const ask = (request: KeyRequest, signal?: AbortSignal): Promise<KeyReply> =>
    new Promise((resolve) => {
      const requestId = nextId++
      pending.set(requestId, resolve)
      port.postMessage({ kind: 'key-request', requestId, request } satisfies KeyClientMessage)
      signal?.addEventListener('abort', () => {
        if (!pending.delete(requestId)) return
        port.postMessage({ kind: 'key-cancel', requestId } satisfies KeyClientMessage)
        resolve({ op: 'cancelled' })
      })
    })
  const done = async (request: KeyRequest): Promise<KeyProvisionResult> => {
    const reply = await ask(request)
    return reply.op === 'done' ? reply.result : { ok: false, message: 'The backend did not confirm the change.' }
  }
  return {
    canProvideKeys: true,
    async check(provider, key, signal) {
      const reply = await ask({ op: 'check', provider, key }, signal)
      if (reply.op === 'check') return reply.check
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      return { status: 'offline' }
    },
    set: (provider, key) => done({ op: 'set', provider, key }),
    remove: (provider) => done({ op: 'remove', provider }),
  }
}

/**
 * Worker side: answers key requests with a {@link KeyService}. Listens at
 * once; requests that arrive before the service exists wait for it.
 */
export function serveKeys(port: KeyPort, service: Promise<KeyService>): void {
  const checks = new Map<number, AbortController>()
  const reply = (requestId: number, value: KeyReply): void => port.postMessage({ kind: 'key-result', requestId, reply: value } satisfies KeyWorkerMessage)

  async function handle(requestId: number, request: KeyRequest): Promise<void> {
    const keys = await service
    if (request.op === 'check') {
      const controller = new AbortController()
      checks.set(requestId, controller)
      try {
        reply(requestId, { op: 'check', check: await keys.check(request.provider, request.key, controller.signal) })
      } catch {
        reply(requestId, controller.signal.aborted ? { op: 'cancelled' } : { op: 'check', check: { status: 'offline' } })
      } finally {
        checks.delete(requestId)
      }
      return
    }
    const result = request.op === 'set' ? await keys.set(request.provider, request.key) : await keys.remove(request.provider)
    reply(requestId, { op: 'done', result })
  }

  port.addEventListener('message', (event) => {
    const message = event.data
    if (!isRecord(message)) return
    if (message['kind'] === 'key-cancel') {
      checks.get((message as unknown as { requestId: number }).requestId)?.abort()
      return
    }
    if (message['kind'] !== 'key-request') return
    const { requestId, request } = message as unknown as Extract<KeyClientMessage, { kind: 'key-request' }>
    handle(requestId, request).catch(() => {
      // An error could carry the key: say only that it failed.
      reply(requestId, request.op === 'check' ? { op: 'check', check: { status: 'offline' } } : { op: 'done', result: { ok: false, message: 'The key service failed.' } })
    })
  })
}

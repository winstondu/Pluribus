import { describe, expect, test } from 'vitest'
import type { BackendClient, StreamFrame } from './backend'
import { PROTOCOL_VERSION } from './backend'
import type { Command } from './commands'
import { asId } from './ids'
import { emptyConversationSnapshot } from './projections'
import { DEFAULT_SETTINGS } from './settings'
import type { BackendMessage, ClientMessage, WirePort } from './wire'
import { createPortClient, servePort } from './wire'

type Listener<T> = (event: { readonly data: T }) => void

/** Two connected ports that deliver asynchronously and copy what they carry, like `postMessage`. */
function portPair(): { client: WirePort<BackendMessage, ClientMessage>; backend: WirePort<ClientMessage, BackendMessage> } {
  const toClient = new Set<Listener<BackendMessage>>()
  const toBackend = new Set<Listener<ClientMessage>>()
  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
  return {
    client: {
      postMessage: (message) => {
        const data = copy(message)
        void Promise.resolve().then(() => toBackend.forEach((listener) => listener({ data })))
      },
      addEventListener: (_type, listener) => void toClient.add(listener),
      removeEventListener: (_type, listener) => void toClient.delete(listener),
    },
    backend: {
      postMessage: (message) => {
        const data = copy(message)
        void Promise.resolve().then(() => toClient.forEach((listener) => listener({ data })))
      },
      addEventListener: (_type, listener) => void toBackend.add(listener),
      removeEventListener: (_type, listener) => void toBackend.delete(listener),
    },
  }
}

const conversationId = asId('conversation', 'cnv_WIRE')

function fakeBackend(): BackendClient & { received: Command[]; emit(frame: StreamFrame): void } {
  const listeners = new Set<(frame: StreamFrame) => void>()
  const received: Command[] = []
  const backend: BackendClient = {
    send: async (command) => {
      received.push(command)
      if (command.type === 'submit-message') {
        return { ok: true, output: { messageId: asId('message', 'msg_1') } } as never
      }
      return { ok: false, error: { code: 'not-allowed', message: 'no' } }
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    snapshot: async (query) => {
      if (query.kind === 'conversation') {
        return { ok: true, value: emptyConversationSnapshot(query.conversationId) } as never
      }
      return { ok: false, error: { code: 'unknown-target', message: 'nothing here' } }
    },
  }
  return Object.assign(backend, { received, emit: (frame: StreamFrame) => listeners.forEach((listener) => listener(frame)) })
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('port transport', () => {
  test('commands and snapshots round-trip with their typed results', async () => {
    const ports = portPair()
    const backend = fakeBackend()
    servePort(backend, ports.backend)
    const client = createPortClient(ports.client)
    await client.ready

    const sent = await client.send({ type: 'submit-message', conversationId, text: 'hello' })
    expect(sent).toEqual({ ok: true, output: { messageId: 'msg_1' } })
    expect(backend.received).toEqual([{ type: 'submit-message', conversationId, text: 'hello' }])

    const refused = await client.send({ type: 'undo-split', conversationId, originalMessageId: asId('message', 'msg_1') })
    expect(refused).toEqual({ ok: false, error: { code: 'not-allowed', message: 'no' } })

    const snapshot = await client.snapshot({ kind: 'conversation', conversationId })
    expect(snapshot.ok && snapshot.value.throughSeq).toBe(0)
  })

  test('requests sent before the backend has started are answered once it is ready, in arrival order', async () => {
    const ports = portPair()
    const backend = fakeBackend()
    let start: (value: BackendClient) => void = () => {}
    servePort(new Promise<BackendClient>((resolve) => (start = resolve)), ports.backend)
    const client = createPortClient(ports.client)

    const first = client.send({ type: 'submit-message', conversationId, text: 'one' })
    const second = client.send({ type: 'submit-message', conversationId, text: 'two' })
    await settle()
    expect(backend.received).toEqual([])

    start(backend)
    await Promise.all([client.ready, first, second])
    expect(backend.received.map((command) => (command.type === 'submit-message' ? command.text : ''))).toEqual(['one', 'two'])
  })

  test('frames reach each subscriber in order until it unsubscribes', async () => {
    const ports = portPair()
    const backend = fakeBackend()
    servePort(backend, ports.backend)
    const client = createPortClient(ports.client)
    await client.ready

    const seen: string[] = []
    const unsubscribe = client.subscribe((frame) => seen.push(frame.kind))
    await settle()
    const app: StreamFrame = { kind: 'app', events: [], app: { conversations: [], settings: DEFAULT_SETTINGS, key: { configured: false } } }
    backend.emit(app)
    backend.emit({ kind: 'conversation', conversationId, fromSeq: 1, throughSeq: 1, events: [], patches: [] })
    await settle()
    expect(seen).toEqual(['app', 'conversation'])

    unsubscribe()
    await settle()
    backend.emit(app)
    await settle()
    expect(seen).toEqual(['app', 'conversation'])
  })

  test('a fault fails pending and later requests instead of leaving them hanging', async () => {
    const ports = portPair()
    servePort(Promise.reject(new Error('IndexedDB is unavailable')), ports.backend)
    const client = createPortClient(ports.client)
    const pending = client.send({ type: 'list-conversations' })
    await expect(client.ready).rejects.toThrow('IndexedDB is unavailable')
    expect(await pending).toEqual({ ok: false, error: { code: 'internal', message: 'IndexedDB is unavailable' } })
    expect(await client.snapshot({ kind: 'app' })).toEqual({ ok: false, error: { code: 'internal', message: 'IndexedDB is unavailable' } })
  })

  test('standby is reported and ready still follows when the backend can serve', async () => {
    const ports = portPair()
    const backend = fakeBackend()
    const reasons: string[] = []
    const client = createPortClient(ports.client, { onStandby: (reason) => reasons.push(reason) })

    // The Worker serves at once but its backend exists only after it holds the lock.
    let lockGranted: (value: BackendClient) => void = () => {}
    servePort(new Promise<BackendClient>((resolve) => (lockGranted = resolve)), ports.backend)
    ports.backend.postMessage({ kind: 'standby', reason: 'another-tab' })
    const pending = client.send({ type: 'submit-message', conversationId, text: 'held' })
    await settle()
    expect(reasons).toEqual(['another-tab'])
    expect(backend.received).toEqual([])

    lockGranted(backend)
    await client.ready
    expect(await pending).toEqual({ ok: true, output: { messageId: 'msg_1' } })
  })

  test('a protocol version mismatch is refused', async () => {
    const ports = portPair()
    const client = createPortClient(ports.client)
    ports.backend.postMessage({ kind: 'ready', protocolVersion: PROTOCOL_VERSION + 1 })
    await expect(client.ready).rejects.toThrow(/protocol/)
  })
})

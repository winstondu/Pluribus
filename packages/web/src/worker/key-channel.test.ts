/// <reference types="node" />
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { KeyCheck } from '@pluribus/protocol'
import { describe, expect, test } from 'vitest'
import { createWorkerKeyProvision, serveKeys, type KeyPort, type KeyService } from './key-channel'
import { createKeyService, type KeyVault } from './key-service'

const KEY = 'sk-ant-api03-0123456789abcdef0123456789abcdef'

/** Two ports wired to each other, recording everything that crosses, as `postMessage` would carry it. */
function wire(): { page: KeyPort; worker: KeyPort; toWorker: unknown[]; toPage: unknown[] } {
  const pageListeners: ((event: { data: unknown }) => void)[] = []
  const workerListeners: ((event: { data: unknown }) => void)[] = []
  const toWorker: unknown[] = []
  const toPage: unknown[] = []
  const deliver = (listeners: typeof pageListeners, log: unknown[], message: unknown): void => {
    const copy: unknown = JSON.parse(JSON.stringify(message))
    log.push(copy)
    queueMicrotask(() => listeners.forEach((listener) => listener({ data: copy })))
  }
  return {
    toWorker,
    toPage,
    page: { postMessage: (message) => deliver(workerListeners, toWorker, message), addEventListener: (_type, listener) => void pageListeners.push(listener) },
    worker: { postMessage: (message) => deliver(pageListeners, toPage, message), addEventListener: (_type, listener) => void workerListeners.push(listener) },
  }
}

function memoryVault(): KeyVault & { readonly stored: Map<string, string> } {
  const stored = new Map<string, string>()
  return {
    stored,
    set: async (name, value) => void stored.set(name, value),
    delete: async (name) => void stored.delete(name),
  }
}

describe('the embedded key provision', () => {
  test('a key goes page → Worker once, into the secrets store, and never comes back', async () => {
    const { page, worker, toWorker, toPage } = wire()
    const vault = memoryVault()
    let refreshed = 0
    const service = createKeyService({
      vault,
      refreshKeyStatus: async () => void (refreshed += 1),
      checks: {
        openrouter: async (key) => (key === KEY ? { status: 'valid', label: null, credit: { kind: 'available' } } : { status: 'invalid' }),
      },
    })
    serveKeys(worker, Promise.resolve(service))
    const keys = createWorkerKeyProvision(page)
    expect(keys.canProvideKeys).toBe(true)

    const signal = new AbortController().signal
    expect(await keys.check('openrouter', KEY, signal)).toEqual({ status: 'valid', label: null, credit: { kind: 'available' } })
    expect(await keys.check('openrouter', 'sk-ant-other', signal)).toEqual({ status: 'invalid' })
    expect(vault.stored.size).toBe(0)

    expect(await keys.set('openrouter', KEY)).toEqual({ ok: true })
    expect(vault.stored.get('openrouter-key')).toBe(KEY)
    expect(refreshed).toBe(1)
    expect(await keys.remove('openrouter')).toEqual({ ok: true })
    expect(vault.stored.has('openrouter-key')).toBe(false)
    expect(refreshed).toBe(2)

    // The key appears only in requests to the Worker; no reply carries it.
    expect(JSON.stringify(toWorker)).toContain(KEY)
    expect(JSON.stringify(toPage)).not.toContain(KEY)
  })

  test('a failing store or check is reported without the key', async () => {
    const { page, worker, toPage } = wire()
    const service = createKeyService({
      vault: {
        set: async (_name, value) => {
          throw new Error(`could not write ${value}`)
        },
        delete: async () => {
          throw new Error('nope')
        },
      },
      refreshKeyStatus: async () => {},
      checks: {
        openrouter: async (key) => {
          throw new Error(`boom ${key}`)
        },
      },
    })
    serveKeys(worker, Promise.resolve(service))
    const keys = createWorkerKeyProvision(page)
    expect(await keys.set('openrouter', KEY)).toEqual({ ok: false, message: 'The key could not be stored in this browser.' })
    expect(await keys.set('openrouter', '   ')).toEqual({ ok: false, message: 'The key cannot be empty.' })
    expect(await keys.remove('openrouter')).toEqual({ ok: false, message: 'The key could not be removed from this browser.' })
    expect(await keys.check('openrouter', KEY, new AbortController().signal)).toEqual({ status: 'offline' })
    expect(JSON.stringify(toPage)).not.toContain(KEY)
  })

  test('an abandoned check is cancelled in the Worker and rejects on the page', async () => {
    const { page, worker } = wire()
    let aborted = false
    const service: KeyService = {
      check: (_provider, _key, signal) =>
        new Promise<KeyCheck>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true
            reject(new Error('aborted'))
          })
        }),
      set: async () => ({ ok: true }),
      remove: async () => ({ ok: true }),
    }
    serveKeys(worker, Promise.resolve(service))
    const controller = new AbortController()
    const pending = createWorkerKeyProvision(page).check('openrouter', KEY, controller.signal)
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()
    await expect(pending).rejects.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(aborted).toBe(true)
  })
})

/** Every `.ts`/`.tsx` under a directory. */
function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path)
    return /\.tsx?$/.test(name) ? [path] : []
  })
}

describe('layering', () => {
  const root = join(import.meta.dirname, '..')

  test('no component reaches the Worker, the storage package or the providers: keys go through KeyProvision, configuration through the backend', () => {
    const offenders: string[] = []
    for (const path of sources(root)) {
      const relative = path.slice(root.length + 1)
      // The Worker's own files, and the one module that connects to it, are the embedded deployment.
      if (relative.startsWith('worker/') || relative === 'backend/connect.ts') continue
      const text = readFileSync(path, 'utf8')
      if (/from '@pluribus\/(storage|providers)'/.test(text) || /from '(@\/worker|\.\.?\/(\.\.\/)*worker)\//.test(text)) offenders.push(relative)
    }
    expect(offenders).toEqual([])
  })

  test('the dev-server keys are read in the key prompt only', () => {
    const readers = sources(root)
      .filter((path) => /__DEV_OPENROUTER_KEY__/.test(readFileSync(path, 'utf8')))
      .map((path) => path.slice(root.length + 1))
      .filter((path) => !path.endsWith('.test.ts') && !path.endsWith('.test.tsx'))
      .sort()
    expect(readers).toEqual(['app/key-prompt.tsx', 'env.d.ts'])
  })
})

import { describe, expect, test } from 'vitest'
import type { AppSnapshot } from '@pluribus/protocol'
import { answer, type TestBackend } from '../../../testing'
import { expectRebuildable, scenario, type Scenario } from '../../../testing/acceptance/engine'

const OPENROUTER_SECRET = 'sk-or-v1-secret-0123456789abcdef'

async function appOf(t: TestBackend): Promise<AppSnapshot> {
  const result = await t.backend.snapshot({ kind: 'app' })
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

const app = (s: Scenario): Promise<AppSnapshot> => appOf(s.t)

/** Asks, and lets the scripted answer finish. */
async function run(s: Scenario, text: string): Promise<void> {
  await s.ask(text, { label: text }, answer('Done.', 10, 20))
  await s.t.advance(30)
}

/** The deployment's key service: it writes the secrets store, then tells the backend. */
async function provide(s: Scenario, name: 'openrouter-key', value: string | null): Promise<void> {
  if (value === null) await s.t.secretsStore.delete(name)
  else await s.t.secretsStore.set(name, value)
  await s.t.backend.refreshKeyStatus()
}

describe('providers and keys', () => {
  test('a key is provided by the deployment, never by a command: only its presence is recorded', async () => {
    const s = await scenario({ key: false })
    expect((await app(s)).key.configured).toBe(false)
    await provide(s, 'openrouter-key', OPENROUTER_SECRET)
    expect((await app(s)).key.configured).toBe(true)
    expect(await s.t.secretsStore.get('openrouter-key')).toBe(OPENROUTER_SECRET)

    const appLog = await s.t.eventStore.read('app')
    expect(appLog.filter((event) => event.type === 'key-status-changed')).toMatchObject([
      { configured: true },
    ])
    // Calling again with nothing changed records nothing.
    await s.t.backend.refreshKeyStatus()
    expect((await s.t.eventStore.read('app')).length).toBe(appLog.length)

    // Run, then look everywhere a key could have leaked.
    await run(s, 'Plan a trip to Kyoto')
    const everything = JSON.stringify([await s.t.eventStore.read('app'), await s.t.eventStore.read(s.c), s.t.frames, await app(s), await s.snap()])
    expect(everything).not.toContain(OPENROUTER_SECRET)
    // The snapshot `events` query is what an export of the log reads.
    const exported = await s.t.backend.snapshot({ kind: 'events', conversationId: s.c, afterSeq: 0 })
    expect(JSON.stringify(exported)).not.toMatch(/sk-or-v1-secret/)
  })

  test('a deployment whose models are set by the server refuses a model change and reports no role as editable', async () => {
    const s = await scenario({ options: { modelsEditable: false } })
    expect((await app(s)).modelRoles.every((role) => !role.editable)).toBe(true)
    const refused = await s.t.send({ type: 'change-settings', changes: { models: { synthesis: 'example/other' } } })
    expect(refused).toMatchObject({ ok: false, error: { code: 'not-allowed' } })
    // Other settings are still the user's.
    expect((await s.t.send({ type: 'change-settings', changes: { concurrencyLimit: 2 } })).ok).toBe(true)
  })
})

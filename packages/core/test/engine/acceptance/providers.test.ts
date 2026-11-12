import { describe, expect, test } from 'vitest'
import type { AppSnapshot } from '@committee/protocol'
import { answer, type TestBackend } from '../../../testing'
import { expectRebuildable, scenario, type Scenario } from '../../../testing/acceptance/engine'

/**
 * Per-role providers and the two keys. Core is provider-agnostic: it passes
 * each role's provider through to its ports and records it; which provider
 * a role may use, and what happens when a key goes, is the backend's rule.
 */

const OPENROUTER_SECRET = 'sk-or-v1-secret-0123456789abcdef'
const ANTHROPIC_SECRET = 'sk-ant-api03-secret-0123456789abcdef'

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
async function provide(s: Scenario, name: 'openrouter-key' | 'anthropic-key', value: string | null): Promise<void> {
  if (value === null) await s.t.secretsStore.delete(name)
  else await s.t.secretsStore.set(name, value)
  await s.t.backend.refreshKeyStatus()
}

describe('providers and keys', () => {
  test('a key is provided by the deployment, never by a command: only its presence is recorded, per provider', async () => {
    const s = await scenario({ key: false })
    expect([(await app(s)).key.configured, (await app(s)).anthropicKey.configured]).toEqual([false, false])
    await provide(s, 'openrouter-key', OPENROUTER_SECRET)
    await provide(s, 'anthropic-key', ANTHROPIC_SECRET)
    expect([(await app(s)).key.configured, (await app(s)).anthropicKey.configured]).toEqual([true, true])
    // The two keys are held apart, and each reads back as it was stored.
    expect(await s.t.secretsStore.get('openrouter-key')).toBe(OPENROUTER_SECRET)
    expect(await s.t.secretsStore.get('anthropic-key')).toBe(ANTHROPIC_SECRET)

    const appLog = await s.t.eventStore.read('app')
    expect(appLog.filter((event) => event.type === 'key-status-changed')).toMatchObject([
      { configured: true },
      { configured: true, provider: 'anthropic' },
    ])
    // Calling again with nothing changed records nothing.
    await s.t.backend.refreshKeyStatus()
    expect((await s.t.eventStore.read('app')).length).toBe(appLog.length)

    // Use both keys' providers, then look everywhere a key could have leaked.
    await s.t.send({ type: 'change-settings', changes: { modelProviders: { answer: 'anthropic' } } })
    await run(s, 'Plan a trip to Kyoto')
    const everything = JSON.stringify([await s.t.eventStore.read('app'), await s.t.eventStore.read(s.c), s.t.frames, await app(s), await s.snap()])
    expect(everything).not.toContain(OPENROUTER_SECRET)
    expect(everything).not.toContain(ANTHROPIC_SECRET)
    // The snapshot `events` query is what an export of the log reads.
    const exported = await s.t.backend.snapshot({ kind: 'events', conversationId: s.c, afterSeq: 0 })
    expect(JSON.stringify(exported)).not.toMatch(/sk-or-v1-secret|sk-ant-api03-secret/)
  })

  test('a role can be moved to the Claude API only while an Anthropic key is configured; the backend picks the default model', async () => {
    const s = await scenario()
    const refused = await s.t.send({ type: 'change-settings', changes: { modelProviders: { answer: 'anthropic' } } })
    expect(refused).toMatchObject({ ok: false, error: { code: 'invalid', message: 'Add an Anthropic key before choosing the Claude API for a role' } })
    expect((await app(s)).modelRoles.find((role) => role.role === 'answer')?.providers.map((p) => p.available)).toEqual([true, false])

    await provide(s, 'anthropic-key', ANTHROPIC_SECRET)
    expect((await app(s)).modelRoles.find((role) => role.role === 'answer')?.providers.map((p) => p.available)).toEqual([true, true])
    expect((await s.t.send({ type: 'change-settings', changes: { modelProviders: { answer: 'anthropic' } } })).ok).toBe(true)
    const settings = (await app(s)).settings
    expect([settings.modelProviders.answer, settings.models.answer]).toEqual(['anthropic', 'claude-sonnet-5-5'])
    expect((await app(s)).modelRoles.find((role) => role.role === 'answer')).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5-5', editable: true })

    // An OpenRouter model ID on a Claude API role is refused, and decisions cannot move.
    expect((await s.t.send({ type: 'change-settings', changes: { models: { answer: 'anthropic/claude-haiku-5.5' } } })).ok).toBe(false)
    expect((await s.t.send({ type: 'change-settings', changes: { modelProviders: { decision: 'anthropic' } } })).ok).toBe(false)
  })

  test('each role\'s provider reaches its port, and an attempt records the provider beside the model', async () => {
    const s = await scenario()
    await provide(s, 'anthropic-key', ANTHROPIC_SECRET)
    // Answers on the Claude API; synthesis and decomposition stay on OpenRouter.
    await s.t.send({ type: 'change-settings', changes: { modelProviders: { answer: 'anthropic' }, models: { answer: 'claude-haiku-5-5' } } })
    await run(s, 'Plan a trip to Kyoto')

    const requests = s.t.model.requests
    expect(requests.at(-1)).toMatchObject({ model: 'claude-haiku-5-5', provider: 'anthropic' })
    const events = await s.events()
    const started = events.find((event) => event.type === 'attempt-started')
    expect(started).toMatchObject({ model: 'claude-haiku-5-5', provider: 'anthropic', modelRole: 'answer' })
    const directiveId = started?.type === 'attempt-started' ? started.directiveId : null
    if (directiveId === null) throw new Error('no attempt')
    const inspection = await s.t.backend.snapshot({ kind: 'run', conversationId: s.c, directiveId, attemptId: null })
    expect(inspection.ok && inspection.value.attempt).toMatchObject({ model: 'claude-haiku-5-5', provider: 'anthropic' })
    await expectRebuildable(s)
  })

  test('removing the Anthropic key returns the roles that used it to OpenRouter and its default models, in the same step', async () => {
    const s = await scenario()
    await provide(s, 'anthropic-key', ANTHROPIC_SECRET)
    await s.t.send({ type: 'change-settings', changes: { modelProviders: { answer: 'anthropic', synthesis: 'anthropic' }, models: { decomposition: 'anthropic/claude-sonnet-5.5' } } })
    expect((await app(s)).settings.modelProviders).toMatchObject({ answer: 'anthropic', synthesis: 'anthropic', decomposition: 'openrouter' })
    const framesBefore = s.t.frames.length

    await provide(s, 'anthropic-key', null)
    const after = await app(s)
    expect(after.anthropicKey.configured).toBe(false)
    expect(after.settings.modelProviders).toEqual({ answer: 'openrouter', synthesis: 'openrouter', decomposition: 'openrouter', decision: 'openrouter' })
    expect(after.settings.models).toMatchObject({ answer: 'anthropic/claude-sonnet-5.5', synthesis: 'anthropic/claude-sonnet-5.5', decomposition: 'anthropic/claude-sonnet-5.5' })
    // One step: the key status and the settings change arrive together, so no frame shows a role on a provider without a key.
    const frames = s.t.frames.slice(framesBefore).filter((frame) => frame.kind === 'app')
    expect(frames).toHaveLength(1)
    expect(frames[0]?.kind === 'app' && frames[0].events.map((event) => event.type)).toEqual(['key-status-changed', 'settings-changed'])
    // The OpenRouter key is untouched.
    expect(after.key.configured).toBe(true)

    // The next run goes to OpenRouter.
    await run(s, 'Plan a trip to Kyoto')
    expect(s.t.model.requests.at(-1)).toMatchObject({ model: 'anthropic/claude-sonnet-5.5', provider: 'openrouter' })
  })

  test('a restart that finds the Anthropic key gone falls back the same way; one that finds it keeps the choice', async () => {
    const s = await scenario()
    await provide(s, 'anthropic-key', ANTHROPIC_SECRET)
    await s.t.send({ type: 'change-settings', changes: { modelProviders: { synthesis: 'anthropic' } } })

    const kept = await s.t.restart()
    expect((await appOf(kept)).settings.modelProviders.synthesis).toBe('anthropic')
    expect((await appOf(kept)).anthropicKey.configured).toBe(true)

    // The secrets store is cleared while no backend runs (site data cleared, say).
    await kept.secretsStore.delete('anthropic-key')
    const fell = await kept.restart()
    const after = await appOf(fell)
    expect(after.anthropicKey.configured).toBe(false)
    expect([after.settings.modelProviders.synthesis, after.settings.models.synthesis]).toEqual(['openrouter', 'anthropic/claude-sonnet-5.5'])
  })

  test('a deployment whose models are set by the server refuses a model or provider change and reports no role as editable', async () => {
    const s = await scenario({ options: { modelsEditable: false } })
    expect((await app(s)).modelRoles.every((role) => !role.editable)).toBe(true)
    const refused = await s.t.send({ type: 'change-settings', changes: { models: { synthesis: 'example/other' } } })
    expect(refused).toMatchObject({ ok: false, error: { code: 'not-allowed' } })
    // Other settings are still the user's.
    expect((await s.t.send({ type: 'change-settings', changes: { concurrencyLimit: 2 } })).ok).toBe(true)
  })
})

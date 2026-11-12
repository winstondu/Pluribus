import { createScriptedKeyProvision } from '@/backend/key-provision'
import { applyPatches, diffSnapshots, type ConversationFrame, type StreamFrame } from '@committee/protocol'
import { describe, expect, test } from 'vitest'
import { createFixtureBackend, fixtures, fx, getFixture, type Fixture } from '@/fixtures'

function twoStepFixture(): Fixture {
  const initial = fx
    .conversation('t')
    .chain('trip')
    .message('a', 'Suggest neighborhoods')
    .response('a', { message: 'a' })
    .section('A', { response: 'a', chain: 'trip', state: 'pending', title: 'neighborhoods' })
    .message('b', 'Suggest rainy-day activities')
    .response('b', { message: 'b' })
    .section('B', { response: 'b', chain: 'trip', state: 'pending', title: 'activities' })
    .build()
  return {
    id: 't',
    title: 'Two',
    covers: [],
    initial,
    steps: [
      {
        label: 'B shows text',
        delayMs: 10,
        next: (previous) =>
          fx
            .from(previous)
            .patch('section', 'B', { state: 'streaming' })
            .attempt('B1', { section: 'B', state: 'streaming', text: 'Tea' })
            .build(),
      },
      {
        label: 'A shows text',
        delayMs: 10,
        next: (previous) =>
          fx
            .from(previous)
            .patch('section', 'A', { state: 'streaming' })
            .attempt('A1', { section: 'A', state: 'streaming', text: 'Gion' })
            .appendText('B1', ' houses')
            .build(),
      },
    ],
  }
}

describe('fixture builder', () => {
  test('derives responseIds, sectionIds, attemptIds, messageId and default actions', () => {
    const snapshot = fx
      .conversation('d')
      .chain('c')
      .message('m', 'Hello')
      .response('r', { message: 'm' })
      .section('s', { response: 'r', chain: 'c', state: 'completed' })
      .attempt('a', { section: 's', state: 'completed', text: 'Hi' })
      .build()
    const section = snapshot.transcript.sections[fx.id('section', 's')]
    expect(snapshot.transcript.messages[fx.id('message', 'm')]?.responseIds).toEqual([fx.id('response', 'r')])
    expect(snapshot.transcript.responses[fx.id('response', 'r')]?.sectionIds).toEqual([fx.id('section', 's')])
    expect(section?.attemptIds).toEqual([fx.id('attempt', 'a')])
    expect(section?.messageId).toBe(fx.id('message', 'm'))
    expect(section?.actions).toEqual({ reply: true, stop: false, retry: false, regenerate: false })
    expect(snapshot.transcript.messages[fx.id('message', 'm')]?.chainIds).toEqual([fx.id('chain', 'c')])
    expect(snapshot.transcript.order).toEqual([
      { kind: 'message', id: fx.id('message', 'm') },
      { kind: 'response', id: fx.id('response', 'r') },
    ])
  })

  test('throws on a dangling reference', () => {
    expect(() =>
      fx.conversation('x').message('m', 'Hi').response('r', { message: 'm' }).section('s', { response: 'r', chain: 'nope', state: 'pending' }).build(),
    ).toThrow(/unknown chain "nope"/)
  })

  test('items keep the position at which they were fixed; pending responses are the tail', () => {
    const fixture = twoStepFixture()
    const backend = createFixtureBackend(fixture)
    const names = () =>
      backend.current.transcript.order.map((item) => `${item.kind === 'message' ? 'm' : 'r'}:${item.id.slice(4)}`)
    expect(names()).toEqual(['m:a', 'm:b', 'r:a', 'r:b'])
    backend.step()
    expect(names()).toEqual(['m:a', 'm:b', 'r:b', 'r:a'])
    backend.step()
    expect(names()).toEqual(['m:a', 'm:b', 'r:b', 'r:a'])
  })

  test('operation depth is the longest dependency path among active operations', () => {
    const snapshot = fx
      .conversation('o')
      .chain('c')
      .operation('a', { chain: 'c', status: 'running' })
      .operation('b', { chain: 'c', status: 'completed', retired: true })
      .operation('j', { chain: 'c', status: 'waiting-for-results', dependsOn: ['a', 'b'], waitingFor: ['a'] })
      .operation('k', { chain: 'c', status: 'waiting-for-results', dependsOn: ['j'] })
      .build()
    const depth = (name: string) => snapshot.operationGraph.operations[fx.id('operation', name)]?.depth
    expect([depth('a'), depth('j'), depth('k')]).toEqual([0, 1, 2])
    expect(snapshot.operationGraph.retired).toEqual([fx.id('operation', 'b')])
  })
})

describe('fixture backend', () => {
  test('each step is one frame whose patches reproduce the next snapshot', () => {
    const backend = createFixtureBackend(twoStepFixture())
    const frames: ConversationFrame[] = []
    backend.subscribe((frame: StreamFrame) => {
      if (frame.kind === 'conversation') frames.push(frame)
    })
    let mirror = backend.current
    expect(backend.step()).toBe(true)
    expect(backend.step()).toBe(true)
    expect(backend.step()).toBe(false)
    expect(frames.map((frame) => [frame.fromSeq, frame.throughSeq, frame.events.length])).toEqual([
      [1, 1, 0],
      [2, 2, 0],
    ])
    for (const frame of frames) mirror = applyPatches(mirror, frame.patches, frame.throughSeq)
    expect(mirror).toEqual(backend.current)
    // Streamed text travels as an append, so a streaming section re-renders alone.
    expect(frames[1]?.patches.some((patch) => patch.target === 'transcript.attempt-text')).toBe(true)
    expect(diffSnapshots(mirror, backend.current)).toEqual([])
  })

  test('a key is provided to the fixture backend, never sent to it: only its presence is known', async () => {
    const backend = createFixtureBackend({ ...twoStepFixture(), app: { key: { configured: false } } })
    const keys = createScriptedKeyProvision(backend, 0)
    expect(await keys.set('openrouter', 'sk-or-v1-secret')).toEqual({ ok: true })
    expect(await keys.set('anthropic', 'sk-ant-secret')).toEqual({ ok: true })
    expect(backend.app.key).toEqual({ configured: true })
    expect(backend.app.anthropicKey).toEqual({ configured: true })
    expect(backend.sent).toEqual([])
    expect(JSON.stringify(backend.app)).not.toMatch(/sk-or-v1-secret|sk-ant-secret/)
  })

  test('the fixture backend reports each role\'s choices and applies the backend\'s rules to them', async () => {
    const backend = createFixtureBackend(twoStepFixture())
    const keys = createScriptedKeyProvision(backend, 0)
    const answer = () => backend.app.modelRoles.find((role) => role.role === 'answer')
    expect(answer()?.providers.map((provider) => [provider.provider, provider.available])).toEqual([['openrouter', true], ['anthropic', false]])
    // Without an Anthropic key the Claude API cannot be chosen.
    expect((await backend.send({ type: 'change-settings', changes: { modelProviders: { answer: 'anthropic' } } })).ok).toBe(false)
    await keys.set('anthropic', 'sk-ant-secret')
    expect(answer()?.providers.every((provider) => provider.available)).toBe(true)
    // The provider alone: the backend gives the role that provider's default model.
    expect((await backend.send({ type: 'change-settings', changes: { modelProviders: { answer: 'anthropic' } } })).ok).toBe(true)
    expect([backend.app.settings.modelProviders.answer, backend.app.settings.models.answer]).toEqual(['anthropic', 'claude-sonnet-5-5'])
    // Removing the key returns the role to OpenRouter and its default there.
    await keys.remove('anthropic')
    expect([backend.app.settings.modelProviders.answer, backend.app.settings.models.answer]).toEqual(['openrouter', 'anthropic/claude-sonnet-5.5'])
  })

  test('answers app commands itself, each with an app frame', async () => {
    const backend = createFixtureBackend(twoStepFixture())
    const frames: StreamFrame[] = []
    backend.subscribe((frame) => frames.push(frame))
    const created = await backend.send({ type: 'create-conversation' })
    expect(created.ok && created.output.conversation.title).toBe('New conversation')
    await backend.send({ type: 'change-settings', changes: { concurrencyLimit: 2 } })
    expect(backend.app.settings.concurrencyLimit).toBe(2)
    const rejected = await backend.send({ type: 'change-settings', changes: { concurrencyLimit: 0 } })
    expect(rejected.ok).toBe(false)
    expect(frames.filter((frame) => frame.kind === 'app')).toHaveLength(2)
  })

  test('respond may reject a command', async () => {
    const backend = createFixtureBackend({
      ...twoStepFixture(),
      respond: (command) =>
        command.type === 'stop' ? { result: { ok: false, error: { code: 'not-allowed', message: 'Already settled' } } } : null,
    })
    const result = await backend.send({
      type: 'stop',
      conversationId: backend.current.conversationId,
      target: { kind: 'section', sectionId: fx.id('section', 'A') },
    })
    expect(result).toEqual({ ok: false, error: { code: 'not-allowed', message: 'Already settled' } })
  })
})

describe('fixture registry', () => {
  test('every case has a unique kebab-case id and builds', () => {
    const ids = fixtures.map((fixture) => fixture.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    expect(getFixture('empty')).toBeDefined()
  })

  test('every case plays to the end and every step is a consistent frame', () => {
    for (const fixture of fixtures) {
      const backend = createFixtureBackend(fixture)
      let mirror = backend.current
      backend.subscribe((frame) => {
        if (frame.kind === 'conversation') mirror = applyPatches(mirror, frame.patches, frame.throughSeq)
      })
      backend.playAll()
      expect(mirror, fixture.id).toEqual(backend.current)
      for (const item of backend.current.transcript.order) {
        const record =
          item.kind === 'message'
            ? backend.current.transcript.messages[item.id]
            : backend.current.transcript.responses[item.id]
        expect(record, `${fixture.id}: ${item.id} in order`).toBeDefined()
      }
    }
  })
})

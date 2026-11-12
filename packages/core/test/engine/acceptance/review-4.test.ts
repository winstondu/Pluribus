import { describe, expect, test } from 'vitest'
import { WORDING, type ExchangeNodeView } from '@pluribus/protocol'
import type { TokenCount } from '../../../src/ports'
import { answer, atomic, createTestBackend } from '../../../testing'
import { engineModule } from '../../../src/engine/engine-module'
import { expectRebuildable, scenario } from '../../../testing/acceptance/engine'

/** Findings of the fourth review that reach the engine alone. */

describe('fourth review: "Waiting for a free slot" only while every slot is taken', () => {
  test('scheduling · a lone run whose tokens are being counted shows "Responding…", never "Waiting for a free slot"', async () => {
    const s = await scenario({ settings: { concurrencyLimit: 2 } })
    let release: ((count: TokenCount) => void) | null = null
    const original = s.t.model.countTokens.bind(s.t.model)
    s.t.model.countTokens = () =>
      new Promise<TokenCount>((resolve) => {
        release = resolve
      })
    s.t.model.script('Lonely', answer('Alone.', 10, 20))
    s.t.router.when('Lonely', (input) => atomic(input, { label: 'Lonely' }))
    void s.t.backend.send({ type: 'submit-message', conversationId: s.c, text: 'Lonely' })
    await s.t.flush()
    const d = s.d('Lonely')
    expect(d.state).toBe('ready')
    expect(d.slotHeld).toBe(false)
    const view = await s.section('Lonely')
    expect(view.status).toEqual({ kind: 'responding', text: WORDING.responding })
    expect((await s.events()).some((e) => e.type === 'directive-slot-held')).toBe(false)
    s.t.model.countTokens = original
    const done = release as ((count: TokenCount) => void) | null
    done?.({ inputTokens: 10, contextLimit: null, exact: false })
    await s.t.advance(100)
    expect(s.d('Lonely').state).toBe('completed')
    expect((await s.events()).some((e) => e.type === 'directive-slot-held')).toBe(false)
  })

  test('scheduling · ready work held by the limit is recorded as held once, and the record rebuilds', async () => {
    const s = await scenario({ settings: { concurrencyLimit: 1 } })
    await s.ask('First', { label: 'first' }, answer('1', 10, 100))
    await s.ask('Second', { label: 'second' }, answer('2', 10, 100))
    expect(s.d('second').slotHeld).toBe(true)
    expect((await s.section('second')).status?.kind).toBe('waiting-for-slot')
    const held = (await s.events()).filter((e) => e.type === 'directive-slot-held')
    expect(held).toHaveLength(1)
    await expectRebuildable(s)
    await s.t.advance(500)
    expect(s.d('second').state).toBe('completed')
    expect((await s.events()).filter((e) => e.type === 'directive-slot-held')).toHaveLength(1)
  })
})

describe('fourth review: the mini-map draws planned work on an open group', () => {
  test('09 §1 · work planned on an open sibling group names the group, so it is never drawn as a new root', async () => {
    const s = await scenario()
    await s.ask('Brief', { label: 'brief' }, answer('Noted.', 10, 20))
    await s.t.advance(50)
    await s.ask('A', { label: 'A', placement: s.on('brief') }, answer('a', 10, 1_000))
    await s.ask('B', { label: 'B', placement: s.onHeadOf('brief') }, answer('b', 10, 1_000))
    await s.ask('J', { label: 'J', placement: s.onGroupOf('A'), prerequisites: [s.needsGroupOf('A')] }, answer('j', 10, 20))
    let snap = await s.snap()
    const group = Object.values(s.state().groups)[0]
    const j = snap.genealogy.nodes[s.d('J').nodeId] as ExchangeNodeView
    expect(j.parents).toEqual([])
    expect(j.plannedGroupIds).toEqual([group?.id])
    await s.t.advance(2_000)
    snap = await s.snap()
    const started = snap.genealogy.nodes[s.d('J').nodeId] as ExchangeNodeView
    expect(started.plannedGroupIds).toEqual([])
    expect(started.parents).toHaveLength(1)
  })
})

describe('fourth review: "New conversation" does not store empty conversations', () => {
  test('10 · Conversation list · creating while an empty conversation exists opens it; after a message a new one is made', async () => {
    const t = await createTestBackend({ modules: [engineModule] })
    const first = await t.createConversation()
    expect(await t.createConversation()).toBe(first)
    expect(await t.createConversation()).toBe(first)
    let list = await t.backend.send({ type: 'list-conversations' })
    expect(list.ok && list.output.conversations.map((c) => c.id)).toEqual([first])
    t.router.when('Hello', (input) => atomic(input, { label: 'Hello' }))
    t.model.script('Hello', answer('Hi.', 10, 20))
    await t.submit(first, 'Hello')
    const second = await t.createConversation()
    expect(second).not.toBe(first)
    list = await t.backend.send({ type: 'list-conversations' })
    expect(list.ok && list.output.conversations).toHaveLength(2)
  })
})


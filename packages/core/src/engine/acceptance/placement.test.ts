import { describe, expect, test } from 'vitest'
import type { ConversationSnapshot, TranscriptItemRef } from '@committee/protocol'
import { answer, independent, say, spanOf } from '../../testing'
import { scenario, type Scenario } from './helpers'

/** P1–P4, P6, P8 (03 · "Transcript and placement") as core facts. */

const A = 'Summarize the history of Kyoto in detail'
const B = 'Translate "good morning" into French'

function order(snap: ConversationSnapshot, s: Scenario): string[] {
  const label = (ref: TranscriptItemRef): string => {
    if (ref.kind === 'message') return `msg:${snap.transcript.messages[ref.id]?.text.slice(0, 9) ?? '?'}`
    const response = snap.transcript.responses[ref.id]
    const message = response ? snap.transcript.messages[response.messageId] : undefined
    return `rsp:${message?.text.slice(0, 9) ?? '?'}:${response?.placement ?? '?'}`
  }
  void s
  return snap.transcript.order.map(label)
}

describe('placement', () => {
  test("P1 · if independent B starts showing an answer before A, B appears ahead of A's pending bubble even though A was requested first", async () => {
    const s = await scenario()
    await s.ask(A, { label: 'history' }, answer('Kyoto was founded in 794…', 500, 900))
    await s.ask(B, { label: 'translation' }, answer('Bonjour.', 100, 150))
    await s.t.advance(200)
    const snap = await s.snap()
    expect(order(snap, s)).toEqual(['msg:Summarize', 'msg:Translate', 'rsp:Translate:fixed', 'rsp:Summarize:pending'])
  })

  test('P2 · if A starts showing an answer first but B completes first, A stays ahead of B', async () => {
    const s = await scenario()
    await s.ask(A, { label: 'history' }, answer('Kyoto was founded in 794…', 100, 1_000))
    await s.ask(B, { label: 'translation' }, answer('Bonjour.', 200, 300))
    await s.t.advance(400)
    expect(s.d('translation').state).toBe('completed')
    expect(s.d('history').state).toBe('running')
    await s.t.advance(1_000)
    const snap = await s.snap()
    expect(order(snap, s)).toEqual(['msg:Summarize', 'msg:Translate', 'rsp:Summarize:fixed', 'rsp:Translate:fixed'])
  })

  test('P3 · user message A remains before user message B in both cases', async () => {
    for (const [aAt, bAt] of [
      [500, 100],
      [100, 200],
    ] as const) {
      const s = await scenario()
      await s.ask(A, { label: 'history' }, answer('Kyoto…', aAt, aAt + 100))
      await s.ask(B, { label: 'translation' }, answer('Bonjour.', bAt, bAt + 100))
      for (const step of [50, 150, 250, 650]) {
        await s.t.advance(step)
        const messages = order(await s.snap(), s).filter((x) => x.startsWith('msg:'))
        expect(messages).toEqual(['msg:Summarize', 'msg:Translate'])
      }
    }
  })

  test("P4 · B's answer is accessible while A is in progress", async () => {
    const s = await scenario()
    await s.ask(A, { label: 'history' }, answer('Kyoto…', 100, 5_000))
    await s.ask(B, { label: 'translation' }, answer('Bonjour.', 100, 200))
    await s.t.advance(300)
    const b = await s.section('translation')
    const a = await s.section('history')
    expect(b.state).toBe('completed')
    expect(b.actions.reply).toBe(true)
    const snap = await s.snap()
    expect(snap.transcript.attempts[b.attemptIds[0] ?? '']?.text).toBe('Bonjour.')
    expect(a.state).toBe('streaming')
  })

  test('P6 · a result-dependent follow-up has a visible queued indicator above the composer; independent work is not shown as dependency-queued', async () => {
    const s = await scenario()
    await s.ask('Recommend a neighborhood', { label: 'neighborhoods' }, answer('Gion.', 100, 1_000))
    await s.ask('Expand the recommendation you are preparing', {
      label: 'expansion',
      placement: s.on('neighborhoods'),
      prerequisites: [s.needs('neighborhoods')],
    })
    await s.ask('Also explain dinosaurs', { label: 'dinosaurs' }, answer('Big lizards.', 100, 2_000))
    const snap = await s.snap()
    expect(snap.queue.items.map((i) => [i.label, i.text, i.state])).toEqual([['expansion', 'Waiting for neighborhoods', 'waiting']])
    expect(snap.queue.items[0]?.messageId).toBe(s.d('expansion').messageId)
    expect((await s.section('expansion')).status?.kind).toBe('waiting-for-results')
    const dinosaurs = await s.section('dinosaurs')
    expect(dinosaurs.status?.kind).not.toBe('waiting-for-results')
    expect(s.d('dinosaurs').state).toBe('running')
    expect(snap.queue.items.some((i) => i.directiveId === s.id('dinosaurs'))).toBe(false)
  })

  test('P8 · a composite reply group keeps its position after first output; an explicit output order is honored', async () => {
    const s = await scenario()
    const text = 'Translate this menu, and separately explain why the sky is blue.'
    s.t.model.script('Translate this menu', answer('Menu.', 300, 400))
    s.t.model.script('explain why the sky is blue', answer('Scattering.', 100, 1_500))
    s.t.router.when(text, (input) =>
      independent(input, [
        { label: 'menu', spans: spanOf(text, 'Translate this menu') },
        { label: 'sky', spans: spanOf(text, 'explain why the sky is blue') },
      ]),
    )
    await s.t.submit(s.c, text)
    await s.ask('Quick: what is 2 + 2?', { label: 'sum' }, answer('4', 200, 250))
    await s.t.advance(150)
    let snap = await s.snap()
    const group = Object.values(snap.transcript.responses).find((r) => r.grouped)
    expect(group?.placement).toBe('fixed')
    const position = snap.transcript.order.findIndex((r) => r.kind === 'response' && r.id === group?.id)
    // Sections inside the group take their positions at their own first output.
    expect(group?.sectionIds).toEqual([s.d('sky').sectionId, s.d('menu').sectionId])
    await s.t.advance(2_000)
    snap = await s.snap()
    expect(snap.transcript.order.findIndex((r) => r.kind === 'response' && r.id === group?.id)).toBe(position)
    expect(snap.transcript.responses[group?.id ?? '']?.sectionIds).toEqual([s.d('sky').sectionId, s.d('menu').sectionId])

    // An explicit output order takes precedence over first output.
    const ordered = 'Put the translation first: translate this sign, and explain tides.'
    s.t.model.script('translate this sign', answer('Sortie.', 400, 500))
    s.t.model.script('explain tides', answer('The moon.', 100, 200))
    s.t.router.when(ordered, (input) =>
      independent(
        input,
        [
          { label: 'sign', spans: spanOf(ordered, 'translate this sign') },
          { label: 'tides', spans: spanOf(ordered, 'explain tides') },
        ],
        { outputOrder: [0, 1], barrier: { reason: 'explicit-order', qualifier: 'Put the translation first' } },
      ),
    )
    await s.t.submit(s.c, ordered)
    await s.t.advance(300)
    snap = await s.snap()
    const explicit = Object.values(snap.transcript.responses).find((r) => r.messageId === s.d('sign').messageId)
    expect(s.d('tides').state).toBe('completed')
    expect(explicit?.sectionIds).toEqual([s.d('sign').sectionId, s.d('tides').sectionId])
    void say
  })
})

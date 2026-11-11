import { describe, expect, test } from 'vitest'
import { answer } from '../../testing'
import { routingScenario } from './helpers'

/** P9 (03 · "Transcript and placement"). */

describe('placement', () => {
  test('P9 · a clarification-derived answer appears as a later response, not as a retroactive insertion into the original answer group', async () => {
    const s = await routingScenario()
    const text = 'Explain why the sky is blue, translate this menu into French: soup, bread, and explain what happened yesterday'
    s.t.model.script('Explain why the sky is blue', answer('Scattering.', 10, 20))
    s.t.model.script('Translate this menu', answer('Soupe, pain.', 30, 40))
    s.t.model.script('Ask the user one short', answer('Which event yesterday?', 10, 20))
    const original = await s.send(
      text,
      { composite: 0.9, parts: [{ relation: 'new' }, { relation: 'new' }, { relation: 'new', clarify: 0.9 }] },
      {
        decompose: [
          { part: 'Explain why the sky is blue', label: 'sky' },
          { part: 'translate this menu into French: soup, bread', instruction: 'Translate this menu into French: soup, bread', label: 'menu' },
          { part: 'explain what happened yesterday', label: 'yesterday' },
        ],
      },
    )
    await s.t.advance(100)
    const initial = s.state().messages[original]?.initialResponseId ?? ''
    let snap = await s.t.snapshot(s.c)
    const group = snap.transcript.responses[initial]
    expect(group?.grouped).toBe(true)
    expect(group?.sectionIds).toEqual([s.d('sky').sectionId, s.d('menu').sectionId])
    const before = [...(group?.sectionIds ?? [])]

    s.t.model.script('Explain what happened yesterday', answer('The drill was at 10.', 10, 20))
    const reply = await s.send('The office fire drill', {}, { replyTo: ['question about yesterday'] })
    await s.t.advance(50)
    snap = await s.t.snapshot(s.c)
    const yesterday = s.d('yesterday')
    const section = snap.transcript.sections[yesterday.sectionId ?? '']
    expect(section?.state).toBe('completed')
    const response = snap.transcript.responses[section?.responseId ?? '']
    expect(response?.reason).toBe('clarified-answer')
    expect(response?.id).not.toBe(initial)
    expect(snap.transcript.responses[initial]?.sectionIds).toEqual(before)
    // It is a later response: after the original group, the question, and the answering message.
    const order = snap.transcript.order.map((r) => `${r.kind}:${r.id}`)
    const questionResponse = snap.transcript.sections[s.d('question about yesterday').sectionId ?? '']?.responseId
    expect(order.indexOf(`response:${response?.id ?? ''}`)).toBeGreaterThan(order.indexOf(`response:${initial}`))
    expect(order.indexOf(`response:${response?.id ?? ''}`)).toBeGreaterThan(order.indexOf(`response:${questionResponse ?? ''}`))
    expect(order.indexOf(`response:${response?.id ?? ''}`)).toBeGreaterThan(order.indexOf(`message:${reply}`))
    // The answering message creates no directive; its rail is the work it released.
    expect(s.state().messages[reply]?.directiveIds).toEqual([])
    expect(snap.transcript.messages[reply]?.chainIds).toEqual([yesterday.chainId])
    // The clarified run reads its request, then the question, then the answer.
    const run = s.state().attempts[yesterday.attemptIds[0] ?? '']
    expect(run?.context.messages.slice(-3).map((m) => m.origin.kind)).toEqual(['request', 'clarification-question', 'clarification-answer'])
  })
})

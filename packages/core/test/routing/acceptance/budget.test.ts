import { textTokens, type RoutingDecided } from '@pluribus/protocol'
import { describe, expect, test } from 'vitest'
import { sessionLogTokens } from '../../../src/engine'
import { answer, fail, say } from '../../../testing'
import { routingScenario } from '../../../testing/acceptance/routing'

/**
 * The decision token budget on a real backend: what a
 * relative budget is a share of, and that routing receives it.
 */

const BRIEF = 'Trip brief: Kyoto, five days, November'
const A = 'Suggest neighborhoods to stay in'
const B = 'Suggest rainy-day activities'
const NEXT = 'Explain how volcanoes form'

describe('the size of the conversation\'s log', () => {
  test('budget · the log is every user message and the text of every attempt, a failed attempt\'s partial text included, at one token per four characters', async () => {
    const s = await routingScenario({ settings: { retryPolicy: 'manual' } })
    expect(sessionLogTokens(s.state())).toBe(0)
    s.t.model.script(BRIEF, answer('Noted.', 10, 20))
    await s.send(BRIEF)
    await s.t.advance(50)
    expect(sessionLogTokens(s.state())).toBe(textTokens(BRIEF.length) + textTokens('Noted.'.length))

    // A fails after it has written something: the attempt and its partial text stay in the log and count.
    s.t.model.script(A, [say(10, 'Gion, and then'), fail(20, 'invalid-request')])
    s.t.model.script(B, answer('Museums and tea houses.', 10, 20))
    await s.send(A, { message: { relation: 'addition' } }, { replyTo: [BRIEF] })
    await s.send(B, { message: { relation: 'addition' } }, { replyTo: [BRIEF] })
    await s.t.advance(100)
    expect(s.d(A).state).toBe('failed')
    const recorded = [BRIEF, 'Noted.', A, 'Gion, and then', B, 'Museums and tea houses.']
    const before = sessionLogTokens(s.state())
    expect(before).toBe(recorded.reduce((sum, text) => sum + textTokens(text.length), 0))

    // Deterministic from state, and it only grows: the same state gives the same figure, more log gives more.
    expect(sessionLogTokens(s.state())).toBe(before)
    s.t.model.script(NEXT, answer('Magma rises.', 10, 20))
    await s.send(NEXT, { message: { relation: 'new' } })
    await s.t.advance(50)
    expect(sessionLogTokens(s.state())).toBe(before + textTokens(NEXT.length) + textTokens('Magma rises.'.length))
  })

  test('budget · with an absolute budget smaller than its request, routing on a backend still sends that request and records why it could not be made smaller', async () => {
    const s = await routingScenario({ settings: { routing: { tokenBudget: { mode: 'absolute', inputTokens: 200 } } } })
    s.t.model.script(BRIEF, answer('Noted.', 10, 20))
    await s.send(BRIEF)
    await s.t.advance(50)
    s.t.model.script(A, answer('Gion and Higashiyama.', 10, 20))
    await s.send(A, { message: { relation: 'addition', targets: { [s.state().sections[s.d(BRIEF).sectionId ?? '']?.title ?? '']: 0.9 } } })
    await s.t.advance(50)
    expect(s.d(A).targets).toEqual([s.d(BRIEF).sectionId])
    const decided = (await s.events()).filter((e): e is RoutingDecided => e.type === 'routing-decided').at(-1)
    expect(decided?.decision.explanation).toContain('The routing request costs more than the decision token budget allows (200 tokens) and could not be made smaller.')
  })
})

import { describe, expect, test } from 'vitest'
import type { ElicitationRaised } from '@pluribus/protocol'
import { answer } from '../../../testing'
import { routingScenario } from '../../../testing/acceptance/routing'

/** E1, E2 (07 · "Elicitation"). E3 and E4 are core-recovery's. */

const TRANSLATE_AND_YESTERDAY = 'Translate this menu into French: soup, bread, and explain what happened yesterday, translation first'

describe('elicitation', () => {
  test('E1 · clarification questions are not blocked by the whole-request answer barrier', async () => {
    const s = await routingScenario()
    s.t.model.script('Ask the user one short', answer('Which event yesterday: the fire drill or the marathon?', 10, 20))
    s.t.model.script('Translate this menu', answer('Soupe, pain.', 10, 20))
    await s.send(
      TRANSLATE_AND_YESTERDAY,
      { composite: 0.9, barrier: 0.9, parts: [{ relation: 'new' }, { relation: 'new', clarify: 0.9, why: 'missing' }] },
      {
        decompose: [
          { part: 'Translate this menu into French: soup, bread', label: 'menu translation' },
          { part: 'explain what happened yesterday', label: 'yesterday' },
        ],
        extra: { barrier: { reason: 'explicit-order', qualifier: 'translation first' }, outputOrder: [0, 1] },
      },
    )
    const translation = s.d('menu translation')
    const yesterday = s.d('yesterday')
    const question = s.d('question about yesterday')
    expect(question.kind).toBe('clarification-question')
    // The barrier holds the answer work: the translation waits for the blocked part.
    expect(yesterday.state).toBe('paused')
    expect(translation.state).toBe('dependency-queued')
    expect(translation.heldByBarrier).toBe(true)
    // The question is not held: it runs at once and is shown.
    await s.t.advance(50)
    expect(s.directive(question.id).state).toBe('completed')
    expect(s.directive(translation.id).attemptIds).toHaveLength(0)
    const snap = await s.t.snapshot(s.c)
    const questionSection = snap.transcript.sections[question.sectionId ?? '']
    expect(questionSection?.state).toBe('completed')
    expect(snap.queue.items.some((i) => i.directiveId === question.id)).toBe(false)

    // The answer releases the blocked part, and with it the barrier.
    s.t.model.script('Explain what happened yesterday', answer('The fire drill was at 10.', 10, 20))
    await s.send('The office fire drill', {}, { replyTo: ['question about yesterday'] })
    await s.t.advance(50)
    expect(s.directive(yesterday.id).state).toBe('completed')
    expect(s.directive(translation.id).state).toBe('completed')
  })

  test('E2 · incompatible user requirements or a consequential missing preference elicit clarification', async () => {
    const s = await routingScenario()
    await s.send('Write a 50-word summary of the Roman Empire that covers every emperor in detail', {
      message: { clarify: 0.92, why: 'conflict' },
    })
    await s.send('Recommend a hotel near the conference', { message: { clarify: 0.88, why: 'missing' } })
    await s.send('Recommend a good book for a long flight', { message: { clarify: 0.2 } })
    const events = await s.events()
    const raised = events.filter((e): e is ElicitationRaised => e.type === 'elicitation-raised').map((e) => e.elicitation)
    expect(raised.map((e) => e.kind === 'clarification' && e.reason)).toEqual(['incompatible-requirements', 'missing-information'])
    const conflict = s.d('Write a 50-word summary of the…')
    const missing = s.d('Recommend a hotel near the conference')
    expect(conflict.state).toBe('paused')
    expect(missing.state).toBe('paused')
    expect(conflict.sectionId).toBeNull()
    // Work with only ordinary vagueness is answered.
    expect(s.d('Recommend a good book for a…').state).not.toBe('awaiting-elicitation')
    // Each question is its own additional response, written by the answer model from the blocked request.
    await s.t.advance(50)
    const snap = await s.t.snapshot(s.c)
    const reasons = Object.values(snap.transcript.responses).map((r) => r.reason)
    expect(reasons.filter((r) => r === 'clarification-question')).toHaveLength(2)
    const request = s.t.model.requests.find((r) => r.messages.at(-1)?.content.includes('contradict'))
    expect(request?.messages.at(-1)?.content).toContain('Write a 50-word summary of the Roman Empire')
    expect(s.state().messages[conflict.messageId]?.decision?.units[0]?.needsClarification).toBeCloseTo(0.92)
  })
})

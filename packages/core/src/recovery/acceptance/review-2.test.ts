import { describe, expect, test } from 'vitest'
import type { SectionId } from '@committee/protocol'
import { answer, done, fail, say } from '../../testing'
import { BRIEF, recoveryScenario, revise, sectionOf } from './helpers'

/**
 * Findings of the second review that reach the recovery slice: the choice
 * with default over a brief, and Stop on started work that waits for a free
 * slot after an automatic retry.
 */

describe('second review: choice with default and stop', () => {
  test('E4 (unaffected) · a running consumer judged unaffected by a shared-requirement revision continues and is not offered', async () => {
    const s = await recoveryScenario()
    await s.ask(BRIEF, { label: 'brief' }, answer('Noted: five days.', 10, 20))
    await s.t.advance(50)
    await s.ask('Suggest neighborhoods to stay in', { label: 'neighborhoods', placement: s.on('brief') }, [say(10, 'Gion'), say(60_000, ' and Higashiyama.'), done(60_010)])
    await s.t.advance(50)
    const first = s.d('neighborhoods').attemptIds[0] ?? ''
    expect(s.d('neighborhoods').state).toBe('running')
    await revise(s, 'Actually, the trip is four days, not five', { scope: 'shared-requirement', targets: ['brief'], affected: { neighborhoods: false } })
    const snap = await s.snap()
    expect(snap.queue.elicitations.filter((e) => e.kind === 'choice-with-default')).toEqual([])
    expect(s.state().attempts[first]?.state).toBe('streaming')
    expect(s.d('neighborhoods').state).toBe('running')
    // Once it finishes it carries the superseded-input note: it read the brief without the correction.
    await s.t.advance(61_000)
    expect(s.d('neighborhoods').state).toBe('completed')
    expect(sectionOf(await s.snap(), s, 'neighborhoods').notes.map((n) => n.kind)).toContain('superseded-input')
  })

  test('F2 (engine) · stopping a section that waits for a free slot after an automatic retry marks it stopped, not cancelled, and keeps its text', async () => {
    const s = await recoveryScenario({ settings: { concurrencyLimit: 1 } })
    s.t.model.script('Explain caching', [say(10, 'PARTIAL caching'), fail(20, 'bad-gateway')])
    await s.ask('Explain caching', { label: 'caching' })
    await s.t.advance(30)
    expect(s.d('caching').state).toBe('retrying')
    await s.ask('Why is the sky blue?', { label: 'sky' }, [say(10, 'Light'), done(60_000)])
    await s.t.advance(2_000)
    // The backoff elapsed, and the one slot is taken: started work, ready again, waiting for a slot.
    expect(s.d('caching').state).toBe('ready')
    const before = sectionOf(await s.snap(), s, 'caching')
    expect(before.actions.stop).toBe(true)
    await s.t.send({ type: 'stop', conversationId: s.c, target: { kind: 'section', sectionId: s.d('caching').sectionId as SectionId } })
    expect(s.d('caching').state).toBe('stopped')
    const snap = await s.snap()
    const view = sectionOf(snap, s, 'caching')
    expect(view.state).toBe('stopped')
    expect(snap.transcript.attempts[view.attemptIds[0] ?? '']?.text).toBe('PARTIAL caching')
    // It never starts again, and the other request keeps running (F2).
    await s.t.advance(60_000)
    expect(s.d('caching').attemptIds).toHaveLength(1)
    expect(s.d('sky').state).toBe('completed')
  })

  test('F2 (engine) · stopping a whole request whose section waits for a slot after a retry marks that section stopped', async () => {
    const s = await recoveryScenario({ settings: { concurrencyLimit: 1 } })
    s.t.model.script('Explain caching', [say(10, 'PARTIAL caching'), fail(20, 'bad-gateway')])
    await s.ask('Explain caching', { label: 'caching' })
    const messageId = s.state().messageOrder[0]
    if (!messageId) throw new Error('no message')
    await s.t.advance(30)
    await s.ask('Why is the sky blue?', { label: 'sky' }, [say(10, 'Light'), done(60_000)])
    await s.t.advance(2_000)
    expect((await s.snap()).transcript.messages[messageId]?.actions.stop).toBe(true)
    await s.t.send({ type: 'stop', conversationId: s.c, target: { kind: 'request', messageId } })
    const view = sectionOf(await s.snap(), s, 'caching')
    expect(view.state).toBe('stopped')
    expect(s.d('sky').state).toBe('running')
  })
})

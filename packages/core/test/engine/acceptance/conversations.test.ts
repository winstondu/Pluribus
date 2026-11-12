import { describe, expect, test } from 'vitest'
import { WORDING, type ConversationId } from '@committee/protocol'
import { answer, atomic } from '../../../testing'
import { scenario } from '../../../testing/acceptance/engine'

/**
 * Q100 (10 · "Front end", 11 · "Embedded"): opening another conversation
 * does not stop work in the previous one, and the concurrency limit is
 * app-wide. The backend never learns which conversation the client shows:
 * every loaded conversation is scheduled from one pool of slots.
 */

describe('conversations', () => {
  test('conversations (Q100) · work in one conversation keeps running while another is used, and the concurrency limit counts the runs of every conversation', async () => {
    const s = await scenario({ settings: { concurrencyLimit: 2 } })
    await s.ask('First', { label: 'first' }, answer('One.', 10, 1_000))
    await s.ask('Second', { label: 'second' }, answer('Two.', 10, 1_000))
    expect([s.d('first').state, s.d('second').state]).toEqual(['running', 'running'])

    // The user opens another conversation and asks there: both slots are taken by the first one's runs.
    const other: ConversationId = await s.t.createConversation()
    s.t.router.when('Third', (input) => atomic(input, { label: 'third' }))
    s.t.model.script('Third', answer('Three.', 10, 20))
    await s.t.submit(other, 'Third')
    const third = Object.values(s.t.state(other).directives)[0]
    expect(third?.state).toBe('ready')
    const view = (await s.t.snapshot(other)).transcript.sections[third?.sectionId ?? '']
    expect(view?.status).toEqual({ kind: 'waiting-for-slot', text: WORDING.waitingForSlot })

    // The first conversation's runs go on in the background and finish; then the other's starts.
    await s.t.advance(500)
    expect(s.state().attemptText[s.d('first').attemptIds[0] ?? '']).toBe('One.')
    expect(s.t.state(other).directives[third?.id ?? '']?.state).toBe('ready')
    await s.t.advance(600)
    expect([s.d('first').state, s.d('second').state]).toEqual(['completed', 'completed'])
    await s.t.advance(100)
    expect(s.t.state(other).directives[third?.id ?? '']?.state).toBe('completed')
  })

  test('conversations (Q100) · the limit is one pool: ready work of two conversations starts in submission order, whichever conversation it is in', async () => {
    const s = await scenario({ settings: { concurrencyLimit: 1 } })
    await s.ask('Here first', { label: 'here first' }, answer('1', 10, 100))
    // Created once the first has a message: an empty conversation is reused rather than stored again.
    const other = await s.t.createConversation()
    s.t.router.when('Elsewhere', (input) => atomic(input, { label: 'elsewhere' }))
    s.t.model.script('Elsewhere', answer('Over there.', 10, 100))
    // Submission order is by time (Q60); the fake clock moves on between the two as a real one would.
    await s.t.advance(1)
    await s.t.submit(other, 'Elsewhere')
    await s.t.advance(1)
    await s.ask('Here again', { label: 'here again' }, answer('2', 10, 100))
    const elsewhere = Object.values(s.t.state(other).directives)[0]
    expect([s.d('here first').state, elsewhere?.state, s.d('here again').state]).toEqual(['running', 'ready', 'ready'])
    await s.t.advance(150)
    expect([s.d('here first').state, s.t.state(other).directives[elsewhere?.id ?? '']?.state, s.d('here again').state]).toEqual(['completed', 'running', 'ready'])
    await s.t.advance(60)
    expect([s.t.state(other).directives[elsewhere?.id ?? '']?.state, s.d('here again').state]).toEqual(['completed', 'running'])
  })
})

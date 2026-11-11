import { describe, expect, test } from 'vitest'
import type { ElicitationId, ElicitationView } from '@committee/protocol'
import { answer, say } from '../../testing'
import { expectRebuildable, type Scenario } from '../../engine/acceptance/helpers'
import { BRIEF, inputOf, recoveryScenario, revise, sectionOf } from './helpers'

/** E3, E4 (07 · "Elicitation") and the choice-with-default tests of PLAN §6. */

const FOUR_DAYS = 'Actually, the trip is four days, not five'

/** The brief, then neighborhoods and activities built on it, and an itinerary that read all three. */
async function briefAndConsumers(itinerary = answer('Day 1 … Day 5.', 10, 20)): Promise<Scenario> {
  const s = await recoveryScenario()
  await s.ask(BRIEF, { label: 'brief' }, answer('Noted: five days.', 10, 20))
  await s.t.advance(50)
  await s.ask('Suggest neighborhoods to stay in', { label: 'neighborhoods', placement: s.on('brief') }, answer('Gion.', 10, 20))
  await s.t.advance(50)
  await s.ask('Suggest rainy-day activities', { label: 'activities', placement: s.on('neighborhoods') }, answer('Museums.', 10, 20))
  await s.t.advance(50)
  await s.ask('Make a five-day itinerary from those', { label: 'itinerary', placement: s.on('activities') }, itinerary)
  await s.t.advance(50)
  return s
}

const SHARED = { scope: 'shared-requirement' as const, targets: ['brief'], affected: { neighborhoods: false, activities: false, itinerary: true } }

function choiceOf(views: readonly ElicitationView[]): Extract<ElicitationView, { kind: 'choice-with-default' }> {
  const view = views.find((v) => v.kind === 'choice-with-default')
  if (!view || view.kind !== 'choice-with-default') throw new Error('No choice with default')
  return view
}

describe('choice with default', () => {
  test('E3 · a shared-requirement revision elicits which affected work to redo, and the default executes without a response; unchosen finished work keeps its result with the superseded-input note', async () => {
    const s = await briefAndConsumers()
    const before = { neighborhoods: s.d('neighborhoods'), activities: s.d('activities'), itinerary: s.d('itinerary'), brief: s.d('brief') }
    const raisedAt = s.t.clock.now()
    await revise(s, FOUR_DAYS, SHARED)
    let snap = await s.snap()
    const choice = choiceOf(snap.queue.elicitations)
    expect(choice.correction).toBe(FOUR_DAYS)
    expect(choice.options.map((o) => [o.label, o.state, o.locked, o.selected])).toEqual([
      ['neighborhoods', 'finished', false, false],
      ['activities', 'finished', false, false],
      ['itinerary', 'finished', false, true],
    ])
    expect(choice.deadlineAt).toBe(raisedAt + 30_000)
    expect(choice.waitMs).toBe(30_000)
    // Nothing is redone until the default runs.
    await s.t.advance(29_000)
    expect(s.d('itinerary').sectionId).toBe(before.itinerary.sectionId)
    expect(sectionOf(await s.snap(), s, 'neighborhoods').notes).toEqual([])
    s.t.model.script('Make a five-day itinerary', answer('Day 1 … Day 4.', 10, 20))
    await s.t.advance(1_100)
    const events = await s.events()
    expect(events.find((e) => e.type === 'elicitation-defaulted')).toMatchObject({ trigger: 'wait-elapsed', redo: [before.itinerary.id] })
    // The chosen finished work is redone as a new response that reads the corrected brief.
    expect(s.d('itinerary').sectionId).not.toBe(before.itinerary.sectionId)
    expect(s.d('itinerary').state).toBe('completed')
    const input = inputOf(s, 'itinerary')
    expect(input.indexOf(`Correction: ${FOUR_DAYS}`)).toBe(input.indexOf('Noted: five days.') + 1)
    snap = await s.snap()
    const redone = sectionOf(snap, s, 'itinerary')
    expect(snap.transcript.responses[redone.responseId]?.reason).toBe('redo')
    // Finished work redone by default is a new response, without the in-flight note (07, Q95).
    expect(redone.notes).toEqual([])
    // Unchosen finished work keeps its result, with the note and Regenerate.
    for (const label of ['neighborhoods', 'activities'] as const) {
      expect(s.d(label).sectionId).toBe(before[label].sectionId)
      expect(s.d(label).attemptIds).toEqual(before[label].attemptIds)
      const view = sectionOf(snap, s, label)
      expect(view.notes[0]).toMatchObject({ kind: 'superseded-input', text: 'Based on superseded brief' })
      expect(view.actions.regenerate).toBe(true)
    }
    // The brief itself stays, and every later run reads it with the correction.
    expect(s.d('brief').attemptIds).toEqual(before.brief.attemptIds)
    expect(snap.queue.elicitations).toEqual([])
    await expectRebuildable(s)
  })

  test('E3 (next message) · sending another message without answering carries out the default', async () => {
    const s = await briefAndConsumers()
    const itinerary = s.d('itinerary')
    await revise(s, FOUR_DAYS, SHARED)
    await s.ask('Why is the sky blue?', { label: 'sky' })
    const defaulted = (await s.events()).find((e) => e.type === 'elicitation-defaulted')
    expect(defaulted).toMatchObject({ trigger: 'next-message', redo: [itinerary.id] })
    expect(s.d('itinerary').sectionId).not.toBe(itinerary.sectionId)
  })

  test('E3 (editing) · the choice stays editable until the default runs; a confirmed choice is carried out at once, without the "by default" note', async () => {
    const s = await briefAndConsumers()
    const itinerary = s.d('itinerary')
    const neighborhoods = s.d('neighborhoods')
    await revise(s, FOUR_DAYS, SHARED)
    const id = choiceOf((await s.snap()).queue.elicitations).id as ElicitationId
    await s.t.send({ type: 'answer-elicitation', conversationId: s.c, elicitationId: id, answer: { kind: 'choice-with-default', redo: [neighborhoods.id], confirm: false } })
    const view = choiceOf((await s.snap()).queue.elicitations)
    expect(view.options.filter((o) => o.selected).map((o) => o.label)).toEqual(['neighborhoods'])
    expect(await s.t.send({ type: 'answer-elicitation', conversationId: s.c, elicitationId: id, answer: { kind: 'choice-with-default', redo: [s.id('brief')], confirm: true } })).toMatchObject({
      ok: false,
      error: { code: 'invalid' },
    })
    await s.t.send({ type: 'answer-elicitation', conversationId: s.c, elicitationId: id, answer: { kind: 'choice-with-default', redo: [neighborhoods.id, itinerary.id], confirm: true } })
    await s.t.advance(100)
    expect(s.d('neighborhoods').sectionId).not.toBe(neighborhoods.sectionId)
    expect(s.d('itinerary').sectionId).not.toBe(itinerary.sectionId)
    const snap = await s.snap()
    expect(sectionOf(snap, s, 'itinerary').notes).toEqual([])
    expect(sectionOf(snap, s, 'activities').notes[0]?.kind).toBe('superseded-input')
    expect(await s.t.send({ type: 'answer-elicitation', conversationId: s.c, elicitationId: id, answer: { kind: 'choice-with-default', redo: [], confirm: true } })).toMatchObject({ ok: false })
  })

  test('E4 · affected work that was running when a shared requirement was revised cannot be deselected and is redone', async () => {
    const s = await briefAndConsumers([say(10, 'Day 1'), say(60_000, ' …')])
    const itinerary = s.d('itinerary')
    expect(itinerary.state).toBe('running')
    await revise(s, FOUR_DAYS, SHARED)
    // Stopped at once for the wait (superseded, not stopped), and held.
    expect(s.state().attempts[itinerary.attemptIds[0] ?? '']?.state).toBe('superseded')
    expect(s.d('itinerary').state).toBe('awaiting-elicitation')
    const choice = choiceOf((await s.snap()).queue.elicitations)
    expect(choice.options.find((o) => o.label === 'itinerary')).toMatchObject({ state: 'running', locked: true, preselected: true, selected: true })
    // Deselecting it has no effect: it is redone whatever is sent.
    s.t.model.script('Make a five-day itinerary', answer('Day 1 … Day 4.', 10, 20))
    await s.t.send({ type: 'answer-elicitation', conversationId: s.c, elicitationId: choice.id, answer: { kind: 'choice-with-default', redo: [], confirm: true } })
    await s.t.advance(100)
    expect(s.d('itinerary').state).toBe('completed')
    expect(inputOf(s, 'itinerary')).toContain(`Correction: ${FOUR_DAYS}`)
    expect(s.d('itinerary').sectionIds).toHaveLength(2)
  })

  test('E3 (correction) · a consumer of a revised brief that was not redone gets the note although the brief was not replaced', async () => {
    const s = await briefAndConsumers()
    const brief = s.d('brief')
    await revise(s, FOUR_DAYS, { scope: 'shared-requirement', targets: ['brief'], affected: { neighborhoods: false } })
    expect(sectionOf(await s.snap(), s, 'neighborhoods').notes).toEqual([])
    await s.t.advance(31_000)
    expect(s.d('brief').state).toBe('completed')
    expect(s.d('brief').resultAttemptId).toBe(brief.resultAttemptId)
    const note = sectionOf(await s.snap(), s, 'neighborhoods').notes[0]
    expect(note).toMatchObject({ kind: 'superseded-input', inputs: [{ kind: 'correction', directiveId: brief.id, label: 'brief' }] })
  })

  test('choice with default · work stopped for the wait carries "Redid … by default" only after the default ran', async () => {
    const s = await briefAndConsumers([say(10, 'Day 1'), say(60_000, ' …')])
    await revise(s, FOUR_DAYS, SHARED)
    let redone = sectionOf(await s.snap(), s, 'itinerary')
    expect(redone.notes).toEqual([])
    expect(redone.status?.kind).toBe('awaiting-answer')
    s.t.model.script('Make a five-day itinerary', answer('Day 1 … Day 4.', 10, 20))
    await s.t.advance(30_100)
    redone = sectionOf(await s.snap(), s, 'itinerary')
    expect(redone.state).toBe('completed')
    expect(redone.notes).toEqual([{ kind: 'redone-by-default', text: 'Redid itinerary by default', elicitationId: expect.any(String) }])
  })

  test('choice with default · a wait that elapsed while nothing ran is carried out on start', async () => {
    const s = await briefAndConsumers()
    const itinerary = s.d('itinerary')
    await revise(s, FOUR_DAYS, SHARED)
    s.t.clock.set(s.t.clock.now() + 60_000)
    const next = await s.t.restart()
    const defaulted = (await next.backend.snapshot({ kind: 'events', conversationId: s.c, afterSeq: 0 }))
    expect(defaulted.ok && defaulted.value.events.some((e) => e.type === 'elicitation-defaulted' && e.trigger === 'wait-elapsed')).toBe(true)
    expect(next.state(s.c).directives[itinerary.id]?.sectionId).not.toBe(itinerary.sectionId)
  })
})

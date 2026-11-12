import { describe, expect, test } from 'vitest'
import type { SectionId } from '@pluribus/protocol'
import { answer, fail, say } from '../../../testing'
import type { Scenario } from '../../../testing/acceptance/engine'
import { A_TEXT, BRIEF, B_TEXT, J_TEXT, inputOf, recoveryScenario, revise, sectionOf, trip } from '../../../testing/acceptance/recovery'

/**
 * Findings of the third review that reach the recovery slice: started work
 * waiting for a slot when its prerequisite is revised, Regenerate after
 * "Continue without", and queued work held by a choice with default.
 */

const LUXURY = 'Actually, use a luxury budget for the neighborhood recommendations'
const FOUR_DAYS = 'Actually, the trip is four days, not five'

describe('third review: a retry waiting for a slot when its prerequisite is revised', () => {
  async function setup(withSlotWait: boolean): Promise<Scenario> {
    const s = await recoveryScenario({ settings: { concurrencyLimit: 2 } })
    await s.ask('Why is the sky blue?', { label: 'sky' }, answer('Scattering.', 10, 60_000))
    await s.ask(BRIEF, { label: 'brief' }, answer('Noted.', 10, 20))
    await s.t.advance(50)
    await s.ask(A_TEXT, { label: 'neighborhoods', placement: s.on('brief') }, answer('OLD-A', 50, 100))
    await s.ask(B_TEXT, { label: 'activities', placement: s.onHeadOf('brief') }, answer('Museums.', 50, 100))
    await s.t.advance(300)
    s.t.model.script(J_TEXT, [say(10, 'PARTIAL itinerary'), fail(20, 'bad-gateway')])
    await s.ask(J_TEXT, { label: 'itinerary', placement: s.onGroupOf('neighborhoods'), prerequisites: [s.needsGroupOf('neighborhoods')] })
    await s.t.advance(25)
    expect(s.d('itinerary').state).toBe('retrying')
    if (withSlotWait) {
      await s.ask('Explain joins', { label: 'joins' }, answer('Joins.', 10, 60_000))
      await s.t.advance(5_000)
      expect(s.d('itinerary').state).toBe('ready')
    }
    s.t.model.script(J_TEXT, answer('NEW-J', 10, 20))
    s.t.model.script(A_TEXT, answer('NEW-A', 50, 100_000))
    await revise(s, LUXURY, { targets: ['neighborhoods'] })
    return s
  }

  test('R3 · R4 · J ready for a retry (backoff elapsed, waiting for a slot) when A is revised: it waits for A′ and reads it', async () => {
    const s = await setup(true)
    expect(s.d('itinerary').state).toBe('dependency-queued')
    await s.t.advance(61_000)
    expect(s.d('neighborhoods').state).toBe('running')
    expect(s.d('itinerary').state).toBe('dependency-queued')
    await s.t.advance(150_000)
    expect(s.d('neighborhoods').state).toBe('completed')
    expect(s.d('itinerary').state).toBe('completed')
    const input = inputOf(s, 'itinerary')
    expect(input).toContain('NEW-A')
    expect(input.join('\n')).not.toContain('OLD-A')
  })

  test('R3 · R4 · J between automatic retries when A is revised: it waits for A′ and reads it', async () => {
    const s = await setup(false)
    await s.t.advance(10_000)
    expect(s.d('neighborhoods').state).toBe('running')
    expect(s.d('itinerary').state).toBe('dependency-queued')
    await s.t.advance(150_000)
    expect(inputOf(s, 'itinerary')).toContain('NEW-A')
    expect(inputOf(s, 'itinerary').join('\n')).not.toContain('OLD-A')
  })
})

describe('third review: Regenerate after Continue without', () => {
  test('R8 · F5 · J ran without failed B and carries a note from revised A; B is revised too; Regenerate J while B′ runs: J′ waits for B′', async () => {
    const s = await recoveryScenario({ settings: { retryPolicy: 'manual' } })
    await trip(s, { a: answer('OLD-A', 50, 100), b: [say(50, 'Muse'), fail(100, 'bad-gateway')], j: answer('Day 1.', 10, 20) })
    await s.t.advance(300)
    await s.t.send({ type: 'continue-without', conversationId: s.c, directiveId: s.id('itinerary') })
    await s.t.advance(100)
    s.t.model.script(A_TEXT, answer('NEW-A', 10, 20))
    await revise(s, LUXURY, { targets: ['neighborhoods'] })
    await s.t.advance(100)
    s.t.model.script(B_TEXT, answer('Free museums.', 10, 3_000))
    await revise(s, 'Actually, only free activities', { targets: ['activities'] })
    await s.t.advance(50)
    expect(s.d('activities').state).toBe('running')
    const view = sectionOf(await s.snap(), s, 'itinerary')
    expect(view.actions.regenerate).toBe(true)
    s.t.model.script(J_TEXT, answer('Day 1 free.', 10, 20))
    await s.t.send({ type: 'regenerate', conversationId: s.c, sectionId: view.id })
    await s.t.advance(50)
    expect(s.d('itinerary').state).toBe('dependency-queued')
    await s.t.advance(4_000)
    expect(s.d('itinerary').state).toBe('completed')
    const input = inputOf(s, 'itinerary')
    expect(input).toContain('Free museums.')
    expect(input).toContain('NEW-A')
    // Nothing it read has been superseded since: no second note.
    expect(sectionOf(await s.snap(), s, 'itinerary').notes.filter((n) => n.kind === 'superseded-input')).toEqual([])
  })

  test('R8 · F5 · a late retry B′ of a waived B is revised; Regenerate J while B″ runs: J′ waits for B″ and reads it', async () => {
    const s = await recoveryScenario({ settings: { retryPolicy: 'manual' } })
    await trip(s, { a: answer('Gion.', 50, 100), b: [say(50, 'Muse'), fail(100, 'bad-gateway')], j: answer('Day 1.', 10, 20) })
    await s.t.advance(300)
    await s.t.send({ type: 'continue-without', conversationId: s.c, directiveId: s.id('itinerary') })
    await s.t.advance(100)
    s.t.model.script(B_TEXT, answer('Museums.', 10, 20))
    await s.t.send({ type: 'retry', conversationId: s.c, target: { kind: 'section', sectionId: s.d('activities').sectionId as SectionId } })
    await s.t.advance(100)
    expect(s.d('activities').state).toBe('completed')
    s.t.model.script(B_TEXT, answer('Free museums.', 10, 3_000))
    await revise(s, 'Actually, only free activities', { targets: ['activities'] })
    await s.t.advance(50)
    expect(s.d('activities').state).toBe('running')
    const view = sectionOf(await s.snap(), s, 'itinerary')
    s.t.model.script(J_TEXT, answer('Day 1 free.', 10, 20))
    await s.t.send({ type: 'regenerate', conversationId: s.c, sectionId: view.id })
    await s.t.advance(4_000)
    expect(inputOf(s, 'itinerary')).toContain('Free museums.')
    expect(sectionOf(await s.snap(), s, 'itinerary').notes.filter((n) => n.kind === 'superseded-input')).toEqual([])
  })
})

describe('third review: queued work during a choice-with-default wait', () => {
  async function brief(s: Scenario): Promise<void> {
    await s.ask(BRIEF, { label: 'brief' }, answer('Noted: five days.', 10, 20))
    await s.t.advance(50)
  }

  test('P6 · dependency-queued affected work keeps a queue item naming what it waits for during the wait', async () => {
    const s = await recoveryScenario()
    await brief(s)
    await s.ask(A_TEXT, { label: 'neighborhoods', placement: s.on('brief') }, answer('Gion.', 10, 60_000))
    await s.ask('Make a five-day itinerary from those', { label: 'itinerary', placement: s.on('neighborhoods'), prerequisites: [s.needs('neighborhoods')] })
    await s.t.advance(50)
    expect((await s.snap()).queue.items.map((i) => i.text)).toEqual(['Waiting for neighborhoods'])
    await revise(s, FOUR_DAYS, { scope: 'shared-requirement', targets: ['brief'], affected: { itinerary: true } })
    const snap = await s.snap()
    expect(snap.queue.items.map((i) => i.directiveId)).toContain(s.id('itinerary'))
    expect(snap.queue.items.find((i) => i.directiveId === s.id('itinerary'))?.waitingFor.map((w) => w.label)).toEqual(['neighborhoods'])
    expect(snap.queue.elicitations.map((e) => e.kind)).toContain('choice-with-default')
    // The wait elapses; the itinerary still waits for the neighborhoods, then runs with the change.
    await s.t.advance(31_000)
    expect(s.d('itinerary').state).toBe('dependency-queued')
    s.t.model.script('Make a five-day itinerary', answer('Four days.', 10, 20))
    await s.t.advance(30_000)
    expect(s.d('itinerary').state).toBe('completed')
    expect(inputOf(s, 'itinerary').join('\n')).toContain('four days')
  })

  test('07 · a paused dependent keeps its recovery choice during the wait', async () => {
    const s = await recoveryScenario({ settings: { retryPolicy: 'manual' } })
    await brief(s)
    await s.ask(A_TEXT, { label: 'neighborhoods', placement: s.on('brief') }, [say(10, 'Gi'), fail(20, 'bad-gateway')])
    await s.ask('Make a five-day itinerary from those', { label: 'itinerary', placement: s.on('neighborhoods'), prerequisites: [s.needs('neighborhoods')] })
    await s.t.advance(50)
    expect(s.d('itinerary').state).toBe('paused')
    await revise(s, FOUR_DAYS, { scope: 'shared-requirement', targets: ['brief'], affected: { itinerary: true } })
    const snap = await s.snap()
    expect(snap.queue.items.map((i) => i.text)).toEqual(['Paused — neighborhoods failed'])
    expect(snap.queue.elicitations.map((e) => e.kind)).toContain('recovery-choice')
    await s.t.advance(31_000)
    expect(s.d('itinerary').state).toBe('paused')
    expect((await s.snap()).queue.elicitations.map((e) => e.kind)).toEqual(['recovery-choice'])
  })
})

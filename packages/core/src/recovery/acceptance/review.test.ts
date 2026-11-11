import { describe, expect, test } from 'vitest'
import type { SectionId } from '@committee/protocol'
import { answer, fail, say } from '../../testing'
import { expectRebuildable } from '../../engine/acceptance/helpers'
import { A_TEXT, BRIEF, B_TEXT, J_TEXT, inputOf, recoveryScenario, revise, sectionOf, trip } from './helpers'

/**
 * The review of the recovery slice: each test failed before its fix. The
 * cases are revisions that reach work through a path the canonical tests do
 * not walk (released-but-not-started work, redo chains, later work sent
 * while a replacement runs, re-formed join-backs with a late retry, the
 * genealogy of a join-back after a member was replaced, a second revision).
 */

const LUXURY = 'Actually, use a luxury budget for the neighborhood recommendations'
const FOUR_DAYS = 'Actually, the trip is four days, not five'

describe('recovery review', () => {
  test('R3 (ready) · J released by the closed group but held by the concurrency limit still waits for A′ when A is revised', async () => {
    const s = await recoveryScenario({ settings: { concurrencyLimit: 3 } })
    await s.ask('Why is the sky blue?', { label: 'sky' }, answer('Scattering.', 10, 5_000))
    await s.ask('Explain caching', { label: 'caching' }, answer('Copies.', 10, 2_000))
    await s.ask(BRIEF, { label: 'brief' }, answer('Noted.', 10, 20))
    await s.t.advance(50)
    await s.ask(A_TEXT, { label: 'neighborhoods', placement: s.on('brief') }, answer('OLD-A', 50, 100))
    await s.ask(B_TEXT, { label: 'activities', placement: s.onHeadOf('brief') }, answer('Museums.', 50, 100))
    await s.ask('Explain joins', { label: 'joins' }, answer('Joins.', 10, 8_000))
    await s.ask(J_TEXT, { label: 'itinerary', placement: s.onGroupOf('neighborhoods'), prerequisites: [s.needsGroupOf('neighborhoods')] }, answer('Day 1.', 10, 20))
    await s.t.advance(500)
    expect(s.d('neighborhoods').state).toBe('completed')
    expect(s.d('activities').state).toBe('completed')
    expect(s.d('itinerary').state).toBe('ready')
    expect(s.d('itinerary').attemptIds).toHaveLength(0)
    s.t.model.script(A_TEXT, answer('NEW-A', 50, 10_000))
    await revise(s, LUXURY, { targets: ['neighborhoods'] })
    expect(s.d('itinerary').state).toBe('dependency-queued')
    // caching frees a slot (A′ takes it), then sky frees the other.
    await s.t.advance(6_000)
    expect(s.d('neighborhoods').state).toBe('running')
    expect(s.d('itinerary').attemptIds).toHaveLength(0)
    await s.t.advance(6_000)
    const input = inputOf(s, 'itinerary')
    expect(input).toContain('NEW-A')
    expect(input).not.toContain('OLD-A')
    await expectRebuildable(s)
  })

  test('E3 (redo chain) · the default redoes finished A and running J that read A: J′ waits for A′ and reads it', async () => {
    const s = await recoveryScenario()
    await s.ask(BRIEF, { label: 'brief' }, answer('Noted: five days.', 10, 20))
    await s.t.advance(50)
    await s.ask('Suggest neighborhoods to stay in', { label: 'neighborhoods', placement: s.on('brief') }, answer('OLD-A five days', 10, 20))
    await s.t.advance(50)
    await s.ask('Make an itinerary from that', { label: 'itinerary', placement: s.on('neighborhoods') }, [say(10, 'Day 1'), say(60_000, ' …')])
    await s.t.advance(50)
    expect(s.d('itinerary').state).toBe('running')
    s.t.model.script('Suggest neighborhoods', answer('NEW-A four days', 50, 3_000))
    s.t.model.script('Make an itinerary', answer('Day 1 … Day 4.', 10, 20))
    await revise(s, FOUR_DAYS, { scope: 'shared-requirement', targets: ['brief'], affected: { neighborhoods: true, itinerary: true } })
    await s.t.advance(30_100)
    expect(s.d('neighborhoods').state).toBe('running')
    expect(s.d('itinerary').attemptIds).toHaveLength(1)
    await s.t.advance(5_000)
    expect(s.d('itinerary').state).toBe('completed')
    const input = inputOf(s, 'itinerary')
    expect(input).toContain('NEW-A four days')
    expect(input).not.toContain('OLD-A five days')
    await expectRebuildable(s)
  })

  test('R5 (in flight) · later work depending on J, sent while A′ is still running, receives the correction plus A′', async () => {
    const s = await recoveryScenario()
    await trip(s, { a: answer('OLD-A', 50, 100), b: answer('Museums.', 50, 100), j: answer('Day 1: OLD-A.', 50, 100) })
    await s.t.advance(500)
    s.t.model.script(A_TEXT, answer('NEW-A', 50, 2_000))
    await revise(s, LUXURY, { targets: ['neighborhoods'] })
    await s.t.advance(100)
    expect(s.d('neighborhoods').state).toBe('running')
    await s.ask('Add a rest day', { label: 'rest day', placement: s.on('itinerary') }, answer('Rest.', 10, 20))
    expect(s.d('rest day').state).toBe('dependency-queued')
    await s.t.advance(3_000)
    const later = inputOf(s, 'rest day')
    expect(later).toContain(`Correction: ${LUXURY}`)
    expect(later).toContain('NEW-A')
    expect(later).not.toContain('OLD-A')
    await expectRebuildable(s)
  })

  test('F6 (re-formed) · B failed, retried after closure, then A revised: later work reads B′ once and keeps B’s marker before it', async () => {
    const s = await recoveryScenario({ settings: { retryPolicy: 'manual' } })
    await trip(s, { a: answer('OLD-A', 50, 100), b: [say(50, 'Muse'), fail(100, 'bad-gateway')], withJ: false })
    await s.t.advance(300)
    s.t.model.script(B_TEXT, answer('Museums.', 10, 20))
    await s.t.send({ type: 'retry', conversationId: s.c, target: { kind: 'section', sectionId: s.d('activities').sectionId as SectionId } })
    await s.t.advance(100)
    expect(s.d('activities').state).toBe('completed')
    s.t.model.script(A_TEXT, answer('NEW-A', 10, 20))
    await revise(s, LUXURY, { targets: ['neighborhoods'] })
    await s.t.advance(100)
    expect(Object.values(s.state().groups)[0]?.joinBackIds).toHaveLength(2)
    await s.ask(J_TEXT, { label: 'itinerary', placement: s.onGroupOf('neighborhoods'), prerequisites: [s.needsGroupOf('neighborhoods')] }, answer('Day 1.', 10, 20))
    await s.t.advance(100)
    const input = inputOf(s, 'itinerary')
    expect(input.filter((m) => m === 'Museums.')).toHaveLength(1)
    const marker = input.indexOf('[No answer: this request failed before it completed.]')
    expect(marker).toBeGreaterThan(-1)
    expect(input.indexOf('Museums.')).toBeGreaterThan(marker)
    expect(input.filter((m) => m === B_TEXT)).toHaveLength(2)
    expect(input).toContain('NEW-A')
    await expectRebuildable(s)
  })

  test('R5 (genealogy) · after A is revised and the join-back re-forms, the join-back is a child of A′, whose answer its readers read', async () => {
    const s = await recoveryScenario()
    await trip(s, { a: answer('OLD-A', 50, 100), b: answer('Museums.', 50, 100), j: answer('Day 1: OLD-A.', 50, 100) })
    await s.t.advance(500)
    const oldA = s.d('neighborhoods').nodeId
    s.t.model.script(A_TEXT, answer('NEW-A', 50, 100))
    await revise(s, LUXURY, { targets: ['neighborhoods'] })
    await s.t.advance(300)
    const newA = s.d('neighborhoods').nodeId
    expect(newA).not.toBe(oldA)
    s.t.model.script(J_TEXT, answer('Day 1: NEW-A.', 10, 20))
    await s.t.send({ type: 'regenerate', conversationId: s.c, sectionId: sectionOf(await s.snap(), s, 'itinerary').id as SectionId })
    await s.t.advance(100)
    const snap = await s.snap()
    const group = Object.values(snap.genealogy.groups)[0]
    const jb = snap.genealogy.nodes[group?.joinBackNodeId ?? '']
    expect(jb?.kind).toBe('join-back')
    expect(inputOf(s, 'itinerary')).toContain('NEW-A')
    expect(jb?.parents).toContain(newA)
    expect(jb?.parents).not.toContain(oldA)
    expect(group?.memberNodeIds).toContain(newA)
    await expectRebuildable(s)
  })

  test('R1 (genealogy) · a member revised while its group is open: the join-back is a child of A′', async () => {
    const s = await recoveryScenario()
    await trip(s, { a: [say(50, 'Gion is'), say(5_000, ' x')], b: answer('Museums.', 50, 3_000), withJ: false })
    await s.t.advance(100)
    s.t.model.script(A_TEXT, answer('NEW-A', 50, 100))
    await revise(s, LUXURY, { targets: ['neighborhoods'] })
    await s.t.advance(4_000)
    const newA = s.d('neighborhoods').nodeId
    const snap = await s.snap()
    const group = Object.values(snap.genealogy.groups)[0]
    expect(group?.state).toBe('closed')
    const jb = snap.genealogy.nodes[group?.joinBackNodeId ?? '']
    expect(jb?.parents).toContain(newA)
    await expectRebuildable(s)
  })

  test('R2 (twice) · revising a finished A twice: A″ rewinds to where A′ started, so it reads A and both corrections, never A′ text', async () => {
    const s = await recoveryScenario()
    await trip(s, { a: answer('FINISHED-A', 50, 100), withJ: false })
    await s.t.advance(300)
    s.t.model.script(A_TEXT, [say(50, 'PARTIAL-A2'), say(5_000, ' …')])
    await revise(s, LUXURY, { targets: ['neighborhoods'] })
    await s.t.advance(100)
    s.t.model.script(A_TEXT, answer('Aman.', 50, 100))
    await revise(s, 'Actually, only Gion', { targets: ['neighborhoods'] })
    await s.t.advance(300)
    const input = inputOf(s, 'neighborhoods')
    expect(input.join('\n')).not.toContain('PARTIAL-A2')
    const finished = input.indexOf('FINISHED-A')
    expect(finished).toBeGreaterThan(-1)
    expect(input.indexOf(`Correction: ${LUXURY}`)).toBe(finished + 1)
    expect(input.indexOf('Correction: Actually, only Gion')).toBe(finished + 2)
    await expectRebuildable(s)
  })
})

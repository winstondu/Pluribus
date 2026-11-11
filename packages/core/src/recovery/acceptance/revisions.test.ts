import { describe, expect, test } from 'vitest'
import { WORDING, type RequirementId, type ResponseId } from '@committee/protocol'
import { answer, atomic, done, say } from '../../testing'
import { expectRebuildable } from '../../engine/acceptance/helpers'
import { A_TEXT, B_TEXT, J_TEXT, inputOf, recoveryScenario, revise, sectionOf, trip } from './helpers'

/** R1–R8 (06 · "Revisions") and the named revision tests of PLAN §6. */

const LUXURY = 'Actually, use a luxury budget for the neighborhood recommendations'

describe('revisions', () => {
  test('R1 · a revision to a running A stops that attempt and starts a replacement; B keeps running untouched', async () => {
    const s = await recoveryScenario()
    await trip(s, { a: [say(100, 'Gion is'), say(3_000, ' lovely'), done(4_000)], b: answer('Museums.', 500, 2_000), withJ: false })
    await s.t.advance(200)
    const a = s.d('neighborhoods')
    const oldSection = a.sectionId
    const oldAttempt = a.attemptIds[0]
    const bAttempt = s.d('activities').attemptIds[0]
    s.t.model.script(A_TEXT, answer('Aman and Park Hyatt.', 50, 200))
    await revise(s, LUXURY, { targets: ['neighborhoods'] })

    expect(s.state().attempts[oldAttempt ?? '']?.state).toBe('superseded')
    expect(s.d('neighborhoods').sectionId).not.toBe(oldSection)
    expect(s.d('activities').attemptIds).toEqual([bAttempt])
    expect(s.d('activities').state).toBe('running')
    await s.t.advance(2_500)
    const a2 = s.d('neighborhoods')
    expect(a2.state).toBe('completed')
    expect(a2.attemptIds).toHaveLength(2)
    expect(s.state().attempts[a2.attemptIds[1] ?? '']?.origin).toBe('revision')
    expect(s.d('activities').attemptIds).toEqual([bAttempt])
    expect(s.d('activities').state).toBe('completed')
    // Superseded, not stopped: nothing was paused.
    expect((await s.snap()).queue.elicitations).toEqual([])
    await expectRebuildable(s)
  })

  test("R2 · A′ never sees A's stopped partial text; A′ following a finished A sees A and the correction", async () => {
    const s = await recoveryScenario()
    await trip(s, { a: [say(100, 'PARTIAL-A'), say(5_000, ' more')], withJ: false })
    await s.t.advance(200)
    await revise(s, LUXURY, { targets: ['neighborhoods'] })
    await s.t.advance(100)
    const rewound = inputOf(s, 'neighborhoods')
    expect(rewound.join('\n')).not.toContain('PARTIAL-A')
    expect(rewound.at(-2)).toBe(A_TEXT)
    expect(rewound.at(-1)).toBe(`Correction: ${LUXURY}`)

    // Finished: the follow-up sees A and the correction.
    const t = await recoveryScenario()
    await trip(t, { a: answer('FINISHED-A', 100, 200), withJ: false })
    await t.t.advance(300)
    await revise(t, LUXURY, { targets: ['neighborhoods'] })
    await t.t.advance(100)
    const followUp = inputOf(t, 'neighborhoods')
    expect(followUp.slice(-3)).toEqual([A_TEXT, 'FINISHED-A', `Correction: ${LUXURY}`])
  })

  test('R3 · queued J waits for A′ and the rest of the full join-back, never a subset', async () => {
    const s = await recoveryScenario()
    await trip(s, { a: [say(100, 'Gion is'), say(5_000, ' x')], b: answer('Museums.', 100, 300) })
    await s.t.advance(200)
    expect(s.d('itinerary').state).toBe('dependency-queued')
    s.t.model.script(A_TEXT, answer('Aman.', 100, 2_000))
    await revise(s, LUXURY, { targets: ['neighborhoods'] })
    await s.t.advance(500)
    // B is done, A′ is running: J still waits, for the whole group.
    expect(s.d('activities').state).toBe('completed')
    expect(s.d('itinerary').state).toBe('dependency-queued')
    expect(s.d('itinerary').attemptIds).toHaveLength(0)
    const item = (await s.snap()).queue.items[0]
    expect(item?.text).toBe('Waiting for neighborhoods + activities')
    await s.t.advance(2_000)
    expect(s.d('itinerary').attemptIds).toHaveLength(1)
    const input = inputOf(s, 'itinerary')
    expect(input).toContain('Aman.')
    expect(input).toContain(`Correction: ${LUXURY}`)
    expect(input.join('\n')).not.toContain('Gion is')
    expect(input.indexOf(`Correction: ${LUXURY}`)).toBeLessThan(input.indexOf('Aman.'))
  })

  test('R4 · running J restarts from the replacement prerequisites', async () => {
    const s = await recoveryScenario()
    await trip(s, { a: answer('OLD-A', 50, 100), b: answer('Museums.', 50, 100), j: [say(100, 'Day 1'), say(5_000, ' more')] })
    await s.t.advance(400)
    const j = s.d('itinerary')
    expect(j.state).toBe('running')
    const oldSection = j.sectionId
    s.t.model.script(A_TEXT, answer('NEW-A', 100, 1_000))
    s.t.model.script(J_TEXT, answer('Day 1: Aman.', 50, 100))
    await revise(s, LUXURY, { targets: ['neighborhoods'] })
    const restarted = s.d('itinerary')
    expect(restarted.sectionId).not.toBe(oldSection)
    expect(s.state().attempts[j.attemptIds[0] ?? '']?.state).toBe('superseded')
    expect(restarted.state).toBe('dependency-queued')
    await s.t.advance(1_500)
    expect(s.d('itinerary').state).toBe('completed')
    const input = inputOf(s, 'itinerary')
    expect(input).toContain('NEW-A')
    expect(input).not.toContain('OLD-A')
    expect(s.state().attempts[s.d('itinerary').attemptIds.at(-1) ?? '']?.origin).toBe('prerequisite-revised')
    await expectRebuildable(s)
  })

  test('R5 · completed J is not rewritten or auto-regenerated; it shows a superseded-input note with Regenerate; later work depending on J receives the correction plus A′', async () => {
    const s = await recoveryScenario()
    await trip(s, { a: answer('OLD-A', 50, 100), b: answer('Museums.', 50, 100), j: answer('Day 1: OLD-A.', 50, 100) })
    await s.t.advance(500)
    const j = s.d('itinerary')
    expect(j.state).toBe('completed')
    s.t.model.script(A_TEXT, answer('NEW-A', 50, 100))
    await revise(s, LUXURY, { targets: ['neighborhoods'] })
    await s.t.advance(500)
    expect(s.d('itinerary').attemptIds).toEqual(j.attemptIds)
    expect(s.d('itinerary').sectionId).toBe(j.sectionId)
    const view = sectionOf(await s.snap(), s, 'itinerary')
    expect(view.state).toBe('completed')
    expect(view.notes[0]).toMatchObject({ kind: 'superseded-input', text: 'Based on superseded neighborhoods' })
    expect(view.actions.regenerate).toBe(true)
    expect(s.state().attemptText[j.attemptIds[0] ?? '']).toBe('Day 1: OLD-A.')

    await s.ask('Add a rest day', { label: 'rest day', placement: s.on('itinerary') })
    await s.t.advance(100)
    const later = inputOf(s, 'rest day')
    expect(later).toContain('NEW-A')
    expect(later).toContain(`Correction: ${LUXURY}`)
    expect(later).not.toContain('OLD-A')
    // The completed J's record still shows the original A (06 · "Context after a revision").
    expect(s.state().attempts[j.attemptIds[0] ?? '']?.context.messages.map((m) => m.content)).toContain('OLD-A')
  })

  test('R6 · revising a queued request edits it in place without changing its dependencies', async () => {
    const s = await recoveryScenario()
    await trip(s, { a: answer('Gion.', 100, 2_000), b: answer('Museums.', 100, 2_000) })
    const before = s.d('itinerary')
    const correction = 'Actually, make the itinerary four days'
    await revise(s, correction, { targets: ['itinerary'] })
    const after = s.d('itinerary')
    expect(after.state).toBe('dependency-queued')
    expect(after.prerequisites).toEqual(before.prerequisites)
    expect(after.sectionId).toBe(before.sectionId)
    expect(after.queueItemId).toBe(before.queueItemId)
    const snap = await s.snap()
    expect(snap.queue.items[0]?.text).toBe('Revised · waiting for neighborhoods + activities')
    expect((await s.events()).some((e) => e.type === 'section-superseded')).toBe(false)
    await s.t.advance(3_000)
    const input = inputOf(s, 'itinerary')
    expect(input.slice(-2)).toEqual([J_TEXT, `Correction: ${correction}`])
  })

  test('R7 · work not depending on A is unaffected', async () => {
    const s = await recoveryScenario()
    await trip(s, { a: answer('Gion.', 50, 100), b: answer('Museums.', 50, 3_000), withJ: false })
    await s.ask('Why is the sky blue?', { label: 'sky' }, answer('Scattering.', 50, 100))
    await s.t.advance(200)
    await s.ask('Give me three cheaper activities', { label: 'cheaper', placement: s.on('brief') })
    const untouched = ['activities', 'sky', 'cheaper'].map((l) => ({ l, d: s.d(l) }))
    s.t.model.script(A_TEXT, answer('Aman.', 50, 100))
    await revise(s, LUXURY, { targets: ['neighborhoods'] })
    await s.t.advance(3_500)
    for (const { l, d } of untouched) {
      expect(s.d(l).sectionId).toBe(d.sectionId)
      expect(s.d(l).attemptIds).toHaveLength(1)
    }
    const snap = await s.snap()
    for (const l of ['activities', 'sky', 'cheaper']) expect(sectionOf(snap, s, l).notes).toEqual([])
  })

  test('R8 · regenerate cancels any ongoing work for its item before redoing it against the new version', async () => {
    const s = await recoveryScenario()
    await trip(s, { a: answer('OLD-A', 50, 100), b: answer('Museums.', 50, 100), j: answer('Day 1.', 50, 100) })
    await s.t.advance(500)
    s.t.model.script(A_TEXT, answer('NEW-A', 50, 100))
    await revise(s, LUXURY, { targets: ['neighborhoods'] })
    await s.t.advance(300)
    const noted = s.d('itinerary').sectionId
    s.t.model.script(J_TEXT, [say(50, 'Regenerating'), say(5_000, ' slowly')])
    expect(await s.t.send({ type: 'regenerate', conversationId: s.c, sectionId: noted ?? ('' as never) })).toMatchObject({ ok: true })
    await s.t.advance(100)
    const running = s.d('itinerary')
    expect(running.state).toBe('running')
    const live = running.attemptIds.at(-1)
    expect(inputOf(s, 'itinerary')).toContain('NEW-A')
    // Regenerate again while it runs: the running work is cancelled first.
    s.t.model.script(J_TEXT, answer('Day 1: Aman.', 50, 100))
    expect(await s.t.send({ type: 'regenerate', conversationId: s.c, sectionId: noted ?? ('' as never) })).toMatchObject({ ok: true })
    expect(s.state().attempts[live ?? '']?.state).toBe('superseded')
    await s.t.advance(300)
    expect(s.d('itinerary').state).toBe('completed')
    expect(s.state().attemptText[s.d('itinerary').attemptIds.at(-1) ?? '']).toBe('Day 1: Aman.')
    expect(s.state().attempts[s.d('itinerary').attemptIds.at(-1) ?? '']?.origin).toBe('regenerate')
    // Nothing regenerates by itself, and work without a note cannot be regenerated.
    expect(await s.t.send({ type: 'regenerate', conversationId: s.c, sectionId: s.d('activities').sectionId ?? ('' as never) })).toMatchObject({ ok: false })
    await expectRebuildable(s)
  })
})

describe('revisions, as the reviews found them', () => {
  test('revision · a failed target is replaced with rewound context', async () => {
    const s = await recoveryScenario()
    await s.ask('Explain caching', { label: 'caching' }, [say(10, 'FAILED-TEXT'), { afterMs: 20, event: { type: 'failed', error: { code: 'refusal', class: 'non-retryable', message: 'No', httpStatus: null, retryAfterMs: null } } }])
    await s.t.advance(50)
    expect(s.d('caching').state).toBe('failed')
    const old = s.d('caching').sectionId
    s.t.model.script('Explain caching', answer('Caching keeps copies.', 10, 20))
    await revise(s, 'Actually, explain it for beginners', { targets: ['caching'] })
    const revision = (await s.events()).find((e) => e.type === 'revision-recorded')
    expect(revision?.type === 'revision-recorded' && revision.targets[0]?.state).toBe('ended-unfinished')
    await s.t.advance(50)
    expect(s.d('caching').state).toBe('completed')
    expect(inputOf(s, 'caching').join('\n')).not.toContain('FAILED-TEXT')
    const snap = await s.snap()
    expect(snap.transcript.sections[old ?? '']).toMatchObject({ state: 'superseded', superseded: { markText: WORDING.supersededPartial } })
    expect(snap.transcript.responses[sectionOf(snap, s, 'caching').responseId]?.reason).toBe('revision-replacement')
  })

  test('revision · a running dependent restarts in a new response once the replacement prerequisite is ready', async () => {
    const s = await recoveryScenario()
    await s.ask('Recommend a laptop', { label: 'laptop' }, answer('A ThinkPad.', 10, 20))
    await s.t.advance(50)
    await s.ask('Summarize that for my manager', { label: 'summary', placement: s.on('laptop') }, [say(10, 'Summary of ThinkPad'), say(5_000, ' …')])
    await s.t.advance(50)
    const summary = s.d('summary')
    expect(summary.prerequisites).toEqual([])
    s.t.model.script('Recommend a laptop', answer('A MacBook.', 100, 1_000))
    s.t.model.script('Summarize that', answer('Summary of MacBook.', 10, 20))
    await revise(s, 'Actually, I need macOS', { targets: ['laptop'] })
    const restarted = s.d('summary')
    expect(restarted.sectionId).not.toBe(summary.sectionId)
    // It read the laptop, so it waits for the replacement before it runs again.
    expect(restarted.prerequisites).toEqual([{ kind: 'directive', directiveId: s.id('laptop') }])
    expect(restarted.state).toBe('dependency-queued')
    const snap = await s.snap()
    const response = snap.transcript.responses[sectionOf(snap, s, 'summary').responseId as ResponseId]
    expect(response?.reason).toBe('prerequisite-revised')
    expect(response?.messageId).toBe(summary.messageId)
    expect(snap.transcript.sections[summary.sectionId ?? '']?.superseded?.markText).toBe(WORDING.supersededPartial)
    await s.t.advance(500)
    expect(s.d('summary').attemptIds).toHaveLength(1)
    await s.t.advance(1_000)
    expect(s.d('summary').state).toBe('completed')
    expect(inputOf(s, 'summary')).toContain('A MacBook.')
  })

  test('session requirement · a replaced requirement is no longer sent', async () => {
    const s = await recoveryScenario()
    const requirement = (id: string, text: string, messageId: string) => ({
      id: id as RequirementId,
      text,
      scope: 'session-wide' as const,
      shared: false,
      provenance: { messageId: messageId as never, span: null },
    })
    s.t.router.when('From now on answer in French. Explain caching', (input) =>
      atomic(input, { label: 'caching', instruction: 'Explain caching' }, { sessionRequirements: [{ requirement: requirement('req_fr', 'Answer in French', input.messageId), replacesRequirementId: null }] }),
    )
    await s.t.submit(s.c, 'From now on answer in French. Explain caching')
    await s.t.advance(50)
    s.t.router.when('Actually, answer in Spanish from now on', (input) =>
      ({
        kind: 'plan',
        plan: {
          ...(atomic(input) as { plan: never }).plan,
          units: [],
          sessionRequirements: [{ requirement: requirement('req_es', 'Answer in Spanish', input.messageId), replacesRequirementId: 'req_fr' as RequirementId }],
          revisions: [{ scope: 'shared-requirement', correction: 'Answer in Spanish', fragment: null, targetDirectiveIds: [], targetRequirementIds: ['req_fr' as RequirementId], affected: [] }],
        },
      }),
    )
    await s.t.submit(s.c, 'Actually, answer in Spanish from now on')
    await s.ask('Explain indexes', { label: 'indexes' })
    await s.t.advance(50)
    const ctx = s.state().attempts[s.d('indexes').attemptIds[0] ?? '']?.context
    expect(ctx?.sessionRequirementIds).toEqual(['req_es'])
    expect(ctx?.messages.some((m) => m.content.includes('French'))).toBe(false)
    // Work that read the replaced requirement is noted.
    const note = sectionOf(await s.snap(), s, 'caching').notes[0]
    expect(note).toMatchObject({ kind: 'superseded-input', text: 'Based on superseded Answer in French' })
    const revision = (await s.events()).find((e) => e.type === 'revision-recorded')
    expect(revision?.type === 'revision-recorded' && revision.requirementIds).toEqual(['req_fr'])
    void B_TEXT
  })
})

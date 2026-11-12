import { describe, expect, test } from 'vitest'
import { WORDING, type ConversationSnapshot, type ResponseId, type SectionId } from '@committee/protocol'
import { answer, done, fail, independent, say, spanOf } from '../../../testing'
import { A_TEXT, recoveryScenario, revise, sectionOf, trip } from '../../../testing/acceptance/recovery'

/** P10–P13 (03 · "Transcript and placement"). */

const LUXURY = 'Actually, use a luxury budget for the neighborhood recommendations'

function responsesInOrder(snap: ConversationSnapshot): ResponseId[] {
  return snap.transcript.order.filter((r) => r.kind === 'response').map((r) => r.id as ResponseId)
}

describe('placement after supersession, failure and retry', () => {
  test('P10 · a status-only bubble disappears on supersession; visible partial or finished text stays in place, marked superseded and linked to the replacement', async () => {
    // Status only: dropped without a trace.
    const s = await recoveryScenario()
    await trip(s, { a: [say(5_000, 'late')], withJ: false })
    const statusOnly = s.d('neighborhoods')
    const oldResponse = s.state().sections[statusOnly.sectionId ?? '']?.responseId
    let snap = await s.snap()
    expect(responsesInOrder(snap)).toContain(oldResponse)
    s.t.model.script(A_TEXT, answer('Aman.', 10, 20))
    await revise(s, LUXURY, { targets: ['neighborhoods'] })
    snap = await s.snap()
    expect(responsesInOrder(snap)).not.toContain(oldResponse)
    expect(snap.transcript.sections[statusOnly.sectionId ?? '']).toBeUndefined()

    // Partial text: stays in place, collapsed, "Superseded — revised below", linked.
    const t = await recoveryScenario()
    await trip(t, { a: [say(50, 'Gion is'), say(5_000, ' …')], b: answer('Museums.', 100, 200), withJ: false })
    await t.t.advance(300)
    const partial = t.d('neighborhoods')
    const before = await t.snap()
    const position = before.transcript.order.findIndex((r) => r.kind === 'response' && r.id === before.transcript.sections[partial.sectionId ?? '']?.responseId)
    await revise(t, LUXURY, { targets: ['neighborhoods'] })
    await t.t.advance(50)
    snap = await t.snap()
    const old = snap.transcript.sections[partial.sectionId ?? '']
    expect(old?.state).toBe('superseded')
    expect(old?.superseded).toEqual({
      markText: WORDING.supersededPartial,
      replacementSectionId: t.d('neighborhoods').sectionId,
      replacementResponseId: sectionOf(snap, t, 'neighborhoods').responseId,
      linkText: WORDING.seeRevision,
    })
    expect(snap.transcript.attempts[old?.attemptIds[0] ?? '']).toMatchObject({ text: 'Gion is', collapsed: true, markText: WORDING.supersededPartial })
    // "Reply to this" stays: a reply to it targets the replacement (T3, 06 · edge cases).
    expect(old?.actions.reply).toBe(true)
    expect(snap.transcript.order[position]).toEqual(before.transcript.order[position])

    // Finished: stays, marked superseded, linked.
    const u = await recoveryScenario()
    await trip(u, { a: answer('Gion.', 10, 20), withJ: false })
    await u.t.advance(100)
    const finished = u.d('neighborhoods')
    await revise(u, LUXURY, { targets: ['neighborhoods'] })
    snap = await u.snap()
    expect(snap.transcript.sections[finished.sectionId ?? '']?.superseded?.markText).toBe(WORDING.supersededFinished)
    expect(snap.transcript.sections[finished.sectionId ?? '']?.superseded?.replacementSectionId).toBe(u.d('neighborhoods').sectionId)
    expect(snap.transcript.attempts[snap.transcript.sections[finished.sectionId ?? '']?.attemptIds[0] ?? '']?.text).toBe('Gion.')
  })

  test('P11 · a replacement appears as a new response, never inside the original bubble or group', async () => {
    const s = await recoveryScenario()
    const text = 'Suggest neighborhoods, and separately suggest activities'
    s.t.router.when(text, (input) =>
      independent(input, [
        { label: 'neighborhoods', spans: spanOf(text, 'Suggest neighborhoods'), instruction: A_TEXT },
        { label: 'activities', spans: spanOf(text, 'suggest activities') },
      ]),
    )
    await s.t.submit(s.c, text)
    await s.t.advance(100)
    const group = s.state().sections[s.d('neighborhoods').sectionId ?? '']?.responseId as ResponseId
    const oldSection = s.d('neighborhoods').sectionId
    await revise(s, LUXURY, { targets: ['neighborhoods'] })
    await s.t.advance(100)
    const snap = await s.snap()
    const replacement = sectionOf(snap, s, 'neighborhoods')
    expect(replacement.responseId).not.toBe(group)
    expect(snap.transcript.responses[group]?.sectionIds).toEqual([oldSection, s.d('activities').sectionId])
    expect(snap.transcript.responses[group]?.sectionIds).not.toContain(replacement.id)
    const response = snap.transcript.responses[replacement.responseId]
    expect(response).toMatchObject({ reason: 'revision-replacement', grouped: false, placement: 'fixed' })
    // The replacement answers the revision message, after it in the transcript.
    const order = snap.transcript.order.map((r) => r.id as string)
    expect(order.indexOf(replacement.responseId)).toBeGreaterThan(order.indexOf(response?.messageId ?? ''))
  })

  test('P12 · a reply that failed before any output stays fixed where it failed; its retry fills the same bubble', async () => {
    const s = await recoveryScenario({ settings: { retryPolicy: 'manual' } })
    await s.ask('Explain caching', { label: 'caching' }, [fail(10, 'bad-gateway')])
    await s.ask('Why is the sky blue?', { label: 'sky' }, answer('Scattering.', 100, 200))
    await s.t.advance(50)
    let snap = await s.snap()
    const caching = sectionOf(snap, s, 'caching')
    const responseId = caching.responseId
    expect(snap.transcript.responses[responseId]?.placement).toBe('fixed')
    await s.t.advance(300)
    snap = await s.snap()
    const before = snap.transcript.order
    expect(responsesInOrder(snap).indexOf(responseId)).toBe(0)
    s.t.model.script('Explain caching', answer('Caching keeps copies.', 10, 20))
    await s.t.send({ type: 'retry', conversationId: s.c, target: { kind: 'section', sectionId: caching.id } })
    await s.t.advance(50)
    snap = await s.snap()
    expect(snap.transcript.order).toEqual(before)
    const after = sectionOf(snap, s, 'caching')
    expect(after.id).toBe(caching.id)
    expect(after.responseId).toBe(responseId)
    expect(after.state).toBe('completed')
    // The failure notice had no text: only the retry's attempt is shown.
    expect(after.attemptIds).toHaveLength(1)
    expect(snap.transcript.attempts[after.attemptIds[0] ?? '']?.text).toBe('Caching keeps copies.')
  })

  test('P13 · a retry after visible partial output streams in the same bubble beneath the collapsed, failed partial text, not as a new response', async () => {
    const s = await recoveryScenario()
    s.t.model.script('Explain caching', [say(10, 'Caching is'), fail(20, 'network')])
    s.t.model.script('Explain caching', [say(10, 'Caching keeps'), say(500, ' copies.'), done(600)])
    await s.ask('Explain caching', { label: 'caching' })
    await s.t.advance(50)
    let snap = await s.snap()
    let section = sectionOf(snap, s, 'caching')
    expect(section.status?.text).toBe(WORDING.retrying)
    expect(snap.transcript.attempts[section.attemptIds[0] ?? '']).toMatchObject({ text: 'Caching is', collapsed: true, markText: WORDING.failed })
    const responses = Object.keys(snap.transcript.responses)
    await s.t.advance(1_100)
    snap = await s.snap()
    section = sectionOf(snap, s, 'caching')
    expect(section.attemptIds).toHaveLength(2)
    expect(snap.transcript.attempts[section.attemptIds[0] ?? '']).toMatchObject({ collapsed: true, markText: WORDING.failed })
    expect(snap.transcript.attempts[section.attemptIds[1] ?? '']).toMatchObject({ text: 'Caching keeps', state: 'streaming', collapsed: false })
    expect(Object.keys(snap.transcript.responses)).toEqual(responses)
    await s.t.advance(1_000)
    expect(sectionOf(await s.snap(), s, 'caching').state).toBe('completed')
    void (s.d('caching').sectionId as SectionId)
  })
})

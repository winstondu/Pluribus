import { describe, expect, test } from 'vitest'
import { WORDING, providerError, type ConversationId, type SectionId } from '@committee/protocol'
import { answer, done, fail, independent, say, spanOf } from '../../testing'
import { expectRebuildable } from '../../engine/acceptance/helpers'
import type { Scenario } from '../../engine/acceptance/helpers'
import { A_TEXT, B_TEXT, J_TEXT, inputOf, recoveryScenario, sectionOf, trip } from './helpers'

/** F1–F9 (08 · "Failure, stopping, and recovery") and the late-retry tests of PLAN §6. */

const rateLimited = (afterMs: number, retryAfterMs: number | null) => ({
  afterMs,
  event: { type: 'failed' as const, error: providerError('rate-limited', 'Too many requests', { httpStatus: 429, retryAfterMs }) },
})

async function threeParts(s: Scenario, scripts: readonly (readonly import('../../testing').ScriptStep[])[]) {
  const text = 'Explain caching, and separately explain indexes, and separately explain joins'
  const parts = ['Explain caching', 'explain indexes', 'explain joins']
  parts.forEach((p, i) => {
    const script = scripts[i]
    if (script) s.t.model.script(p, script)
  })
  s.t.router.when(text, (input) =>
    independent(
      input,
      parts.map((p, i) => ({ label: ['caching', 'indexes', 'joins'][i] ?? p, spans: spanOf(text, p) })),
    ),
  )
  return s.t.submit(s.c, text)
}

describe('failure, stopping and recovery', () => {
  test('F1 · a failed directive is visibly identified, does not stop unfinished siblings, and does not mark the overall request failed', async () => {
    const s = await recoveryScenario()
    const messageId = await threeParts(s, [answer('Caching.', 10, 20), [fail(30, 'invalid-request', 'Bad request')], [say(10, 'Joins'), done(2_000)]])
    await s.t.advance(100)
    expect(s.d('indexes').state).toBe('failed')
    expect(s.d('joins').state).toBe('running')
    const snap = await s.snap()
    const failed = sectionOf(snap, s, 'indexes')
    expect(failed.state).toBe('failed')
    expect(failed.failure?.message).toBe('Bad request')
    expect(failed.actions.retry).toBe(true)
    const message = snap.transcript.messages[messageId]
    expect(message && 'state' in message).toBe(false)
    const response = snap.transcript.responses[failed.responseId]
    expect(response?.header?.countText).toBe('1 done · 1 failed · 1 pending')
    expect(JSON.stringify(response)).not.toMatch(/"(state|status)":"failed"/)
    await s.t.advance(2_000)
    expect(s.d('joins').state).toBe('completed')
  })

  test('F2 · stopping a section leaves unrelated requests running and preserves visible partial text', async () => {
    const s = await recoveryScenario()
    await s.ask('Explain caching', { label: 'caching' }, [say(10, 'Caching is'), say(5_000, ' more')])
    await s.ask('Why is the sky blue?', { label: 'sky' }, [say(10, 'Light'), done(3_000)])
    await s.t.advance(50)
    await s.t.send({ type: 'stop', conversationId: s.c, target: { kind: 'section', sectionId: s.d('caching').sectionId as SectionId } })
    expect(s.d('caching').state).toBe('stopped')
    expect(s.d('sky').state).toBe('running')
    const snap = await s.snap()
    const stopped = sectionOf(snap, s, 'caching')
    expect(stopped.state).toBe('stopped')
    expect(snap.transcript.attempts[stopped.attemptIds[0] ?? '']).toMatchObject({ text: 'Caching is', markText: WORDING.stoppedPartial })
    await s.t.advance(3_000)
    expect(s.d('sky').state).toBe('completed')
  })

  test('F3 · transient failures retry per the retry setting (Standard by default) with status text only; non-retryable errors go straight to failed', async () => {
    const s = await recoveryScenario()
    s.t.model.script('Explain caching', [fail(10, 'bad-gateway')])
    s.t.model.script('Explain caching', [fail(10, 'network')])
    s.t.model.script('Explain caching', answer('Caching keeps copies.', 10, 20))
    await s.ask('Explain caching', { label: 'caching' })
    await s.t.advance(50)
    expect(s.d('caching').state).toBe('retrying')
    let snap = await s.snap()
    expect(sectionOf(snap, s, 'caching').status).toEqual({ kind: 'retrying', text: WORDING.retrying })
    expect(sectionOf(snap, s, 'caching').placement).toBe('pending')
    expect(snap.queue).toEqual({ items: [], elicitations: [] })
    // Backoff 1 s, then 2 s, on the injected clock.
    await s.t.advance(900)
    expect(s.d('caching').attemptIds).toHaveLength(1)
    await s.t.advance(100)
    expect(s.d('caching').attemptIds).toHaveLength(2)
    await s.t.advance(1_900)
    expect(s.d('caching').attemptIds).toHaveLength(2)
    await s.t.advance(100)
    expect(s.d('caching').state).toBe('completed')
    expect(s.d('caching').sectionIds).toHaveLength(1)
    expect(s.d('caching').attemptIds.map((id) => s.state().attempts[id]?.origin)).toEqual(['initial', 'automatic-retry', 'automatic-retry'])

    // Non-retryable: straight to failed, no automatic attempt.
    s.t.model.script('Refuse this', [fail(10, 'refusal', 'The model declined')])
    await s.ask('Refuse this', { label: 'refused' })
    await s.t.advance(5_000)
    expect(s.d('refused').state).toBe('failed')
    expect(s.d('refused').attemptIds).toHaveLength(1)
    snap = await s.snap()
    expect(sectionOf(snap, s, 'refused').failure?.code).toBe('refusal')

    // Out of credits is non-retryable, with its fixed message.
    s.t.model.script('Spend money', [fail(10, 'out-of-credits', WORDING.outOfCredits)])
    await s.ask('Spend money', { label: 'credits' })
    await s.t.advance(5_000)
    expect(s.d('credits').attemptIds).toHaveLength(1)
    expect(sectionOf(await s.snap(), s, 'credits').failure?.message).toBe('Out of OpenRouter credits')
  })

  test('F3 (policies) · Standard gives up after three automatic retries, Persistent keeps going, Manual never retries; rate limits wait as "Waiting for capacity"', async () => {
    const standard = await recoveryScenario()
    standard.t.model.setDefault([fail(10, 'service-unavailable')])
    await standard.ask('Explain caching', { label: 'caching' })
    await standard.t.advance(60_000)
    expect(standard.d('caching').state).toBe('failed')
    expect(standard.d('caching').attemptIds).toHaveLength(4)
    expect(standard.state().attempts[standard.d('caching').attemptIds[3] ?? '']?.retry).toEqual({ kind: 'none', reason: 'exhausted' })

    const persistent = await recoveryScenario({ settings: { retryPolicy: 'persistent' } })
    persistent.t.model.setDefault([fail(10, 'bad-gateway')])
    await persistent.ask('Explain caching', { label: 'caching' })
    await persistent.t.advance(600_000)
    expect(persistent.d('caching').attemptIds).toHaveLength(9)

    const manual = await recoveryScenario({ settings: { retryPolicy: 'manual' } })
    manual.t.model.setDefault([fail(10, 'bad-gateway')])
    await manual.ask('Explain caching', { label: 'caching' })
    await manual.t.advance(10_000)
    expect(manual.d('caching').state).toBe('failed')
    expect(manual.d('caching').attemptIds).toHaveLength(1)
    expect(sectionOf(await manual.snap(), manual, 'caching').actions.retry).toBe(true)

    const limited = await recoveryScenario()
    limited.t.model.script('Explain caching', [rateLimited(10, 3_000)])
    limited.t.model.script('Explain caching', [rateLimited(10, null)])
    limited.t.model.script('Explain caching', [rateLimited(10, 120_000)])
    await limited.ask('Explain caching', { label: 'caching' })
    await limited.t.advance(50)
    expect(limited.d('caching').state).toBe('waiting-for-capacity')
    const snap = await limited.snap()
    expect(sectionOf(snap, limited, 'caching').status?.text).toBe(WORDING.waitingForCapacity)
    expect(snap.queue.items).toEqual([])
    await limited.t.advance(2_900)
    expect(limited.d('caching').attemptIds).toHaveLength(1)
    await limited.t.advance(200)
    expect(limited.d('caching').attemptIds).toHaveLength(2)
    // No Retry-After: the policy's default wait (5 s).
    await limited.t.advance(5_100)
    expect(limited.d('caching').attemptIds).toHaveLength(3)
    // A Retry-After longer than Standard accepts fails instead of waiting.
    await limited.t.advance(100)
    expect(limited.d('caching').state).toBe('failed')
  })

  test('F4 · each retry is a new attempt that never consumes earlier partial text', async () => {
    const s = await recoveryScenario()
    s.t.model.script('Explain caching', [say(10, 'PARTIAL'), fail(20, 'mid-stream-error')])
    s.t.model.script('Explain caching', answer('Caching keeps copies.', 10, 20))
    await s.ask('Explain caching', { label: 'caching' })
    await s.t.advance(2_000)
    const d = s.d('caching')
    expect(d.state).toBe('completed')
    expect(d.attemptIds).toHaveLength(2)
    expect(new Set(d.attemptIds).size).toBe(2)
    expect(inputOf(s, 'caching').join('\n')).not.toContain('PARTIAL')
    expect(s.state().attempts[d.attemptIds[1] ?? '']?.context.inputs).toEqual([])
  })

  test('F5 · J paused on a failed or stopped B never runs on a subset; it waits for the user’s Retry, Continue without, or Cancel choice', async () => {
    for (const choice of ['retry', 'continue-without', 'cancel'] as const) {
      const s = await recoveryScenario({ settings: { retryPolicy: 'manual' } })
      await trip(s, { a: answer('Gion.', 50, 100), b: [say(50, 'Muse'), fail(100, 'bad-gateway')] })
      await s.t.advance(500)
      expect(s.d('activities').state).toBe('failed')
      expect(s.d('itinerary').state).toBe('paused')
      let snap = await s.snap()
      const item = snap.queue.items[0]
      expect(item).toMatchObject({ state: 'paused', text: 'Paused — activities failed' })
      expect(item?.recovery).toMatchObject({
        retry: { label: 'Retry activities', sectionId: s.d('activities').sectionId },
        continueWithout: { label: 'Continue without activities' },
        cancel: { label: 'Cancel itinerary' },
      })
      expect(snap.queue.elicitations.map((e) => e.kind)).toEqual(['recovery-choice'])
      // No default: Committee waits for as long as it takes.
      await s.t.advance(600_000)
      expect(s.d('itinerary').attemptIds).toHaveLength(0)
      expect(s.d('itinerary').state).toBe('paused')

      if (choice === 'retry') {
        s.t.model.script(B_TEXT, answer('Museums.', 10, 20))
        await s.t.send({ type: 'retry', conversationId: s.c, target: { kind: 'section', sectionId: s.d('activities').sectionId as SectionId } })
        expect(s.d('itinerary').state).not.toBe('paused')
        await s.t.advance(1_500)
        expect(s.d('itinerary').state).toBe('completed')
        expect(inputOf(s, 'itinerary')).toContain('Museums.')
      } else if (choice === 'continue-without') {
        await s.t.send({ type: 'continue-without', conversationId: s.c, directiveId: s.id('itinerary') })
        await s.t.advance(1_500)
        expect(s.d('itinerary').state).toBe('completed')
        const input = inputOf(s, 'itinerary')
        expect(input).toContain('[No answer: this request failed before it completed.]')
        expect(input.join('\n')).not.toContain('Muse')
        expect(input).toContain('Gion.')
      } else {
        await s.t.send({ type: 'cancel', conversationId: s.c, directiveId: s.id('itinerary') })
        expect(s.d('itinerary').state).toBe('cancelled')
        expect(sectionOf(await s.snap(), s, 'itinerary').state).toBe('cancelled')
      }
      snap = await s.snap()
      expect(snap.queue.items).toEqual([])
      expect(snap.queue.elicitations).toEqual([])
      await expectRebuildable(s)
    }

    // Stopped, not failed: paused the same way, never cancelled by the stop (Q48).
    const s = await recoveryScenario()
    await trip(s, { a: answer('Gion.', 50, 100), b: [say(50, 'Muse'), say(5_000, 'um')] })
    await s.t.advance(200)
    await s.t.send({ type: 'stop', conversationId: s.c, target: { kind: 'section', sectionId: s.d('activities').sectionId as SectionId } })
    expect(s.d('itinerary').state).toBe('paused')
    expect((await s.snap()).queue.items[0]?.text).toBe('Paused — activities stopped')
  })

  test('F6 · a failed or stopped member that is not retrying lets the group close; a retry after closure runs as a descendant of the join-back', async () => {
    const s = await recoveryScenario({ settings: { retryPolicy: 'manual' } })
    await trip(s, { a: answer('Gion.', 50, 100), b: [say(50, 'Muse'), fail(80, 'bad-gateway')], withJ: false })
    await s.t.advance(300)
    const group = Object.values(s.state().groups)[0]
    expect(group?.state).toBe('closed')
    const joinBack = s.state().joinBacks[group?.joinBackIds[0] ?? '']
    expect(joinBack?.members.map((m) => m.outcome)).toEqual(['completed', 'failed'])
    s.t.model.script(B_TEXT, answer('Museums.', 10, 20))
    await s.t.send({ type: 'retry', conversationId: s.c, target: { kind: 'section', sectionId: s.d('activities').sectionId as SectionId } })
    const node = s.state().nodes[s.d('activities').nodeId]
    expect(node?.reason).toBe('retry-after-closure')
    expect(node?.plannedParents).toEqual([{ kind: 'node', nodeId: joinBack?.nodeId }])
    expect(node?.chainId).toBe(group?.baseChainId)
    await s.t.advance(100)
    expect(s.d('activities').state).toBe('completed')
    expect(Object.values(s.state().groups)[0]?.members).toHaveLength(2)

    // Standard: a member retrying automatically keeps the group open, and its retry is still a sibling.
    const t = await recoveryScenario()
    await trip(t, { a: answer('Gion.', 50, 100), b: [say(50, 'Muse'), fail(80, 'bad-gateway')], withJ: false })
    t.t.model.script(B_TEXT, answer('Museums.', 10, 20))
    await t.t.advance(300)
    expect(t.d('activities').state).toBe('retrying')
    expect(Object.values(t.state().groups)[0]?.state).toBe('open')
    await t.t.advance(1_000)
    expect(t.d('activities').state).toBe('completed')
    expect(t.state().nodes[t.d('activities').nodeId]?.reason).toBe('initial')
    const formed = Object.values(t.state().joinBacks)[0]
    expect(formed?.members.map((m) => m.outcome)).toEqual(['completed', 'completed'])
  })

  test('F7 · mixed-result requests show per-section states and a count, never an overall failed or cancelled label', async () => {
    const s = await recoveryScenario({ settings: { retryPolicy: 'manual' } })
    const messageId = await threeParts(s, [answer('Caching.', 10, 20), [fail(10, 'bad-gateway')], [say(10, 'Joins are'), say(5_000, ' more')]])
    await s.t.advance(50)
    await s.t.send({ type: 'stop', conversationId: s.c, target: { kind: 'section', sectionId: s.d('joins').sectionId as SectionId } })
    const snap = await s.snap()
    expect(['caching', 'indexes', 'joins'].map((l) => sectionOf(snap, s, l).state)).toEqual(['completed', 'failed', 'stopped'])
    const response = snap.transcript.responses[sectionOf(snap, s, 'caching').responseId]
    expect(response?.header).toEqual({ counts: { done: 1, failed: 1, stopped: 1, interrupted: 0, cancelled: 0, inProgress: 0 }, countText: '1 done · 1 failed · 1 stopped' })
    const message = snap.transcript.messages[messageId]
    expect(Object.keys(message ?? {})).not.toContain('state')
    expect(message?.actions).toEqual({ stop: false, retry: true })
  })

  test('F8 · retrying a request reruns only unfinished sections', async () => {
    const s = await recoveryScenario({ settings: { retryPolicy: 'manual' } })
    const messageId = await threeParts(s, [answer('Caching.', 10, 20), [say(10, 'Ind'), fail(20, 'bad-gateway')], [say(10, 'Joins are'), say(5_000, ' more')]])
    await s.t.advance(50)
    await s.t.send({ type: 'stop', conversationId: s.c, target: { kind: 'section', sectionId: s.d('joins').sectionId as SectionId } })
    s.t.model.script('explain indexes', answer('Indexes.', 10, 20))
    s.t.model.script('explain joins', answer('Joins.', 10, 20))
    await s.t.send({ type: 'retry', conversationId: s.c, target: { kind: 'request', messageId } })
    await s.t.advance(100)
    expect(s.d('caching').attemptIds).toHaveLength(1)
    expect(s.d('indexes').attemptIds).toHaveLength(2)
    expect(s.d('joins').attemptIds).toHaveLength(2)
    const snap = await s.snap()
    for (const label of ['caching', 'indexes', 'joins']) expect(sectionOf(snap, s, label).state).toBe('completed')
    expect(snap.transcript.responses[sectionOf(snap, s, 'caching').responseId]?.header?.countText).toBeNull()
  })

  test('F9 · an interrupted attempt is labeled interrupted and offers the same retry choices; under Standard and Persistent it retries automatically within the retry limit', async () => {
    // Manual: interrupted, with Retry, and its dependent gets the recovery choice.
    const m = await recoveryScenario({ settings: { retryPolicy: 'manual' } })
    await trip(m, { a: answer('Gion.', 50, 100), b: [say(50, 'Muse'), say(5_000, 'um')] })
    await m.t.advance(200)
    const restarted = await m.t.restart()
    const state = () => restarted.state(m.c)
    const b = Object.values(state().directives).find((d) => d.label === 'activities')
    const j = Object.values(state().directives).find((d) => d.label === 'itinerary')
    expect(b?.state).toBe('interrupted')
    expect(j?.state).toBe('paused')
    let snap = await restarted.snapshot(m.c)
    const section = snap.transcript.sections[b?.sectionId ?? '']
    expect(section?.state).toBe('interrupted')
    expect(section?.actions.retry).toBe(true)
    expect(snap.transcript.attempts[section?.attemptIds[0] ?? '']?.markText).toBe(WORDING.interrupted)
    expect(snap.queue.items[0]?.text).toBe('Paused — activities interrupted')
    // The group closed with the member marked interrupted (08 edge case, Manual).
    expect(Object.values(state().joinBacks)[0]?.members.map((x) => x.outcome)).toEqual(['completed', 'interrupted'])

    // Standard: retried automatically on start, as an interruption recovery, with rewound context.
    const s = await recoveryScenario()
    await s.ask('Explain caching', { label: 'caching' }, [say(20, 'PARTIAL'), say(10_000, ' …')])
    await s.t.advance(50)
    s.t.model.script('Explain caching', answer('Caching keeps copies.', 10, 20))
    const next = await s.t.restart()
    const d = () => Object.values(next.state(s.c).directives)[0]
    expect(d()?.state).toBe('retrying')
    snap = await next.snapshot(s.c)
    expect(snap.transcript.sections[d()?.sectionId ?? '']?.status?.text).toBe(WORDING.retrying)
    await next.advance(100)
    expect(d()?.state).toBe('completed')
    const attempts = (d()?.attemptIds ?? []).map((id) => next.state(s.c).attempts[id])
    expect(attempts.map((a) => a?.state)).toEqual(['interrupted', 'completed'])
    expect(attempts[1]?.origin).toBe('interruption-recovery')
    expect(attempts[1]?.sectionId).toBe(attempts[0]?.sectionId)
    expect(attempts[1]?.context.messages.some((x) => x.content.includes('PARTIAL'))).toBe(false)

    // Within the limit: interruptions count against the same three retries.
    const p = await recoveryScenario()
    p.t.model.setDefault([say(10, 'x'), say(100_000, 'y')])
    await p.ask('Explain caching', { label: 'caching' })
    await p.t.advance(50)
    let current = p.t
    for (let i = 0; i < 4; i++) {
      current = await current.restart()
      await current.advance(50)
    }
    const last = Object.values(current.state(p.c).directives)[0]
    expect(last?.state).toBe('interrupted')
    expect(last?.attemptIds).toHaveLength(4)
  })
})

describe('late retries, as the reviews found them', () => {
  async function failedB(j: readonly import('../../testing').ScriptStep[] = answer('Itinerary without activities.', 10, 20)): Promise<Scenario> {
    const s = await recoveryScenario({ settings: { retryPolicy: 'manual' } })
    await trip(s, { a: answer('Gion.', 50, 100), b: [say(50, 'Muse'), fail(100, 'bad-gateway')], j })
    await s.t.advance(300)
    return s
  }

  test('late retry · continue without B, retry B, regenerate J: J′ is a child of the join-back, reads B′, and never descends from J', async () => {
    const s = await failedB()
    await s.t.send({ type: 'continue-without', conversationId: s.c, directiveId: s.id('itinerary') })
    await s.t.advance(100)
    const j = s.d('itinerary')
    expect(j.state).toBe('completed')
    s.t.model.script(B_TEXT, answer('Museums.', 10, 20))
    await s.t.send({ type: 'retry', conversationId: s.c, target: { kind: 'section', sectionId: s.d('activities').sectionId as SectionId } })
    await s.t.advance(100)
    expect(s.d('activities').state).toBe('completed')
    let snap = await s.snap()
    expect(sectionOf(snap, s, 'itinerary').notes[0]).toMatchObject({ kind: 'superseded-input', text: 'Based on superseded activities' })
    s.t.model.script(J_TEXT, answer('Itinerary with museums.', 10, 20))
    await s.t.send({ type: 'regenerate', conversationId: s.c, sectionId: j.sectionId as SectionId })
    await s.t.advance(100)
    const j2 = s.d('itinerary')
    expect(j2.state).toBe('completed')
    const node = s.state().nodes[j2.nodeId]
    const joinBack = Object.values(s.state().joinBacks)[0]
    expect(node?.reason).toBe('regenerate')
    expect(node?.replacesNodeId).toBe(j.nodeId)
    const run = s.state().attempts[j2.attemptIds.at(-1) ?? '']
    expect(run?.parents).toEqual([joinBack?.nodeId])
    expect(run?.context.nodeIds).not.toContain(j.nodeId)
    const input = inputOf(s, 'itinerary')
    expect(input).toContain('Museums.')
    expect(input.indexOf('[No answer: this request failed before it completed.]')).toBeLessThan(input.indexOf('Museums.'))
    snap = await s.snap()
    expect(sectionOf(snap, s, 'itinerary').notes).toEqual([])
    await expectRebuildable(s)
  })

  test('late retry · a retry requested while a continue-without dependent runs does not fork it', async () => {
    const s = await failedB([say(10, 'Day 1'), done(2_000)])
    await s.t.send({ type: 'continue-without', conversationId: s.c, directiveId: s.id('itinerary') })
    await s.t.advance(50)
    const j = s.d('itinerary')
    expect(j.state).toBe('running')
    const groupsBefore = Object.keys(s.state().groups)
    const chainsBefore = s.state().chainOrder.length
    s.t.model.script(B_TEXT, answer('Museums.', 10, 20))
    await s.t.send({ type: 'retry', conversationId: s.c, target: { kind: 'section', sectionId: s.d('activities').sectionId as SectionId } })
    await s.t.advance(100)
    expect(Object.keys(s.state().groups)).toEqual(groupsBefore)
    expect(s.state().chainOrder).toHaveLength(chainsBefore)
    expect(s.d('itinerary').chainId).toBe(j.chainId)
    expect(s.d('itinerary').nodeId).toBe(j.nodeId)
    await s.t.advance(2_000)
    expect(s.d('itinerary').state).toBe('completed')
    expect(sectionOf(await s.snap(), s, 'itinerary').notes[0]?.kind).toBe('superseded-input')
    void A_TEXT
    void (s.c as ConversationId)
  })
})

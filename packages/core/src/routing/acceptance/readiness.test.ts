import { describe, expect, test } from 'vitest'
import {
  WORDING,
  providerError,
  type AttemptStarted,
  type ConversationEvent,
  type DirectiveId,
  type DirectiveReadinessEstablished,
  type ElicitationId,
  type SectionId,
} from '@committee/protocol'
import { engineModule } from '../../engine'
import { expectRebuildable, scenario, type Scenario } from '../../engine/acceptance/helpers'
import { recoveryModule } from '../../recovery/module'
import { answer, askUser, done, fail, independent, needsClarification, noUnits, say, spanOf, type TestBackendOverrides } from '../../testing'
import { routingModule } from '../module'

/**
 * E5 and the rules behind it (07 · "Clarification"; Q103, Q105, Q106): typed
 * readiness before any visible answer text, known questions asked at once,
 * the remaining check after results arrive, and the late clarification that
 * pauses a directive for the user's input.
 */

async function readinessScenario(overrides: TestBackendOverrides = {}): Promise<Scenario> {
  return scenario({ modules: [engineModule, routingModule, recoveryModule], ...overrides })
}

const A_TEXT = 'Suggest neighborhoods to stay in'

/** The open clarification that pauses the directive with this label. */
function pausedFor(s: Scenario, label: string): ElicitationId {
  const pause = s.d(label).pause
  if (pause?.reason !== 'awaiting-input') throw new Error(`"${label}" is not paused awaiting input`)
  return pause.elicitationId
}

/** The section of the question that elicitation asks. */
function questionSection(s: Scenario, elicitationId: ElicitationId): SectionId {
  const record = s.state().elicitations[elicitationId]?.record
  if (record?.kind !== 'clarification') throw new Error('Not a clarification')
  const sectionId = s.state().directives[record.questionDirectiveId]?.sectionId
  if (!sectionId) throw new Error('The question has no section')
  return sectionId
}

/** Submits `text` as the answer to that clarification: targeted at the question, or untargeted and recognised as the answer (Q98). */
async function reply(s: Scenario, text: string, elicitationId: ElicitationId, targeted = true): Promise<void> {
  s.t.router.when(text, (input) => noUnits(input, { answersElicitationId: elicitationId }))
  await s.t.submit(s.c, text, targeted ? [questionSection(s, elicitationId)] : undefined)
}

function textOf(s: Scenario, sectionId: SectionId | null): string {
  const section = sectionId ? s.state().sections[sectionId] : undefined
  return (section?.attemptIds ?? []).map((id) => s.state().attemptText[id] ?? '').join('')
}

/**
 * Every piece of visible answer text follows a `ready` readiness result that was the latest one for its
 * directive when its run started; and a run that started without one (a failed preparation step) wrote nothing.
 */
function expectReadinessBeforeEveryAnswer(s: Scenario, events: readonly ConversationEvent[]): void {
  const latest = new Map<DirectiveId, DirectiveReadinessEstablished>()
  const startedReady = new Map<string, boolean>()
  let texts = 0
  for (const event of events) {
    if (event.type === 'directive-readiness-established') latest.set(event.directiveId, event)
    if (event.type === 'attempt-started' && s.state().directives[event.directiveId]?.kind === 'answer') {
      const record = latest.get(event.directiveId)
      startedReady.set(event.attemptId, record?.readiness.kind === 'ready' && !record.awaitingResults)
    }
    if (event.type === 'attempt-output' && startedReady.has(event.attemptId)) {
      texts += 1
      expect(startedReady.get(event.attemptId), `readiness before the text of ${event.attemptId}`).toBe(true)
    }
  }
  expect(texts).toBeGreaterThan(0)
}

describe('typed readiness and clarification', () => {
  test('E5 · visible answer generation starts only after typed readiness; known questions are asked while prerequisites are pending, remaining checks run after results; a late clarification pauses the directive, keeps partial text and releases no dependent, while unaffected work proceeds', async () => {
    const s = await readinessScenario()
    // A is in flight: everything that needs its result has a pending prerequisite.
    await s.ask(A_TEXT, { label: 'neighborhoods' }, answer('Stay in Gion.', 100, 1_000))
    const text = 'Translate "thank you" into Japanese, summarize that recommendation, and plan a dinner nearby'
    s.t.router.when(text, (input) =>
      independent(
        input,
        [
          { label: 'translation', spans: spanOf(text, 'Translate "thank you" into Japanese') },
          { label: 'summary', spans: spanOf(text, 'summarize that recommendation'), placement: s.on('neighborhoods'), prerequisites: [s.needs('neighborhoods')] },
          { label: 'dinner', spans: spanOf(text, 'plan a dinner nearby'), prerequisites: [s.needs('neighborhoods')] },
        ],
        {
          clarifications: (units) => [
            {
              questionDirectiveId: input.ids.next('directive'),
              reason: 'missing-information',
              about: 'which cuisine the user wants',
              blockedDirectiveIds: [units[2]?.directiveId as DirectiveId],
            },
          ],
        },
      ),
    )
    s.t.model.script('Translate "thank you"', answer('Arigato.', 10, 20))
    s.t.model.script('Ask the user one short', answer('Which cuisine do you want?', 10, 20))
    s.t.model.script('summarize that recommendation', [say(10, 'Gion is'), askUser(30, 'Should the summary include prices?')])
    await s.t.submit(s.c, text)

    // ── Known questions are asked while prerequisites are pending (Q105) ──
    await s.t.advance(50)
    expect(s.d('neighborhoods').state).toBe('running')
    expect(s.d('translation').state).toBe('completed')
    const dinnerQuestion = pausedFor(s, 'dinner')
    expect(textOf(s, questionSection(s, dinnerQuestion))).toBe('Which cuisine do you want?')
    expect(s.d('dinner').readiness).toMatchObject({ readiness: { kind: 'clarification-needed', about: 'which cuisine the user wants' }, source: 'routing', awaitingResults: true })
    expect(s.d('dinner').attemptIds).toHaveLength(0)
    expect(s.d('summary').state).toBe('dependency-queued')
    expect(s.d('summary').readiness).toMatchObject({ readiness: { kind: 'ready' }, source: 'routing', awaitingResults: true })
    expect(s.t.preparer.requests).toHaveLength(0)

    // Work that depends on the summary.
    await s.ask('Shorten that summary', { label: 'short', placement: s.on('summary'), prerequisites: [s.needs('summary')] }, answer('Gion.', 10, 20))

    // The answer arrives while the prerequisite is still pending: the dinner waits for the result alone.
    s.t.model.script('Italian', answer('A trattoria on Shijo.', 10, 20))
    await reply(s, 'Italian', dinnerQuestion)
    expect(s.d('dinner').state).toBe('dependency-queued')
    expect(s.d('dinner').readiness).toMatchObject({ readiness: { kind: 'ready' }, source: 'answer', awaitingResults: true })
    expect(s.t.preparer.requests).toHaveLength(0)

    // ── Remaining checks run after the results arrive, before generation (Q105) ──
    await s.t.advance(1_000)
    expect(s.d('neighborhoods').state).toBe('completed')
    expect(s.t.preparer.requestsFor('summarize that recommendation')).toHaveLength(1)
    expect(s.t.preparer.requestsFor('summarize that recommendation')[0]?.messages.some((m) => m.content.includes('Stay in Gion.'))).toBe(true)
    expect(s.t.preparer.requests).toHaveLength(2)
    // Work that waited for nothing was never prepared.
    expect(s.t.preparer.requestsFor('Translate "thank you"')).toHaveLength(0)
    expect(s.t.preparer.requestsFor(A_TEXT)).toHaveLength(0)

    // ── Late clarification (Q106) ──
    await s.t.advance(100)
    const summary = s.d('summary')
    expect(summary.state).toBe('paused')
    const summaryQuestion = pausedFor(s, 'summary')
    const pausedSectionId = summary.sectionId as SectionId
    const pausedAttempt = s.state().attempts[summary.attemptIds[0] ?? '']
    expect(pausedAttempt?.state).toBe('paused')
    expect(s.state().attemptText[pausedAttempt?.id ?? '']).toBe('Gion is')
    expect(summary.resultAttemptId).toBeNull()
    expect(summary.readiness).toMatchObject({ readiness: { kind: 'clarification-needed', question: 'Should the summary include prices?' }, source: 'generation' })
    let snap = await s.snap()
    const pausedView = snap.transcript.sections[pausedSectionId]
    expect(pausedView?.state).toBe('paused')
    expect(pausedView?.status?.text).toBe(WORDING.pausedAwaitingInput)
    expect(pausedView?.pause).toEqual({ reason: 'awaiting-input', elicitationId: summaryQuestion, questionSectionId: questionSection(s, summaryQuestion) })
    expect(pausedView?.actions).toMatchObject({ retry: false, stop: false })
    expect(snap.transcript.attempts[pausedAttempt?.id ?? '']).toMatchObject({ text: 'Gion is', markText: WORDING.pausedPartial, resultStatus: 'paused' })
    // The question is an additional response with its text, and no model wrote it after the fact.
    const lateQuestion = snap.transcript.sections[questionSection(s, summaryQuestion)]
    expect(snap.transcript.responses[lateQuestion?.responseId ?? '']?.reason).toBe('clarification-question')
    expect(lateQuestion?.responseId).not.toBe(pausedView?.responseId)
    expect(textOf(s, questionSection(s, summaryQuestion))).toBe('Should the summary include prices?')
    expect(s.t.model.requests.filter((r) => r.messages.at(-1)?.content.includes('Ask the user one short'))).toHaveLength(1)
    // Dependents remain blocked: neither released nor offered a recovery choice.
    expect(s.d('short').state).toBe('dependency-queued')
    expect(s.d('short').attemptIds).toHaveLength(0)
    expect(snap.queue.items.find((i) => i.directiveId === s.id('short'))).toMatchObject({ state: 'waiting', recovery: null, text: 'Waiting for summary' })
    expect(snap.queue.items.some((i) => i.directiveId === summary.id)).toBe(false)
    expect(snap.queue.elicitations.filter((e) => e.kind === 'recovery-choice')).toEqual([])
    // Unaffected work proceeds.
    expect(s.d('dinner').state).toBe('completed')
    expect(textOf(s, s.d('dinner').sectionId)).toBe('A trattoria on Shijo.')

    // ── The eventual answer is another additional response ──
    s.t.model.script('Yes, include prices', answer('Gion, mid-range prices.', 10, 20))
    await reply(s, 'Yes, include prices', summaryQuestion, false)
    await s.t.advance(100)
    const resumed = s.d('summary')
    expect(resumed.state).toBe('completed')
    expect(resumed.sectionId).not.toBe(pausedSectionId)
    expect(textOf(s, resumed.sectionId)).toBe('Gion, mid-range prices.')
    snap = await s.snap()
    const answerView = snap.transcript.sections[resumed.sectionId ?? '']
    expect(snap.transcript.responses[answerView?.responseId ?? '']?.reason).toBe('clarified-answer')
    // The partial text stays where it was, labeled, and links to the answer.
    expect(snap.transcript.sections[pausedSectionId]).toMatchObject({
      state: 'superseded',
      superseded: { markText: WORDING.clarifiedPartial, replacementSectionId: resumed.sectionId, linkText: WORDING.seeAnswer },
    })
    expect(snap.transcript.attempts[pausedAttempt?.id ?? '']).toMatchObject({ text: 'Gion is', markText: WORDING.clarifiedPartial })
    // The new run read the question and the answer, never the partial text (invariant 7).
    const input = s.state().attempts[resumed.resultAttemptId ?? '']?.context.messages ?? []
    expect(input.slice(-2).map((m) => [m.origin.kind, m.content])).toEqual([
      ['clarification-question', 'Should the summary include prices?'],
      ['clarification-answer', 'Yes, include prices'],
    ])
    expect(input.some((m) => m.content.includes('Gion is'))).toBe(false)
    // The answer needed no further check of the summary. Only now is the dependent released, and, having
    // waited for a result, it gets its own check first.
    expect(s.t.preparer.requestsFor('summarize that recommendation')).toHaveLength(1)
    expect(s.d('short').state).toBe('completed')
    expect(s.t.preparer.requestsFor('Shorten that summary')).toHaveLength(1)
    expect(s.t.preparer.requests).toHaveLength(3)

    // ── Typed readiness precedes every answer run, and replay calls no model ──
    const events = await s.events()
    expectReadinessBeforeEveryAnswer(s, events)
    const firstText = events.find((e) => e.type === 'attempt-output' && s.state().attempts[e.attemptId]?.directiveId === summary.id)
    const prepared = events.find((e) => e.type === 'directive-readiness-established' && e.directiveId === summary.id && e.source === 'preparation')
    expect(prepared && firstText && prepared.seq < firstText.seq).toBe(true)
    await expectRebuildable(s)
    const calls = { model: s.t.model.requests.length, preparer: s.t.preparer.requests.length }
    const again = await s.t.restart()
    await again.settle()
    expect(again.state(s.c)).toEqual(s.state())
    expect({ model: again.model.requests.length, preparer: again.preparer.requests.length }).toEqual(calls)
  })

  test('readiness from routing is recorded before the first visible text, with no preparation step for work that waits for no result', async () => {
    const s = await readinessScenario()
    await s.ask('Why is the sky blue?', { label: 'sky' }, answer('Rayleigh scattering.', 10, 20))
    await s.t.advance(50)
    const events = await s.events()
    const established = events.find((e): e is DirectiveReadinessEstablished => e.type === 'directive-readiness-established')
    const started = events.find((e): e is AttemptStarted => e.type === 'attempt-started')
    expect(established).toMatchObject({ directiveId: s.id('sky'), readiness: { kind: 'ready' }, source: 'routing', awaitingResults: false, basis: null })
    expect(established && started && established.seq < started.seq).toBe(true)
    expect(s.t.preparer.requests).toHaveLength(0)
    expect(s.t.model.requests[0]?.clarificationSignal).toBe(true)
    expect((await s.t.backend.snapshot({ kind: 'run', conversationId: s.c, directiveId: s.id('sky'), attemptId: null })).ok).toBe(true)
  })

  test('a known question is asked at once while a whole-request barrier holds the answer work', async () => {
    const s = await readinessScenario()
    await s.ask(A_TEXT, { label: 'neighborhoods' }, answer('Stay in Gion.', 100, 1_000))
    const text = 'Summarize that recommendation and translate this menu, translation first'
    s.t.router.when(text, (input) =>
      independent(
        input,
        [
          { label: 'summary', spans: spanOf(text, 'Summarize that recommendation'), placement: s.on('neighborhoods'), prerequisites: [s.needs('neighborhoods')] },
          { label: 'menu', spans: spanOf(text, 'translate this menu') },
        ],
        {
          barrier: { reason: 'explicit-order', qualifier: 'translation first' },
          outputOrder: [1, 0],
          clarifications: (units) => [
            { questionDirectiveId: input.ids.next('directive'), reason: 'missing-information', about: 'which menu', blockedDirectiveIds: [units[1]?.directiveId as DirectiveId] },
          ],
        },
      ),
    )
    s.t.model.script('Ask the user one short', answer('Which menu?', 10, 20))
    await s.t.submit(s.c, text)
    await s.t.advance(50)
    // The barrier holds the summary; the question is out, and the prerequisite is still pending.
    expect(s.d('neighborhoods').state).toBe('running')
    expect(s.d('summary')).toMatchObject({ state: 'dependency-queued' })
    expect(s.d('menu').pause?.reason).toBe('awaiting-input')
    expect(textOf(s, questionSection(s, pausedFor(s, 'menu')))).toBe('Which menu?')
    const snap = await s.snap()
    expect(snap.transcript.responses[snap.transcript.sections[questionSection(s, pausedFor(s, 'menu'))]?.responseId ?? '']?.reason).toBe('clarification-question')
  })

  test('the remaining check can ask: the question is an additional response written without an answer run, and the answer is another', async () => {
    const s = await readinessScenario()
    await s.ask(A_TEXT, { label: 'neighborhoods' }, answer('Gion or Arashiyama.', 100, 1_000))
    await s.ask('Book a hotel there', { label: 'hotel', placement: s.on('neighborhoods'), prerequisites: [s.needs('neighborhoods')] })
    s.t.preparer.script('Book a hotel there', needsClarification('Gion or Arashiyama?'))
    const pendingSectionId = s.d('hotel').sectionId as SectionId
    await s.t.advance(1_100)
    const hotel = s.d('hotel')
    expect(hotel.state).toBe('paused')
    expect(hotel.attemptIds).toHaveLength(0)
    expect(hotel.readiness).toMatchObject({ readiness: { kind: 'clarification-needed', question: 'Gion or Arashiyama?' }, source: 'preparation' })
    const elicitationId = pausedFor(s, 'hotel')
    expect(s.state().elicitations[elicitationId]?.record).toMatchObject({ kind: 'clarification', source: 'preparation', blockedDirectiveIds: [hotel.id] })
    expect(textOf(s, questionSection(s, elicitationId))).toBe('Gion or Arashiyama?')
    // No answer run and no question run: one model request so far, for the neighborhoods.
    expect(s.t.model.requests).toHaveLength(1)
    let snap = await s.snap()
    expect(snap.transcript.sections[pendingSectionId]).toMatchObject({ state: 'paused', attemptIds: [], pause: { reason: 'awaiting-input' } })
    expect(snap.operationGraph.operations[snap.transcript.sections[pendingSectionId]?.operationId ?? '']).toMatchObject({ status: 'paused', pauseReason: 'awaiting-input' })

    s.t.model.script('Gion', answer('Booked in Gion.', 10, 20))
    await reply(s, 'Gion', elicitationId)
    await s.t.advance(50)
    expect(s.d('hotel').state).toBe('completed')
    snap = await s.snap()
    // The bubble that showed nothing is gone; the answer is a new response.
    expect(snap.transcript.sections[pendingSectionId]).toBeUndefined()
    expect(snap.transcript.responses[snap.transcript.sections[s.d('hotel').sectionId ?? '']?.responseId ?? '']?.reason).toBe('clarified-answer')
    // The user's answer established readiness: the preparation step is not asked again.
    expect(s.t.preparer.requests).toHaveLength(1)
    expectReadinessBeforeEveryAnswer(s, await s.events())
    await expectRebuildable(s)
  })

  test('an unchanged check is reused: a retry with the same input is not prepared again', async () => {
    const s = await readinessScenario()
    await s.ask(A_TEXT, { label: 'neighborhoods' }, answer('Gion.', 10, 20))
    s.t.model.script('Book a hotel there', [fail(10, 'provider-error')])
    s.t.model.script('Book a hotel there', answer('Booked.', 10, 20))
    await s.ask('Book a hotel there', { label: 'hotel', placement: s.on('neighborhoods'), prerequisites: [s.needs('neighborhoods')] })
    await s.t.advance(60_000)
    expect(s.d('hotel').state).toBe('completed')
    expect(s.d('hotel').attemptIds).toHaveLength(2)
    expect(s.t.preparer.requests).toHaveLength(1)
    expect(s.d('hotel').readiness).toMatchObject({ source: 'preparation', readiness: { kind: 'ready' } })
    expect(s.d('hotel').readiness?.basis).toMatch(/^\d+:[0-9a-f]{16}$/)
  })

  test('a preparation step that fails establishes nothing: no answer is generated, the directive fails and Retry prepares again', async () => {
    const s = await readinessScenario({ settings: { retryPolicy: 'manual' } })
    await s.ask(A_TEXT, { label: 'neighborhoods' }, answer('Gion.', 10, 20))
    s.t.preparer.script('Book a hotel there', { ok: false, error: providerError('provider-error', 'Upstream error', { httpStatus: 500 }) })
    await s.ask('Book a hotel there', { label: 'hotel', placement: s.on('neighborhoods'), prerequisites: [s.needs('neighborhoods')] }, answer('Booked.', 10, 20))
    await s.t.advance(100)
    expect(s.d('hotel').state).toBe('failed')
    expect(s.t.model.requestsFor('Book a hotel there')).toHaveLength(0)
    expect((await s.section('hotel')).failure?.message).toBe('Upstream error')
    await s.t.send({ type: 'retry', conversationId: s.c, target: { kind: 'section', sectionId: s.d('hotel').sectionId as SectionId } })
    await s.t.advance(100)
    expect(s.d('hotel').state).toBe('completed')
    expect(s.t.preparer.requests).toHaveLength(2)
    expectReadinessBeforeEveryAnswer(s, await s.events())
  })

  test('the two pause reasons are distinct everywhere: awaiting input resumes by the answer, dependency recovery by its recovery choice', async () => {
    const s = await readinessScenario({ settings: { retryPolicy: 'manual' } })
    await s.ask('Explain caching', { label: 'caching' }, [say(10, 'Caching is'), askUser(20, 'For which database?')])
    await s.ask('Give an example of it', { label: 'example', placement: s.on('caching'), prerequisites: [s.needs('caching')] })
    await s.t.advance(50)
    const caching = s.d('caching')
    const example = s.d('example')
    expect(caching.pause).toMatchObject({ reason: 'awaiting-input' })
    let snap = await s.snap()
    // Transcript, operation graph, genealogy and run inspector all say "paused awaiting user input".
    expect(snap.transcript.sections[caching.sectionId ?? '']).toMatchObject({ state: 'paused', pause: { reason: 'awaiting-input' } })
    expect(snap.operationGraph.operations[snap.transcript.sections[caching.sectionId ?? '']?.operationId ?? '']).toMatchObject({
      status: 'paused',
      statusText: WORDING.pausedAwaitingInput,
      pauseReason: 'awaiting-input',
    })
    expect(snap.genealogy.nodes[caching.nodeId]).toMatchObject({ kind: 'exchange', state: 'paused' })
    const run = await s.t.backend.snapshot({ kind: 'run', conversationId: s.c, directiveId: caching.id, attemptId: null })
    expect(run.ok && run.value).toMatchObject({ pauseReason: 'awaiting-input', readiness: { source: 'generation' }, attempt: { state: 'paused', resultStatus: 'paused' } })
    // No queue item and no recovery choice for it; its dependent just waits.
    expect(snap.queue.items.map((i) => [i.directiveId, i.state])).toEqual([[example.id, 'waiting']])
    expect(snap.queue.elicitations.map((e) => e.kind)).toEqual(['clarification'])
    // The recovery choices do not apply to it.
    const refused = await s.t.send({ type: 'continue-without', conversationId: s.c, directiveId: caching.id })
    expect(refused.ok).toBe(false)
    const retried = await s.t.send({ type: 'retry', conversationId: s.c, target: { kind: 'section', sectionId: caching.sectionId as SectionId } })
    expect(retried.ok).toBe(false)

    // Cancel is a recovery choice and does not apply to it either (10 · "Cancel | A request paused for dependency recovery").
    const cancelled = await s.t.send({ type: 'cancel', conversationId: s.c, directiveId: caching.id })
    expect(cancelled.ok).toBe(false)
    expect(s.d('caching').state).toBe('paused')
    // Stop ends it: work that ran keeps its text and is stopped; the question is withdrawn.
    const stopped = await s.t.send({ type: 'stop', conversationId: s.c, target: { kind: 'request', messageId: caching.messageId } })
    expect(stopped.ok).toBe(true)
    expect(s.d('caching').state).toBe('stopped')
    expect(textOf(s, caching.sectionId)).toBe('Caching is')
    expect(Object.values(s.state().elicitations).find((e) => e.record.kind === 'clarification')?.status).toBe('withdrawn')
    // Its dependent is now paused for dependency recovery, with the recovery choice on its queue item.
    expect(s.d('example').pause).toMatchObject({ reason: 'dependency-recovery', cause: { outcome: 'stopped' } })
    snap = await s.snap()
    expect(snap.queue.items[0]).toMatchObject({ state: 'paused', text: 'Paused — caching stopped', recovery: { continueWithout: { label: 'Continue without caching' } } })
    expect(snap.operationGraph.operations[snap.transcript.sections[s.d('example').sectionId ?? '']?.operationId ?? '']).toMatchObject({
      status: 'paused',
      pauseReason: 'dependency-recovery',
    })
    expect(snap.transcript.sections[s.d('example').sectionId ?? '']).toMatchObject({ state: 'pending', pause: { reason: 'dependency-recovery' } })
    await expectRebuildable(s)
  })

  test('stopping a request whose section is paused awaiting input keeps its partial text as stopped; one that never ran is cancelled', async () => {
    const s = await readinessScenario()
    const text = 'Explain caching, and plan a dinner'
    s.t.router.when(text, (input) =>
      independent(input, [{ label: 'caching', spans: spanOf(text, 'Explain caching') }, { label: 'dinner', spans: spanOf(text, 'plan a dinner') }], {
        clarifications: (units) => [
          { questionDirectiveId: input.ids.next('directive'), reason: 'missing-information', about: 'which city', blockedDirectiveIds: [units[1]?.directiveId as DirectiveId] },
        ],
      }),
    )
    s.t.model.script('Explain caching', [say(10, 'Caching is'), askUser(20, 'For which database?')])
    const messageId = await s.t.submit(s.c, text)
    await s.t.advance(50)
    expect(s.d('caching').state).toBe('paused')
    expect(s.d('dinner').state).toBe('paused')
    await s.t.send({ type: 'stop', conversationId: s.c, target: { kind: 'request', messageId } })
    expect(s.d('caching').state).toBe('stopped')
    expect(s.d('dinner').state).toBe('cancelled')
    expect(Object.values(s.state().elicitations).every((e) => e.status === 'withdrawn')).toBe(true)
    const snap = await s.snap()
    expect(snap.transcript.sections[s.d('caching').sectionId ?? '']?.state).toBe('stopped')
  })

  test('a run that asks without a question is a failure, never a pause', async () => {
    const s = await readinessScenario({ settings: { retryPolicy: 'manual' } })
    await s.ask('Explain caching', { label: 'caching' }, [say(10, 'Caching is'), askUser(20, '   '), done(30)])
    await s.t.advance(50)
    expect(s.d('caching').state).toBe('failed')
    expect(s.state().elicitationOrder).toHaveLength(0)
  })
})

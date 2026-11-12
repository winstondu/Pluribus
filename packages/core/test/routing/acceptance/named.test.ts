import { describe, expect, test } from 'vitest'
import { providerError, type AttemptStarted, type MessageDecomposed, type SectionId } from '@committee/protocol'
import type { CoreModule } from '../../../src/engine'
import { answer } from '../../../testing'
import { routingScenario } from '../../../testing/acceptance/routing'

/** The named tests of PLAN §6 for core-routing, and the routing cases around them. */

const BRIEF = 'Trip brief: Kyoto, five days, November, moderate budget'
const capture: CoreModule = { name: 'accept-revisions', planAppliers: [{ parts: ['revisions'], apply: () => undefined }] }

/** The brief, then A on the trip chain (running), as the router would place them. */
async function tripWithA(overrides: Parameters<typeof routingScenario>[0] = {}, aDoneAt = 2_000) {
  const s = await routingScenario(overrides)
  s.t.model.script(BRIEF, answer('Noted.', 10, 20))
  await s.send(BRIEF)
  await s.t.advance(50)
  s.t.model.script('Suggest neighborhoods', answer('Gion.', 100, aDoneAt))
  await s.send('Suggest neighborhoods to stay in', { message: { relation: 'addition', targets: { 'Trip brief: Kyoto, five days, November…': 0.9 } } })
  return s
}

describe('routing, as the reviews found it', () => {
  test('clarification · one ambiguous shared requirement is asked once and blocks both fragments', async () => {
    const s = await routingScenario()
    s.t.model.script('Ask the user one short', answer('Which venue: the conference centre or the stadium?', 10, 20))
    const text = 'Suggest a hotel and a restaurant, both near the venue'
    await s.send(text, { composite: 0.9, sharedClarify: { 1: 0.9 }, parts: [{ relation: 'new' }, { relation: 'new' }] }, {
      decompose: [
        { part: 'Suggest a hotel', label: 'hotel', requirements: [{ text: 'Near the venue', part: 'both near the venue' }] },
        { part: 'a restaurant', instruction: 'Suggest a restaurant', label: 'restaurant', requirements: [{ text: 'Near the venue', part: 'both near the venue' }] },
      ],
    })
    const raised = Object.values(s.state().elicitations)
    expect(raised).toHaveLength(1)
    const record = raised[0]?.record
    expect(record?.kind === 'clarification' && record.blockedDirectiveIds).toEqual([s.d('hotel').id, s.d('restaurant').id])
    expect(s.d('hotel').state).toBe('paused')
    expect(s.d('restaurant').state).toBe('paused')
    const question = s.d('question about hotel + restaurant')
    expect(question.instruction).toContain('Near the venue')
    // No bubble and no queue item for the held parts; the initial bubble goes away.
    const snap = await s.t.snapshot(s.c)
    expect(snap.queue.items).toEqual([])
    const original = Object.values(s.state().messages).find((m) => m.text === text)
    expect(snap.transcript.responses[original?.initialResponseId ?? '']).toBeUndefined()
    // One answer releases both, in one clarified-answer response.
    await s.t.advance(50)
    await s.send('The conference centre', {}, { replyTo: ['question about hotel + restaurant'] })
    const hotel = s.d('hotel')
    const restaurant = s.d('restaurant')
    expect(hotel.sectionId).not.toBeNull()
    expect(s.state().sections[hotel.sectionId ?? '']?.responseId).toBe(s.state().sections[restaurant.sectionId ?? '']?.responseId)
    expect(s.state().responses[s.state().sections[hotel.sectionId ?? '']?.responseId ?? '']?.reason).toBe('clarified-answer')
  })

  test("clarification · the clarified run's input ends with the question and the answer", async () => {
    const s = await routingScenario()
    s.t.model.script('Ask the user one short', answer('Which conference?', 10, 20))
    await s.send('Recommend a hotel near the conference', { message: { clarify: 0.9 } })
    await s.t.advance(50)
    const blocked = s.d('Recommend a hotel near the conference')
    // An untargeted next message recognised as the answer (Q98).
    s.t.model.script('Recommend a hotel near the conference', answer('The Hotel Granvia.', 10, 20))
    const reply = await s.send('The one at the Kyoto International Conference Center', { message: { targets: { Question: 0.9 } } })
    await s.t.advance(50)
    expect(s.state().messages[reply]?.decision?.units[0]?.targets.mode).toBe('inferred')
    const run = s.state().attempts[s.directive(blocked.id).attemptIds[0] ?? '']
    const tail = run?.context.messages.slice(-3)
    expect(tail?.map((m) => m.origin.kind)).toEqual(['request', 'clarification-question', 'clarification-answer'])
    expect(tail?.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(tail?.[1]?.content).toBe('Which conference?')
    expect(tail?.[2]?.content).toBe('The one at the Kyoto International Conference Center')
    expect(s.directive(blocked.id).state).toBe('completed')
    // The question ran on the blocked directive's node, with its ancestry and its own request: no genealogy node of its own.
    const question = s.d('question about Recommend a hotel near the conference')
    expect(question.nodeId).toBe(blocked.nodeId)
    expect(Object.values(s.state().nodes).some((n) => n.directiveId === question.id)).toBe(false)
  })

  test('undo split · forks withdrawn from an open group leave it consistent; a group left empty is dissolved', async () => {
    const s = await tripWithA()
    const trip = 'Trip brief: Kyoto, five days, November…'
    // F1 forks beside running A (one group); F2 needs F1.
    const text = 'Suggest rainy-day activities, then pick the best one for day two'
    const original = await s.send(
      text,
      { composite: 0.9, parts: [{ relation: 'addition', targets: { [trip]: 0.9 } }, { relation: 'dependent', after: { 1: 0.9 } }] },
      { decompose: [{ part: 'Suggest rainy-day activities', label: 'activities' }, { part: 'pick the best one for day two', label: 'best activity', after: [0] }] },
    )
    const group = () => Object.values(s.state().groups)[0]
    expect(group()?.members.map((m) => s.directive(m.directiveId).label)).toEqual(['Suggest neighborhoods to stay in', 'activities'])
    expect(await s.t.send({ type: 'undo-split', conversationId: s.c, originalMessageId: original })).toMatchObject({ ok: true })
    expect(group()?.state).toBe('open')
    expect(group()?.withdrawn).toEqual([s.d('activities').id])
    await s.t.advance(2_100)
    // A one-member join-back returns A's exchange to the base chain.
    expect(group()?.state).toBe('closed')
    const joinBack = Object.values(s.state().joinBacks)[0]
    expect(joinBack?.members.map((m) => s.directive(m.directiveId).label)).toEqual(['Suggest neighborhoods to stay in'])
    let snap = await s.t.snapshot(s.c)
    expect(snap.genealogy.groups[group()?.id ?? '']?.withdrawnNodeIds).toEqual([s.d('activities').nodeId])

    // A split whose forks are the whole group: undone, the group is dissolved and forms no join-back.
    const text2 = 'Suggest a temple, suggest a garden, then plan a walk between them'
    const original2 = await s.send(
      text2,
      {
        composite: 0.9,
        parts: [
          { relation: 'addition', chain: 'Trip brief: Kyoto, five days, November…' },
          { relation: 'addition', chain: 'Trip brief: Kyoto, five days, November…' },
          { relation: 'dependent', after: { 1: 0.9, 2: 0.9 } },
        ],
      },
      {
        decompose: [
          { part: 'Suggest a temple', label: 'temple' },
          { part: 'suggest a garden', label: 'garden' },
          { part: 'plan a walk between them', label: 'walk', after: [0, 1] },
        ],
      },
    )
    const second = Object.values(s.state().groups).find((g) => g.members.some((m) => m.directiveId === s.d('temple').id))
    expect(second?.members.map((m) => s.directive(m.directiveId).label)).toEqual(['temple', 'garden'])
    // The walk needs both members: it waits for the whole group, on its point.
    expect(s.d('walk').prerequisites).toEqual([{ kind: 'sibling-group', groupId: second?.id }])
    expect(await s.t.send({ type: 'undo-split', conversationId: s.c, originalMessageId: original2 })).toMatchObject({ ok: true })
    expect(s.state().groups[second?.id ?? '']?.state).toBe('dissolved')
    await s.t.advance(100)
    expect(s.state().groups[second?.id ?? '']?.joinBackIds).toEqual([])
    snap = await s.t.snapshot(s.c)
    expect(snap.genealogy.groups[second?.id ?? '']?.state).toBe('dissolved')
    expect(s.directive(s.d('walk').id).state).toBe('superseded')
  })

  test('join chain · a parent on an open sibling group resolves to its join-back at start', async () => {
    const s = await tripWithA({}, 400)
    s.t.model.script('Suggest rainy-day activities', answer('Museums.', 50, 300))
    const trip = 'Trip brief: Kyoto, five days, November…'
    await s.send('Suggest rainy-day activities', { message: { relation: 'addition', targets: { [trip]: 0.9 } } })
    s.t.model.script('Why is the sky blue?', answer('Scattering.', 10, 20))
    await s.send('Why is the sky blue?')
    await s.t.advance(50)
    const group = Object.values(s.state().groups)[0]
    expect(group?.state).toBe('open')
    // "Compare the trip recommendations, still running, with the sky explanation."
    s.t.model.script('Compare the trip recommendations', answer('Both mention blue.', 10, 20))
    await s.send('Compare the trip recommendations with the sky explanation', {
      message: {
        relation: 'dependent',
        targets: { 'Suggest neighborhoods to stay in': 0.9, 'Suggest rainy-day activities': 0.9, 'Why is the sky blue': 0.9 },
        needs: { 'Suggest neighborhoods to stay in + Suggest rainy-day activities': 0.9 },
      },
    })
    const cmp = s.d('Compare the trip recommendations with the…')
    expect(s.state().chains[cmp.chainId]?.kind).toBe('join')
    expect(s.state().nodes[cmp.nodeId]?.plannedParents).toEqual([
      { kind: 'sibling-group', groupId: group?.id },
      { kind: 'node', nodeId: s.d('Why is the sky blue').nodeId },
    ])
    expect(cmp.prerequisites).toEqual([{ kind: 'sibling-group', groupId: group?.id }])
    expect(cmp.state).toBe('dependency-queued')
    await s.t.advance(500)
    const joinBack = Object.values(s.state().joinBacks)[0]
    const started = (await s.events()).find((e): e is AttemptStarted => e.type === 'attempt-started' && e.directiveId === cmp.id)
    expect(started?.parents).toEqual([joinBack?.nodeId, s.d('Why is the sky blue').nodeId])
    expect(started?.context.inputs.map((i) => s.directive(i.directiveId).label)).toEqual([
      'Trip brief: Kyoto, five days, November…',
      'Suggest neighborhoods to stay in',
      'Suggest rainy-day activities',
      'Why is the sky blue',
    ])
  })

  test('composite · one corrective fragment and one new fragment are planned and recorded', async () => {
    const s = await tripWithA({ extraModules: [capture] }, 100)
    await s.t.advance(200)
    const a = s.d('Suggest neighborhoods to stay in')
    const text = 'Actually use a luxury budget for the neighborhoods, and also suggest some day trips'
    s.t.model.script('Suggest some day trips', answer('Nara and Uji.', 10, 20))
    const messageId = await s.send(
      text,
      { composite: 0.9, parts: [{ corrective: 0.95, targets: { 'Suggest neighborhoods to stay in': 0.9 } }, { relation: 'addition', chain: 'Trip brief: Kyoto, five days, November…' }] },
      {
        decompose: [
          { part: 'Actually use a luxury budget for the neighborhoods', instruction: 'Use a luxury budget for the neighborhood recommendations.', label: 'luxury' },
          { part: 'also suggest some day trips', instruction: 'Suggest some day trips from Kyoto.', label: 'day trips' },
        ],
      },
    )
    const decomposed = (await s.events()).find((e): e is MessageDecomposed => e.type === 'message-decomposed' && e.messageId === messageId)
    expect(decomposed?.fragments.map((f) => f.kind)).toEqual(['revision', 'work'])
    expect(decomposed?.fragments[0]?.directiveId).toBe(a.id)
    expect(decomposed?.fragments[0]?.rewrittenText).toBe('Use a luxury budget for the neighborhood recommendations.')
    expect(decomposed?.fragments[1]?.directiveId).toBe(s.d('day trips').id)
    const decision = s.state().messages[messageId]?.decision
    expect(decision?.units.map((u) => u.relation.value)).toEqual(['revision', 'addition'])
    // One unit beside its revision: the reply is not grouped.
    const response = s.state().responses[s.state().messages[messageId]?.initialResponseId ?? '']
    expect(response?.grouped).toBe(false)
    expect(s.d('day trips').chainId).toBe(s.d('Trip brief: Kyoto, five days, November…').chainId)
  })
})

describe('routing outcomes', () => {
  test('clarification · a question for work on a join chain is written by the answer model, the blocked work by the synthesis model', async () => {
    const s = await routingScenario()
    s.t.model.script('Why is the sky blue?', answer('Scattering.', 10, 20))
    s.t.model.script('Why is the sea salty?', answer('Minerals.', 10, 20))
    await s.send('Why is the sky blue?')
    await s.send('Why is the sea salty?')
    await s.t.advance(50)
    await s.send('Compare those two for my presentation', {
      message: { relation: 'addition', several: 0.9, targets: { 'Why is the sky blue': 0.9, 'Why is the sea salty': 0.9 }, clarify: 0.9 },
    })
    await s.t.advance(50)
    const blocked = s.d('Compare those two for my presentation')
    expect(s.state().chains[blocked.chainId]?.kind).toBe('join')
    const question = s.d('question about Compare those two for my presentation')
    expect(s.state().attempts[question.attemptIds[0] ?? '']?.model).toBe(s.state().attempts[s.d('Why is the sky blue').attemptIds[0] ?? '']?.model)
    expect(s.state().attempts[question.attemptIds[0] ?? '']?.modelRole).toBe('answer')
    await s.send('It is for ten-year-olds', {}, { replyTo: ['question about Compare those two for my presentation'] })
    await s.t.advance(50)
    expect(s.state().attempts[s.directive(blocked.id).attemptIds[0] ?? '']?.modelRole).toBe('synthesis')
  })


  test('target ambiguity · the reply waits for the user, routes with the chosen sections, and keeps them across a restart', async () => {
    const s = await routingScenario()
    s.t.model.script('Why is the sky blue?', answer('Scattering.', 10, 20))
    s.t.model.script('Translate this menu', answer('Soupe.', 10, 20))
    await s.send('Why is the sky blue?')
    await s.send('Translate this menu into French: soup')
    await s.t.advance(50)
    const sky = s.d('Why is the sky blue')
    const menu = s.d('Translate this menu into French: soup')
    const messageId = await s.send('Make that shorter', { message: { relation: 'addition', targets: { 'Why is the sky blue': 0.5, 'Translate this menu into French: soup': 0.45 } } })
    const elicitation = Object.values(s.state().elicitations)[0]
    expect(elicitation?.record).toMatchObject({ kind: 'target-ambiguity', messageId })
    expect(elicitation?.record.kind === 'target-ambiguity' && elicitation.record.candidates.map((c) => c.sectionId)).toEqual([sky.sectionId, menu.sectionId])
    expect(s.state().messages[messageId]?.routing).toBe('awaiting-target')
    let snap = await s.t.snapshot(s.c)
    expect(snap.queue.elicitations.map((e) => e.kind)).toEqual(['target-ambiguity'])
    // Only an offered section can be chosen.
    const bad = await s.t.send({ type: 'answer-elicitation', conversationId: s.c, elicitationId: elicitation?.id as never, answer: { kind: 'target-ambiguity', sectionIds: ['sec_nope' as SectionId] } })
    expect(!bad.ok && bad.error.code).toBe('invalid')
    // Hold the next routing so a restart can find it lost.
    let release: () => void = () => undefined
    s.t.decisions.push(() => new Promise((resolve) => (release = () => resolve({ ok: false, error: providerError('network', 'lost') }))))
    await s.t.backend.send({ type: 'answer-elicitation', conversationId: s.c, elicitationId: elicitation?.id as never, answer: { kind: 'target-ambiguity', sectionIds: [menu.sectionId as SectionId] } })
    await s.t.flush()
    expect(s.state().messages[messageId]?.routing).toBe('routing')
    const t2 = await s.t.restart()
    release()
    await t2.settle()
    const input = t2.decisions.requests.at(-1)
    expect(input?.state).toContain('The user replied to S2.')
    const state = t2.state(s.c)
    const reply = state.messages[messageId]
    expect(reply?.routing).toBe('routed')
    const unit = reply?.decision?.units[0]
    expect(unit?.targets).toMatchObject({ mode: 'elicited', sectionIds: [menu.sectionId] })
    const d = state.directives[reply?.directiveIds[0] ?? '']
    expect(d?.targets).toEqual([menu.sectionId])
    snap = await t2.snapshot(s.c)
    expect(snap.queue.elicitations).toEqual([])
  })

  test('routing failure · a failed decision call is recorded, never guessed, and Retry routes again', async () => {
    const s = await routingScenario()
    s.t.decisions.push({ ok: false, error: providerError('service-unavailable', 'Decisions are down', { httpStatus: 503 }) })
    const messageId = await s.send('Why is the sky blue?')
    const message = s.state().messages[messageId]
    expect(message?.routing).toBe('failed')
    expect(message?.routingFailure?.code).toBe('service-unavailable')
    expect(message?.directiveIds).toEqual([])
    // The decomposer failing is the same.
    const composite = 'Explain tides and explain eclipses'
    s.t.decomposer.push({ ok: false, error: providerError('malformed-response', 'Not JSON') })
    const second = await s.send(composite, { composite: 0.9 })
    expect(s.state().messages[second]?.routingFailure?.code).toBe('malformed-response')
    // Retry on the request routes it again.
    const retried = await s.t.send({ type: 'retry', conversationId: s.c, target: { kind: 'request', messageId } })
    expect(retried.ok).toBe(true)
    expect(s.state().messages[messageId]?.routing).toBe('routed')
    expect(s.state().messages[messageId]?.directiveIds).toHaveLength(1)
  })

  test('undo split · a re-routing lost with the executor, or retried after a failure, stays atomic', async () => {
    const s = await routingScenario()
    const text = 'Find three neighborhoods, then plan a day around the best one'
    const rules = { composite: 0.9, parts: [{ relation: 'new' as const }, { relation: 'dependent' as const, after: { 1: 0.9 } }] }
    s.t.model.script('Find three neighborhoods', answer('Gion…', 5_000, 6_000))
    const original = await s.send(text, rules, {
      decompose: [
        { part: 'Find three neighborhoods', label: 'neighborhoods' },
        { part: 'plan a day around the best one', label: 'day plan', after: [0] },
      ],
    })
    s.t.decisions.push({ ok: false, error: providerError('network', 'offline') })
    await s.t.send({ type: 'undo-split', conversationId: s.c, originalMessageId: original })
    expect(s.state().messages[original]?.routing).toBe('failed')
    await s.t.send({ type: 'retry', conversationId: s.c, target: { kind: 'request', messageId: original } })
    const asked = s.t.decisions.requests.at(-1)?.questions ?? {}
    expect('composite' in asked).toBe(false)
    expect(s.state().messages[original]?.decision?.composition.value).toBe('atomic')
    expect(s.t.decomposer.requests).toHaveLength(1)
  })
})

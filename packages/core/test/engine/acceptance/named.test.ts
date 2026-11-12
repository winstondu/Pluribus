import { describe, expect, test } from 'vitest'
import {
  WORDING,
  providerError,
  type ConversationEvent,
  type ConversationEventBody,
  type ConversationFrame,
  type DirectiveId,
  type EventId,
  type MessageId,
  type NodeId,
  type ResponseId,
  type SectionId,
} from '@committee/protocol'
import { answer, atomic, fail, independent, noUnits, say, spanOf } from '../../../testing'
import type { CoreModule } from '../../../src/engine/module'
import { assembleContext } from '../../../src/engine/context'
import { rebuildSnapshot } from '../../../src/engine/projections'
import { fold } from '../../../src/engine/reducers'
import { emptyConversationState } from '../../../src/engine/state'
import { expectRebuildable, scenario, type Scenario } from '../../../testing/acceptance/engine'

/** The named tests of PLAN §6 that are core-engine's. */

const hang = (text?: string) => (text ? [say(50, text)] : [])

async function tripWithA(scriptA = answer('Gion.', 100, 1_000)): Promise<Scenario> {
  const s = await scenario()
  await s.ask('Trip brief: Kyoto, five days', { label: 'brief' }, answer('Noted.', 10, 20))
  await s.t.advance(50)
  await s.ask('Suggest neighborhoods', { label: 'neighborhoods', placement: s.on('brief') }, scriptA)
  return s
}

/** Appends hand-written events to a log, stamping their envelopes. */
function extend(events: readonly ConversationEvent[], bodies: readonly ConversationEventBody[]): ConversationEvent[] {
  const first = events[0]
  if (!first) throw new Error('empty log')
  let seq = events[events.length - 1]?.seq ?? 0
  const at = events[events.length - 1]?.at ?? 0
  return [
    ...events,
    ...bodies.map((body) => {
      seq += 1
      return { ...body, id: `evt_${seq}` as EventId, log: first.log, seq, v: 1, at } as ConversationEvent
    }),
  ]
}

describe('placement, as the reviews found it', () => {
  test('first fork · B sent while only A runs is a fork beside A, not a child of running A', async () => {
    const s = await tripWithA()
    const tripChain = s.d('brief').chainId
    expect(s.d('neighborhoods').chainId).toBe(tripChain)
    await s.ask('Suggest rainy-day activities', { label: 'activities', placement: s.onHeadOf('neighborhoods') })
    const group = Object.values(s.state().groups)[0]
    expect(group?.startNodeId).toBe(s.d('brief').nodeId)
    expect(group?.baseChainId).toBe(tripChain)
    expect(group?.members.map((m) => m.directiveId)).toEqual([s.id('neighborhoods'), s.id('activities')])
    // A moved to a fork chain of its own; the base chain's head is the brief again.
    expect(s.d('neighborhoods').chainId).not.toBe(tripChain)
    expect(s.state().chains[s.d('neighborhoods').chainId]?.kind).toBe('fork')
    expect(s.state().chains[tripChain]?.nodeIds).toEqual([s.d('brief').nodeId])
    expect(s.state().nodes[s.d('activities').nodeId]?.plannedParents).toEqual([{ kind: 'node', nodeId: s.d('brief').nodeId }])
    await expectRebuildable(s)
  })

  test('placement · the first reply to a finished sibling opens a branch chain in its own color', async () => {
    const s = await tripWithA(answer('Gion.', 100, 300))
    await s.ask('Suggest rainy-day activities', { label: 'activities', placement: s.onHeadOf('brief') }, answer('Museums.', 50, 200))
    await s.t.advance(250)
    // B finished, A still running: the group is open, and B is the last node of its fork chain.
    expect(Object.values(s.state().groups)[0]?.state).toBe('open')
    await s.ask('Give me three cheaper alternatives', { label: 'cheaper', placement: s.on('activities') })
    const chain = s.state().chains[s.d('cheaper').chainId]
    expect(chain?.kind).toBe('branch')
    expect(chain?.baseChainId).toBe(s.d('activities').chainId)
    const colors = s.state().chainOrder.map((id) => s.state().chains[id]?.colorIndex)
    expect(new Set(colors).size).toBe(colors.length)
    expect(Object.values(s.state().groups)[0]?.members).toHaveLength(2)
  })

  test('placement · a second reply to a sibling while the first is running opens a sibling group at that sibling', async () => {
    const s = await tripWithA(answer('Gion.', 100, 300))
    await s.ask('Suggest rainy-day activities', { label: 'activities', placement: s.onHeadOf('brief') }, answer('Museums.', 50, 200))
    await s.t.advance(400)
    await s.ask('Give me three cheaper alternatives', { label: 'cheaper', placement: s.on('activities') }, answer('Shrines.', 10, 2_000))
    await s.ask('And three family-friendly ones', { label: 'family', placement: s.on('activities') }, answer('Aquarium.', 10, 2_000))
    const groups = Object.values(s.state().groups)
    expect(groups).toHaveLength(2)
    const second = groups[1]
    expect(second?.startNodeId).toBe(s.d('activities').nodeId)
    expect(second?.baseChainId).toBe(s.d('activities').chainId)
    // The first reply was on a branch chain of its own and keeps it.
    expect(second?.members).toEqual([
      { directiveId: s.id('cheaper'), nodeId: s.d('cheaper').nodeId, chainId: s.d('cheaper').chainId },
      { directiveId: s.id('family'), nodeId: s.d('family').nodeId, chainId: s.d('family').chainId },
    ])
    expect(s.state().chains[s.d('cheaper').chainId]?.kind).toBe('branch')
    expect(s.state().chains[s.d('family').chainId]?.kind).toBe('fork')
  })

  test('placement · continue on an in-flight node without its prerequisite is repaired to its starting context', async () => {
    const s = await tripWithA()
    // The router pointed at running A itself, without waiting for it.
    await s.ask('Also give me luxury options', { label: 'luxury', placement: s.on('neighborhoods') }, answer('Ritz.', 10, 20))
    expect(s.state().nodes[s.d('luxury').nodeId]?.plannedParents).toEqual([{ kind: 'node', nodeId: s.d('brief').nodeId }])
    expect(Object.values(s.state().groups)[0]?.members.map((m) => m.directiveId)).toEqual([s.id('neighborhoods'), s.id('luxury')])
    await s.t.advance(50)
    const run = s.state().attempts[s.d('luxury').attemptIds[0] ?? '']
    expect(run?.context.nodeIds).not.toContain(s.d('neighborhoods').nodeId)
  })

  const inputsOf = (s: Scenario, label: string): string[] =>
    (s.state().attempts[s.d(label).attemptIds[0] ?? '']?.context.inputs ?? []).map((i) => s.state().directives[i.directiveId]?.label ?? '?')
  const chainLabels = (s: Scenario, label: string): string[] =>
    (s.state().chains[s.d(label).chainId]?.nodeIds ?? []).map((id) => {
      const n = s.state().nodes[id]
      return n?.kind === 'join-back' ? 'JB' : (s.state().directives[n?.directiveId ?? '']?.label ?? '?')
    })

  test('placement · two concurrent replies to a node its chain has moved past fork on a branch; continuing the chain still reads its later nodes', async () => {
    const s = await scenario()
    await s.ask('Explain TCP', { label: 'n1' }, answer('TCP is…', 10, 20))
    await s.t.advance(30)
    await s.ask('And UDP?', { label: 'n2', placement: s.onHeadOf('n1') }, answer('UDP-ANSWER.', 10, 20))
    await s.t.advance(30)
    expect(s.d('n2').chainId).toBe(s.d('n1').chainId)
    await s.ask('Expand on the handshake', { label: 'X', placement: s.on('n1') }, answer('SYN…', 10, 200))
    await s.ask('Expand on congestion control', { label: 'Y', placement: s.on('n1') }, answer('AIMD…', 10, 200))
    const group = Object.values(s.state().groups)[0]
    expect(group?.startNodeId).toBe(s.d('n1').nodeId)
    expect(group?.baseChainId).not.toBe(s.d('n1').chainId)
    expect(s.state().chains[group?.baseChainId ?? '']?.kind).toBe('branch')
    await s.t.advance(300)
    expect(chainLabels(s, 'n1')).toEqual(['n1', 'n2'])
    await s.ask('Which should I use for video calls?', { label: 'K', placement: s.onHeadOf('n1') }, answer('UDP.', 10, 20))
    await s.t.advance(50)
    expect(inputsOf(s, 'K')).toEqual(['n1', 'n2'])
    expect(s.d('K').chainId).toBe(s.d('n1').chainId)
    // Work on the group continues from its join-back on the branch, reading n1, X and Y.
    await s.ask('Combine both', { label: 'both', placement: s.onGroupOf('X') }, answer('Both.', 10, 20))
    await s.t.advance(50)
    expect(inputsOf(s, 'both')).toEqual(['n1', 'X', 'Y'])
    expect(s.d('both').chainId).toBe(group?.baseChainId)
    await expectRebuildable(s)
  })

  test('placement · a second sibling group at the start node of a closed group does not land on the chain that moved on', async () => {
    const s = await scenario()
    await s.ask('Trip brief: Kyoto', { label: 'brief' }, answer('Noted.', 10, 20))
    await s.t.advance(50)
    await s.ask('Suggest neighborhoods', { label: 'A', placement: s.on('brief') }, answer('Gion.', 10, 100))
    await s.ask('Suggest rainy-day activities', { label: 'B', placement: s.onHeadOf('brief') }, answer('Museums.', 10, 100))
    await s.t.advance(200)
    await s.ask('Make an itinerary from those', { label: 'J', placement: s.onGroupOf('A') }, answer('ITINERARY-TEXT.', 10, 20))
    await s.t.advance(50)
    await s.ask('Suggest day trips', { label: 'X', placement: s.on('brief') }, answer('Nara.', 10, 300))
    await s.ask('Suggest food', { label: 'Y', placement: s.on('brief') }, answer('Ramen.', 10, 300))
    await s.t.advance(400)
    expect(chainLabels(s, 'brief')).toEqual(['brief', 'JB', 'J'])
    await s.ask('Add a tea ceremony to day 2 of the itinerary', { label: 'K', placement: s.onHeadOf('brief') }, answer('Done.', 10, 20))
    await s.t.advance(50)
    expect(s.d('K').chainId).toBe(s.d('brief').chainId)
    expect(inputsOf(s, 'K')).toEqual(['brief', 'A', 'B', 'J'])
  })

  test('C11 (engine) · work that consumes a finished member, placed on the start node, is that member\'s descendant and reads its result', async () => {
    const s = await scenario()
    await s.ask('Trip brief', { label: 'brief' }, answer('Noted.', 10, 20))
    await s.t.advance(50)
    await s.ask('Suggest neighborhoods', { label: 'A', placement: s.on('brief') }, answer('Gion.', 10, 100))
    await s.ask('Suggest activities', { label: 'B', placement: s.onHeadOf('brief') }, answer('Museums.', 10, 400))
    await s.ask('Suggest day trips', { label: 'D', placement: s.onHeadOf('brief') }, answer('Nara.', 10, 3_000))
    await s.t.advance(500)
    await s.ask('Use the activities for an evening plan', { label: 'C', placement: s.on('brief'), prerequisites: [s.needs('B')] }, answer('Evening.', 10, 20))
    const group = Object.values(s.state().groups)[0]
    expect(group?.members.map((m) => m.directiveId)).not.toContain(s.id('C'))
    expect(s.state().nodes[s.d('C').nodeId]?.plannedParents).toEqual([{ kind: 'node', nodeId: s.d('B').nodeId }])
    await s.t.advance(50)
    expect(inputsOf(s, 'C')).toEqual(['brief', 'B'])
  })

  test('C9 (engine) · work that continues one member and waits for another depends on the whole group', async () => {
    const s = await scenario()
    await s.ask('Trip brief', { label: 'brief' }, answer('Noted.', 10, 20))
    await s.t.advance(50)
    await s.ask('Suggest neighborhoods', { label: 'A', placement: s.on('brief') }, answer('Gion.', 10, 100))
    await s.ask('Suggest activities', { label: 'B', placement: s.onHeadOf('brief') }, answer('Museums.', 10, 400))
    await s.ask('Suggest day trips', { label: 'D', placement: s.onHeadOf('brief') }, answer('Nara.', 10, 3_000))
    await s.t.advance(150)
    await s.ask('Compare the neighborhoods with the activities', { label: 'cmp', placement: s.on('A'), prerequisites: [s.needs('B')] }, answer('Compared.', 10, 20))
    expect(s.d('cmp').prerequisites).toContainEqual(s.needsGroupOf('A'))
    await s.t.advance(400)
    expect(s.d('cmp').attemptIds).toHaveLength(0)
    await s.t.advance(3_000)
    expect(inputsOf(s, 'cmp')).toEqual(['brief', 'A', 'B', 'D'])
  })
})

describe('whole-request barrier, with scripted plans', () => {
  const text = 'Summarize that recommendation and separately translate this menu'
  async function withRecommendation(barrier: boolean): Promise<Scenario> {
    const s = await scenario()
    await s.ask('Recommend a restaurant', { label: 'recommendation' }, answer('Try Kikunoi.', 100, 1_000))
    s.t.model.script('translate this menu', answer('Menu en français.', 10, 50))
    s.t.router.when(text, (input) =>
      independent(
        input,
        [
          { label: 'summary', spans: spanOf(text, 'Summarize that recommendation'), placement: s.on('recommendation'), prerequisites: [s.needs('recommendation')] },
          { label: 'translation', spans: spanOf(text, 'translate this menu') },
        ],
        barrier ? { barrier: { reason: 'explicit-order', qualifier: 'but put the translation first' }, outputOrder: [1, 0] } : {},
      ),
    )
    await s.t.submit(s.c, text)
    return s
  }

  test('D2 (engine) · with a recommendation in flight, an unrelated translation requested alongside a summary of it runs before it completes', async () => {
    const s = await withRecommendation(false)
    expect(s.d('translation').state).toBe('running')
    expect(s.d('summary').state).toBe('dependency-queued')
    await s.t.advance(100)
    expect(s.d('translation').state).toBe('completed')
    expect(s.d('recommendation').state).toBe('running')
    const snap = await s.snap()
    expect(snap.queue.items.map((i) => i.label)).toEqual(['summary'])
  })

  test('D3 (engine) · with an output-order qualifier on that request, the translation does not start before the recommendation completes', async () => {
    const s = await withRecommendation(true)
    expect(s.d('translation').state).toBe('dependency-queued')
    expect(s.d('translation').heldByBarrier).toBe(true)
    let snap = await s.snap()
    const held = snap.queue.items.find((i) => i.directiveId === s.id('translation'))
    expect(held?.heldByBarrier).toBe(true)
    expect(held?.text).toBe('Waiting for recommendation')
    const op = snap.operationGraph.operations[snap.transcript.sections[s.d('translation').sectionId ?? '']?.operationId ?? '']
    expect(op?.heldByBarrier).toBe(true)
    expect(op?.dependsOn).toEqual([])
    const inspection = await s.t.backend.snapshot({ kind: 'run', conversationId: s.c, directiveId: s.id('translation'), attemptId: null })
    expect(inspection.ok && inspection.value.barrier?.waitingFor.map((w) => w.label)).toEqual(['recommendation'])
    await s.t.advance(900)
    expect(s.d('translation').attemptIds).toHaveLength(0)
    await s.t.advance(200)
    expect(s.d('translation').attemptIds).toHaveLength(1)
    expect(s.d('summary').attemptIds).toHaveLength(1)
    snap = await s.snap()
    expect(snap.queue.items).toEqual([])
  })
})

describe('supersession, stop, routing, start and stream', () => {
  test('supersession · status-only bubble dropped, partial text collapsed, finished work marked', async () => {
    // The prefix comes from the engine; the supersessions are written by hand, as the recovery slice will emit them.
    const s = await scenario()
    await s.ask('Explain caching', { label: 'caching' }, hang())
    await s.ask('Explain indexes', { label: 'indexes' }, hang('Indexes are'))
    await s.ask('Explain joins', { label: 'joins' }, answer('Joins combine rows.', 10, 20))
    await s.ask('Actually, make them all for beginners', (input) => noUnits(input))
    await s.t.advance(100)
    const state = s.state()
    const revision = Object.values(state.messages).find((m) => m.text.startsWith('Actually'))?.id as MessageId
    const prefix = await s.events()
    const bodies: ConversationEventBody[] = []
    const replacement: Record<string, { section: SectionId; response: ResponseId; node: NodeId }> = {}
    let n = 0
    for (const label of ['caching', 'indexes', 'joins']) {
      const d = s.d(label)
      n += 1
      const ids = { section: `sec_R${n}` as SectionId, response: `rsp_R${n}` as ResponseId, node: `nod_R${n}` as NodeId }
      replacement[label] = ids
      const section = state.sections[d.sectionId ?? '']
      const live = section?.attemptIds.find((a) => ['running', 'streaming'].includes(state.attempts[a]?.state ?? ''))
      bodies.push(
        {
          type: 'revision-recorded',
          messageId: revision,
          scope: 'work',
          correction: 'Make it for beginners',
          fragmentId: null,
          targets: [{ directiveId: d.id, sectionId: d.sectionId, state: label === 'joins' ? 'finished' : label === 'indexes' ? 'running-with-text' : 'running-status-only' }],
          requirementIds: [],
        },
        {
          type: 'section-superseded',
          sectionId: d.sectionId as SectionId,
          directiveId: d.id,
          endedAttemptId: live ?? null,
          hadVisibleOutput: section?.visibleOutput ?? false,
          wasFinished: label === 'joins',
          cause: { kind: 'revision', revisionMessageId: revision },
          replacementSectionId: ids.section,
        },
        { type: 'node-created', nodeId: ids.node, chainId: d.chainId, directiveId: d.id, reason: 'revision', plannedParents: [], replacesNodeId: d.nodeId },
        { type: 'response-opened', responseId: ids.response, messageId: revision, reason: 'revision-replacement', grouped: false, sectionOrder: 'first-output' },
        { type: 'section-opened', sectionId: ids.section, directiveId: d.id, responseId: ids.response, title: label, replacesSectionId: d.sectionId, operationId: `opr_R${n}` as never, explicitPosition: null },
        { type: 'directive-ready', directiveId: d.id },
      )
    }
    const log = extend(prefix, bodies)
    const folded = fold(emptyConversationState(s.c), log)
    const snap = rebuildSnapshot(folded)
    const old = (label: string) => s.d(label).sectionId ?? ''

    // Status only: dropped without a trace, bubble and all.
    expect(snap.transcript.sections[old('caching')]).toBeUndefined()
    const cachingResponse = state.sections[old('caching')]?.responseId ?? ''
    expect(snap.transcript.responses[cachingResponse]).toBeUndefined()
    expect(snap.transcript.order.some((r) => r.id === cachingResponse)).toBe(false)
    // Partial text: stays in place, collapsed, "Superseded — revised below", linked.
    const indexes = snap.transcript.sections[old('indexes')]
    expect(indexes?.state).toBe('superseded')
    expect(indexes?.superseded).toEqual({
      markText: WORDING.supersededPartial,
      replacementSectionId: replacement.indexes?.section,
      replacementResponseId: replacement.indexes?.response,
      linkText: WORDING.seeRevision,
    })
    const partial = snap.transcript.attempts[indexes?.attemptIds[0] ?? '']
    expect(partial).toMatchObject({ state: 'superseded', collapsed: true, markText: WORDING.supersededPartial, text: 'Indexes are' })
    // Finished: stays, marked superseded, linked.
    const joins = snap.transcript.sections[old('joins')]
    expect(joins?.superseded?.markText).toBe(WORDING.supersededFinished)
    expect(snap.transcript.attempts[joins?.attemptIds[0] ?? '']?.resultStatus).toBe('superseded')
    // A superseded section keeps "Reply to this"; the reply resolves to the replacement (T3).
    expect(joins?.actions.reply).toBe(true)
    // Replacements are new responses (P11), and A′ after a finished A sees A and the correction (06).
    expect(snap.transcript.responses[replacement.joins?.response ?? '']?.reason).toBe('revision-replacement')
    const joinsAgain = assembleContext(folded, s.id('joins'), replacement.joins?.node as NodeId, [])
    expect(joinsAgain.messages.slice(1).map((m) => [m.role, m.content])).toEqual([
      ['user', 'Explain joins'],
      ['assistant', 'Joins combine rows.'],
      ['user', 'Correction: Make it for beginners'],
    ])
    // A replacement of running work starts clean: no partial text (invariant 7).
    const indexesAgain = assembleContext(folded, s.id('indexes'), replacement.indexes?.node as NodeId, [])
    expect(indexesAgain.messages.some((m) => m.content.includes('Indexes are'))).toBe(false)
    expect(indexesAgain.messages.at(-1)?.content).toBe('Correction: Make it for beginners')
  })

  test('stop · work between automatic retries becomes stopped and its retry never fires', async () => {
    const retrying: CoreModule = {
      name: 'test-retry',
      retryPlanner: (_state, _id, cause, now) =>
        cause.kind === 'failed' && cause.error.class === 'transient'
          ? { kind: 'scheduled', at: now + 1_000, wait: 'backoff', retryNumber: 1 }
          : { kind: 'none', reason: 'non-retryable' },
    }
    const s = await scenario({ extraModules: [retrying] })
    await s.ask('Explain caching', { label: 'caching' }, [say(20, 'Caching is'), fail(50, 'bad-gateway')])
    await s.t.advance(100)
    expect(s.d('caching').state).toBe('retrying')
    let section = await s.section('caching')
    expect(section.status?.text).toBe(WORDING.retrying)
    expect(section.actions.stop).toBe(true)
    await s.t.send({ type: 'stop', conversationId: s.c, target: { kind: 'section', sectionId: section.id } })
    expect(s.d('caching').state).toBe('stopped')
    const events = await s.events()
    expect(events.filter((e) => e.type === 'directive-stopped')).toHaveLength(1)
    await s.t.advance(5_000)
    expect(s.d('caching').attemptIds).toHaveLength(1)
    expect(s.t.model.requests.filter((r) => r.messages.at(-1)?.content === 'Explain caching')).toHaveLength(1)
    section = await s.section('caching')
    expect(section.state).toBe('stopped')
    expect(section.actions.retry).toBe(true)
    // The attempt keeps its own terminal state (invariant 3).
    expect(s.state().attempts[s.d('caching').attemptIds[0] ?? '']?.state).toBe('failed')
  })

  test('stop · a single section that has not started is cancelled', async () => {
    const s = await scenario()
    await s.ask('Recommend a neighborhood', { label: 'neighborhoods' }, answer('Gion.', 100, 1_000))
    await s.ask('Expand it', { label: 'expansion', placement: s.on('neighborhoods'), prerequisites: [s.needs('neighborhoods')] })
    const sectionId = s.d('expansion').sectionId as SectionId
    expect((await s.section('expansion')).actions.stop).toBe(false)
    const result = await s.t.send({ type: 'stop', conversationId: s.c, target: { kind: 'section', sectionId } })
    expect(result.ok).toBe(true)
    expect(s.d('expansion').state).toBe('cancelled')
    expect(s.d('neighborhoods').state).toBe('running')
    const cancelled = (await s.events()).find((e) => e.type === 'directive-cancelled')
    expect(cancelled?.type === 'directive-cancelled' && cancelled.cause).toBe('section-stopped')
    const section = await s.section('expansion')
    expect(section.state).toBe('cancelled')
    expect(section.placement).toBe('fixed')
    expect((await s.snap()).queue.items).toEqual([])
    await s.t.advance(1_100)
    expect(s.d('expansion').attemptIds).toHaveLength(0)
  })

  test('routing · pending status is on the provisional response from submission, never on the message', async () => {
    const s = await scenario()
    let release!: () => void
    s.t.router.gate = new Promise((resolve) => {
      release = resolve
    })
    s.t.router.when('Hello there', () => ({ kind: 'failed', error: providerError('service-unavailable', 'Decisions are down') }))
    const sent = await s.t.backend.send({ type: 'submit-message', conversationId: s.c, text: 'Hello there' })
    await s.t.flush()
    const messageId = sent.ok ? sent.output.messageId : ('' as MessageId)
    let snap = await s.snap()
    const message = snap.transcript.messages[messageId]
    expect(snap.transcript.order).toEqual([
      { kind: 'message', id: messageId },
      { kind: 'response', id: message?.responseIds[0] },
    ])
    const provisional = snap.transcript.responses[message?.responseIds[0] ?? '']
    expect(provisional?.routing).toEqual({ state: 'routing', text: WORDING.routing, failure: null })
    expect(provisional?.sectionIds).toEqual([])
    expect(provisional?.placement).toBe('pending')
    expect(Object.keys(message ?? {}).sort()).toEqual(
      ['actions', 'chainIds', 'decomposition', 'id', 'kind', 'replyingTo', 'responseIds', 'routing', 'split', 'submittedAt', 'text'].sort(),
    )
    release()
    s.t.router.gate = null
    await s.t.settle()
    snap = await s.snap()
    const failed = snap.transcript.responses[message?.responseIds[0] ?? '']
    expect(failed?.routing?.state).toBe('failed')
    expect(failed?.routing?.text).toBe(`${WORDING.routingFailed}: Decisions are down`)
    expect(failed?.placement).toBe('pending')
    expect(snap.transcript.messages[messageId]?.actions.retry).toBe(true)
    // Retry on the request routes again; the bubble shows the routing status again, then the answer.
    s.t.router.when('Hello there', (input) => atomic(input, { label: 'greeting' }))
    await s.t.send({ type: 'retry', conversationId: s.c, target: { kind: 'request', messageId } })
    expect((await s.events()).some((e) => e.type === 'routing-retried')).toBe(true)
    snap = await s.snap()
    const routed = snap.transcript.responses[message?.responseIds[0] ?? '']
    expect(routed?.routing).toBeNull()
    expect(routed?.sectionIds).toHaveLength(1)
  })

  test('start · a message whose routing was lost is routed again', async () => {
    const s = await scenario()
    s.t.router.gate = new Promise(() => {})
    const sent = await s.t.backend.send({ type: 'submit-message', conversationId: s.c, text: 'Explain monads' })
    await s.t.flush()
    const messageId = sent.ok ? sent.output.messageId : ('' as MessageId)
    expect(s.state().messages[messageId]?.routing).toBe('routing')
    const routedBefore = s.t.router.inputs.length
    s.t.router.gate = null
    s.t.router.when('Explain monads', (input) => atomic(input, { label: 'monads' }))
    const next = await s.t.restart()
    const state = next.state(s.c)
    expect(next.router.inputs.length).toBe(routedBefore + 1)
    expect(state.messages[messageId]?.routing).toBe('routed')
    expect(state.directiveOrder).toHaveLength(1)
    // Nothing was recorded for the lost routing, so nothing is repeated.
    const result = await next.backend.snapshot({ kind: 'events', conversationId: s.c, afterSeq: 0 })
    const events = result.ok ? result.value.events : []
    expect(events.filter((e) => e.type === 'message-submitted')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'routing-decided')).toHaveLength(1)
  })

  test('stream · attempt-started is framed without the model input and stored with it', async () => {
    const s = await scenario()
    await s.ask('Explain caching', { label: 'caching' }, answer('Caching keeps copies.', 10, 20))
    await s.t.advance(50)
    const framed = s.t.frames
      .filter((f): f is ConversationFrame => f.kind === 'conversation')
      .flatMap((f) => f.events)
      .find((e) => e.type === 'attempt-started')
    expect(framed).toBeDefined()
    expect(framed && 'messages' in framed.context).toBe(false)
    expect(framed?.type === 'attempt-started' && framed.context.inputs).toEqual([])
    const stored = (await s.events()).find((e) => e.type === 'attempt-started')
    expect(stored?.type === 'attempt-started' && stored.context.messages.at(-1)?.content).toBe('Explain caching')
    expect(stored?.type === 'attempt-started' && stored.context.messages[0]?.origin).toEqual({ kind: 'preamble' })
  })
})

describe('engine lifecycle', () => {
  test('start · an attempt lost with its executor is recorded interrupted, and offers Retry under the default planner', async () => {
    const s = await scenario()
    await s.ask('Explain caching', { label: 'caching' }, [say(20, 'Caching is')])
    await s.t.advance(50)
    expect(s.d('caching').state).toBe('running')
    const next = await s.t.restart()
    const state = next.state(s.c)
    const d = Object.values(state.directives)[0]
    expect(d?.state).toBe('interrupted')
    expect(state.attempts[d?.attemptIds[0] ?? '']?.state).toBe('interrupted')
    const snap = await next.snapshot(s.c)
    const section = snap.transcript.sections[d?.sectionId ?? '']
    expect(section?.state).toBe('interrupted')
    expect(section?.actions.retry).toBe(true)
    expect(snap.transcript.attempts[d?.attemptIds[0] ?? '']).toMatchObject({ markText: WORDING.interrupted, text: 'Caching is' })
  })

  test('start · under a planner that retries, an interrupted attempt retries automatically with rewound context', async () => {
    const retrying: CoreModule = {
      name: 'test-retry',
      retryPlanner: (_state, _id, cause, now) =>
        cause.kind === 'interrupted' ? { kind: 'scheduled', at: now + 500, wait: 'backoff', retryNumber: 1 } : { kind: 'none', reason: 'manual-policy' },
    }
    const s = await scenario({ extraModules: [retrying] })
    await s.ask('Explain caching', { label: 'caching' }, [say(20, 'Caching is')])
    await s.t.advance(50)
    s.t.model.script('Explain caching', answer('Caching keeps copies.', 10, 20))
    const next = await s.t.restart()
    expect(Object.values(next.state(s.c).directives)[0]?.state).toBe('retrying')
    await next.advance(600)
    const d = Object.values(next.state(s.c).directives)[0]
    expect(d?.state).toBe('completed')
    const second = next.state(s.c).attempts[d?.attemptIds[1] ?? '']
    expect(second?.origin).toBe('interruption-recovery')
    expect(second?.sectionId).toBe(d?.sectionId)
    expect(second?.context.messages.some((m) => m.content.includes('Caching is'))).toBe(false)
  })

  test('capacity · a rate-limited directive shows "Waiting for capacity", never a dependency wait, and resumes in the same section', async () => {
    const rateLimited: CoreModule = {
      name: 'test-rate-limit',
      retryPlanner: (_state, _id, cause, now) =>
        cause.kind === 'failed' && cause.error.code === 'rate-limited'
          ? { kind: 'scheduled', at: now + (cause.error.retryAfterMs ?? 1_000), wait: 'rate-limit', retryNumber: 1 }
          : { kind: 'none', reason: 'non-retryable' },
    }
    const s = await scenario({ extraModules: [rateLimited] })
    s.t.model.next([{ afterMs: 10, event: { type: 'failed', error: providerError('rate-limited', 'Too many requests', { httpStatus: 429, retryAfterMs: 2_000 }) } }])
    s.t.model.next(answer('Done.', 10, 20))
    await s.ask('Explain caching', { label: 'caching' })
    await s.t.advance(100)
    expect(s.d('caching').state).toBe('waiting-for-capacity')
    const section = await s.section('caching')
    expect(section.status).toEqual({ kind: 'waiting-for-capacity', text: WORDING.waitingForCapacity })
    expect(section.placement).toBe('pending')
    const snap = await s.snap()
    expect(snap.queue.items).toEqual([])
    expect(snap.operationGraph.operations[section.operationId]?.status).toBe('waiting-for-capacity')
    await s.t.advance(2_100)
    expect(s.d('caching').state).toBe('completed')
    expect(s.d('caching').sectionIds).toHaveLength(1)
    expect(s.state().attempts[s.d('caching').attemptIds[1] ?? '']?.origin).toBe('automatic-retry')
  })

  test('backend · createBackend refuses to build without a router or a module that makes one', async () => {
    const { createEngine } = await import('../../../src/engine/backend')
    const t = s0()
    expect(() => createEngine({ ...t, router: undefined } as never, {}, [])).toThrow(/router/)
  })

  test('chunks · the first text is stored at once, then grouped by size or delay, and flushed before the terminal event', async () => {
    const s = await scenario({ options: { outputChunk: { maxChars: 10, maxDelayMs: 80 } } })
    await s.ask('Count', { label: 'count' }, [say(10, 'one'), say(20, ' two'), say(30, ' three four five'), say(40, ' six'), say(200, ' seven'), say(210, ' eight'), done(220)])
    await s.t.advance(300)
    const outputs = (await s.events()).filter((e) => e.type === 'attempt-output').map((e) => (e.type === 'attempt-output' ? [e.index, e.text] : []))
    expect(outputs).toEqual([
      [0, 'one'],
      [1, ' two three four five'],
      [2, ' six'],
      [3, ' seven eight'],
    ])
    const events = await s.events()
    const lastOutput = events.filter((e) => e.type === 'attempt-output').at(-1)?.seq ?? 0
    expect(events.find((e) => e.type === 'attempt-completed')?.seq).toBeGreaterThan(lastOutput)
    expect(s.state().attemptText[s.d('count').attemptIds[0] ?? '']).toBe('one two three four five six seven eight')
  })

  test('scheduling · the concurrency limit holds ready work as "Waiting for a free slot" and starts it in submission order', async () => {
    const s = await scenario({ settings: { concurrencyLimit: 1 } })
    await s.ask('First', { label: 'first' }, answer('1', 10, 100))
    await s.ask('Second', { label: 'second' }, answer('2', 10, 100))
    await s.ask('Third', { label: 'third' }, answer('3', 10, 100))
    expect(s.d('first').state).toBe('running')
    expect(s.d('second').state).toBe('ready')
    const second = await s.section('second')
    expect(second.status).toEqual({ kind: 'waiting-for-slot', text: WORDING.waitingForSlot })
    expect((await s.snap()).queue.items).toEqual([])
    await s.t.advance(150)
    expect(s.d('second').state).toBe('running')
    expect(s.d('third').state).toBe('ready')
    await s.t.advance(500)
    const starts = (await s.events()).filter((e) => e.type === 'attempt-started').map((e) => e.type === 'attempt-started' && e.directiveId)
    expect(starts).toEqual([s.id('first'), s.id('second'), s.id('third')])
  })

  test('context · tokens are counted before each run; near the limit a note, over it a non-retryable failure', async () => {
    const s = await scenario()
    s.t.model.setTokenCount((request) => ({
      inputTokens: request.messages.at(-1)?.content === 'Big' ? 1_200 : 850,
      contextLimit: 1_000,
      exact: true,
    }))
    await s.ask('Near', { label: 'near' }, answer('ok', 10, 20))
    await s.ask('Big', { label: 'big' })
    await s.t.advance(50)
    const near = await s.section('near')
    expect(near.notes.map((n) => n.kind)).toEqual(['context-near-limit'])
    expect(s.d('big').state).toBe('failed')
    const big = await s.section('big')
    expect(big.failure?.code).toBe('context-length-exceeded')
    expect(big.failure?.class).toBe('non-retryable')
    expect(s.t.model.requestsFor('Big')).toHaveLength(0)
  })

  test('context · an estimate over the limit warns and runs; only an exact count fails a run before it starts', async () => {
    const s = await scenario()
    s.t.model.setTokenCount(() => ({ inputTokens: 1_100, contextLimit: 1_000, exact: false }))
    await s.ask('Estimated big', { label: 'estimated' }, answer('fits after all', 10, 20))
    await s.t.advance(50)
    expect(s.d('estimated').state).toBe('completed')
    expect(s.t.model.requestsFor('Estimated big')).toHaveLength(1)
    expect((await s.section('estimated')).notes.map((n) => n.kind)).toEqual(['context-near-limit'])
  })

  test('labels · a provisional label is replaced by the decomposer\'s, without taking a slot', async () => {
    const s = await scenario({ settings: { concurrencyLimit: 1 } })
    s.t.decomposer.labelWith((text) => ({ ok: true, label: text.includes('neighborhood') ? 'neighborhoods' : 'other' }))
    s.t.router.when('Which neighborhood should we stay in for five days?', (input) => atomic(input, {}))
    await s.t.submit(s.c, 'Which neighborhood should we stay in for five days?')
    const d = Object.values(s.state().directives)[0]
    expect(d?.label).toBe('neighborhoods')
    expect(s.t.decomposer.labelRequests).toHaveLength(1)
    expect((await s.events()).some((e) => e.type === 'directive-labeled')).toBe(true)
  })

  test('session requirements · the ones in force are sent, in order, and a replaced one is not', async () => {
    const s = await scenario()
    const requirement = (id: string, text: string, messageId: MessageId) => ({
      id: id as never,
      text,
      scope: 'session-wide' as const,
      shared: false,
      provenance: { messageId, span: null },
    })
    s.t.router.when('From now on answer in French', (input) =>
      atomic(input, { label: 'french' }, { sessionRequirements: [{ requirement: requirement('req_fr', 'Answer in French', input.messageId), replacesRequirementId: null }] }),
    )
    await s.t.submit(s.c, 'From now on answer in French')
    s.t.router.when('Actually, from now on answer in Spanish', (input) =>
      atomic(input, { label: 'spanish' }, { sessionRequirements: [{ requirement: requirement('req_es', 'Answer in Spanish', input.messageId), replacesRequirementId: 'req_fr' as never }] }),
    )
    await s.t.submit(s.c, 'Actually, from now on answer in Spanish')
    await s.t.advance(50)
    const [first, second] = s.id('french') && [s.d('french'), s.d('spanish')]
    const ctx = (d: typeof first) => s.state().attempts[d?.attemptIds[0] ?? '']?.context
    expect(ctx(first)?.sessionRequirementIds).toEqual(['req_fr'])
    expect(ctx(second)?.sessionRequirementIds).toEqual(['req_es'])
    expect(ctx(second)?.messages.some((m) => m.content.includes('French'))).toBe(false)
  })

  test('retry · a request retries only its unfinished sections, in the same bubbles', async () => {
    const s = await scenario()
    const text = 'Explain caching, and separately explain indexes.'
    s.t.model.script('Explain caching', answer('Caching.', 10, 20))
    s.t.model.script('explain indexes', [say(10, 'Indexes'), fail(20, 'invalid-request')])
    s.t.router.when(text, (input) =>
      independent(input, [
        { label: 'caching', spans: spanOf(text, 'Explain caching') },
        { label: 'indexes', spans: spanOf(text, 'explain indexes') },
      ]),
    )
    const messageId = await s.t.submit(s.c, text)
    await s.t.advance(50)
    let snap = await s.snap()
    const group = Object.values(snap.transcript.responses)[0]
    expect(group?.header?.countText).toBe('1 done · 1 failed')
    s.t.model.script('explain indexes', answer('Indexes help lookups.', 10, 20))
    await s.t.send({ type: 'retry', conversationId: s.c, target: { kind: 'request', messageId } })
    await s.t.advance(50)
    expect(s.d('caching').attemptIds).toHaveLength(1)
    expect(s.d('indexes').attemptIds).toHaveLength(2)
    snap = await s.snap()
    const indexes = snap.transcript.sections[s.d('indexes').sectionId ?? '']
    expect(indexes?.state).toBe('completed')
    expect(indexes?.attemptIds).toHaveLength(2)
    expect(snap.transcript.attempts[indexes?.attemptIds[0] ?? '']).toMatchObject({ collapsed: true, markText: WORDING.failed, text: 'Indexes' })
    expect(snap.transcript.attempts[indexes?.attemptIds[1] ?? '']?.origin).toBe('user-retry')
    expect(snap.transcript.responses[group?.id ?? '']?.header?.countText).toBeNull()
  })

  test('late retry · a member retried after its group closed runs as a child of the join-back on the base chain, and the record keeps its marker', async () => {
    const s = await tripWithA(answer('Gion.', 100, 300))
    await s.ask('Suggest rainy-day activities', { label: 'activities', placement: s.onHeadOf('brief') }, [say(10, 'Mus'), fail(50, 'invalid-request')])
    await s.t.advance(400)
    const group = Object.values(s.state().groups)[0]
    expect(group?.state).toBe('closed')
    const joinBack = s.state().joinBacks[group?.joinBackIds[0] ?? '']
    expect(joinBack?.members.map((m) => m.outcome)).toEqual(['completed', 'failed'])
    s.t.model.script('Suggest rainy-day activities', answer('Museums.', 10, 20))
    await s.t.send({ type: 'retry', conversationId: s.c, target: { kind: 'section', sectionId: s.d('activities').sectionId as SectionId } })
    const late = s.state().nodes[s.d('activities').nodeId]
    expect(late?.reason).toBe('retry-after-closure')
    expect(late?.chainId).toBe(group?.baseChainId)
    expect(late?.plannedParents).toEqual([{ kind: 'node', nodeId: joinBack?.nodeId }])
    await s.t.advance(50)
    expect(s.d('activities').state).toBe('completed')
    // The retry read the record with the marker, never the partial text.
    const retry = s.state().attempts[s.d('activities').attemptIds[1] ?? '']
    expect(retry?.context.inputs).toContainEqual({ directiveId: s.id('activities'), attemptId: null, marker: 'failed' })
    expect(retry?.context.messages.some((m) => m.content === 'Mus')).toBe(false)
    // Work placed on the group later reads the record, then the retry's exchange; the join-back is not re-formed.
    await s.ask('Use those to plan a day', { label: 'plan', placement: s.onGroupOf('neighborhoods') })
    await s.t.advance(50)
    const plan = s.state().attempts[s.d('plan').attemptIds[0] ?? '']
    expect(plan?.context.inputs.map((i) => [i.directiveId, i.marker])).toEqual([
      [s.id('brief'), null],
      [s.id('neighborhoods'), null],
      [s.id('activities'), null],
    ])
    const contents = plan?.context.messages.map((m) => m.content) ?? []
    expect(contents.indexOf('[No answer: this request failed before completing.]')).toBeLessThan(contents.indexOf('Museums.'))
    expect(Object.values(s.state().groups)[0]?.joinBackIds).toHaveLength(1)
    const snap = await s.snap()
    const node = snap.genealogy.nodes[joinBack?.nodeId ?? '']
    expect(node?.kind === 'join-back' && node.lateRetryNodeIds).toEqual([s.d('activities').nodeId])
    await expectRebuildable(s)
  })

  test('late retry · rails: the retry is handled on the base chain in its color; the failed attempt, the message and Focus keep the fork it ran on', async () => {
    const s = await tripWithA(answer('Gion.', 100, 300))
    await s.ask('Suggest rainy-day activities', { label: 'activities', placement: s.onHeadOf('brief') }, [say(10, 'Mus'), fail(50, 'invalid-request')])
    await s.t.advance(400)
    const group = Object.values(s.state().groups)[0]
    expect(group?.state).toBe('closed')
    const forkChainId = s.d('activities').chainId
    const baseChainId = group?.baseChainId
    expect(forkChainId).not.toBe(baseChainId)
    const before = await s.snap()
    const colors = Object.fromEntries(before.genealogy.chainIds.map((id) => [id, before.genealogy.chains[id]?.colorIndex]))
    expect((await s.section('activities')).chainId).toBe(forkChainId)

    s.t.model.script('Suggest rainy-day activities', answer('Museums.', 10, 20))
    await s.t.send({ type: 'retry', conversationId: s.c, target: { kind: 'section', sectionId: s.d('activities').sectionId as SectionId } })
    await s.t.advance(50)
    expect(s.d('activities').state).toBe('completed')
    const snap = await s.snap()
    const view = await s.section('activities')
    // The retry continues from the join-back: the base chain's color (01 · "Chain colors", Q78), on its node's chain (Q92).
    expect(view.chainId).toBe(baseChainId)
    const [failed, retried] = view.attemptIds.map((id) => snap.transcript.attempts[id])
    expect(failed?.chainId).toBe(forkChainId)
    expect(retried?.chainId).toBe(baseChainId)
    // The message's rail shows both chains its runs were handled on, the fork first, as separate marks.
    expect(snap.transcript.messages[view.messageId]?.chainIds).toEqual([forkChainId, baseChainId])
    // Focus on the fork still owns the message whose first run it handled; no chain changed color.
    expect(snap.transcript.chains[forkChainId]?.focus.own.messageIds).toContain(view.messageId)
    expect(Object.fromEntries(snap.genealogy.chainIds.map((id) => [id, snap.genealogy.chains[id]?.colorIndex]))).toMatchObject(colors)
    await expectRebuildable(s)
  })

  test('app · conversations are created, titled, listed and deleted; the key reaches only the secrets store', async () => {
    const s = await scenario({ key: false })
    let app = await s.t.backend.snapshot({ kind: 'app' })
    expect(app.ok && app.value.key.configured).toBe(false)
    await s.t.send({ type: 'change-settings', changes: { concurrencyLimit: 2 } })
    await s.t.secretsStore.set('openrouter-key', 'sk-or-secret-123')
    await s.t.backend.refreshKeyStatus()
    app = await s.t.backend.snapshot({ kind: 'app' })
    expect(app.ok && app.value.key.configured).toBe(true)
    expect(app.ok && app.value.settings.concurrencyLimit).toBe(2)
    expect(await s.t.secretsStore.get('openrouter-key')).toBe('sk-or-secret-123')
    const appLog = JSON.stringify(await s.t.eventStore.read('app'))
    expect(appLog).not.toContain('sk-or-secret-123')
    expect(JSON.stringify(s.t.frames)).not.toContain('sk-or-secret-123')
    await s.ask('Plan a trip to Kyoto', { label: 'trip' })
    const listed = await s.t.send({ type: 'list-conversations' })
    expect(listed.ok && listed.output.conversations.map((c) => c.title)).toEqual(['Plan a trip to Kyoto'])
    const invalid = await s.t.send({ type: 'change-settings', changes: { concurrencyLimit: 0 } })
    expect(invalid.ok).toBe(false)
    await s.t.send({ type: 'delete-conversation', conversationId: s.c })
    expect(s.t.internals.state(s.c)).toBeNull()
    expect(await s.t.eventStore.lastSeq(s.c)).toBe(0)
    const missing = await s.t.send({ type: 'submit-message', conversationId: s.c, text: 'hi' })
    expect(!missing.ok && missing.error.code).toBe('unknown-conversation')
  })

  test('cache · a restart loads the projection cache and folds only the events after it', async () => {
    const s = await scenario({ options: { cacheEveryEvents: 5 } })
    await s.ask('Explain caching', { label: 'caching' }, answer('Caching.', 10, 20))
    await s.ask('Explain indexes', { label: 'indexes' }, answer('Indexes.', 10, 20))
    await s.t.advance(50)
    const before = await s.snap()
    expect(s.t.projectionCache.saves).toBeGreaterThan(0)
    const next = await s.t.restart()
    expect(await next.snapshot(s.c)).toEqual(before)
    const result = await next.backend.snapshot({ kind: 'events', conversationId: s.c, afterSeq: 0 })
    const events = result.ok ? result.value.events : []
    expect(fold(emptyConversationState(s.c), events)).toEqual(next.state(s.c))
  })

  test('commands · unknown targets and empty messages are refused without recording anything', async () => {
    const s = await scenario()
    const empty = await s.t.send({ type: 'submit-message', conversationId: s.c, text: '   ' })
    expect(!empty.ok && empty.error.code).toBe('invalid')
    const unknown = await s.t.send({ type: 'stop', conversationId: s.c, target: { kind: 'section', sectionId: 'sec_nope' as SectionId } })
    expect(!unknown.ok && unknown.error.code).toBe('unknown-target')
    const unhandled = await s.t.send({ type: 'regenerate', conversationId: s.c, sectionId: 'sec_nope' as SectionId })
    expect(unhandled.ok).toBe(false)
    expect(await s.events()).toEqual([])
    void ({} as DirectiveId)
  })
})

function s0() {
  return { modelProvider: {}, preparer: {}, decisionProvider: {}, decomposer: {}, eventStore: {}, projectionCache: {}, secretsStore: {}, clock: {}, timers: {}, ids: {} }
}

function done(afterMs: number) {
  return { afterMs, event: { type: 'completed' as const, finishReason: 'stop' as const, usage: null } }
}

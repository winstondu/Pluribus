import { describe, expect, test } from 'vitest'
import type { AttemptStarted, ConversationEvent, DirectiveId, ElicitationId } from '@committee/protocol'
import { answer, atomic, fail, independent, spanOf } from '../../testing'
import type { CoreModule } from '../module'
import { clone, expectRebuildable, scenario, seqOf, type Scenario } from './helpers'

/**
 * C1–C20 (04 · "Chains, dependencies, and context"), on the running example:
 * the trip brief, then A (neighborhoods) and B (rainy-day activities) sent
 * while the trip chain is busy, so they are forks of one sibling group.
 */

const BRIEF = 'Trip brief: Kyoto, five days, November, moderate budget'
const A = 'Suggest neighborhoods to stay in'
const B = 'Suggest rainy-day activities'

async function trip(scriptA = answer('Stay in Gion or Higashiyama.', 100, 1_000), scriptB = answer('Museums and tea houses.', 50, 200)): Promise<Scenario> {
  const s = await scenario()
  await s.ask(BRIEF, { label: 'brief' }, answer('Noted: Kyoto, five days.', 10, 20))
  await s.t.advance(50)
  await s.ask(A, { label: 'neighborhoods', placement: s.on('brief') }, scriptA)
  await s.ask(B, { label: 'activities', placement: s.onHeadOf('brief') }, scriptB)
  return s
}

const started = (events: readonly ConversationEvent[], directiveId: string): AttemptStarted[] =>
  events.filter((e): e is AttemptStarted => e.type === 'attempt-started' && e.directiveId === directiveId)

describe('chains, dependencies and context', () => {
  test('C1 · with available capacity, B can execute before A completes', async () => {
    const s = await trip()
    expect(s.d('neighborhoods').state).toBe('running')
    expect(s.d('activities').state).toBe('running')
    await s.t.advance(300)
    expect(s.d('activities').state).toBe('completed')
    expect(s.d('neighborhoods').state).toBe('running')
    await expectRebuildable(s)
  })

  test("C2 · if B needs A's result, B cannot emit its dependent answer before that result is available", async () => {
    const s = await trip()
    await s.ask('Expand the neighborhoods you are preparing', {
      label: 'expansion',
      placement: s.on('neighborhoods'),
      prerequisites: [s.needs('neighborhoods')],
    }, answer('Gion in depth.', 10, 30))
    expect(s.d('expansion').state).toBe('dependency-queued')
    await s.t.advance(500)
    expect(s.d('expansion').attemptIds).toHaveLength(0)
    await s.t.advance(1_000)
    const events = await s.events()
    const aDone = seqOf(events, (e) => e.type === 'attempt-completed' && e.attemptId === s.d('neighborhoods').resultAttemptId)
    const [run] = started(events, s.id('expansion'))
    expect(run).toBeDefined()
    expect(run?.seq).toBeGreaterThan(aDone)
    expect(run?.context.inputs).toContainEqual({ directiveId: s.id('neighborhoods'), attemptId: s.d('neighborhoods').resultAttemptId, marker: null })
    const firstText = seqOf(events, (e) => e.type === 'attempt-output' && e.attemptId === run?.attemptId)
    expect(firstText).toBeGreaterThan(aDone)
  })

  test("C3 · no view claims B consumed A's unfinished answer", async () => {
    const s = await trip()
    await s.t.advance(300)
    const a = s.d('neighborhoods')
    const b = s.d('activities')
    const bAttempt = s.state().attempts[b.attemptIds[0] ?? '']
    expect(bAttempt?.context.inputs.map((i) => i.directiveId)).not.toContain(a.id)
    expect(bAttempt?.context.nodeIds).not.toContain(a.nodeId)
    expect(bAttempt?.context.messages.some((m) => m.content.includes('Gion'))).toBe(false)
    const snap = await s.snap()
    const bNode = snap.genealogy.nodes[b.nodeId]
    expect(bNode?.kind === 'exchange' && bNode.parents).toEqual([s.d('brief').nodeId])
    const focus = snap.transcript.chains[b.chainId]?.focus
    expect(focus?.inherited.sectionIds).not.toContain(a.sectionId)
    expect(focus?.inherited.messageIds).not.toContain(a.messageId)
    const inspection = await s.t.backend.snapshot({ kind: 'run', conversationId: s.c, directiveId: b.id, attemptId: null })
    expect(inspection.ok && inspection.value.ancestry.map((n) => n.nodeId)).not.toContain(a.nodeId)
  })

  test('C4 · successful sibling exchanges become available through automatic join-back in request order, regardless of answer order', async () => {
    const s = await trip(answer('Stay in Gion.', 100, 600), answer('Museums.', 50, 200))
    await s.t.advance(700)
    const group = Object.values(s.state().groups)[0]
    expect(group?.state).toBe('closed')
    const record = s.state().joinBacks[group?.joinBackIds[0] ?? '']
    expect(record?.members.map((m) => m.directiveId)).toEqual([s.id('neighborhoods'), s.id('activities')])
    expect(record?.members.every((m) => m.outcome === 'completed')).toBe(true)
    // Read as if the model had answered A and then B.
    await s.ask('Use those recommendations to make a five-day itinerary', { label: 'itinerary', placement: s.onGroupOf('neighborhoods') })
    const run = started(await s.events(), s.id('itinerary'))[0]
    const contents = run?.context.messages.map((m) => m.content) ?? []
    const at = (text: string): number => contents.findIndex((c) => c.includes(text))
    expect(at(A)).toBeLessThan(at('Stay in Gion.'))
    expect(at('Stay in Gion.')).toBeLessThan(at(B))
    expect(at(B)).toBeLessThan(at('Museums.'))
  })

  test('C5 · join-back creates no synthesis call and no assistant answer', async () => {
    const s = await trip(answer('Gion.', 100, 400), answer('Museums.', 50, 200))
    await s.t.advance(300)
    const before = await s.snap()
    const requests = s.t.model.requests.length
    await s.t.advance(200)
    const after = await s.snap()
    const group = Object.values(s.state().groups)[0]
    expect(group?.state).toBe('closed')
    expect(s.t.model.requests.length).toBe(requests)
    expect(Object.keys(after.transcript.responses)).toEqual(Object.keys(before.transcript.responses))
    expect(Object.keys(after.transcript.sections)).toEqual(Object.keys(before.transcript.sections))
    const joinNode = after.genealogy.nodes[group?.joinBackIds[0] ? (s.state().joinBacks[group.joinBackIds[0]]?.nodeId ?? '') : '']
    expect(joinNode?.kind).toBe('join-back')
    const op = after.operationGraph.operations[group?.joinBackOperationId ?? '']
    expect(op?.kind).toBe('join-back')
    expect(op?.status).toBe('formed')
    expect((await s.events()).filter((e) => e.type === 'attempt-started')).toHaveLength(3)
  })

  test('C6 · C can start using B while A runs when C does not need A', async () => {
    const s = await trip(answer('Gion.', 100, 2_000), answer('Museums and tea houses.', 50, 200))
    await s.t.advance(300)
    await s.ask('Suggest indoor evening activities', { label: 'evening', placement: s.on('activities') }, answer('Jazz bars.', 10, 50))
    expect(s.d('evening').state).toBe('running')
    expect(s.d('neighborhoods').state).toBe('running')
    const run = started(await s.events(), s.id('evening'))[0]
    expect(run?.context.inputs.map((i) => i.directiveId)).toEqual([s.id('brief'), s.id('activities')])
    expect(run?.context.messages.some((m) => m.content === 'Museums and tea houses.')).toBe(true)
  })

  test("C7 · C's consumed context does not change when A later completes", async () => {
    const s = await trip(answer('Gion.', 100, 2_000), answer('Museums.', 50, 200))
    await s.t.advance(300)
    await s.ask('Suggest indoor evening activities', { label: 'evening', placement: s.on('activities') }, answer('Jazz bars.', 10, 50))
    const attemptId = s.d('evening').attemptIds[0] ?? ''
    const recorded = clone(s.state().attempts[attemptId]?.context)
    const inspected = await s.t.backend.snapshot({ kind: 'run', conversationId: s.c, directiveId: s.id('evening'), attemptId: null })
    await s.t.advance(2_500)
    expect(s.d('neighborhoods').state).toBe('completed')
    expect(Object.values(s.state().groups)[0]?.state).toBe('closed')
    expect(s.state().attempts[attemptId]?.context).toEqual(recorded)
    const later = await s.t.backend.snapshot({ kind: 'run', conversationId: s.c, directiveId: s.id('evening'), attemptId: null })
    expect(later.ok && later.value.input).toEqual(inspected.ok && inspected.value.input)
    const stored = started(await s.events(), s.id('evening'))[0]
    expect(stored?.context).toEqual(recorded)
  })

  test('C8 · an explicit branch from B remains available after join-back and does not automatically inherit A', async () => {
    const s = await trip(answer('Gion.', 100, 400), answer('Museums.', 50, 200))
    await s.t.advance(500)
    expect(Object.values(s.state().groups)[0]?.state).toBe('closed')
    await s.ask('Give me three cheaper alternatives', { label: 'cheaper', placement: s.on('activities') }, answer('Free shrines.', 10, 20))
    const chain = s.state().chains[s.d('cheaper').chainId]
    expect(chain?.kind).toBe('branch')
    expect(chain?.baseChainId).toBe(s.d('activities').chainId)
    await s.t.advance(50)
    const run = started(await s.events(), s.id('cheaper'))[0]
    expect(run?.context.inputs.map((i) => i.directiveId)).toEqual([s.id('brief'), s.id('activities')])
    expect(run?.context.nodeIds).not.toContain(s.d('neighborhoods').nodeId)
    expect(s.d('cheaper').state).toBe('completed')
  })

  test('C9 · a continuation requiring multiple siblings depends on their full join-back, never a subset', async () => {
    const s = await trip(answer('Gion.', 100, 300), answer('Museums.', 50, 200))
    await s.ask('Suggest day trips', { label: 'day trips', placement: s.onHeadOf('brief') }, answer('Nara.', 10, 2_000))
    // The router named two members; validation makes it the whole group.
    await s.ask('Compare the neighborhoods with the activities', {
      label: 'comparison',
      placement: s.onGroupOf('neighborhoods'),
      prerequisites: [s.needs('neighborhoods'), s.needs('activities')],
    })
    expect(s.d('comparison').prerequisites).toEqual([s.needsGroupOf('neighborhoods')])
    await s.t.advance(500)
    expect(s.d('neighborhoods').state).toBe('completed')
    expect(s.d('activities').state).toBe('completed')
    expect(s.d('comparison').state).toBe('dependency-queued')
    expect(s.d('comparison').attemptIds).toHaveLength(0)
    await s.t.advance(2_000)
    expect(s.d('comparison').attemptIds.length).toBeGreaterThan(0)
  })

  test('C10 · context inspection preserves the ancestry each historical run actually consumed', async () => {
    const s = await trip(answer('Gion.', 100, 400), answer('Museums.', 50, 200))
    await s.t.advance(300)
    await s.ask('Suggest indoor evening activities', { label: 'evening', placement: s.on('activities') }, answer('Jazz.', 10, 20))
    await s.t.advance(50)
    const inspect = async (label: string) => {
      const result = await s.t.backend.snapshot({ kind: 'run', conversationId: s.c, directiveId: s.id(label), attemptId: null })
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    }
    const evening = await inspect('evening')
    expect(evening.ancestry.map((n) => n.nodeId)).toEqual([s.d('brief').nodeId, s.d('activities').nodeId])
    await s.t.advance(500)
    await s.ask('Use those to make an itinerary', { label: 'itinerary', placement: s.onGroupOf('neighborhoods') })
    await s.t.advance(50)
    expect((await inspect('evening')).ancestry).toEqual(evening.ancestry)
    const itinerary = await inspect('itinerary')
    const joinNode = s.state().joinBacks[Object.values(s.state().groups)[0]?.joinBackIds[0] ?? '']?.nodeId
    expect(itinerary.ancestry.map((n) => n.nodeId)).toEqual([s.d('brief').nodeId, joinNode, s.d('neighborhoods').nodeId, s.d('activities').nodeId])
  })

  test('C11 · D from the same starting context joins an open A/B group; C consuming B does not', async () => {
    const s = await trip(answer('Gion.', 100, 2_000), answer('Museums.', 50, 200))
    await s.t.advance(300)
    await s.ask('Suggest day trips', { label: 'day trips', placement: s.onHeadOf('brief') }, answer('Nara.', 10, 3_000))
    await s.ask('Suggest indoor evening activities', { label: 'evening', placement: s.on('activities') }, answer('Jazz.', 10, 3_000))
    const group = Object.values(s.state().groups)[0]
    expect(group?.state).toBe('open')
    expect(group?.members.map((m) => m.directiveId)).toEqual([s.id('neighborhoods'), s.id('activities'), s.id('day trips')])
    expect(group?.members.map((m) => m.directiveId)).not.toContain(s.id('evening'))
    expect(s.state().chains[s.d('day trips').chainId]?.kind).toBe('fork')
    expect(s.state().chains[s.d('evening').chainId]?.kind).toBe('branch')
  })

  test('C12 · a closed group and its join-back cannot be enlarged by later branches', async () => {
    const s = await trip(answer('Gion.', 100, 400), answer('Museums.', 50, 200))
    await s.t.advance(500)
    const before = clone(Object.values(s.state().groups)[0])
    await s.ask('Suggest day trips', { label: 'day trips', placement: s.on('brief') }, answer('Nara.', 10, 1_000))
    await s.ask('Give me three cheaper alternatives', { label: 'cheaper', placement: s.on('activities') }, answer('Shrines.', 10, 1_000))
    const after = Object.values(s.state().groups)[0]
    expect(Object.values(s.state().groups)).toHaveLength(1)
    expect(after?.members).toEqual(before?.members)
    expect(after?.joinBackIds).toEqual(before?.joinBackIds)
    expect(after?.state).toBe('closed')
    expect(s.state().chains[s.d('day trips').chainId]?.kind).toBe('branch')
    expect(s.state().chains[s.d('cheaper').chainId]?.kind).toBe('branch')
    await s.t.advance(1_100)
    expect(Object.values(s.state().groups)[0]?.joinBackIds).toEqual(before?.joinBackIds)
  })

  test('C13 · visible partial source text does not release dependent answer work', async () => {
    const s = await trip(answer('Gion is lovely.', 100, 1_000))
    await s.ask('Expand the neighborhoods', { label: 'expansion', placement: s.on('neighborhoods'), prerequisites: [s.needs('neighborhoods')] })
    await s.t.advance(500)
    expect((await s.section('neighborhoods')).state).toBe('streaming')
    expect(s.d('expansion').state).toBe('dependency-queued')
    expect(s.d('expansion').attemptIds).toHaveLength(0)
    await s.t.advance(600)
    expect(s.d('expansion').attemptIds).toHaveLength(1)
  })

  test('C14 · a dependency on a single answer section proceeds when that section successfully finishes, without waiting for unrelated sections', async () => {
    const s = await scenario()
    const text = 'Translate this menu into French, and separately explain why the sky is blue.'
    s.t.model.script('Translate this menu', answer('Menu en français.', 20, 100))
    s.t.model.script('why the sky is blue', answer('Rayleigh scattering…', 20, 3_000))
    s.t.router.when(text, (input) =>
      independent(input, [
        { label: 'menu translation', spans: spanOf(text, 'Translate this menu into French') },
        { label: 'sky explanation', spans: spanOf(text, 'explain why the sky is blue') },
      ]),
    )
    await s.t.submit(s.c, text)
    const response = Object.values((await s.snap()).transcript.responses)[0]
    expect(response?.grouped).toBe(true)
    await s.t.advance(200)
    await s.ask('Make the translation shorter', {
      label: 'shorter',
      placement: s.on('menu translation'),
      prerequisites: [s.needs('menu translation')],
    }, answer('Menu.', 10, 20))
    expect(s.d('sky explanation').state).toBe('running')
    await s.t.advance(50)
    expect(s.d('shorter').state).toBe('completed')
    expect(s.d('sky explanation').state).toBe('running')
  })

  test('C15 · a full join-back dependency cannot proceed while its group remains open or unfinished', async () => {
    const s = await trip(answer('Gion.', 100, 300), answer('Museums.', 50, 900))
    await s.ask('Use those recommendations to make a five-day itinerary', { label: 'itinerary', placement: s.onGroupOf('neighborhoods') })
    await s.t.advance(400)
    expect(s.d('neighborhoods').state).toBe('completed')
    expect(Object.values(s.state().groups)[0]?.state).toBe('open')
    expect(s.d('itinerary').state).toBe('dependency-queued')
    await s.t.advance(600)
    expect(s.d('itinerary').attemptIds).toHaveLength(1)

    // Unfinished: a member that failed lets the group close, but the full join-back is not satisfied.
    const u = await trip(answer('Gion.', 100, 300), [fail(50, 'invalid-request')])
    await u.ask('Use those recommendations to make a five-day itinerary', { label: 'itinerary', placement: u.onGroupOf('neighborhoods') })
    await u.t.advance(1_000)
    expect(Object.values(u.state().groups)[0]?.state).toBe('closed')
    expect(u.d('activities').state).toBe('failed')
    expect(u.d('itinerary').state).toBe('dependency-queued')
    expect(u.d('itinerary').attemptIds).toHaveLength(0)
  })

  test('C16 · an additional sibling admitted to the open group extends the full join-back dependency; a descendant continuing one sibling does not', async () => {
    const s = await trip(answer('Gion.', 100, 300), answer('Museums.', 50, 200))
    await s.ask('Use those recommendations to make a five-day itinerary', { label: 'itinerary', placement: s.onGroupOf('neighborhoods') })
    await s.ask('Suggest day trips', { label: 'day trips', placement: s.onHeadOf('brief') }, answer('Nara.', 10, 800))
    await s.t.advance(250)
    await s.ask('Suggest indoor evening activities', { label: 'evening', placement: s.on('activities') }, answer('Jazz.', 10, 5_000))
    let item = (await s.snap()).queue.items.find((i) => i.directiveId === s.id('itinerary'))
    expect(item?.text).toBe('Waiting for neighborhoods + activities + day trips')
    await s.t.advance(200)
    expect(s.d('neighborhoods').state).toBe('completed')
    expect(s.d('itinerary').state).toBe('dependency-queued')
    await s.t.advance(500)
    expect(s.d('day trips').state).toBe('completed')
    expect(s.d('evening').state).toBe('running')
    expect(s.d('itinerary').attemptIds).toHaveLength(1)
    item = (await s.snap()).queue.items.find((i) => i.directiveId === s.id('itinerary'))
    expect(item).toBeUndefined()
  })

  test('C17 · J can reconcile recommendations within the established brief and explain the trade-off without changing source answers', async () => {
    const s = await trip(answer('Gion.', 100, 300), answer('Museums.', 50, 200))
    await s.t.advance(400)
    const sources = ['neighborhoods', 'activities'].map((label) => {
      const id = s.d(label).resultAttemptId ?? ''
      return { id, text: s.state().attemptText[id], section: s.d(label).sectionId }
    })
    await s.ask('Use those recommendations to make a five-day itinerary, and explain the trade-offs', { label: 'itinerary', placement: s.onGroupOf('neighborhoods') },
      answer('Day 1 Gion; rainy days at museums. Trade-off: …', 10, 50))
    await s.t.advance(100)
    const run = s.state().attempts[s.d('itinerary').attemptIds[0] ?? '']
    expect(run?.context.inputs.map((i) => i.directiveId)).toEqual([s.id('brief'), s.id('neighborhoods'), s.id('activities')])
    expect(s.d('itinerary').state).toBe('completed')
    const snap = await s.snap()
    for (const source of sources) {
      expect(s.state().attemptText[source.id]).toBe(source.text)
      expect(snap.transcript.attempts[source.id]?.resultStatus).toBe('current')
      expect(snap.transcript.sections[source.section ?? '']?.state).toBe('completed')
    }
  })

  test('C18 · a join chain preserves its source chains and the specific ancestry it consumed', async () => {
    const s = await trip(answer('Gion.', 100, 300), answer('Museums.', 50, 200))
    await s.t.advance(400)
    await s.ask('Use those recommendations to make an itinerary', { label: 'itinerary', placement: s.onGroupOf('neighborhoods') }, answer('Itinerary.', 10, 20))
    await s.ask('Why is the sky blue?', { label: 'sky' }, answer('Scattering.', 10, 20))
    await s.t.advance(50)
    await s.ask('Compare the itinerary with the sky explanation', {
      label: 'comparison',
      placement: { kind: 'join-chain', parents: [{ kind: 'node', nodeId: s.d('itinerary').nodeId }, { kind: 'node', nodeId: s.d('sky').nodeId }] },
    }, answer('Both are blue-ish.', 10, 500))
    const join = s.d('comparison')
    expect(s.state().chains[join.chainId]?.kind).toBe('join')
    const record = clone(s.state().attempts[join.attemptIds[0] ?? '']?.context)
    // The sources stay independently continuable.
    await s.ask('And why are sunsets red?', { label: 'sunsets', placement: s.on('sky') }, answer('Longer path.', 10, 20))
    expect(s.d('sunsets').chainId).toBe(s.d('sky').chainId)
    await s.t.advance(600)
    const snap = await s.snap()
    const node = snap.genealogy.nodes[join.nodeId]
    expect(node?.kind === 'exchange' && node.parents).toEqual([s.d('itinerary').nodeId, s.d('sky').nodeId])
    expect(s.state().attempts[join.attemptIds[0] ?? '']?.context).toEqual(record)
    expect(record?.inputs.map((i) => i.directiveId)).not.toContain(s.id('sunsets'))
    expect(record?.inputs.map((i) => i.directiveId)).toEqual([
      s.id('brief'),
      s.id('neighborhoods'),
      s.id('activities'),
      s.id('itinerary'),
      s.id('sky'),
    ])
  })

  test('C19 · J, continuing from the A/B join-back, is on the chain A and B forked from and creates no new chain', async () => {
    const s = await trip(answer('Gion.', 100, 300), answer('Museums.', 50, 200))
    await s.t.advance(400)
    const chains = s.state().chainOrder.length
    await s.ask('Use those recommendations to make an itinerary', { label: 'itinerary', placement: s.onGroupOf('neighborhoods') })
    const group = Object.values(s.state().groups)[0]
    expect(s.d('itinerary').chainId).toBe(group?.baseChainId)
    expect(s.d('itinerary').chainId).toBe(s.d('brief').chainId)
    expect(s.state().chainOrder).toHaveLength(chains)
    expect(s.d('itinerary').chainId).not.toBe(s.d('neighborhoods').chainId)
    const snap = await s.snap()
    expect(snap.transcript.chains[s.d('itinerary').chainId]?.colorIndex).toBe(snap.transcript.chains[s.d('brief').chainId]?.colorIndex)
  })

  test('C20 · a join chain can only be created from leaves of its source chains, and may combine two or more of them', async () => {
    const s = await trip(answer('Gion.', 100, 300), answer('Museums.', 50, 200))
    await s.t.advance(400)
    await s.ask('Why is the sky blue?', { label: 'sky' }, answer('Scattering.', 10, 20))
    await s.ask('What is a haiku?', { label: 'haiku' }, answer('A short poem.', 10, 20))
    await s.t.advance(50)
    // The router named the brief, a non-leaf: it becomes the trip chain's leaf.
    await s.ask('Write a haiku about a rainy blue-sky trip', {
      label: 'trip haiku',
      placement: {
        kind: 'join-chain',
        parents: [
          { kind: 'node', nodeId: s.d('brief').nodeId },
          { kind: 'node', nodeId: s.d('sky').nodeId },
          { kind: 'node', nodeId: s.d('haiku').nodeId },
        ],
      },
    })
    const tripLeaf = s.state().chains[s.d('brief').chainId]?.nodeIds.at(-1)
    const node = s.state().nodes[s.d('trip haiku').nodeId]
    expect(node?.plannedParents).toEqual([
      { kind: 'node', nodeId: tripLeaf },
      { kind: 'node', nodeId: s.d('sky').nodeId },
      { kind: 'node', nodeId: s.d('haiku').nodeId },
    ])
    expect(tripLeaf).not.toBe(s.d('brief').nodeId)
    expect(s.state().chains[s.d('trip haiku').chainId]?.kind).toBe('join')
    // One parent is not a join chain: refused, never guessed.
    await s.ask('Join the sky with itself', {
      label: 'self join',
      placement: { kind: 'join-chain', parents: [{ kind: 'node', nodeId: s.d('sky').nodeId }] },
    })
    const message = Object.values(s.state().messages).find((m) => m.text === 'Join the sky with itself')
    expect(message?.routing).toBe('failed')
    expect(message?.routingFailure?.code).toBe('malformed-response')
  })
})

const contents = (run: AttemptStarted | undefined): string[] => (run ? run.context.messages.map((m) => m.content) : [])

describe('chains, dependencies and context: the review cases', () => {
  test('C3 (engine) · a join chain over a leaf still running waits for it and never reads its unfinished answer', async () => {
    const s = await scenario()
    await s.ask('Plan a trip to Kyoto in detail', { label: 'plan' }, answer('Day 1 Gion…', 100, 5_000))
    await s.ask('Why is the sky blue?', { label: 'sky' }, answer('Scattering.', 10, 20))
    await s.t.advance(200)
    await s.ask('Compare the plan with the sky explanation', {
      label: 'K',
      placement: { kind: 'join-chain', parents: [{ kind: 'node', nodeId: s.d('plan').nodeId }, { kind: 'node', nodeId: s.d('sky').nodeId }] },
    }, answer('Compared.', 10, 20))
    await s.t.advance(50)
    const k = s.d('K')
    // Streaming text never releases it (C13): no attempt, so no record of the partial plan anywhere.
    expect(k.state).toBe('dependency-queued')
    expect(k.attemptIds).toHaveLength(0)
    let snap = await s.snap()
    expect(snap.transcript.chains[k.chainId]?.focus.inherited.sectionIds ?? []).not.toContain(s.d('plan').sectionId)
    await s.t.advance(5_000)
    expect(s.d('K').state).toBe('completed')
    const run = s.state().attempts[s.d('K').attemptIds[0] ?? '']
    expect(run?.context.inputs.map((i) => i.directiveId)).toEqual([s.id('plan'), s.id('sky')])
    expect(run?.context.messages.filter((m) => m.content === 'Day 1 Gion…')).toHaveLength(1)
    snap = await s.snap()
    expect(snap.transcript.chains[k.chainId]?.focus.inherited.sectionIds).toContain(s.d('plan').sectionId)
    await expectRebuildable(s)
  })

  test('C9 (engine) · a join chain over two members of one sibling group does not bypass the full join-back', async () => {
    const s = await trip(answer('Gion.', 100, 300), answer('Museums.', 50, 100))
    await s.ask('Suggest day trips', { label: 'day trips', placement: s.onHeadOf('brief') }, answer('Nara.', 10, 5_000))
    await s.t.advance(400)
    await s.ask('Compare the neighborhoods with the activities', {
      label: 'comparison',
      placement: {
        kind: 'join-chain',
        parents: [{ kind: 'node', nodeId: s.d('neighborhoods').nodeId }, { kind: 'node', nodeId: s.d('activities').nodeId }],
      },
    }, answer('Compared.', 10, 20))
    await s.t.advance(50)
    expect(s.d('day trips').state).toBe('running')
    expect(s.d('comparison').attemptIds).toHaveLength(0)
    expect(s.d('comparison').prerequisites).toEqual([s.needsGroupOf('neighborhoods')])
    // It continues the base chain from the join-back: no join chain.
    expect(s.d('comparison').chainId).toBe(s.d('brief').chainId)
    await s.t.advance(5_000)
    expect(s.d('comparison').state).toBe('completed')
    const run = s.state().attempts[s.d('comparison').attemptIds[0] ?? '']
    expect(run?.context.inputs.map((i) => i.directiveId)).toEqual([s.id('brief'), s.id('neighborhoods'), s.id('activities'), s.id('day trips')])
  })

  test('C20 (engine) · a join-chain parent is always the leaf: a leaf still in flight stays the parent and is waited for', async () => {
    const s = await scenario()
    await s.ask('Trip brief', { label: 'brief' }, answer('Noted.', 10, 20))
    await s.t.advance(50)
    await s.ask('Plan day one', { label: 'day one', placement: s.on('brief') }, answer('Day 1 Gion…', 100, 5_000))
    await s.ask('Why is the sky blue?', { label: 'sky' }, answer('Scattering.', 10, 20))
    await s.t.advance(200)
    // The router names the trip's settled head; the leaf of that chain is 'day one', still running.
    await s.ask('Compare the trip with the sky explanation', {
      label: 'K',
      placement: { kind: 'join-chain', parents: [{ kind: 'node', nodeId: s.d('brief').nodeId }, { kind: 'node', nodeId: s.d('sky').nodeId }] },
    }, answer('Compared.', 10, 20))
    await s.t.advance(50)
    const node = s.state().nodes[s.d('K').nodeId]
    expect(node?.plannedParents).toEqual([{ kind: 'node', nodeId: s.d('day one').nodeId }, { kind: 'node', nodeId: s.d('sky').nodeId }])
    expect(s.d('K').prerequisites).toEqual([s.needs('day one')])
    expect(s.d('K').attemptIds).toHaveLength(0)
    await s.t.advance(5_000)
    const run = s.state().attempts[s.d('K').attemptIds[0] ?? '']
    expect(run?.context.inputs.map((i) => i.directiveId)).toEqual([s.id('brief'), s.id('day one'), s.id('sky')])
  })

  test('acyclic · work that waits for an open group is never admitted to that group', async () => {
    const s = await scenario()
    await s.ask('Brief', { label: 'brief' }, answer('Ok.', 10, 20))
    await s.t.advance(30)
    await s.ask('Child A', { label: 'A', placement: s.on('brief') }, answer('A ok.', 10, 200))
    await s.ask('Child B', { label: 'B', placement: s.onHeadOf('brief') }, answer('B ok.', 10, 300))
    const group = Object.values(s.state().groups)[0]
    await s.ask('Make an itinerary from both', {
      label: 'J',
      placement: s.onHeadOf('brief'),
      prerequisites: [{ kind: 'sibling-group', groupId: group?.id as never }],
    }, answer('It.', 10, 20))
    await s.t.advance(2_000)
    const g = Object.values(s.state().groups)[0]
    expect(g?.members.map((m) => s.state().directives[m.directiveId]?.label)).not.toContain('J')
    expect(g?.state).toBe('closed')
    expect(s.d('J').state).toBe('completed')
    expect(s.d('J').chainId).toBe(s.d('brief').chainId)
  })

  test('acyclic · work that waits for one running sibling is its descendant, not a member', async () => {
    const s = await scenario()
    await s.ask('Brief', { label: 'brief' }, answer('Ok.', 10, 20))
    await s.t.advance(30)
    await s.ask('Child A', { label: 'A', placement: s.on('brief') }, answer('A ok.', 10, 200))
    await s.ask('Child B', { label: 'B', placement: s.onHeadOf('brief') }, answer('B ok.', 10, 300))
    await s.ask('Expand A', { label: 'C', placement: s.onHeadOf('brief'), prerequisites: [s.needs('A')] }, answer('More A.', 10, 20))
    const g = Object.values(s.state().groups)[0]
    expect(g?.members.map((m) => s.state().directives[m.directiveId]?.label)).toEqual(['A', 'B'])
    expect(s.state().nodes[s.d('C').nodeId]?.plannedParents).toEqual([{ kind: 'node', nodeId: s.d('A').nodeId }])
    await s.t.advance(2_000)
    expect(s.d('C').state).toBe('completed')
  })

  test('04 edge case · a later request needing both J and the B-only branch is a join chain whose parents are those two leaves, every node read once', async () => {
    const s = await trip(answer('Gion.', 100, 300), answer('Museums.', 50, 100))
    await s.t.advance(400)
    await s.ask('Make an itinerary', { label: 'J', placement: s.onGroupOf('neighborhoods') }, answer('Itinerary.', 10, 20))
    await s.ask('Give me three cheaper alternatives', { label: 'B2', placement: s.on('activities') }, answer('Free shrines.', 10, 20))
    await s.t.advance(50)
    await s.ask('Fit the cheaper alternatives into the itinerary', {
      label: 'K',
      placement: { kind: 'join-chain', parents: [{ kind: 'node', nodeId: s.d('J').nodeId }, { kind: 'node', nodeId: s.d('B2').nodeId }] },
    }, answer('Done.', 10, 20))
    await s.t.advance(50)
    expect(s.state().nodes[s.d('K').nodeId]?.startedParents).toEqual([s.d('J').nodeId, s.d('B2').nodeId])
    const run = started(await s.events(), s.id('K'))[0]
    expect(contents(run).filter((c) => c === B)).toHaveLength(1)
    expect(contents(run).filter((c) => c === 'Museums.')).toHaveLength(1)
    expect(run?.context.inputs.map((i) => i.directiveId)).toEqual([s.id('brief'), s.id('neighborhoods'), s.id('activities'), s.id('J'), s.id('B2')])
    // The other parent order reads the record once too.
    await s.ask('Fit the itinerary into the cheaper alternatives', {
      label: 'K2',
      placement: { kind: 'join-chain', parents: [{ kind: 'node', nodeId: s.d('B2').nodeId }, { kind: 'node', nodeId: s.d('J').nodeId }] },
    }, answer('Done.', 10, 20))
    await s.t.advance(50)
    const run2 = started(await s.events(), s.id('K2'))[0]
    expect(contents(run2).filter((c) => c === B)).toHaveLength(1)
    expect(new Set(run2?.context.inputs.map((i) => i.directiveId)).size).toBe(run2?.context.inputs.length)
  })

  test('Q60 · ready work runs in submission order even when a later message is routed first', async () => {
    const s = await scenario({ settings: { concurrencyLimit: 1 } })
    await s.ask('Hold the only slot', { label: 'X' }, answer('X.', 10, 1_000))
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    s.t.router.when('First submitted', async (input) => {
      await gate
      return atomic(input, { label: 'first' })
    })
    s.t.router.when('Second submitted', (input) => atomic(input, { label: 'second' }))
    await s.t.backend.send({ type: 'submit-message', conversationId: s.c, text: 'First submitted' })
    await s.t.flush()
    await s.t.backend.send({ type: 'submit-message', conversationId: s.c, text: 'Second submitted' })
    await s.t.flush()
    release()
    await s.t.settle()
    await s.t.advance(1_000)
    expect(s.d('first').state).toBe('running')
    expect(s.d('second').state).toBe('ready')
  })

  test('stop · a request stop cancels a directive held for a clarification that has no section yet', async () => {
    const holder: CoreModule = {
      name: 'test-clarify',
      planAppliers: [
        {
          parts: ['clarifications'],
          apply(_s, plan, _t, ctx) {
            for (const c of plan.clarifications) {
              const elicitationId = ctx.ids.next('elicitation') as ElicitationId
              for (const id of c.blockedDirectiveIds) ctx.emit({ type: 'directive-held', directiveId: id, elicitationId, reason: 'clarification' })
            }
          },
        },
      ],
    }
    const s = await scenario({ extraModules: [holder] })
    const text = 'Book a hotel, and plan a dinner'
    s.t.router.when(text, (input) =>
      independent(input, [{ label: 'hotel', spans: spanOf(text, 'Book a hotel') }, { label: 'dinner', spans: spanOf(text, 'plan a dinner') }], {
        clarifications: (units) => [
          { questionDirectiveId: input.ids.next('directive') as DirectiveId, reason: 'missing-information', about: 'which city', blockedDirectiveIds: [units[1]?.directiveId as DirectiveId] },
        ],
      }),
    )
    s.t.model.script('Book a hotel', answer('Booked.', 100, 5_000))
    const messageId = await s.t.submit(s.c, text)
    expect(s.d('dinner').sectionId).toBeNull()
    expect(s.d('dinner').state).toBe('awaiting-elicitation')
    await s.t.send({ type: 'stop', conversationId: s.c, target: { kind: 'request', messageId } })
    expect(s.d('hotel').state).toBe('stopped')
    expect(s.d('dinner').state).toBe('cancelled')
  })
})

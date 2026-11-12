import { describe, expect, test } from 'vitest'
import { WORDING, type ConversationSnapshot, type NodeId, type OperationId, type SectionId } from '@committee/protocol'
import { answer, fail, say } from '../../../testing'
import type { Scenario } from '../../../testing/acceptance/engine'
import { A_TEXT, B_TEXT, J_TEXT, recoveryScenario, revise, sectionOf, trip } from '../../../testing/acceptance/recovery'

/**
 * Findings of the fourth review that reach core: the ancestry of work
 * restarted after a member revision, operation-graph edges to the work a
 * dependent really waits for, inheritance-aware Focus, the reply action
 * and link text of superseded sections.
 */

const LUXURY = 'Actually, use a luxury budget for the neighborhood recommendations'

function opLabel(snap: ConversationSnapshot, id: OperationId): string {
  const op = snap.operationGraph.operations[id]
  return `${op?.label ?? '?'}:${op?.kind ?? '?'}`
}

function opOf(snap: ConversationSnapshot, s: Scenario, label: string): OperationId {
  return sectionOf(snap, s, label).operationId
}

describe('fourth review: work restarted after a member revision descends from the current join-back', () => {
  test('C10 · J continues the closed A/B join-back; A is revised while J runs; the restarted J runs on, and is drawn under, the new join-back', async () => {
    const s = await recoveryScenario()
    await trip(s, { a: answer('OLD-A', 50, 100), b: answer('Museums.', 50, 100), withJ: false })
    await s.t.advance(500)
    const group = Object.values(s.state().groups)[0]
    const first = group?.joinBackIds[0] ? s.state().joinBacks[group.joinBackIds[0]] : undefined
    expect(first).toBeDefined()
    const firstNode = first?.nodeId ?? ('' as NodeId)
    // Routed after the group closed: planned on the join-back node itself, as the chain's head.
    await s.ask(J_TEXT, { label: 'itinerary', placement: { kind: 'continue', buildsOn: { kind: 'node', nodeId: firstNode } } }, answer('OLD-J', 10, 5_000))
    await s.t.advance(50)
    expect(s.state().attempts[s.d('itinerary').attemptIds[0] ?? '']?.parents).toEqual([firstNode])
    s.t.model.script(A_TEXT, answer('NEW-A', 10, 50))
    s.t.model.script(J_TEXT, answer('NEW-J', 10, 50))
    await revise(s, LUXURY, { targets: ['neighborhoods'] })
    await s.t.advance(2_000)
    const j = s.d('itinerary')
    expect(j.state).toBe('completed')
    const current = s.state().groups[group?.id ?? '']?.joinBackIds.at(-1)
    const currentNode = current ? s.state().joinBacks[current]?.nodeId : undefined
    expect(currentNode).toBeDefined()
    expect(currentNode).not.toBe(firstNode)
    const run = s.state().attempts[j.attemptIds.at(-1) ?? '']
    expect(run?.parents).toEqual([currentNode])
    expect(run?.context.messages.map((m) => m.content).join('\n')).toContain('NEW-A')
    const snap = await s.snap()
    const node = snap.genealogy.nodes[j.nodeId]
    expect(node?.parents).toEqual([currentNode])
    // The replaced record keeps only the history that really read it.
    const children = Object.values(snap.genealogy.nodes).filter((n) => n.kind === 'exchange' && n.parents.includes(firstNode))
    expect(children.map((n) => n.id)).toEqual([s.state().attempts[j.attemptIds[0] ?? '']?.nodeId])
  })
})

describe('fourth review: operation-graph edges go to the work a dependent waits for', () => {
  test('09 §4 · J waits on a closed group whose member B failed, then on B\'s late retry: its edge goes to B\'s operation, which is drawn', async () => {
    const s = await recoveryScenario({ settings: { retryPolicy: 'manual' } })
    await trip(s, { a: answer('Gion.', 50, 100), b: [say(50, 'Muse'), fail(80, 'bad-gateway')] })
    await s.t.advance(300)
    expect(s.d('itinerary').state).toBe('paused')
    let snap = await s.snap()
    const j = snap.operationGraph.operations[opOf(snap, s, 'itinerary')]
    const b = opOf(snap, s, 'activities')
    expect(j?.waitingFor).toEqual([b])
    expect(j?.dependsOn).toContain(b)
    expect(snap.operationGraph.active).toContain(b)

    s.t.model.script(B_TEXT, [say(10, 'Museums'), say(3_000, ' and more'), { afterMs: 3_100, event: { type: 'completed', finishReason: 'stop', usage: null } }])
    await s.t.send({ type: 'retry', conversationId: s.c, target: { kind: 'section', sectionId: s.d('activities').sectionId as SectionId } })
    await s.t.advance(100)
    expect(s.d('activities').state).toBe('running')
    snap = await s.snap()
    const waiting = snap.operationGraph.operations[opOf(snap, s, 'itinerary')]
    const retry = opOf(snap, s, 'activities')
    expect(waiting?.status).toBe('waiting-for-results')
    expect(waiting?.waitingFor.map((id) => opLabel(snap, id))).toEqual(['activities:answer'])
    expect(waiting?.waitingFor).toEqual([retry])
    expect(snap.operationGraph.active).toContain(retry)
    expect(waiting?.depth).toBe((snap.operationGraph.operations[retry]?.depth ?? 0) + 1)
  })

  test('09 §4 · B is paused on A, whose request was stopped before it started: cancelled A stays on the graph with B\'s edge to it', async () => {
    const s = await recoveryScenario({ settings: { concurrencyLimit: 1 } })
    await s.ask('Long thing', { label: 'X' }, [say(10, 'x'), say(9_000, 'y')])
    await s.ask('Neighborhoods', { label: 'A' }, answer('Gion.', 10, 20))
    await s.ask('Use the neighborhoods', { label: 'B', placement: s.on('A'), prerequisites: [s.needs('A')] }, answer('Ok.', 10, 20))
    await s.t.advance(50)
    await s.t.send({ type: 'stop', conversationId: s.c, target: { kind: 'request', messageId: s.d('A').messageId } })
    expect(s.d('A').state).toBe('cancelled')
    expect(s.d('B').state).toBe('paused')
    const snap = await s.snap()
    const a = opOf(snap, s, 'A')
    expect(snap.operationGraph.operations[a]?.status).toBe('cancelled')
    expect(snap.operationGraph.active).toContain(a)
    expect(snap.operationGraph.operations[opOf(snap, s, 'B')]?.waitingFor).toEqual([a])
  })
})

describe('fourth review: inheritance-aware Focus', () => {
  test('C10 · a branch read failed A\'s marker; after A is revised, its Focus still credits the failed section, never A\'s replacement', async () => {
    const s = await recoveryScenario({ settings: { retryPolicy: 'manual' } })
    await s.ask('Trip brief Kyoto', { label: 'brief' }, answer('Noted.', 10, 20))
    await s.t.advance(50)
    await s.ask('Suggest neighborhoods', { label: 'A', placement: s.on('brief') }, [say(10, 'Gi'), fail(200, 'bad-gateway')])
    await s.ask('Suggest activities', { label: 'B', placement: s.onHeadOf('brief') }, answer('Museums.', 10, 300))
    await s.t.advance(500)
    await s.ask('Anything else nearby?', { label: 'C', placement: s.on('A') }, answer('Nearby things.', 10, 20))
    await s.t.advance(50)
    const failed = s.d('A').sectionId as SectionId
    expect(s.state().attempts[s.d('C').attemptIds[0] ?? '']?.context.inputs).toContainEqual({ directiveId: s.id('A'), attemptId: null, marker: 'failed' })
    const chain = s.d('C').chainId
    let snap = await s.snap()
    expect(snap.transcript.chains[chain]?.focus.inherited.sectionIds).toContain(failed)

    s.t.model.script('Suggest neighborhoods', answer('Aman.', 10, 20))
    await revise(s, 'Actually, luxury neighborhoods', { targets: ['A'] })
    await s.t.advance(100)
    expect(s.d('A').sectionId).not.toBe(failed)
    snap = await s.snap()
    const inherited = snap.transcript.chains[chain]?.focus.inherited.sectionIds ?? []
    expect(inherited).toContain(failed)
    expect(inherited).not.toContain(s.d('A').sectionId)
  })

  test('C10 · a correction a run read is highlighted under that run\'s Focus, and is the revised work\'s own', async () => {
    const s = await recoveryScenario()
    await trip(s, { a: answer('Gion.', 100, 300), b: answer('Museums.', 100, 200) })
    await s.t.advance(2_000)
    s.t.model.script(A_TEXT, answer('Aman and Ritz.', 10, 50))
    await revise(s, 'Actually, use a luxury budget for the neighborhoods', { targets: ['neighborhoods'] })
    await s.t.advance(500)
    s.t.model.script(J_TEXT, answer('Day 1: Aman.', 10, 50))
    await s.t.send({ type: 'regenerate', conversationId: s.c, sectionId: s.d('itinerary').sectionId as SectionId })
    await s.t.advance(500)
    const snap = await s.snap()
    const correction = Object.values(snap.transcript.messages).find((m) => m.text.startsWith('Actually'))
    expect(correction).toBeDefined()
    const j = s.d('itinerary')
    const run = s.state().attempts[j.attemptIds.at(-1) ?? '']
    expect(run?.context.corrections).toEqual([correction?.id])
    const focus = snap.transcript.chains[j.chainId]?.focus
    expect([...(focus?.own.messageIds ?? []), ...(focus?.inherited.messageIds ?? [])]).toContain(correction?.id)
    expect(snap.transcript.chains[s.d('neighborhoods').chainId]?.focus.own.messageIds).toContain(correction?.id)
  })

  test('01 principle 1 · superseded sections stay under their own chain\'s Focus', async () => {
    const s = await recoveryScenario()
    await trip(s, { a: answer('Gion.', 100, 300), b: [say(100, 'Muse'), say(5_000, 'ums')], j: answer('Day 1.', 10, 20) })
    await s.t.advance(400)
    expect(s.d('activities').state).toBe('running')
    const running = s.d('activities').sectionId as SectionId
    s.t.model.script(B_TEXT, answer('Indoor onsen.', 10, 50))
    await revise(s, 'Actually, make the rainy-day activities onsen only', { targets: ['activities'] })
    await s.t.advance(2_000)
    const snap = await s.snap()
    expect(snap.transcript.sections[running]?.state).toBe('superseded')
    expect(snap.transcript.chains[s.d('activities').chainId]?.focus.own.sectionIds).toContain(running)
  })

  test('01 principle 1 · a section superseded by Regenerate stays under its chain\'s Focus', async () => {
    const s = await recoveryScenario()
    await trip(s, { a: answer('Gion.', 100, 300), b: answer('Museums.', 100, 200) })
    await s.t.advance(2_000)
    s.t.model.script(A_TEXT, answer('Aman.', 10, 50))
    await revise(s, LUXURY, { targets: ['neighborhoods'] })
    await s.t.advance(500)
    const jOld = s.d('itinerary').sectionId as SectionId
    s.t.model.script(J_TEXT, answer('Day 1 again.', 10, 20))
    await s.t.send({ type: 'regenerate', conversationId: s.c, sectionId: jOld })
    await s.t.advance(500)
    const snap = await s.snap()
    expect(snap.transcript.sections[jOld]?.state).toBe('superseded')
    expect(snap.transcript.chains[s.d('itinerary').chainId]?.focus.own.sectionIds).toContain(jOld)
  })
})

describe('fourth review: superseded sections', () => {
  test('T3 · "Reply to this" stays on a superseded section; its link names what replaced it (Regenerate is not a revision)', async () => {
    const s = await recoveryScenario()
    await trip(s, { a: answer('Gion.', 100, 300), b: answer('Museums.', 100, 200) })
    await s.t.advance(2_000)
    s.t.model.script(A_TEXT, answer('Aman.', 10, 50))
    const revisedA = s.d('neighborhoods').sectionId as SectionId
    await revise(s, LUXURY, { targets: ['neighborhoods'] })
    await s.t.advance(500)
    const jOld = s.d('itinerary').sectionId as SectionId
    s.t.model.script(J_TEXT, answer('Day 1: Aman.', 10, 50))
    await s.t.send({ type: 'regenerate', conversationId: s.c, sectionId: jOld })
    await s.t.advance(500)
    const snap = await s.snap()
    expect(snap.transcript.sections[revisedA]?.superseded?.linkText).toBe(WORDING.seeRevision)
    expect(snap.transcript.sections[jOld]?.superseded?.linkText).toBe(WORDING.seeRegenerated)
    expect(snap.transcript.sections[revisedA]?.actions.reply).toBe(true)
    expect(snap.transcript.sections[jOld]?.actions.reply).toBe(true)
  })
})

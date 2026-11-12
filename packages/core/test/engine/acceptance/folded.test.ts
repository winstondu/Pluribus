import { describe, expect, test } from 'vitest'
import {
  CONVERSATION_EVENT_TYPES,
  WORDING,
  type ConversationEvent,
  type ConversationEventBody,
  type ConversationId,
  type ConversationSnapshot,
  type DirectiveId,
  type ElicitationId,
  type EventId,
  type MessageId,
  type NodeId,
  type QueueItemId,
  type ResponseId,
  type SectionId,
} from '@committee/protocol'
import { answer, fail, say, sequential, spanOf } from '../../../testing'
import { assembleContext } from '../../../src/engine/context'
import { computeWait } from '../../../src/engine/lifecycle'
import { Projector, projectSnapshot, rebuildSnapshot, runInspection } from '../../../src/engine/projections'
import { resolvePoint } from '../../../src/engine/queries'
import { REDUCERS, fold, reduce } from '../../../src/engine/reducers'
import { emptyConversationState, type ConversationState } from '../../../src/engine/state'
import { scenario, type Scenario } from '../../../testing/acceptance/engine'

/**
 * Reducers for events the engine does not emit itself, folded from
 * hand-written logs on top of a prefix the engine produced. Every log is
 * also projected incrementally, event by event, and compared with a
 * rebuild at each step.
 */

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

/** Folds the log, projecting incrementally after every event; each step must equal a rebuild. */
function foldChecked(conversationId: ConversationId, log: readonly ConversationEvent[]): { state: ConversationState; snap: ConversationSnapshot } {
  const projector = new Projector()
  let state = emptyConversationState(conversationId)
  let snap = projectSnapshot(projector, state)
  for (const event of log) {
    state = reduce(state, event)
    snap = projectSnapshot(projector, state)
    expect(snap, `after ${event.type} #${event.seq}`).toEqual(rebuildSnapshot(state))
  }
  return { state, snap }
}

async function trip(scriptB: Parameters<Scenario['ask']>[2] = answer('Museums.', 50, 200)): Promise<Scenario> {
  const s = await scenario()
  await s.ask('Trip brief: Kyoto', { label: 'brief' }, answer('Noted.', 10, 20))
  await s.t.advance(50)
  await s.ask('Suggest neighborhoods', { label: 'neighborhoods', placement: s.on('brief') }, answer('Gion.', 100, 300))
  await s.ask('Suggest rainy-day activities', { label: 'activities', placement: s.onHeadOf('brief') }, scriptB)
  return s
}

describe('reducers over hand-written logs', () => {
  test('every conversation event type has a reducer', () => {
    expect(Object.keys(REDUCERS).sort()).toEqual([...CONVERSATION_EVENT_TYPES].sort())
  })

  test('pause and the recovery choice; Continue without consumes the full join-back with the marker', async () => {
    const s = await trip([say(20, 'Mus'), fail(50, 'invalid-request')])
    await s.ask('Use those to make an itinerary', { label: 'itinerary', placement: s.onGroupOf('neighborhoods') })
    await s.t.advance(400)
    const j = s.d('itinerary')
    expect(j.state).toBe('dependency-queued')
    const E = 'eli_recover' as ElicitationId
    const cause = { directiveId: s.id('activities'), label: 'activities', outcome: 'failed' as const }
    const paused = extend(await s.events(), [
      { type: 'directive-paused', directiveId: j.id, queueItemId: j.queueItemId as QueueItemId, cause, elicitationId: E },
      { type: 'elicitation-raised', elicitation: { kind: 'recovery-choice', elicitationId: E, pausedDirectiveId: j.id, cause } },
    ])
    let { state, snap } = foldChecked(s.c, paused)
    const item = snap.queue.items[0]
    expect(item).toMatchObject({ state: 'paused', text: 'Paused — activities failed' })
    expect(item?.recovery).toMatchObject({
      retry: { label: 'Retry activities', sectionId: s.d('activities').sectionId },
      continueWithout: { label: 'Continue without activities' },
      cancel: { label: 'Cancel itinerary' },
    })
    expect(snap.queue.elicitations).toEqual([{ kind: 'recovery-choice', id: E, queueItemId: j.queueItemId }])
    expect(snap.transcript.sections[j.sectionId ?? '']?.status).toEqual({ kind: 'paused', text: 'Paused — activities failed' })
    expect(snap.operationGraph.operations[snap.transcript.sections[j.sectionId ?? '']?.operationId ?? '']?.status).toBe('paused')

    const resumed = extend(paused, [
      { type: 'prerequisite-waived', directiveId: j.id, waivedDirectiveId: s.id('activities'), elicitationId: E },
      { type: 'elicitation-answered', elicitationId: E, resolution: { kind: 'recovery-choice', choice: 'continue-without' } },
      { type: 'directive-ready', directiveId: j.id },
    ])
    ;({ state, snap } = foldChecked(s.c, resumed))
    expect(snap.queue).toEqual({ items: [], elicitations: [] })
    expect(computeWait(state, state.directives[j.id] ?? j)).toEqual({ kind: 'ready' })
    const node = state.nodes[j.nodeId]
    const parents = node ? [resolvePoint(state, node.plannedParents[0] ?? { kind: 'node', nodeId: '' as NodeId }) as NodeId] : []
    const context = assembleContext(state, j.id, j.nodeId, parents)
    expect(context.inputs).toContainEqual({ directiveId: s.id('activities'), attemptId: null, marker: 'failed' })
    expect(context.messages.some((m) => m.content === 'Mus')).toBe(false)
  })

  test('choice with default: held and redone work, and "Redid … by default" only once the default ran', async () => {
    const s = await scenario()
    await s.ask('Trip brief: Kyoto, five days', { label: 'brief' }, answer('Noted.', 10, 20))
    await s.t.advance(50)
    await s.ask('Make a five-day itinerary', { label: 'itinerary', placement: s.on('brief') }, [say(10, 'Day 1')])
    await s.ask('Book dinners for the itinerary', { label: 'dinners', placement: s.on('itinerary'), prerequisites: [s.needs('itinerary')] })
    await s.t.advance(50)
    const revision = 'msg_rev' as MessageId
    const E = 'eli_choice' as ElicitationId
    const j = s.d('itinerary')
    const k = s.d('dinners')
    const live = j.attemptIds[0] ?? null
    const ids = { section: 'sec_J2' as SectionId, response: 'rsp_J2' as ResponseId, node: 'nod_J2' as NodeId }
    const raised = extend(await s.events(), [
      { type: 'message-submitted', messageId: revision, text: 'Actually, four days', explicitTargets: [], responseId: 'rsp_rev' as ResponseId },
      { type: 'routing-decided', messageId: revision, decision: { source: 'supplied', model: null, composition: { value: 'atomic', confidence: null }, units: [], thresholds: {}, explanation: '', questions: [] } },
      { type: 'revision-recorded', messageId: revision, scope: 'shared-requirement', correction: 'The trip is four days', fragmentId: null, targets: [{ directiveId: s.id('brief'), sectionId: s.d('brief').sectionId, state: 'finished' }], requirementIds: [] },
      {
        type: 'elicitation-raised',
        elicitation: {
          kind: 'choice-with-default',
          elicitationId: E,
          revisionMessageId: revision,
          deadlineAt: (s.state().attempts[live ?? '']?.startedAt ?? 0) + 30_000,
          options: [
            { directiveId: s.id('brief'), label: 'brief', state: 'finished', locked: false, preselected: false },
            { directiveId: j.id, label: 'itinerary', state: 'running', locked: true, preselected: true },
            { directiveId: k.id, label: 'dinners', state: 'queued', locked: true, preselected: true },
          ],
        },
      },
      { type: 'section-superseded', sectionId: j.sectionId as SectionId, directiveId: j.id, endedAttemptId: live, hadVisibleOutput: true, wasFinished: false, cause: { kind: 'redo', elicitationId: E }, replacementSectionId: ids.section },
      { type: 'node-created', nodeId: ids.node, chainId: j.chainId, directiveId: j.id, reason: 'redo', plannedParents: [{ kind: 'node', nodeId: s.d('brief').nodeId }], replacesNodeId: j.nodeId },
      { type: 'response-opened', responseId: ids.response, messageId: j.messageId, reason: 'redo', grouped: false, sectionOrder: 'first-output' },
      { type: 'section-opened', sectionId: ids.section, directiveId: j.id, responseId: ids.response, title: 'itinerary', replacesSectionId: j.sectionId, operationId: 'opr_J2' as never, explicitPosition: null },
      { type: 'directive-held', directiveId: j.id, elicitationId: E, reason: 'choice-with-default' },
      { type: 'directive-held', directiveId: k.id, elicitationId: E, reason: 'choice-with-default' },
    ])
    let { snap } = foldChecked(s.c, raised)
    const choice = snap.queue.elicitations[0]
    expect(choice?.kind).toBe('choice-with-default')
    if (choice?.kind === 'choice-with-default') {
      expect(choice.correction).toBe('The trip is four days')
      expect(choice.waitMs).toBeGreaterThan(0)
      expect(choice.options.map((o) => [o.label, o.locked, o.selected])).toEqual([
        ['brief', false, false],
        ['itinerary', true, true],
        ['dinners', true, true],
      ])
    }
    expect(snap.transcript.sections[ids.section]?.status).toEqual({ kind: 'awaiting-answer', text: WORDING.awaitingAnswer })
    expect(snap.transcript.sections[ids.section]?.notes).toEqual([])
    expect(snap.transcript.sections[j.sectionId ?? '']?.superseded?.markText).toBe(WORDING.supersededPartial)

    const defaulted = extend(raised, [
      { type: 'elicitation-defaulted', elicitationId: E, trigger: 'wait-elapsed', redo: [] },
      { type: 'directive-ready', directiveId: j.id },
      { type: 'directive-waiting', directiveId: k.id, queueItemId: 'que_K' as QueueItemId, waitingFor: [{ kind: 'directive', directiveId: j.id }], heldByBarrier: false, revised: false },
    ])
    ;({ snap } = foldChecked(s.c, defaulted))
    expect(snap.queue.elicitations).toEqual([])
    expect(snap.transcript.sections[ids.section]?.notes).toEqual([{ kind: 'redone-by-default', text: 'Redid itinerary by default', elicitationId: E }])
    expect(snap.transcript.sections[k.sectionId ?? '']?.notes.map((n) => n.text)).toEqual(['Redid dinners by default'])
  })

  test('clarification: the blocked run reads its request, then the question, then the answer; the answering message carries its rail', async () => {
    const s = await scenario()
    await s.ask('Which event yesterday do you mean?', { label: 'question' }, answer('Which event do you mean: the talk or the dinner?', 10, 20))
    await s.t.advance(50)
    const q = s.d('question')
    const E = 'eli_clar' as ElicitationId
    const X = 'dir_X' as DirectiveId
    const answerMessage = 'msg_answer' as MessageId
    const log = extend(await s.events(), [
      { type: 'chain-created', chainId: 'chn_X' as never, kind: 'root', colorIndex: 1, baseChainId: null, label: 'explanation' },
      { type: 'node-created', nodeId: 'nod_X' as NodeId, chainId: 'chn_X' as never, directiveId: X, reason: 'initial', plannedParents: [], replacesNodeId: null },
      {
        type: 'directive-created', directiveId: X, kind: 'answer', messageId: q.messageId, originalMessageId: q.messageId, fragmentId: null,
        instruction: 'Explain what happened yesterday', label: 'explanation', requirements: [], relation: 'new', targets: [],
        nodeId: 'nod_X' as NodeId, chainId: 'chn_X' as never, prerequisites: [], asksElicitationId: null,
      },
      { type: 'elicitation-raised', elicitation: { kind: 'clarification', elicitationId: E, questionDirectiveId: q.id, blockedDirectiveIds: [X], reason: 'missing-information' } },
      { type: 'directive-held', directiveId: X, elicitationId: E, reason: 'clarification' },
    ])
    let { snap } = foldChecked(s.c, log)
    expect(snap.queue.elicitations).toEqual([{ kind: 'clarification', id: E, questionSectionId: q.sectionId, blockedLabels: ['explanation'] }])
    expect(snap.queue.items).toEqual([])
    const answered = extend(log, [
      { type: 'message-submitted', messageId: answerMessage, text: 'The dinner', explicitTargets: [q.sectionId as SectionId], responseId: 'rsp_answer' as ResponseId },
      { type: 'routing-decided', messageId: answerMessage, decision: { source: 'supplied', model: null, composition: { value: 'atomic', confidence: null }, units: [], thresholds: {}, explanation: '', questions: [] } },
      { type: 'elicitation-answered', elicitationId: E, resolution: { kind: 'clarification', answerMessageId: answerMessage } },
      { type: 'directive-ready', directiveId: X },
    ])
    let state: ConversationState
    ;({ state, snap } = foldChecked(s.c, answered))
    const context = assembleContext(state, X, 'nod_X' as NodeId, [])
    expect(context.messages.slice(-3).map((m) => [m.role, m.origin.kind, m.content])).toEqual([
      ['user', 'request', 'Explain what happened yesterday'],
      ['assistant', 'clarification-question', 'Which event do you mean: the talk or the dinner?'],
      ['user', 'clarification-answer', 'The dinner'],
    ])
    expect(snap.transcript.messages[answerMessage]?.chainIds).toEqual(['chn_X'])
    // The provisional bubble of a message that only answers goes away without a trace.
    expect(snap.transcript.responses['rsp_answer']).toBeUndefined()
  })

  test('a superseded-input note offers Regenerate', async () => {
    const s = await scenario()
    await s.ask('Recommend a neighborhood', { label: 'neighborhoods' }, answer('Gion.', 10, 20))
    await s.ask('Itinerary from it', { label: 'itinerary', placement: s.on('neighborhoods'), prerequisites: [s.needs('neighborhoods')] }, answer('Day 1.', 10, 20))
    await s.t.advance(100)
    const j = s.d('itinerary')
    const log = extend(await s.events(), [
      {
        type: 'superseded-input-noted',
        sectionId: j.sectionId as SectionId,
        attemptId: j.resultAttemptId as never,
        inputs: [{ kind: 'result', directiveId: s.id('neighborhoods'), label: 'neighborhood recommendations', consumedAttemptId: s.d('neighborhoods').resultAttemptId }],
      },
    ])
    const { snap } = foldChecked(s.c, log)
    const section = snap.transcript.sections[j.sectionId ?? '']
    // The note names the input by its directive's current label, whatever label the record copied.
    expect(section?.notes.map((n) => n.text)).toEqual(['Based on superseded neighborhoods'])
    expect(section?.actions.regenerate).toBe(true)
  })

  test('split messages appear at once in plan order with the link; Undo split restores the original with its provisional bubble', async () => {
    const s = await scenario()
    const text = 'List three museums, then make a day plan from them.'
    s.t.router.when(text, (input) => {
      const museums = input.ids.next('directive')
      return sequential(input, [
        { directiveId: museums, label: 'museums', spans: spanOf(text, 'List three museums') },
        {
          label: 'day plan',
          spans: spanOf(text, 'make a day plan from them'),
          placement: { kind: 'continue', buildsOn: { kind: 'directive', directiveId: museums } },
          prerequisites: [{ kind: 'directive', directiveId: museums }],
        },
      ])
    })
    s.t.model.script('List three museums', [say(1_000, 'MOMAK')])
    const original = await s.t.submit(s.c, text)
    let snap = await s.snap()
    const split = snap.transcript.splits[original]
    expect(split?.messageIds).toHaveLength(2)
    expect(split?.undoAvailable).toBe(true)
    expect(snap.transcript.messages[original]).toBeUndefined()
    expect(snap.transcript.order.filter((r) => r.kind === 'message').map((r) => snap.transcript.messages[r.id]?.text)).toEqual([
      'List three museums',
      'make a day plan from them',
    ])
    expect(snap.transcript.messages[split?.messageIds[1] ?? '']?.split).toEqual({ originalMessageId: original, index: 1, count: 2 })
    expect(snap.queue.items.map((i) => i.messageId)).toEqual([split?.messageIds[1]])
    expect(s.state().chains[s.d('day plan').chainId]).toBe(s.state().chains[s.d('museums').chainId])

    const state = s.state()
    const withdrawn = [s.id('museums'), s.id('day plan')]
    const log = extend(await s.events(), [
      ...withdrawn.map((id): ConversationEventBody => {
        const d = state.directives[id]
        const sectionId = d?.sectionId as SectionId
        const live = state.sections[sectionId]?.attemptIds.find((a) => state.attempts[a]?.state === 'running') ?? null
        return { type: 'section-superseded', sectionId, directiveId: id, endedAttemptId: live, hadVisibleOutput: false, wasFinished: false, cause: { kind: 'undo-split' }, replacementSectionId: null }
      }),
      { type: 'split-undone', originalMessageId: original, splitMessageIds: split?.messageIds ?? [], withdrawnDirectiveIds: withdrawn },
    ])
    let folded: ConversationState
    ;({ state: folded, snap } = foldChecked(s.c, log))
    expect(snap.transcript.order.map((r) => r.kind)).toEqual(['message', 'response'])
    const message = snap.transcript.messages[original]
    expect(message?.kind).toBe('original')
    expect(message?.routing).toBe('routing')
    expect(snap.transcript.responses[message?.responseIds[0] ?? '']?.routing?.state).toBe('routing')
    expect(snap.transcript.splits).toEqual({})
    expect(snap.queue.items).toEqual([])
    expect(folded.directives[s.id('museums')]?.state).toBe('superseded')
  })

  test('withdrawn members: a group left with one member carries on and joins back that member alone; one left with none is dissolved', async () => {
    const s = await trip(answer('Museums.', 50, 5_000))
    const group = Object.values(s.state().groups)[0]
    if (!group) throw new Error('no group')
    const one = extend(await s.events(), [{ type: 'siblings-withdrawn', groupId: group.id, directiveIds: [s.id('activities')], dissolved: false }])
    let { state, snap } = foldChecked(s.c, one)
    expect(snap.genealogy.groups[group.id]).toMatchObject({ state: 'open', withdrawnNodeIds: [s.d('activities').nodeId] })
    expect(snap.operationGraph.operations[group.joinBackOperationId]?.label).toBe('neighborhoods')

    const none = extend(await s.events(), [{ type: 'siblings-withdrawn', groupId: group.id, directiveIds: [s.id('neighborhoods'), s.id('activities')], dissolved: true }])
    ;({ state, snap } = foldChecked(s.c, none))
    expect(snap.genealogy.groups[group.id]?.state).toBe('dissolved')
    expect(snap.operationGraph.operations[group.joinBackOperationId]).toMatchObject({ status: 'cancelled', retired: true })
    expect(resolvePoint(state, { kind: 'sibling-group', groupId: group.id })).toBe(group.startNodeId)
  })

  test('a revision of queued work edits it in place: "Revised · waiting for …", the dependencies unchanged', async () => {
    const s = await scenario()
    await s.ask('Recommend a neighborhood', { label: 'neighborhoods' }, answer('Gion.', 100, 1_000))
    await s.ask('Make an itinerary from it', { label: 'itinerary', placement: s.on('neighborhoods'), prerequisites: [s.needs('neighborhoods')] })
    const j = s.d('itinerary')
    const revision = 'msg_rev' as MessageId
    const log = extend(await s.events(), [
      { type: 'message-submitted', messageId: revision, text: 'Actually, make it three days', explicitTargets: [], responseId: 'rsp_rev' as ResponseId },
      { type: 'routing-decided', messageId: revision, decision: { source: 'supplied', model: null, composition: { value: 'atomic', confidence: null }, units: [], thresholds: {}, explanation: '', questions: [] } },
      { type: 'revision-recorded', messageId: revision, scope: 'work', correction: 'Make it three days', fragmentId: null, targets: [{ directiveId: j.id, sectionId: j.sectionId, state: 'not-started' }], requirementIds: [] },
      { type: 'directive-revised-in-place', directiveId: j.id, revisionMessageId: revision, instruction: 'Make a three-day itinerary from it', requirements: [] },
      { type: 'directive-waiting', directiveId: j.id, queueItemId: j.queueItemId as QueueItemId, waitingFor: j.waitingFor, heldByBarrier: false, revised: true },
    ])
    const { state, snap } = foldChecked(s.c, log)
    expect(snap.queue.items.map((i) => [i.id, i.text])).toEqual([[j.queueItemId, 'Revised · waiting for neighborhoods']])
    expect(state.directives[j.id]?.prerequisites).toEqual(j.prerequisites)
    expect(runInspection(state, j.id, null)?.instruction).toBe('Make a three-day itinerary from it')
    expect(snap.transcript.messages[revision]?.chainIds).toEqual([j.chainId])
    const context = assembleContext(state, j.id, j.nodeId, [s.d('neighborhoods').nodeId])
    expect(context.messages.slice(-2).map((m) => m.content)).toEqual(['Make an itinerary from it', 'Correction: Make it three days'])
  })

  test('target ambiguity: the reply is not acted on and its bubble says so; answering routes it again', async () => {
    const s = await scenario()
    await s.ask('Explain caching', { label: 'caching' }, answer('Caching keeps copies.', 10, 20))
    await s.t.advance(50)
    const reply = 'msg_reply' as MessageId
    const E = 'eli_target' as ElicitationId
    const log = extend(await s.events(), [
      { type: 'message-submitted', messageId: reply, text: 'Make that shorter', explicitTargets: [], responseId: 'rsp_reply' as ResponseId },
      { type: 'elicitation-raised', elicitation: { kind: 'target-ambiguity', elicitationId: E, messageId: reply, candidates: [{ sectionId: s.d('caching').sectionId as SectionId, confidence: 0.4 }] } },
    ])
    let { state, snap } = foldChecked(s.c, log)
    expect(state.messages[reply]?.routing).toBe('awaiting-target')
    expect(snap.transcript.responses['rsp_reply']?.routing).toEqual({ state: 'awaiting-target', text: WORDING.awaitingAnswer, failure: null })
    expect(snap.queue.elicitations[0]).toMatchObject({
      kind: 'target-ambiguity',
      messageText: 'Make that shorter',
      candidates: [{ sectionId: s.d('caching').sectionId, title: 'caching', excerpt: 'Caching keeps copies.', chainId: s.d('caching').chainId }],
    })
    ;({ state } = foldChecked(s.c, extend(log, [{ type: 'elicitation-answered', elicitationId: E, resolution: { kind: 'target-ambiguity', sectionIds: [s.d('caching').sectionId as SectionId] } }])))
    expect(state.messages[reply]?.routing).toBe('routing')
  })

  test('a re-formed join-back replaces the earlier one in context and in the genealogy', async () => {
    const s = await trip()
    await s.t.advance(400)
    const group = Object.values(s.state().groups)[0]
    const first = s.state().joinBacks[group?.joinBackIds[0] ?? '']
    if (!group || !first) throw new Error('no join-back')
    const log = extend(await s.events(), [
      {
        type: 'join-back-formed',
        joinBackId: 'jbk_2' as never,
        nodeId: 'nod_jb2' as NodeId,
        groupId: group.id,
        chainId: group.baseChainId,
        members: first.members.map((m, i) => (i === 1 ? { ...m, outcome: 'stopped' as const, attemptId: null } : m)),
        replacesJoinBackId: first.id,
      },
    ])
    const { state, snap } = foldChecked(s.c, log)
    const old = snap.genealogy.nodes[first.nodeId]
    expect(old?.kind === 'join-back' && old.replacedByNodeId).toBe('nod_jb2')
    expect(snap.genealogy.groups[group.id]?.joinBackNodeId).toBe('nod_jb2')
    expect(state.chains[group.baseChainId]?.nodeIds).toEqual([s.d('brief').nodeId, first.nodeId, 'nod_jb2'])
    // A run reading the earlier node reads the latest formation.
    const context = assembleContext(state, s.id('brief'), s.d('brief').nodeId, [first.nodeId])
    expect(context.inputs).toContainEqual({ directiveId: s.id('activities'), attemptId: null, marker: 'stopped' })
  })

  test('folding the same log twice gives the same state (reducers are pure)', async () => {
    const s = await trip()
    await s.t.advance(400)
    const events = await s.events()
    expect(fold(emptyConversationState(s.c), events)).toEqual(fold(emptyConversationState(s.c), events))
  })
})

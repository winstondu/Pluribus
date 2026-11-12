import type { AttemptStarted, RoutingDecided, StrategySelectionMode } from '@committee/protocol'
import { describe, expect, test } from 'vitest'
import type { DecisionQuestions, DecisionRequest, DecisionResult } from '../../../src/ports'
import { answer } from '../../../testing'
import { answerFrom, routingScenario, type RoutingScenario } from '../../../testing/acceptance/routing'

/**
 * Strategy selection on a real backend (docs/build/dependency-decisioning.md
 * · "Strategy selection"): the J request lands on both siblings whoever
 * chooses the strategy (C9, C19), the choice is recorded with the routing
 * decision, and a choice made by the decision model is reused from the
 * event log while the conversation's shape is the same.
 */

const BRIEF = 'Trip brief: Kyoto, five days, November'
const A = 'Suggest neighborhoods to stay in'
const B = 'Suggest rainy-day activities'
const J = 'Use those recommendations to make a five-day itinerary.'

const isSelector = (request: DecisionRequest<DecisionQuestions>): boolean => 'sel_strategy' in request.questions

/** The scenario's scripted decisions, with the selector's questions answered: the tree walk, confidently, no switch. */
function answerSelector(s: RoutingScenario): void {
  const routing = answerFrom(s.rules)
  s.t.decisions.answerWith((request): DecisionResult<DecisionQuestions> => {
    if (!isSelector(request)) return routing(request)
    const answers = {
      sel_strategy: { type: 'choice', choice: 'tree-walk', confidence: 0.9, probabilities: { 'one-pass': 0.1, 'tree-walk': 0.9 } },
      sel_trunk: { type: 'noul', probability: 0.1 },
      sel_search: { type: 'noul', probability: 0.9 },
    }
    return { ok: true, model: 'typesafe/jev-1.13-20260917', answers: answers as never, usage: null }
  })
}

async function trip(strategySelection: StrategySelectionMode, runMs: number): Promise<RoutingScenario> {
  // Configured the other way round from what is selected, so the result can only come from the selector.
  const s = await routingScenario({ settings: { routing: { referentStrategy: strategySelection === 'rules' ? 'tree-walk' : 'one-pass', strategySelection } } })
  answerSelector(s)
  s.t.model.script(BRIEF, answer('Noted.', 10, 20))
  await s.send(BRIEF)
  await s.t.advance(50)
  s.t.model.script(A, answer('Gion and Higashiyama.', 20, runMs))
  s.t.model.script(B, answer('Museums and tea houses.', 20, runMs))
  await s.send(A, { message: { relation: 'addition' } }, { replyTo: [BRIEF] })
  await s.send(B, { message: { relation: 'addition' } }, { replyTo: [BRIEF] })
  return s
}

const title = (s: RoutingScenario, label: string): string => s.state().sections[s.d(label).sectionId ?? '']?.title ?? ''
const j = (s: RoutingScenario) => s.d('Use those recommendations to make a…')
const decisionOf = async (s: RoutingScenario, messageId: string) => (await s.events()).filter((e): e is RoutingDecided => e.type === 'routing-decided' && e.messageId === messageId).at(-1)?.decision

describe.each<StrategySelectionMode>(['rules', 'decision-model'])('the J request, strategy selected by %s', (mode) => {
  test('C19 · J continues from the join-back on the base chain and reads both siblings, and the routing decision records who chose the strategy and why', async () => {
    const s = await trip(mode, 100)
    await s.t.advance(500)
    s.t.model.script(J, answer('Day 1: Gion.', 10, 20))
    const message = await s.send(J, {
      message: { relation: 'addition', several: 0.4, targets: { [title(s, BRIEF)]: 0.5, [title(s, A)]: 0.77, [title(s, B)]: 0.3 }, together: { [title(s, A)]: 0.86 } },
    })
    await s.t.advance(100)
    const work = j(s)
    expect(new Set(work.targets)).toEqual(new Set([s.d(A).sectionId, s.d(B).sectionId]))
    expect(work.chainId).toBe(s.d(BRIEF).chainId)
    const joinBack = Object.values(s.state().joinBacks)[0]
    expect(s.state().nodes[work.nodeId]?.startedParents).toEqual([joinBack?.nodeId])
    const started = (await s.events()).find((e): e is AttemptStarted => e.type === 'attempt-started' && e.directiveId === work.id)
    expect((started?.context.inputs ?? []).map((i) => s.directive(i.directiveId).label)).toEqual([BRIEF, A, B])

    const selection = (await decisionOf(s, message))?.strategySelection
    expect(selection?.selector).toBe(mode)
    // Three answers, all listed: the rules choose one pass; the scripted decision model chooses the tree walk.
    expect(selection?.choice).toEqual(mode === 'rules' ? { strategy: 'one-pass' } : { strategy: 'tree-walk', startAtTrunkBase: false, searchLongRuns: true })
    expect(selection?.fallback).toBeNull()
    expect((await decisionOf(s, message))?.explanation).toContain(`Referent strategy chosen by ${mode === 'rules' ? 'the rules' : 'the decision model'}`)
    // What the run inspector reads: the state holds the same record.
    expect(s.state().messages[message]?.decision?.strategySelection).toEqual(selection)
  })

  test('C9 · J, sent while both siblings run, depends on the whole group and reads every member once it has closed', async () => {
    const s = await trip(mode, 200)
    const group = Object.values(s.state().groups)[0]
    s.t.model.script(J, answer('Day 1: Gion.', 10, 20))
    await s.send(J, { message: { relation: 'dependent', several: 0.4, targets: { [title(s, A)]: 0.77, [title(s, B)]: 0.2 }, together: { [title(s, B)]: 0.86 } } })
    const queued = j(s)
    expect(new Set(queued.targets)).toEqual(new Set([s.d(A).sectionId, s.d(B).sectionId]))
    expect(queued.prerequisites).toEqual([{ kind: 'sibling-group', groupId: group?.id }])
    expect(queued.state).toBe('dependency-queued')
    await s.t.advance(500)
    expect(j(s).state).toBe('completed')
  })
})

describe('reuse from the event log', () => {
  test('selection · the decision model is asked once for a shape: the next message of the same shape reuses the choice recorded in the log', async () => {
    const s = await routingScenario({ settings: { routing: { strategySelection: 'decision-model' } } })
    answerSelector(s)
    const asked = (): number => s.t.decisions.requests.filter(isSelector).length
    // The first message has nothing to refer to: nothing to select.
    s.t.model.script('What causes tides?', answer('The moon.', 10, 20))
    await s.send('What causes tides?')
    await s.t.advance(50)
    expect(asked()).toBe(0)

    // Two answers, then a third and a fourth: one, two and three sections are three shapes (1, 2–3).
    const texts = ['Why is the sky blue?', 'How do volcanoes form?', 'What is a tide pool?']
    const ids: string[] = []
    for (const text of texts) {
      s.t.model.script(text, answer('An answer.', 10, 20))
      ids.push(await s.send(text, { message: { relation: 'new' } }))
      await s.t.advance(50)
    }
    // One section, then two: two shapes asked about. Three sections are the same shape as two: reused.
    expect(asked()).toBe(2)
    const [first, second, third] = await Promise.all(ids.map((id) => decisionOf(s, id)))
    expect(first?.strategySelection).toMatchObject({ selector: 'decision-model', reused: false })
    expect(second?.strategySelection).toMatchObject({ selector: 'decision-model', reused: false })
    expect(third?.strategySelection).toEqual({ ...second?.strategySelection, reused: true })
    expect(third?.explanation).toContain('as chosen earlier for a conversation of this shape')
    // Its questions are in the record of the routing that asked them, and not in the one that reused the choice.
    expect(second?.questions.some((q) => q.id === 'sel_strategy')).toBe(true)
    expect(third?.questions.some((q) => q.id === 'sel_strategy')).toBe(false)
  })
})

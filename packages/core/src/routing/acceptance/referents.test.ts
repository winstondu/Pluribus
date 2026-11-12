import type { AttemptStarted, ReferentStrategyName, SectionId } from '@committee/protocol'
import { describe, expect, test } from 'vitest'
import type { CandidateQuery } from '../../ports'
import { answer } from '../../testing'
import { routingScenario, type RoutingScenario } from './helpers'

/**
 * The spec's J request end to end, with either referent strategy
 * (docs/build/dependency-decisioning.md): the decision model is clear about
 * one sibling, weak about the other, and says the message builds on the
 * two together. J must be a child of both through their join-back: it
 * depends on the whole group and reads every member (01, 04 · "Join-back",
 * C9, C19), and work across diverged lines is a join chain over leaves (C20).
 */

const BRIEF = 'Trip brief: Kyoto, five days, November'
const A = 'Suggest neighborhoods to stay in'
const B = 'Suggest rainy-day activities'
const D = 'Suggest day trips'
const J = 'Use those recommendations to make a five-day itinerary.'
const SKY = 'Why is the sky blue?'

async function trip(strategy: ReferentStrategyName, runMs: number, withD = false, overrides: Parameters<typeof routingScenario>[0] = {}): Promise<RoutingScenario> {
  const s = await routingScenario({ settings: { routing: { referentStrategy: strategy } }, ...overrides })
  s.t.model.script(BRIEF, answer('Noted.', 10, 20))
  await s.send(BRIEF)
  await s.t.advance(50)
  s.t.model.script(A, answer('Gion and Higashiyama.', 20, runMs))
  s.t.model.script(B, answer('Museums and tea houses.', 20, runMs))
  await s.send(A, { message: { relation: 'addition' } }, { replyTo: [BRIEF] })
  await s.send(B, { message: { relation: 'addition' } }, { replyTo: [BRIEF] })
  if (withD) {
    s.t.model.script(D, answer('Nara and Uji.', 20, runMs * 3))
    await s.send(D, { message: { relation: 'addition' } }, { replyTo: [BRIEF] })
  }
  return s
}

const title = (s: RoutingScenario, label: string): string => s.state().sections[s.d(label).sectionId ?? '']?.title ?? ''
const j = (s: RoutingScenario) => s.d('Use those recommendations to make a…')
const inputsOf = async (s: RoutingScenario, id: string): Promise<string[]> => {
  const started = (await s.events()).find((e): e is AttemptStarted => e.type === 'attempt-started' && e.directiveId === id)
  return (started?.context.inputs ?? []).map((i) => s.directive(i.directiveId).label)
}

describe.each<ReferentStrategyName>(['one-pass', 'tree-walk'])('the J request, referents by %s', (strategy) => {
  test('C19 · J, clear about A and weak about B, builds on the two together: it continues from the join-back on the base chain and reads both', async () => {
    const s = await trip(strategy, 100)
    await s.t.advance(500)
    expect(Object.values(s.state().groups)[0]?.state).toBe('closed')
    s.t.model.script(J, answer('Day 1: Gion.', 10, 20))
    await s.send(J, {
      message: { relation: 'addition', several: 0.4, targets: { [title(s, BRIEF)]: 0.5, [title(s, A)]: 0.77, [title(s, B)]: 0.3 }, together: { [title(s, A)]: 0.86 } },
    })
    await s.t.advance(100)
    const work = j(s)
    expect(new Set(work.targets)).toEqual(new Set([s.d(A).sectionId, s.d(B).sectionId]))
    expect(work.chainId).toBe(s.d(BRIEF).chainId)
    expect(s.state().chains[work.chainId]?.kind).not.toBe('join')
    const joinBack = Object.values(s.state().joinBacks)[0]
    expect(s.state().nodes[work.nodeId]?.startedParents).toEqual([joinBack?.nodeId])
    expect(await inputsOf(s, work.id)).toEqual([BRIEF, A, B])
    const run = s.state().attempts[work.attemptIds[0] ?? '']
    expect(run?.context.messages.some((m) => m.content.includes('Gion and Higashiyama.'))).toBe(true)
    expect(run?.context.messages.some((m) => m.content.includes('Museums and tea houses.'))).toBe(true)
  })

  test('C9 · J needs two of three running siblings: it depends on their full join-back, waits for the third too, and then reads every member', async () => {
    const s = await trip(strategy, 200, true)
    const group = Object.values(s.state().groups)[0]
    expect(group?.state).toBe('open')
    s.t.model.script(J, answer('Day 1: Gion.', 10, 20))
    // Nothing says "all of the group": the two siblings named are enough to make it the whole group (Q30).
    await s.send(J, { message: { relation: 'dependent', targets: { [title(s, A)]: 0.9, [title(s, B)]: 0.85 }, several: 0.9 } })
    const queued = j(s)
    expect(queued.prerequisites).toEqual([{ kind: 'sibling-group', groupId: group?.id }])
    expect(queued.state).toBe('dependency-queued')
    // A and B finish; D is still running, so the group is open and J does not start (C15).
    await s.t.advance(300)
    expect(s.d(A).state).toBe('completed')
    expect(s.d(B).state).toBe('completed')
    expect(j(s).state).toBe('dependency-queued')
    await s.t.advance(600)
    expect(j(s).state).toBe('completed')
    expect(await inputsOf(s, queued.id)).toEqual([BRIEF, A, B, D])
  })

  test('C9 · J is weak about the second running sibling but builds on the two together: the dependency is the group, not the clear sibling alone', async () => {
    const s = await trip(strategy, 200)
    const group = Object.values(s.state().groups)[0]
    s.t.model.script(J, answer('Day 1: Gion.', 10, 20))
    await s.send(J, { message: { relation: 'dependent', several: 0.4, targets: { [title(s, A)]: 0.77, [title(s, B)]: 0.2 }, together: { [title(s, B)]: 0.86 } } })
    const queued = j(s)
    expect(new Set(queued.targets)).toEqual(new Set([s.d(A).sectionId, s.d(B).sectionId]))
    expect(queued.prerequisites).toEqual([{ kind: 'sibling-group', groupId: group?.id }])
    await s.t.advance(500)
    expect(await inputsOf(s, queued.id)).toEqual([BRIEF, A, B])
  })

  test('C20 · a follow-up naming the itinerary and an answer of a separate tree is a join chain whose parents are leaves', async () => {
    const s = await trip(strategy, 100)
    await s.t.advance(500)
    s.t.model.script(J, answer('Day 1: Gion.', 10, 20))
    await s.send(J, { message: { relation: 'addition', targets: { [title(s, A)]: 0.9, [title(s, B)]: 0.9 }, several: 0.9 } })
    s.t.model.script(SKY, answer('Scattering.', 10, 20))
    await s.send(SKY)
    await s.t.advance(100)
    const text = 'Compare the itinerary with the sky explanation'
    s.t.model.script(text, answer('Both are about Kyoto skies.', 10, 20))
    await s.send(text, { message: { relation: 'addition', several: 0.9, targets: { [title(s, 'Use those recommendations to make a…')]: 0.9, [title(s, 'Why is the sky blue')]: 0.85 } } })
    await s.t.advance(100)
    const cmp = s.d('Compare the itinerary with the sky…')
    expect(s.state().chains[cmp.chainId]?.kind).toBe('join')
    expect(s.state().nodes[cmp.nodeId]?.startedParents).toEqual([j(s).nodeId, s.d('Why is the sky blue').nodeId])
    expect(await inputsOf(s, cmp.id)).toEqual([BRIEF, A, B, 'Use those recommendations to make a…', 'Why is the sky blue'])
  })
})

describe('start candidates on a backend', () => {
  test('candidates · the candidate source of the backend\'s dependencies is asked for each routed message, and the tree walk starts at what it names', async () => {
    const queries: CandidateQuery[] = []
    let hits: readonly SectionId[] = []
    const s = await trip('tree-walk', 100, false, {
      // The walk as configured: with three answers the rules would choose one pass, which does not walk.
      settings: { routing: { referentStrategy: 'tree-walk', strategySelection: 'off' } },
      candidateSource: {
        candidates: async (query) => {
          queries.push(query)
          return hits
        },
      },
    })
    await s.t.advance(500)
    // A retrieval hit on the neighborhoods: the walk starts there, and asks about the group it is a member of as a whole.
    hits = [s.d(A).sectionId as SectionId]
    s.t.model.script(J, answer('Day 1: Gion.', 10, 20))
    const before = queries.length
    await s.send(J, { message: { relation: 'addition', several: 0.4, targets: { [title(s, A)]: 0.77, [title(s, B)]: 0.3 }, together: { [title(s, A)]: 0.86 } } })
    await s.t.advance(100)
    expect(queries.slice(before).map((q) => ({ unit: q.unit.key, text: q.text, sections: q.sections.length }))).toEqual([{ unit: 'm', text: J, sections: 3 }])
    const work = j(s)
    expect(new Set(work.targets)).toEqual(new Set([s.d(A).sectionId, s.d(B).sectionId]))
    expect(await inputsOf(s, work.id)).toEqual([BRIEF, A, B])
    // A message sent with "Reply to this" has its target given: no candidates are asked for.
    const asked = queries.length
    s.t.model.script('Make it shorter', answer('Shorter.', 10, 20))
    await s.send('Make it shorter', { message: { relation: 'addition' } }, { replyTo: ['Use those recommendations to make a…'] })
    expect(queries).toHaveLength(asked)
  })
})

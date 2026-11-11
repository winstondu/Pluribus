import { DEFAULT_SETTINGS, type DecisionBudget, type ReferentStrategyName, type RoutingSettings } from '@committee/protocol'
import { describe, expect, test } from 'vitest'
import { NEVER_CANCELLED, type DecisionProvider, type DecisionQuestions, type DecisionRequest, type DecisionResult, type ReferentStrategy, type RoutingOutcome, type RoutingPlan } from '../../ports'
import { corpusInput, referenceDecomposer, scene, sceneIds, type CorpusExample, type Scene } from '../corpus'
import { createRouter } from '../pipeline'
import { numberedAnswerSections, supply } from '../supply'
import { ancestorsOf, branchingDepth, buildTree, estimateDecisionTokens, segmentFrom } from './index'

/**
 * The two referent strategies over a scripted decision provider
 * (docs/build/dependency-decisioning.md). Decisions are stated by section
 * handle: `own` is "does the message refer to this section", `together`
 * "does it build on this group as a whole", `under` "does it refer to
 * anything built on this section". Anything not stated is answered no.
 */

const BRIEF = 'Trip brief: Kyoto, five days, November, moderate budget'

/** The running example of 01 and 04: brief → A, B (siblings, joined back) → J; B → B2; and the unrelated S. */
const trip = (open = false) => {
  const s = scene()
    .chain('trip', 'root', 'trip')
    .add('brief', { chain: 'trip', on: null, label: 'brief', request: BRIEF, answer: 'Noted.' })
    .chain('A', 'fork', 'neighborhoods')
    .add('A', { chain: 'A', on: 'brief', label: 'neighborhoods', request: 'Suggest neighborhoods to stay in', consumed: ['brief'], ...(open ? { state: 'running' as const } : { answer: 'Gion or Higashiyama.' }) })
    .chain('B', 'fork', 'activities')
    .add('B', { chain: 'B', on: 'brief', label: 'activities', request: 'Suggest rainy-day activities', consumed: ['brief'], ...(open ? { state: 'running' as const } : { answer: 'Museums and tea houses.' }) })
    .group('G', { base: 'trip', start: 'brief', members: ['A', 'B'], open })
  return s
}
const tripClosed = trip().build()
const tripRunning = trip(true).build()
const tripFull = trip()
  .add('J', { chain: 'trip', on: 'jb_G', label: 'itinerary', request: 'Make a five-day itinerary', answer: 'Day 1: Gion.', consumed: ['brief', 'A', 'B'] })
  .chain('b2', 'branch', 'cheaper activities')
  .add('B2', { chain: 'b2', on: 'B', label: 'cheaper activities', request: 'Give me three cheaper alternatives', answer: 'Free shrines.', consumed: ['brief', 'B'] })
  .chain('sky', 'root', 'sky')
  .add('S', { chain: 'sky', on: null, label: 'sky', request: 'Why is the sky blue?', answer: 'Rayleigh scattering.' })
  .build()

interface Rules {
  readonly relation?: 'new' | 'addition' | 'dependent'
  readonly corrective?: number
  readonly several?: number
  readonly own?: { readonly [handle: string]: number }
  readonly together?: { readonly [groupHandle: string]: number }
  readonly under?: { readonly [handle: string]: number }
}

/** Answers by handle and records every request. Sections are found by their number in the state text, as the pipeline numbered them. */
function scripted(sc: Scene, rules: Rules, numberOf: ReadonlyMap<string, number>) {
  const requests: DecisionRequest<DecisionQuestions>[] = []
  const handleOf = new Map([...numberOf].map(([h, n]) => [n, h]))
  const groupHandle = (index: number): string => sc.handles.get(sc.candidates.groups[index - 1]?.groupId ?? '')?.replace('group:', '') ?? ''
  const provider: DecisionProvider = {
    async decide<Q extends DecisionQuestions>(request: DecisionRequest<Q>): Promise<DecisionResult<Q>> {
      requests.push(request)
      const answers: { [id: string]: unknown } = {}
      for (const [id, q] of Object.entries(request.questions)) {
        const question = id.replace(/^m_/, '')
        const number = Number(/\d+$/.exec(question)?.[0])
        let p = 0.05
        if (question === 'several') p = rules.several ?? 0.05
        else if (question === 'corrective') p = rules.corrective ?? 0.05
        else if (/^s\d+$/.test(question)) p = rules.own?.[handleOf.get(number) ?? ''] ?? 0.05
        else if (/^j\d+$/.test(question)) p = rules.together?.[groupHandle(number)] ?? 0.05
        else if (/^u\d+$/.test(question)) p = rules.under?.[handleOf.get(number) ?? ''] ?? 0.05
        else if (/^uj\d+$/.test(question)) p = rules.under?.[`group:${groupHandle(number)}`] ?? 0.05
        if (q.type === 'choice') {
          const options = Object.keys(q.options)
          const chosen = question === 'relation' ? (rules.relation ?? 'addition') : (options[0] ?? '')
          const confidence = question === 'relation' ? 0.9 : 0.3
          answers[id] = { type: 'choice', choice: chosen, confidence, probabilities: Object.fromEntries(options.map((o) => [o, o === chosen ? confidence : 0])) }
        } else answers[id] = { type: 'noul', probability: p }
      }
      return { ok: true, model: 'scripted', answers: answers as never, usage: null }
    },
  }
  return { provider, requests }
}

interface Routed {
  readonly outcome: RoutingOutcome
  readonly requests: DecisionRequest<DecisionQuestions>[]
  /** IDs of the yes/no questions about sections, groups and subtrees, per request. */
  readonly asked: string[][]
  readonly numberOf: ReadonlyMap<string, number>
}

async function route(
  sc: Scene,
  text: string,
  rules: Rules,
  routing: { readonly strategy?: ReferentStrategyName; readonly budget?: Partial<DecisionBudget>; readonly inject?: ReferentStrategy } = {},
): Promise<Routed> {
  const example: CorpusExample = { id: 'test', covers: ['targets'], note: 'a test scene', scene: sc, text, expect: {} }
  const settings: RoutingSettings = {
    referentStrategy: routing.strategy ?? 'tree-walk',
    referentBudget: { ...DEFAULT_SETTINGS.routing.referentBudget, ...routing.budget },
  }
  const input = corpusInput(example, { ...DEFAULT_SETTINGS, routing: settings })
  const numberOf = new Map(numberedAnswerSections(input, supply(input, [])).map((s) => [sc.handles.get(s.section.sectionId) ?? '', s.n]))
  const { provider, requests } = scripted(sc, rules, numberOf)
  const router = createRouter({ decisionProvider: provider, decomposer: referenceDecomposer(example), ...(routing.inject ? { referentStrategy: routing.inject } : {}) })
  const outcome = await router.route(input, NEVER_CANCELLED)
  const asked = requests.map((r) => Object.keys(r.questions).filter((id) => /^m_(s|j|u|uj)\d+$/.test(id)))
  return { outcome, requests, asked, numberOf }
}

function planOf(routed: Routed): RoutingPlan {
  if (routed.outcome.kind !== 'plan') throw new Error(`Expected a plan, got ${routed.outcome.kind}`)
  return routed.outcome.plan
}

const unit = (routed: Routed) => {
  const first = planOf(routed).units[0]
  if (!first) throw new Error('The plan has no unit')
  return first
}

const sections = (handles: readonly string[]) => handles.map(sceneIds.section)
const ids = (routed: Routed, kind: 's' | 'u', handles: readonly string[]) => handles.map((h) => `m_${kind}${routed.numberOf.get(h) ?? '?'}`)

const STRATEGIES: readonly ReferentStrategyName[] = ['one-pass', 'tree-walk']

describe('context tree', () => {
  test('tree · the join-back is a node under the starting context, every member is its ancestor, and work that continues from it hangs under it', () => {
    const input = corpusInput({ id: 't', covers: ['targets'], note: 'tree', scene: tripFull, text: 'x', expect: {} })
    const tree = buildTree({ sections: numberedAnswerSections(input, supply(input, [])), candidates: input.candidates })
    const node = (h: string) => {
      const found = tree.bySection.get(sceneIds.section(h))
      if (!found) throw new Error(h)
      return found
    }
    const group = tree.byGroup.get(sceneIds.group('G'))
    expect(tree.roots.map((r) => r.key)).toEqual([node('brief').key, node('S').key])
    expect(node('brief').children.map((c) => c.key)).toEqual([node('A').key, node('B').key, group?.key])
    expect(group?.children).toEqual([node('J')])
    expect(node('B').children).toEqual([node('B2')])
    expect(new Set(ancestorsOf(node('J')))).toEqual(new Set([group, node('A'), node('B'), node('brief')]))
    // A run of only children is one segment; a branch point ends it.
    expect(segmentFrom(node('B')).map((n) => n.key)).toEqual([node('B').key, node('B2').key])
    expect(segmentFrom(node('brief'))).toEqual([node('brief')])
    expect(branchingDepth(tree)).toBe(2)
  })
})

describe.each(STRATEGIES)('referents by %s', (strategy) => {
  test('C19 · J is clear about one sibling and weak about the other, and builds on the group as a whole: both are referents and J continues from the join-back', async () => {
    const routed = await route(tripClosed, 'Use those recommendations to make a five-day itinerary.', { own: { A: 0.77, B: 0.3, brief: 0.5 }, several: 0.4, together: { G: 0.86 }, under: { brief: 0.9 } }, { strategy })
    expect(new Set(unit(routed).targets)).toEqual(new Set(sections(['A', 'B'])))
    expect(unit(routed).placement).toEqual({ kind: 'continue', buildsOn: { kind: 'sibling-group', groupId: sceneIds.group('G') } })
    expect(unit(routed).prerequisites).toEqual([])
  })

  test('C9 · J needs both running siblings: it depends on the whole group, never on a subset', async () => {
    const routed = await route(tripRunning, 'Use those recommendations to make a five-day itinerary.', { relation: 'dependent', own: { A: 0.77, B: 0.2 }, together: { G: 0.86 }, under: { brief: 0.9 } }, { strategy })
    expect(new Set(unit(routed).targets)).toEqual(new Set(sections(['A', 'B'])))
    expect(unit(routed).placement).toEqual({ kind: 'continue', buildsOn: { kind: 'sibling-group', groupId: sceneIds.group('G') } })
    expect(unit(routed).prerequisites).toEqual([{ kind: 'sibling-group', groupId: sceneIds.group('G') }])
    expect(unit(routed).relation).toBe('result-dependent')
  })

  test('C20 · a follow-up that names an earlier node of one line and another line is a join chain; validation moves its parents to leaves', async () => {
    // B is not a leaf: B2 continues it. S is a leaf of a separate tree.
    const routed = await route(tripFull, 'Put the activities and the sky explanation into one handout', { own: { B: 0.9, S: 0.9 }, several: 0.9, under: { brief: 0.9 } }, { strategy })
    expect(new Set(unit(routed).targets)).toEqual(new Set(sections(['B', 'S'])))
    expect(unit(routed).placement.kind).toBe('join-chain')
    const applied = unit(routed).placement
    if (applied.kind !== 'join-chain') return
    expect(applied.parents).toEqual([
      { kind: 'node', nodeId: sceneIds.node('B') },
      { kind: 'node', nodeId: sceneIds.node('S') },
    ])
  })

  test('referents · a relevant ancestor is dropped for its relevant descendant, and kept for a correction that names it', async () => {
    const scores: Rules = { own: { brief: 0.9, A: 0.85 }, under: { brief: 0.9 } }
    const followUp = await route(tripClosed, 'Which of those is quietest?', scores, { strategy })
    expect(unit(followUp).targets).toEqual(sections(['A']))
    const correction = await route(tripClosed, 'Actually, the trip is four days, not five', { ...scores, corrective: 0.95 }, { strategy })
    expect(planOf(correction).units).toEqual([])
    expect(new Set(planOf(correction).revisions[0]?.targetDirectiveIds)).toEqual(new Set([sceneIds.directive('brief'), sceneIds.directive('A')]))
  })

  test('referents · nothing relevant: a new chain, and no further request', async () => {
    const routed = await route(tripFull, 'Explain how volcanoes form', { relation: 'new' }, { strategy })
    expect(unit(routed).placement).toEqual({ kind: 'new-chain' })
    expect(routed.requests).toHaveLength(1)
  })
})

describe('one pass', () => {
  test('one-pass · every listed section and every sibling group as a whole is asked about in the pipeline\'s own request, and nothing after it', async () => {
    const routed = await route(tripFull, 'Make that shorter', { own: { J: 0.9 } }, { strategy: 'one-pass' })
    expect(routed.requests).toHaveLength(1)
    expect(new Set(routed.asked[0])).toEqual(new Set([...ids(routed, 's', ['brief', 'A', 'B', 'J', 'B2', 'S']), 'm_j1']))
    expect(Object.keys(routed.requests[0]?.questions ?? {})).toContain('m_several')
  })
})

describe('tree walk', () => {
  test('tree-walk · the roots ride in the pipeline\'s request; a relevant branch point costs one further request that lists only its level, with the join group as a node', async () => {
    const routed = await route(tripFull, 'Use those recommendations to make a five-day itinerary.', { own: { A: 0.8, B: 0.3 }, together: { G: 0.9 }, under: { brief: 0.9 } })
    // Level 0, in the pipeline's request: the roots, and whether anything built on the branch point is relevant.
    expect(new Set(routed.asked[0])).toEqual(new Set([...ids(routed, 's', ['brief', 'S']), ...ids(routed, 'u', ['brief'])]))
    // Level 1, one request: the siblings, the join group, and the runs below them down to the next branch point.
    expect(routed.requests).toHaveLength(2)
    expect(new Set(routed.asked[1])).toEqual(new Set([...ids(routed, 's', ['A', 'B', 'B2', 'J']), 'm_j1']))
    const state = routed.requests[1]?.state ?? ''
    expect(state).toContain('"neighborhoods"')
    expect(state).toContain('were requested in parallel')
    expect(state).not.toContain('"sky"')
    expect(state).not.toContain('Lines of work')
    expect(state).toContain('New message: "Use those recommendations to make a five-day itinerary."')
    expect(new Set(unit(routed).targets)).toEqual(new Set(sections(['A', 'B'])))
    expect(planOf(routed).decision.explanation).toContain('Referents by tree-walk: one further decision request.')
  })

  test('tree-walk · an irrelevant line of work is pruned: nothing below it is ever asked about', async () => {
    const routed = await route(tripFull, 'Turn the sky answer into a haiku', { own: { S: 0.95 } })
    expect(routed.requests).toHaveLength(1)
    const everything = routed.asked.flat()
    for (const id of [...ids(routed, 's', ['A', 'B', 'J', 'B2']), 'm_j1']) expect(everything).not.toContain(id)
    expect(unit(routed).targets).toEqual(sections(['S']))
    expect(unit(routed).placement).toEqual({ kind: 'continue', buildsOn: { kind: 'node', nodeId: sceneIds.node('S') } })
  })

  test('tree-walk · a branch point whose own answer is not relevant is still descended into when what is built on it is', async () => {
    const routed = await route(tripFull, 'Fit the cheaper alternatives into the itinerary', { own: { J: 0.9, B2: 0.85 }, several: 0.8, under: { brief: 0.9 } })
    expect(new Set(unit(routed).targets)).toEqual(new Set(sections(['J', 'B2'])))
    expect(unit(routed).placement.kind).toBe('join-chain')
  })

  test('tree-walk · ancestors of a relevant node are removed: J stands for the group and the siblings it was built on', async () => {
    const routed = await route(tripFull, 'Make the itinerary shorter', { own: { brief: 0.8, A: 0.75, B: 0.75, J: 0.9 }, together: { G: 0.8 }, under: { brief: 0.9 } })
    expect(unit(routed).targets).toEqual(sections(['J']))
    expect(unit(routed).placement).toEqual({ kind: 'continue', buildsOn: { kind: 'node', nodeId: sceneIds.node('J') } })
  })

  test('tree-walk · a linear conversation is one request, however long: a run of only children is never walked one node at a time', async () => {
    const s = scene().chain('chat', 'root', 'chat')
    for (let i = 0; i < 12; i++) s.add(`T${i}`, { chain: 'chat', on: i === 0 ? null : `T${i - 1}`, label: `turn ${i}`, request: `Question ${i}`, answer: `Answer ${i}` })
    const routed = await route(s.build(), 'Make that shorter', { own: { T11: 0.9, T10: 0.3 } })
    expect(routed.requests).toHaveLength(1)
    expect(routed.asked[0]).toHaveLength(12)
    expect(unit(routed).targets).toEqual(sections(['T11']))
  })
})

/** A tree three branch points deep: every level must be asked about to reach the leaf. */
const deep = (() => {
  const s = scene().chain('c0', 'root', 'root')
  s.add('N0', { chain: 'c0', on: null, label: 'level 0', request: 'Plan a conference', answer: 'Noted.' })
  for (let level = 1; level <= 3; level++) {
    for (const side of ['a', 'b']) {
      const handle = `N${level}${side}`
      s.chain(handle, 'fork', handle).add(handle, { chain: handle, on: level === 1 ? 'N0' : `N${level - 1}a`, label: `level ${level}${side}`, request: `Detail ${level}${side}`, answer: `Answer ${level}${side}` })
    }
  }
  return s.build()
})()
const deepRules: Rules = { own: { N3a: 0.9 }, under: { N0: 0.9, N1a: 0.9, N2a: 0.9 } }

describe('decision budget', () => {
  test('guard · within the budget the walk reaches the leaf: one further request per branching level', async () => {
    const routed = await route(deep, 'Expand detail 3a', deepRules)
    expect(routed.requests).toHaveLength(4)
    expect(unit(routed).targets).toEqual(sections(['N3a']))
    expect(planOf(routed).decision.explanation).toContain('Referents by tree-walk: 3 further decision requests.')
  })

  test('guard · a walk that would exceed its request budget stops and asks the remaining candidates in one request instead', async () => {
    const routed = await route(deep, 'Expand detail 3a', deepRules, { budget: { requests: 2 } })
    // The pipeline's request, one level of the walk, then the one-pass questions not asked yet. Never a fourth.
    expect(routed.requests).toHaveLength(3)
    expect(new Set(routed.asked[2])).toEqual(new Set(ids(routed, 's', ['N2a', 'N2b', 'N3a', 'N3b'])))
    expect(routed.requests[2]?.state).toBe(routed.requests[0]?.state)
    expect(unit(routed).targets).toEqual(sections(['N3a']))
    expect(planOf(routed).decision.explanation).toContain('its request budget was reached, so the remaining candidates were asked about in one request')
  })

  test('guard · the question and token budgets stop the walk the same way', async () => {
    const byQuestions = await route(deep, 'Expand detail 3a', deepRules, { budget: { questions: 9 } })
    expect(byQuestions.requests).toHaveLength(3)
    expect(planOf(byQuestions).decision.explanation).toContain('its question budget was reached')
    expect(unit(byQuestions).targets).toEqual(sections(['N3a']))

    // Room for the first level and for the fallback as it stands before that level, not for the second level as well.
    const whole = await route(deep, 'Expand detail 3a', deepRules)
    const firstLevel = whole.requests[1]
    const onePass = await route(deep, 'Expand detail 3a', deepRules, { strategy: 'one-pass' })
    const notYetAsked = Object.fromEntries(Object.entries(onePass.requests[0]?.questions ?? {}).filter(([id]) => /^m_s\d+$/.test(id) && id !== 'm_s1'))
    const reserve = estimateDecisionTokens(whole.requests[0]?.state ?? '', notYetAsked as never)
    const byTokens = await route(deep, 'Expand detail 3a', deepRules, {
      budget: { inputTokens: estimateDecisionTokens(firstLevel?.state ?? '', (firstLevel?.questions ?? {}) as never) + reserve },
    })
    expect(byTokens.requests).toHaveLength(3)
    expect(planOf(byTokens).decision.explanation).toContain('its input-token budget was reached')
    expect(unit(byTokens).targets).toEqual(sections(['N3a']))
  })

  test('guard · with no room for even that request, the referents are the relevant nodes reached, and nothing further is sent', async () => {
    const routed = await route(deep, 'Expand detail 3a', { own: { N0: 0.9, N3a: 0.9 }, under: deepRules.under ?? {} }, { budget: { requests: 0 } })
    expect(routed.requests).toHaveLength(1)
    expect(unit(routed).targets).toEqual(sections(['N0']))
    expect(planOf(routed).decision.explanation).toContain('its request budget was reached, so it kept what it had scored')
  })

  test('guard · a strategy that keeps asking is refused at the budget: the provider never sees a request beyond it', async () => {
    const refusals: string[] = []
    const greedy: ReferentStrategy = {
      name: 'greedy',
      questions: () => ({}),
      async resolve(request, _gate, ask) {
        for (let i = 0; i < 50; i++) {
          const result = await ask(request.stateText, { [`m_x${i}`]: { type: 'noul', instructions: 'Again?' } })
          if (result.kind === 'refused') refusals.push(result.limit)
        }
        return { ok: true, units: { m: { sections: [], several: null } }, fallback: null }
      },
    }
    const routed = await route(tripClosed, 'Make that shorter', {}, { inject: greedy, budget: { requests: 3 } })
    expect(routed.requests).toHaveLength(1 + 3)
    expect(refusals).toHaveLength(47)
    expect(new Set(refusals)).toEqual(new Set(['requests']))
    expect(routed.outcome.kind).toBe('plan')
  })

  test('guard · one pass is bounded by construction: no further request, and at most one question per listed section and group', async () => {
    const s = scene()
    for (let i = 0; i < 40; i++) s.chain(`c${i}`, 'root', `topic ${i}`).add(`T${i}`, { chain: `c${i}`, on: null, label: `topic ${i}`, request: `Question ${i}`, answer: `Answer ${i}` })
    const routed = await route(s.build(), 'Explain how volcanoes form', { relation: 'new' }, { strategy: 'one-pass' })
    expect(routed.requests).toHaveLength(1)
    expect(routed.asked[0]).toHaveLength(24)
  })
})

describe('strategy swap', () => {
  test('swap · the same plan comes out whichever strategy scored the referents, and the pipeline accepts any implementation of the interface', async () => {
    const rules: Rules = { own: { A: 0.9, B: 0.85 }, several: 0.9, under: { brief: 0.9 } }
    const text = 'Make an itinerary from the neighborhoods and the activities'
    const stub: ReferentStrategy = {
      name: 'stub',
      questions: () => ({}),
      resolve: async () => ({
        ok: true,
        units: { m: { sections: [{ sectionId: sceneIds.section('A'), confidence: 0.9 }, { sectionId: sceneIds.section('B'), confidence: 0.85 }], several: 0.9 } },
        fallback: null,
      }),
    }
    const plans = [
      planOf(await route(tripClosed, text, rules, { strategy: 'one-pass' })),
      planOf(await route(tripClosed, text, rules, { strategy: 'tree-walk' })),
      planOf(await route(tripClosed, text, {}, { inject: stub })),
    ]
    const shape = (plan: RoutingPlan) => plan.units.map((u) => ({ targets: [...u.targets].sort(), placement: u.placement, prerequisites: u.prerequisites, relation: u.relation }))
    expect(shape(plans[1] as RoutingPlan)).toEqual(shape(plans[0] as RoutingPlan))
    expect(shape(plans[2] as RoutingPlan)).toEqual(shape(plans[0] as RoutingPlan))
    expect(shape(plans[0] as RoutingPlan)).toEqual([
      { targets: sections(['A', 'B']).sort(), placement: { kind: 'continue', buildsOn: { kind: 'sibling-group', groupId: sceneIds.group('G') } }, prerequisites: [], relation: 'addition' },
    ])
  })

  test('swap · a strategy cannot name a section that was not supplied', async () => {
    const rogue: ReferentStrategy = {
      name: 'rogue',
      questions: () => ({}),
      resolve: async () => ({ ok: true, units: { m: { sections: [{ sectionId: sceneIds.section('nowhere'), confidence: 0.99 }], several: null } }, fallback: null }),
    }
    const routed = await route(tripClosed, 'Explain how volcanoes form', { relation: 'new' }, { inject: rogue })
    expect(unit(routed).targets).toEqual([])
    expect(unit(routed).placement).toEqual({ kind: 'new-chain' })
  })
})

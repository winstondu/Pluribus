import { DEFAULT_SETTINGS, type NodeId, type DecisionBudget, type DecisionCostGuard, type ReferentStrategyName, type RoutingSettings, type TreeWalkSettings } from '@committee/protocol'
import { describe, expect, test } from 'vitest'
import { NEVER_CANCELLED, type DecisionContext, type RoutingInput, type DecisionProvider, type DecisionQuestions, type DecisionRequest, type DecisionResult, type ReferentStrategy, type RoutingOutcome, type RoutingPlan } from '../../ports'
import { corpusInput, referenceDecomposer, scene, sceneIds, type CorpusExample, type Scene } from '../corpus'
import { createRouter } from '../pipeline'
import { numberedAnswerSections, supply } from '../supply'
import { ancestorsOf, branchingDepth, buildTree, decisionAllowance, estimateDecisionTokens, segmentFrom } from './index'

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
  /** A chunk of a searched run scores the highest `own` of the sections it names, unless one of them is stated here. */
  readonly chunk?: { readonly [handle: string]: number }
  /** What a section scores the first time it is asked about, when that differs from `own`: asked about without its neighbours. */
  readonly alone?: { readonly [handle: string]: number }
}

/** Answers by handle and records every request. Sections are found by their number in the state text, as the pipeline numbered them. */
function scripted(sc: Scene, rules: Rules, numberOf: ReadonlyMap<string, number>) {
  const requests: DecisionRequest<DecisionQuestions>[] = []
  const seen = new Set<string>()
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
        else if (/^s\d+$/.test(question)) p = (seen.has(id) ? undefined : rules.alone?.[handleOf.get(number) ?? '']) ?? rules.own?.[handleOf.get(number) ?? ''] ?? 0.05
        else if (/^j\d+$/.test(question)) p = rules.together?.[groupHandle(number)] ?? 0.05
        else if (/^u\d+$/.test(question)) p = rules.under?.[handleOf.get(number) ?? ''] ?? 0.05
        else if (/^uj\d+$/.test(question)) p = rules.under?.[`group:${groupHandle(number)}`] ?? 0.05
        else if (/^c\d+_\d+$/.test(question)) {
          const named = [...q.instructions.matchAll(/S(\d+) \(/g)].map((m) => handleOf.get(Number(m[1])) ?? '')
          p = Math.max(0.05, ...named.map((h) => rules.chunk?.[h] ?? rules.own?.[h] ?? 0.05))
        }
        seen.add(id)
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
  routing: { readonly strategy?: ReferentStrategyName; readonly budget?: Partial<DecisionBudget>; readonly inject?: ReferentStrategy; readonly treeWalk?: Partial<TreeWalkSettings>; readonly costGuard?: Partial<DecisionCostGuard>; readonly summaries?: (nodeId: NodeId) => DecisionContext | null } = {},
): Promise<Routed> {
  const example: CorpusExample = { id: 'test', covers: ['targets'], note: 'a test scene', scene: sc, text, expect: {} }
  const settings: RoutingSettings = {
    referentStrategy: routing.strategy ?? 'tree-walk',
    referentBudget: { ...DEFAULT_SETTINGS.routing.referentBudget, ...routing.budget },
    treeWalk: { ...DEFAULT_SETTINGS.routing.treeWalk, ...routing.treeWalk },
    costGuard: { ...DEFAULT_SETTINGS.routing.costGuard, ...routing.costGuard },
    useSummaryIfAvailable: routing.summaries !== undefined,
    backgroundSummaries: false,
  }
  const input: RoutingInput = { ...corpusInput(example, { ...DEFAULT_SETTINGS, routing: settings }), ...(routing.summaries ? { decisionContext: routing.summaries } : {}) }
  const numberOf = new Map(numberedAnswerSections(input, supply(input, [])).map((s) => [sc.handles.get(s.section.sectionId) ?? '', s.n]))
  const { provider, requests } = scripted(sc, rules, numberOf)
  const router = createRouter({ decisionProvider: provider, decomposer: referenceDecomposer(example), ...(routing.inject ? { referentStrategy: routing.inject } : {}) })
  const outcome = await router.route(input, NEVER_CANCELLED)
  const asked = requests.map((r) => Object.keys(r.questions).filter((id) => /^m_((s|j|u|uj)\d+|c\d+_\d+)$/.test(id)))
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

describe('price guard', () => {
  test('guard · the walk goes on without its reserve when the fallback is what the budget cannot pay for and the level is', async () => {
    const whole = await route(tripFull, 'Use those recommendations to make a five-day itinerary.', { own: { A: 0.8, B: 0.3 }, together: { G: 0.9 }, under: { brief: 0.9 } })
    const level = whole.requests[1]
    const cost = estimateDecisionTokens(level?.state ?? '', (level?.questions ?? {}) as never)
    // Room for the level and nothing else: the fallback, a request over the pipeline's whole state text, costs more.
    const routed = await route(tripFull, 'Use those recommendations to make a five-day itinerary.', { own: { A: 0.8, B: 0.3 }, together: { G: 0.9 }, under: { brief: 0.9 } }, { budget: { inputTokens: cost } })
    expect(routed.requests).toHaveLength(2)
    expect(new Set(unit(routed).targets)).toEqual(new Set(sections(['A', 'B'])))
    expect(planOf(routed).decision.explanation).not.toContain('budget was reached')
  })

  test('guard · the strategy\'s token budget is what twice the answer\'s price leaves after the pipeline\'s own request', async () => {
    const rules: Rules = { own: { A: 0.8, B: 0.3 }, together: { G: 0.9 }, under: { brief: 0.9 } }
    const text = 'Use those recommendations to make a five-day itinerary.'
    // Fewer than five completed answers, so the setting's figure is the expected output. An answer expected to be a few tokens long buys less than the pipeline's request costs: nothing further is sent.
    const cheap = await route(tripClosed, text, rules, { costGuard: { expectedOutputTokens: 5 } })
    expect(cheap.requests).toHaveLength(1)
    expect(planOf(cheap).decision.explanation).toContain('its input-token budget was reached')
    // Off, or with an answer of ordinary length, the walk is as before.
    for (const costGuard of [{ expectedOutputTokens: 5, maxAnswerCostRatio: 0 }, {}]) {
      const routed = await route(tripClosed, text, rules, { costGuard })
      expect(routed.requests).toHaveLength(2)
      expect(new Set(unit(routed).targets)).toEqual(new Set(sections(['A', 'B'])))
    }
    // The allowance: 2 × (14 tokens of message × $0.10 + 1,700 × $0.50) ÷ $0.042, per piece of work.
    expect(decisionAllowance(DEFAULT_SETTINGS.routing.costGuard, { messageLength: 55, answerLengths: [], units: 1 })).toBe(40_542)
    // Five completed answers or more: their median length, not below 250 tokens.
    expect(decisionAllowance(DEFAULT_SETTINGS.routing.costGuard, { messageLength: 0, answerLengths: [400, 4000, 4000, 4000, 40_000], units: 1 })).toBe(Math.floor((2 * 1000 * 0.5) / 0.042))
    expect(decisionAllowance(DEFAULT_SETTINGS.routing.costGuard, { messageLength: 0, answerLengths: [4, 4, 4, 4, 4], units: 2 })).toBe(Math.floor((2 * 2 * 250 * 0.5) / 0.042))
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

// ───────────────────────────── long runs ─────────────────────────────

/** One chain of `n` exchanges: a single trunk that never splits. */
const flat = (n: number): Scene => {
  const s = scene().chain('chat', 'root', 'chat')
  for (let i = 0; i < n; i++) s.add(`T${i}`, { chain: 'chat', on: i === 0 ? null : `T${i - 1}`, label: `turn ${i}`, request: `Question ${i}`, answer: `Answer ${i}` })
  return s.build()
}

/** `n` unrelated one-answer lines: every section is a root. */
const wide = (n: number): Scene => {
  const s = scene()
  for (let i = 0; i < n; i++) s.chain(`c${i}`, 'root', `topic ${i}`).add(`T${i}`, { chain: `c${i}`, on: null, label: `topic ${i}`, request: `Question ${i}`, answer: `Answer ${i}` })
  return s.build()
}

/** A trunk of ten (T0…T9) that splits at T9 into X and Y. */
const trunk = (() => {
  const s = scene().chain('chat', 'root', 'chat')
  for (let i = 0; i < 10; i++) s.add(`T${i}`, { chain: 'chat', on: i === 0 ? null : `T${i - 1}`, label: `turn ${i}`, request: `Question ${i}`, answer: `Answer ${i}` })
  for (const side of ['X', 'Y']) s.chain(side, 'branch', side).add(side, { chain: side, on: 'T9', label: `side ${side}`, request: `Branch ${side}`, answer: `Answer ${side}` })
  return s.build()
})()

/** A brief with two branches of only children: A…A4, which splits into P and Q, and B…B3, which ends. */
const runs = (() => {
  const s = scene().chain('c', 'root', 'brief').add('brief', { chain: 'c', on: null, label: 'brief', request: 'Plan a product launch', answer: 'Noted.' })
  s.chain('a', 'branch', 'a')
  ;['A', 'A1', 'A2', 'A3', 'A4'].forEach((h, i, all) => s.add(h, { chain: 'a', on: i === 0 ? 'brief' : (all[i - 1] ?? null), label: `press ${i}`, request: `Press step ${i}`, answer: `Done ${h}` }))
  for (const side of ['P', 'Q']) s.chain(side, 'branch', side).add(side, { chain: side, on: 'A4', label: `variant ${side}`, request: `Variant ${side}`, answer: `Answer ${side}` })
  s.chain('b', 'branch', 'b')
  ;['B', 'B1', 'B2', 'B3'].forEach((h, i, all) => s.add(h, { chain: 'b', on: i === 0 ? 'brief' : (all[i - 1] ?? null), label: `pricing ${i}`, request: `Pricing step ${i}`, answer: `Done ${h}` }))
  return s.build()
})()

const chunkIds = (routed: Routed, request: number): string[] => (routed.asked[request] ?? []).filter((id) => /^m_c/.test(id))
const ownIds = (routed: Routed, request: number): string[] => (routed.asked[request] ?? []).filter((id) => /^m_s/.test(id))
/** What the guard counted for the further requests. */
const furtherTokens = (routed: Routed): number => routed.requests.slice(1).reduce((sum, r) => sum + estimateDecisionTokens(r.state, r.questions as never), 0)
const NEVER_SEARCH: Partial<TreeWalkSettings> = { searchRunsOverTokens: 1_000_000 }

const COMBINATIONS: readonly (readonly [string, Partial<TreeWalkSettings>])[] = [
  ['neither switch', {}],
  ['start at the trunk base', { startAtTrunkBase: true }],
  ['hops between branch points', { hopBetweenBranchPoints: true }],
  ['trunk base and hops', { startAtTrunkBase: true, hopBetweenBranchPoints: true }],
]

describe('long runs · search', () => {
  test('search · a 200-section conversation on one chain: a section far older than the window is found within the budget, by chunks and then one by one', async () => {
    const sc = flat(200)
    const routed = await route(sc, 'Make the answer to question 40 shorter', { own: { T40: 0.9 } })
    // The pipeline's request, the chunks of the 176 older sections, then the sections of the one relevant chunk.
    expect(routed.requests).toHaveLength(3)
    expect(chunkIds(routed, 0)).toEqual([])
    expect(ownIds(routed, 0)).toHaveLength(24)
    expect(chunkIds(routed, 1).length).toBeGreaterThan(1)
    expect(ownIds(routed, 1)).toEqual([])
    expect(chunkIds(routed, 2)).toEqual([])
    expect(ownIds(routed, 2)).toContain(`m_s${routed.numberOf.get('T40') ?? '?'}`)
    expect(ownIds(routed, 2).length).toBeLessThan(40)
    expect(unit(routed).targets).toEqual(sections(['T40']))
    expect(unit(routed).placement).toEqual({ kind: 'continue', buildsOn: { kind: 'node', nodeId: sceneIds.node('T40') } })
    expect(planOf(routed).decision.explanation).not.toContain('budget was reached')
    expect(furtherTokens(routed)).toBeLessThanOrEqual(DEFAULT_SETTINGS.routing.referentBudget.inputTokens)

    // Asked about one by one, the older sections do not fit the budget: the walk falls back and never reaches the section.
    const listed = await route(sc, 'Make the answer to question 40 shorter', { own: { T40: 0.9 } }, { treeWalk: NEVER_SEARCH })
    expect(planOf(listed).decision.explanation).toContain('budget was reached')
    expect(unit(listed).targets).toEqual([])
  })

  test('search · 200 unrelated one-answer lines: the old roots are searched as one run and the one referred to is found within the budget', async () => {
    const routed = await route(wide(200), 'Expand the answer on topic 17', { own: { T17: 0.9 } })
    expect(routed.requests).toHaveLength(3)
    expect(unit(routed).targets).toEqual(sections(['T17']))
    expect(planOf(routed).decision.explanation).not.toContain('budget was reached')
  })

  test.each([['start', 'T0'], ['middle', 'T88'], ['end', 'T175']])('search · a referent at the %s of a long run is resolved exactly', async (_where, handle) => {
    const routed = await route(flat(200), 'Expand that earlier answer', { own: { [handle]: 0.9 } })
    expect(unit(routed).targets).toEqual(sections([handle]))
    expect(unit(routed).placement).toEqual({ kind: 'continue', buildsOn: { kind: 'node', nodeId: sceneIds.node(handle) } })
    expect(routed.requests).toHaveLength(3)
  })

  test('search · two referents in different chunks: both chunks are followed in the same request', async () => {
    const routed = await route(wide(200), 'Compare the answer on topic 3 with the one on topic 150', { own: { T3: 0.9, T150: 0.9 }, several: 0.9 })
    expect(routed.requests).toHaveLength(3)
    expect(ownIds(routed, 2)).toEqual(expect.arrayContaining(ids(routed, 's', ['T3', 'T150'])))
    expect(new Set(unit(routed).targets)).toEqual(new Set(sections(['T3', 'T150'])))
    expect(unit(routed).placement.kind).toBe('join-chain')
  })

  test('search · no chunk is relevant: the search ends after one request and nothing in the run is a referent', async () => {
    const routed = await route(flat(200), 'Explain how volcanoes form', { relation: 'new' })
    expect(routed.requests).toHaveLength(2)
    expect(ownIds(routed, 1)).toEqual([])
    expect(unit(routed).placement).toEqual({ kind: 'new-chain' })
  })

  test('search · a chunk question is asked beside the most recent answer, whose line is in the state text', async () => {
    const routed = await route(flat(200), 'Make the answer to question 40 shorter', { own: { T40: 0.9 } })
    expect(Object.keys(routed.requests[1]?.questions ?? {})).toContain('m_recent')
    expect(routed.requests[1]?.state).toContain('"turn 199"')
    expect(routed.requests[1]?.state).not.toContain('"turn 198"')
    // Each section of a chunk is named by the request it answered.
    expect(JSON.stringify(routed.requests[1]?.questions)).toContain('(\\"Question 40\\")')
  })

  test('search · a run with more chunks than one request carries is split again: the requests grow with the logarithm of its length', async () => {
    const routed = await route(flat(424), 'Make the answer to question 40 shorter', { own: { T40: 0.9 } }, { treeWalk: { searchRunsOverTokens: 200 } })
    // 400 older sections at four to a chunk are 100 chunks: 24 groups first, then the chunks of the relevant group, then its sections.
    expect(routed.requests).toHaveLength(4)
    expect(chunkIds(routed, 1)).toHaveLength(24)
    expect(chunkIds(routed, 2).length).toBeGreaterThan(1)
    expect(chunkIds(routed, 2).length).toBeLessThanOrEqual(24)
    expect(ownIds(routed, 3).length).toBeLessThanOrEqual(6)
    expect(unit(routed).targets).toEqual(sections(['T40']))
  })

  test('search · the budget ends the search before the relevant chunk is listed: its sections are put to the user, and none is taken', async () => {
    const routed = await route(flat(200), 'Make the answer to question 40 shorter', { own: { T40: 0.9 } }, { budget: { requests: 1 } })
    // The pipeline's request and the chunks. The request that would list the chunk's sections is never sent.
    expect(routed.requests).toHaveLength(2)
    expect(routed.outcome.kind).toBe('target-ambiguity')
    if (routed.outcome.kind !== 'target-ambiguity') return
    const candidates = routed.outcome.candidates
    expect(candidates.map((c) => c.sectionId)).toContain(sceneIds.section('T40'))
    expect(candidates.length).toBeLessThan(40)
    for (const c of candidates) expect(c.confidence).toBeLessThan(DEFAULT_SETTINGS.thresholds.targetChoice)
  })

  test('search · the budget guard holds: a search never sends more than the budget allows, whatever the tree', async () => {
    for (const budget of [{ requests: 0 }, { requests: 1 }, { requests: 2 }, { questions: 10 }, { inputTokens: 900 }]) {
      const routed = await route(wide(300), 'Compare the answer on topic 3 with the one on topic 150', { own: { T3: 0.9, T150: 0.9 }, several: 0.9 }, { budget })
      const allowed = { ...DEFAULT_SETTINGS.routing.referentBudget, ...budget }
      const further = routed.requests.slice(1)
      expect(further.length).toBeLessThanOrEqual(allowed.requests)
      expect(further.reduce((sum, r) => sum + Object.keys(r.questions).length, 0)).toBeLessThanOrEqual(allowed.questions)
      expect(furtherTokens(routed)).toBeLessThanOrEqual(allowed.inputTokens)
    }
  })
})

describe('long runs · start at the trunk base', () => {
  const on: Partial<TreeWalkSettings> = { startAtTrunkBase: true }

  test('trunk · off, every section of the trunk is asked about; on, only its base, and the sections above it ride as one chunk question', async () => {
    const off = await route(trunk, 'Explain how volcanoes form', { relation: 'new' })
    expect(new Set(off.asked[0])).toEqual(new Set([...ids(off, 's', ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9']), ...ids(off, 'u', ['T9'])]))
    const routed = await route(trunk, 'Explain how volcanoes form', { relation: 'new' }, { treeWalk: on })
    expect(routed.requests).toHaveLength(1)
    expect(new Set(routed.asked[0])).toEqual(new Set([...ids(routed, 's', ['T9']), ...ids(routed, 'u', ['T9']), `m_c${routed.numberOf.get('T0') ?? '?'}_${routed.numberOf.get('T8') ?? '?'}`]))
  })

  test('trunk · a reply to a section in the middle of the trunk is resolved exactly: its chunk is relevant, so its sections are asked about one by one', async () => {
    const routed = await route(trunk, 'Make the answer to question 4 shorter', { own: { T4: 0.9 } }, { treeWalk: on })
    expect(routed.requests).toHaveLength(2)
    // The relevant chunk also counts for the trunk: what is built on its base is looked at in the same request.
    expect(new Set(ownIds(routed, 1))).toEqual(new Set(ids(routed, 's', ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'X', 'Y'])))
    expect(unit(routed).targets).toEqual(sections(['T4']))
    expect(unit(routed).placement).toEqual({ kind: 'continue', buildsOn: { kind: 'node', nodeId: sceneIds.node('T4') } })
  })

  test('trunk · with no budget to look inside the trunk, a reply to a section in it is put to the user and is not placed on the base', async () => {
    const routed = await route(trunk, 'Make the answer to question 4 shorter', { own: { T4: 0.9 } }, { treeWalk: on, budget: { requests: 0 } })
    expect(routed.requests).toHaveLength(1)
    expect(routed.outcome.kind).toBe('target-ambiguity')
    if (routed.outcome.kind !== 'target-ambiguity') return
    expect(new Set(routed.outcome.candidates.map((c) => c.sectionId))).toEqual(new Set(sections(['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8'])))
  })

  test('trunk · a correction still keeps the ancestor it revises, found through the chunk above the base', async () => {
    const routed = await route(trunk, 'Actually, question 0 was about four days, not five', { own: { T0: 0.9, X: 0.85 }, under: { T9: 0.9 }, corrective: 0.95 }, { treeWalk: on })
    expect(planOf(routed).units).toEqual([])
    expect(new Set(planOf(routed).revisions[0]?.targetDirectiveIds)).toEqual(new Set([sceneIds.directive('T0'), sceneIds.directive('X')]))
  })

  test('trunk · a trunk that never splits: the tip is the base, and a long flat conversation is one chunk request away from any section', async () => {
    const routed = await route(flat(200), 'Make the answer to question 40 shorter', { own: { T40: 0.9 } }, { treeWalk: on })
    // In the pipeline's request: the tip, and two chunks of the other listed sections instead of 23 questions.
    expect(ownIds(routed, 0)).toEqual(ids(routed, 's', ['T199']))
    expect(chunkIds(routed, 0).length).toBeGreaterThan(0)
    expect(chunkIds(routed, 0).length).toBeLessThan(6)
    expect(routed.requests).toHaveLength(3)
    expect(unit(routed).targets).toEqual(sections(['T40']))
    const latest = await route(flat(200), 'Make that shorter', { own: { T199: 0.9 } }, { treeWalk: on })
    expect(latest.requests).toHaveLength(2)
    expect(unit(latest).targets).toEqual(sections(['T199']))
  })
})

describe('long runs · hop between branch points', () => {
  const on: Partial<TreeWalkSettings> = { hopBetweenBranchPoints: true }

  test('hops · off, every section of a branch is asked about; on, only the end of each run, and the sections skipped as one chunk question per run', async () => {
    const off = await route(runs, 'Change variant P', { own: { P: 0.9 }, under: { brief: 0.9, A4: 0.9 } })
    expect(new Set(off.asked[1])).toEqual(new Set([...ids(off, 's', ['A', 'A1', 'A2', 'A3', 'A4', 'B', 'B1', 'B2', 'B3']), ...ids(off, 'u', ['A4'])]))
    const routed = await route(runs, 'Change variant P', { own: { P: 0.9 }, under: { brief: 0.9, A4: 0.9 } }, { treeWalk: on })
    const chunk = (from: string, to: string) => `m_c${routed.numberOf.get(from) ?? '?'}_${routed.numberOf.get(to) ?? '?'}`
    expect(new Set(routed.asked[1])).toEqual(new Set([...ids(routed, 's', ['A4', 'B3']), ...ids(routed, 'u', ['A4']), chunk('A', 'A3'), chunk('B', 'B2')]))
    // The lines of the skipped sections are not sent.
    expect(routed.requests[1]?.state).not.toContain('"press 2"')
    expect(new Set(routed.asked[2])).toEqual(new Set(ids(routed, 's', ['P', 'Q'])))
    expect(unit(routed).targets).toEqual(sections(['P']))
  })

  test('hops · a reply to a section in the middle of a skipped run is resolved exactly, never placed on the end of the hop', async () => {
    const routed = await route(runs, 'Redo pricing step 1', { own: { B1: 0.9 }, under: { brief: 0.9 } }, { treeWalk: on })
    expect(routed.requests).toHaveLength(3)
    // The run's sections, and its end again beside them.
    expect(new Set(routed.asked[2])).toEqual(new Set(ids(routed, 's', ['B', 'B1', 'B2', 'B3'])))
    expect(unit(routed).targets).toEqual(sections(['B1']))
    expect(unit(routed).placement).toEqual({ kind: 'continue', buildsOn: { kind: 'node', nodeId: sceneIds.node('B1') } })
  })

  test('hops · the end of a hop that looked relevant on its own is asked about again beside the run it ends: the reply goes to the section it names', async () => {
    // Without its neighbours B3 scores 0.8 for a reply to B1; beside them it does not. B3 is built on B1, so its first score would have taken the reply.
    const routed = await route(runs, 'Redo pricing step 1', { own: { B1: 0.9 }, alone: { B3: 0.8 }, under: { brief: 0.9 } }, { treeWalk: on })
    expect(routed.asked[1]).toContain(`m_s${routed.numberOf.get('B3') ?? '?'}`)
    expect(routed.asked[2]).toContain(`m_s${routed.numberOf.get('B3') ?? '?'}`)
    expect(unit(routed).targets).toEqual(sections(['B1']))
    expect(unit(routed).placement).toEqual({ kind: 'continue', buildsOn: { kind: 'node', nodeId: sceneIds.node('B1') } })
  })

  test('hops · when the budget ends before the skipped run is looked into, the walk falls back to asking every listed section in one request: still resolved exactly', async () => {
    const routed = await route(runs, 'Redo pricing step 1', { own: { B1: 0.9 }, under: { brief: 0.9 } }, { treeWalk: on, budget: { requests: 1 } })
    // The walk keeps room for its fallback, so with one request left it asks the one-pass questions instead of hopping.
    expect(routed.requests).toHaveLength(2)
    expect(chunkIds(routed, 1)).toEqual([])
    expect(planOf(routed).decision.explanation).toContain('its request budget was reached, so the remaining candidates were asked about in one request')
    expect(unit(routed).targets).toEqual(sections(['B1']))
  })

  test('hops · a relevant chunk of a skipped run is reason to descend below the end of the hop', async () => {
    // Nothing but the chunk says the line A…A4 is relevant; the walk still looks below A4 and inside the run.
    const routed = await route(runs, 'Compare press step 2 with variant Q', { own: { A2: 0.9, Q: 0.9 }, several: 0.9, under: { brief: 0.9 } }, { treeWalk: on })
    expect(new Set(routed.asked[2])).toEqual(new Set(ids(routed, 's', ['A', 'A1', 'A2', 'A3', 'A4', 'P', 'Q'])))
    // Q was built on A2: the nearer section stands for its ancestor.
    expect(unit(routed).targets).toEqual(sections(['Q']))
  })
})

describe.each(COMBINATIONS)('long runs · %s', (_name, treeWalk) => {
  test('C19 · J builds on the group as a whole: both siblings are referents and J continues from the join-back', async () => {
    const routed = await route(tripClosed, 'Use those recommendations to make a five-day itinerary.', { own: { A: 0.77, B: 0.3, brief: 0.5 }, several: 0.4, together: { G: 0.86 }, under: { brief: 0.9 } }, { treeWalk })
    expect(new Set(unit(routed).targets)).toEqual(new Set(sections(['A', 'B'])))
    expect(unit(routed).placement).toEqual({ kind: 'continue', buildsOn: { kind: 'sibling-group', groupId: sceneIds.group('G') } })
    expect(unit(routed).prerequisites).toEqual([])
  })

  test('C9 · J needs both running siblings: it depends on the whole group, never on a subset', async () => {
    const routed = await route(tripRunning, 'Use those recommendations to make a five-day itinerary.', { relation: 'dependent', own: { A: 0.77, B: 0.2 }, together: { G: 0.86 }, under: { brief: 0.9 } }, { treeWalk })
    expect(new Set(unit(routed).targets)).toEqual(new Set(sections(['A', 'B'])))
    expect(unit(routed).placement).toEqual({ kind: 'continue', buildsOn: { kind: 'sibling-group', groupId: sceneIds.group('G') } })
    expect(unit(routed).prerequisites).toEqual([{ kind: 'sibling-group', groupId: sceneIds.group('G') }])
  })

  test('C19 · J after a long trunk and among long branches still lands on the full sibling group', async () => {
    const s = scene().chain('trip', 'root', 'trip')
    for (let i = 0; i < 8; i++) s.add(`T${i}`, { chain: 'trip', on: i === 0 ? null : `T${i - 1}`, label: `brief ${i}`, request: `Trip detail ${i}`, answer: 'Noted.' })
    for (const side of ['A', 'B']) s.chain(side, 'fork', side).add(side, { chain: side, on: 'T7', label: side === 'A' ? 'neighborhoods' : 'activities', request: `Suggest ${side}`, answer: `Answer ${side}`, consumed: ['T7'] })
    s.group('G', { base: 'trip', start: 'T7', members: ['A', 'B'], open: false })
    s.chain('a2', 'branch', 'a2')
    ;['A1', 'A2', 'A3', 'A4'].forEach((h, i, all) => s.add(h, { chain: 'a2', on: i === 0 ? 'A' : (all[i - 1] ?? null), label: `refine ${i}`, request: `Refine ${i}`, answer: `Refined ${h}` }))
    const routed = await route(s.build(), 'Use those recommendations to make a five-day itinerary.', { own: { A: 0.77, B: 0.3 }, together: { G: 0.86 }, under: { T7: 0.9 } }, { treeWalk })
    expect(new Set(unit(routed).targets)).toEqual(new Set(sections(['A', 'B'])))
    expect(unit(routed).placement).toEqual({ kind: 'continue', buildsOn: { kind: 'sibling-group', groupId: sceneIds.group('G') } })
  })

  test('referents · a reply to a section in the middle of a run is resolved exactly, in the trunk and in a branch', async () => {
    const inTrunk = await route(trunk, 'Make the answer to question 4 shorter', { own: { T4: 0.9 } }, { treeWalk })
    expect(unit(inTrunk).targets).toEqual(sections(['T4']))
    const inBranch = await route(runs, 'Redo press step 2', { own: { A2: 0.9 }, under: { brief: 0.9 } }, { treeWalk })
    expect(unit(inBranch).targets).toEqual(sections(['A2']))
  })

  test('referents · a correction keeps the ancestor it revises beside its relevant descendant', async () => {
    const routed = await route(runs, 'Actually, the launch is in March, not May', { own: { brief: 0.9, A2: 0.85 }, under: { brief: 0.9 }, corrective: 0.95 }, { treeWalk })
    expect(planOf(routed).units).toEqual([])
    expect(new Set(planOf(routed).revisions[0]?.targetDirectiveIds)).toEqual(new Set([sceneIds.directive('brief'), sceneIds.directive('A2')]))
  })

  test('guard · the budget holds: no request beyond it, and the walk falls back deterministically', async () => {
    for (const [sc, rules] of [[runs, { own: { P: 0.9, B1: 0.9 }, several: 0.9, under: { brief: 0.9, A4: 0.9 } }], [flat(120), { own: { T30: 0.9 } }]] as const) {
      for (const budget of [{ requests: 0 }, { requests: 1 }, { questions: 4 }, { inputTokens: 700 }]) {
        const first = await route(sc, 'Look at that again', rules, { treeWalk, budget })
        const again = await route(sc, 'Look at that again', rules, { treeWalk, budget })
        const allowed = { ...DEFAULT_SETTINGS.routing.referentBudget, ...budget }
        expect(first.requests.length - 1).toBeLessThanOrEqual(allowed.requests)
        expect(first.requests.slice(1).reduce((sum, r) => sum + Object.keys(r.questions).length, 0)).toBeLessThanOrEqual(allowed.questions)
        expect(furtherTokens(first)).toBeLessThanOrEqual(allowed.inputTokens)
        expect(again.outcome).toEqual(first.outcome)
      }
    }
  })
})

// ───────────────────────────── context summaries ─────────────────────────────

/** A test-only provider: a stored summary anchored at the brief for the handles given, nothing for the rest. */
const summarised = (handles: readonly string[]) => (nodeId: NodeId): DecisionContext | null => {
  const handle = handles.find((h) => sceneIds.node(h) === nodeId)
  if (handle === undefined) return null
  return {
    kind: 'summary',
    nodeId,
    summary: {
      anchorNodeId: sceneIds.node('brief'),
      text: 'The user plans five days in Kyoto in November on a moderate budget.',
      tokens: 16,
      provenance: { summaryId: 'sum_1', model: 'scripted', coveredNodeIds: [sceneIds.node('brief')], recordedSeq: 12 },
    },
    own:
      handle === 'brief'
        ? []
        : [
            { role: 'user', content: `Own request of ${handle}`, origin: { kind: 'preamble' } },
            { role: 'assistant', content: `Own answer of ${handle}`, origin: { kind: 'preamble' } },
          ],
  }
}
/** What the provider the backend uses by default amounts to for a strategy: a full chain, which is not a summary. */
const fullChain = (nodeId: NodeId): DecisionContext => ({ kind: 'full-chain', nodeId, chain: { nodeId, messages: [], nodeIds: [nodeId] } })

describe.each(STRATEGIES)('context summaries, referents by %s', (strategy) => {
  const J_TEXT = 'Use those recommendations to make a five-day itinerary.'
  const rules: Rules = { own: { A: 0.77, B: 0.3, brief: 0.5 }, several: 0.4, together: { G: 0.86 }, under: { brief: 0.9 } }

  test('summaries · with a provider that returns full chains, turning the setting on changes no request and no plan', async () => {
    const off = await route(tripFull, J_TEXT, rules, { strategy })
    const on = await route(tripFull, J_TEXT, rules, { strategy, summaries: fullChain })
    expect(on.requests.map((r) => ({ state: r.state, questions: r.questions }))).toEqual(off.requests.map((r) => ({ state: r.state, questions: r.questions })))
    expect(planOf(on).units).toEqual(planOf(off).units)
    // A provider that has nothing for any node is the same.
    const none = await route(tripFull, J_TEXT, rules, { strategy, summaries: () => null })
    expect(none.requests.map((r) => r.state)).toEqual(off.requests.map((r) => r.state))
  })

  test('summaries · a section that has a summary is shown the summary and its own content; one that has none keeps its usual line; the plan is the same', async () => {
    const off = await route(tripFull, J_TEXT, rules, { strategy })
    const on = await route(tripFull, J_TEXT, rules, { strategy, summaries: summarised(['brief', 'A', 'J']) })
    const shown = on.requests.map((r) => r.state).join('\n')
    // The anchor: its summary. A child of it: the same summary, then the child's own content.
    expect(shown).toContain('"brief": the work before it, summarised: "The user plans five days in Kyoto in November on a moderate budget."')
    expect(shown).toContain('"neighborhoods": the work before it, summarised: "The user plans five days in Kyoto in November on a moderate budget."; after that: request "Own request of A"; answer "Own answer of A"')
    expect(shown).not.toContain('"neighborhoods": request')
    // B has no summary: its line is the usual one, in the same request.
    expect(shown).toContain('"activities": request "Suggest rainy-day activities"; answer "Museums and tea houses."')
    expect(on.requests.map((r) => Object.keys(r.questions))).toEqual(off.requests.map((r) => Object.keys(r.questions)))
    expect(planOf(on).units).toEqual(planOf(off).units)
    // The routing decision says which the decision model saw.
    expect(planOf(on).decision.explanation).toContain('Decision context: a stored summary was shown for 3 of the 6 listed sections.')
    expect(planOf(off).decision.explanation).not.toContain('Decision context')
  })

  test('summaries · the guard counts what is sent: with longer lines the budget still holds', async () => {
    for (const budget of [{ inputTokens: 300 }, { inputTokens: 700 }, { requests: 1 }]) {
      const routed = await route(tripFull, J_TEXT, rules, { strategy, summaries: summarised(['brief', 'A', 'B', 'J', 'B2']), budget })
      const allowed = { ...DEFAULT_SETTINGS.routing.referentBudget, ...budget }
      expect(routed.requests.length - 1).toBeLessThanOrEqual(allowed.requests)
      expect(furtherTokens(routed)).toBeLessThanOrEqual(allowed.inputTokens)
    }
  })
})

import { DEFAULT_SETTINGS, resolveTokenBudget, type NodeId, type DecisionBudget, type DecisionCostGuard, type DecisionTokenBudget, type ReferentStrategyName, type RoutingSettings, type TreeWalkSettings } from '@committee/protocol'
import { describe, expect, test } from 'vitest'
import { NEVER_CANCELLED, type DecisionContext, type RoutingInput, type DecisionProvider, type DecisionQuestions, type DecisionRequest, type DecisionResult, type ReferentStrategy, type RoutingOutcome, type RoutingPlan } from '../../ports'
import { compareWithLabel as compare, corpusInput, oracleDecisionProvider, referenceDecomposer, scene, sceneIds, sceneLogTokens, suppliedIn, type CorpusExample, type Scene } from '../corpus'
import { createRouter } from '../pipeline'
import { MIN_SECTIONS, numberedAnswerSections, supply } from '../supply'
import { FIRST_PASS_SECTIONS, ancestorsOf, bestNodeFound, branchingDepth, buildTree, decisionAllowance, estimateDecisionTokens, estimateRequestTokens, firstPassSectionIds, routingTokenBudget, segmentFrom, type TreeNode } from './index'

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

/**
 * Answers by handle and records every request. Sections are found by their number in the state text, as the pipeline
 * numbered them: `numberOf` is brought up to date from each of the pipeline's own requests, whose window the budget may cut.
 */
function scripted(sc: Scene, rules: Rules, numberOf: Map<string, number>, input: RoutingInput) {
  const requests: DecisionRequest<DecisionQuestions>[] = []
  const seen = new Set<string>()
  let handleOf = new Map([...numberOf].map(([h, n]) => [n, h]))
  const groupHandle = (index: number): string => sc.handles.get(sc.candidates.groups[index - 1]?.groupId ?? '')?.replace('group:', '') ?? ''
  const follow = (state: string): void => {
    const listed = suppliedIn(input, [], state)
    if (!listed) return
    numberOf.clear()
    for (const s of numberedAnswerSections(input, listed)) numberOf.set(sc.handles.get(s.section.sectionId) ?? '', s.n)
    handleOf = new Map([...numberOf].map(([h, n]) => [n, h]))
  }
  const provider: DecisionProvider = {
    async decide<Q extends DecisionQuestions>(request: DecisionRequest<Q>): Promise<DecisionResult<Q>> {
      requests.push(request)
      follow(request.state)
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

/** `budget.inputTokens` is what the strategy may add beyond the pipeline's own request: the routing's token budget is set to that request's size plus it. */
interface RouteOptions {
  readonly strategy?: ReferentStrategyName
  readonly budget?: Partial<DecisionBudget>
  readonly tokenBudget?: DecisionTokenBudget
  readonly inject?: ReferentStrategy
  readonly treeWalk?: Partial<TreeWalkSettings>
  readonly costGuard?: Partial<DecisionCostGuard>
  readonly summaries?: (nodeId: NodeId) => DecisionContext | null
}

async function route(sc: Scene, text: string, rules: Rules, routing: RouteOptions = {}): Promise<Routed> {
  const example: CorpusExample = { id: 'test', covers: ['targets'], note: 'a test scene', scene: sc, text, expect: {} }
  let tokenBudget = routing.tokenBudget ?? DEFAULT_SETTINGS.routing.tokenBudget
  if (routing.budget?.inputTokens !== undefined) {
    const { inputTokens: _further, ...caps } = routing.budget
    const unlimited = await route(sc, text, rules, { ...routing, budget: caps, tokenBudget: { mode: 'absolute', inputTokens: 1_000_000_000 } })
    const own = unlimited.requests[0]
    tokenBudget = { mode: 'absolute', inputTokens: (own ? estimateRequestTokens(own.state, own.questions) : 0) + routing.budget.inputTokens }
  }
  const settings: RoutingSettings = {
    referentStrategy: routing.strategy ?? 'tree-walk',
    strategySelection: 'off',
    referentBudget: { requests: routing.budget?.requests ?? DEFAULT_SETTINGS.routing.referentBudget.requests, questions: routing.budget?.questions ?? DEFAULT_SETTINGS.routing.referentBudget.questions },
    tokenBudget,
    treeWalk: { ...DEFAULT_SETTINGS.routing.treeWalk, ...routing.treeWalk },
    costGuard: { ...DEFAULT_SETTINGS.routing.costGuard, ...routing.costGuard },
    useSummaryIfAvailable: routing.summaries !== undefined,
    backgroundSummaries: false,
  }
  const input: RoutingInput = { ...corpusInput(example, { ...DEFAULT_SETTINGS, routing: settings }), ...(routing.summaries ? { decisionContext: routing.summaries } : {}) }
  const numberOf = new Map(numberedAnswerSections(input, supply(input, [])).map((s) => [sc.handles.get(s.section.sectionId) ?? '', s.n]))
  const { provider, requests } = scripted(sc, rules, numberOf, input)
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
    // Level 0, in the pipeline's request: the roots, and whether anything built on the branch point is relevant. With them the
    // first pass: the most recent sections that no later one builds on (S is one of them and a root).
    expect(new Set(routed.asked[0])).toEqual(new Set([...ids(routed, 's', ['brief', 'S', 'J', 'B2']), ...ids(routed, 'u', ['brief'])]))
    // Level 1, one request: the siblings and the join group. The runs below them were asked about in the first pass.
    expect(routed.requests).toHaveLength(2)
    expect(new Set(routed.asked[1])).toEqual(new Set([...ids(routed, 's', ['A', 'B']), 'm_j1']))
    const state = routed.requests[1]?.state ?? ''
    expect(state).toContain('"neighborhoods"')
    expect(state).toContain('were requested in parallel')
    expect(state).not.toContain('"sky"')
    expect(state).not.toContain('Lines of work')
    expect(state).toContain('New message: "Use those recommendations to make a five-day itinerary."')
    expect(new Set(unit(routed).targets)).toEqual(new Set(sections(['A', 'B'])))
    expect(planOf(routed).decision.explanation).toContain('Referents by tree-walk: one further decision request.')
  })

  test('tree-walk · an irrelevant line of work is pruned: nothing below it is asked about beyond the first pass', async () => {
    const routed = await route(tripFull, 'Turn the sky answer into a haiku', { own: { S: 0.95 } })
    expect(routed.requests).toHaveLength(1)
    const everything = routed.asked.flat()
    for (const id of [...ids(routed, 's', ['A', 'B']), 'm_j1']) expect(everything).not.toContain(id)
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

/** One chain of `n` exchanges, and `n` unrelated one-answer lines: declared here for the first pass, used again for long runs. */
const chainOf = (n: number): Scene => {
  const s = scene().chain('chat', 'root', 'chat')
  for (let i = 0; i < n; i++) s.add(`T${i}`, { chain: 'chat', on: i === 0 ? null : `T${i - 1}`, label: `turn ${i}`, request: `Question ${i}`, answer: `Answer ${i}` })
  return s.build()
}
const rootsOf = (n: number): Scene => {
  const s = scene()
  for (let i = 0; i < n; i++) s.chain(`c${i}`, 'root', `topic ${i}`).add(`T${i}`, { chain: `c${i}`, on: null, label: `topic ${i}`, request: `Question ${i}`, answer: `Answer ${i}` })
  return s.build()
}

describe('first pass', () => {
  test('first-pass · the five most recent answer sections that no later one of them builds on: an ancestor of one already taken is skipped', () => {
    expect(FIRST_PASS_SECTIONS).toBe(5)
    expect(MIN_SECTIONS).toBe(FIRST_PASS_SECTIONS)
    // Unrelated answers: the five most recent, oldest first.
    expect(firstPassSectionIds(rootsOf(40).candidates)).toEqual(sections(['T35', 'T36', 'T37', 'T38', 'T39']))
    // One chain: every earlier answer is in the context of the latest.
    expect(firstPassSectionIds(chainOf(30).candidates)).toEqual(sections(['T29']))
    // The trip: S, B2 and J. B (B2 was built on it), A (J was built on the group) and the brief are ancestors of one taken.
    expect(firstPassSectionIds(tripFull.candidates)).toEqual(sections(['J', 'B2', 'S']))
    // Two siblings nothing was built on yet are both taken; the brief they were requested from is not.
    expect(firstPassSectionIds(tripClosed.candidates)).toEqual(sections(['A', 'B']))
    expect(firstPassSectionIds(deep.candidates)).toEqual(sections(['N1b', 'N2b', 'N3a', 'N3b']))
    expect(firstPassSectionIds(scene().build().candidates)).toEqual([])
  })

  test.each(STRATEGIES)('first-pass · with %s the first-pass sections are asked about by themselves in the routing request, and a sibling group among them as a whole', async (strategy) => {
    const routed = await route(tripFull, 'Explain how volcanoes form', { relation: 'new' }, { strategy })
    for (const id of ids(routed, 's', ['J', 'B2', 'S'])) expect(routed.asked[0]).toContain(id)
    // The siblings are the most recent sections here: each by itself, and the group as a whole beside them.
    const siblings = await route(tripClosed, 'Explain how volcanoes form', { relation: 'new' }, { strategy })
    expect(siblings.requests).toHaveLength(1)
    for (const id of [...ids(siblings, 's', ['A', 'B']), 'm_j1']) expect(siblings.asked[0]).toContain(id)
    // Deep in a tree the walk would only reach the leaves level by level: they are asked about first.
    const leaves = await route(deep, 'Explain how volcanoes form', { relation: 'new' }, { strategy })
    for (const id of ids(leaves, 's', ['N1b', 'N2b', 'N3a', 'N3b'])) expect(leaves.asked[0]).toContain(id)
  })

  test.each(STRATEGIES)('first-pass · with %s, when the budget cuts the routing request to its smallest, the first-pass sections are what it lists and asks about', async (strategy) => {
    const tight: RouteOptions = { strategy, tokenBudget: { mode: 'absolute', inputTokens: 300 } }
    const unrelated = await route(rootsOf(40), 'Make that shorter', { own: { T39: 0.9 } }, tight)
    expect(unrelated.requests).toHaveLength(1)
    expect([...(unrelated.requests[0]?.state ?? '').matchAll(/^S\d+\. "topic (\d+)"/gm)].map((m) => Number(m[1]))).toEqual([35, 36, 37, 38, 39])
    expect(new Set(ownIds(unrelated, 0))).toEqual(new Set(ids(unrelated, 's', ['T35', 'T36', 'T37', 'T38', 'T39'])))
    expect(unit(unrelated).targets).toEqual(sections(['T39']))
    expect(planOf(unrelated).decision.explanation).toContain('listed only the 5 most recent answer sections that no later one of them builds on, the fewest it lists, and still costs more than the decision token budget allows (300 tokens)')
    // A trunk that split: the two branches, not the ten answers of the trunk they were built on.
    const split = await route(trunk, 'Make that shorter', { own: { Y: 0.9 } }, tight)
    expect([...(split.requests[0]?.state ?? '').matchAll(/^S\d+\. "([^"]+)"/gm)].map((m) => m[1])).toEqual(['side X', 'side Y'])
    expect(new Set(ownIds(split, 0))).toEqual(new Set(ids(split, 's', ['X', 'Y'])))
    expect(unit(split).targets).toEqual(sections(['Y']))
  })
})

describe('best node found so far', () => {
  const treeOf = (sc: Scene) => {
    const input = corpusInput({ id: 't', covers: ['targets'], note: 'tree', scene: sc, text: 'x', expect: {} })
    const tree = buildTree({ sections: numberedAnswerSections(input, supply(input, [])), candidates: input.candidates })
    const key = (node: TreeNode): string => (node.kind === 'section' ? (sc.handles.get(node.entry.section.sectionId) ?? '') : 'G')
    const best = (scores: { readonly [handle: string]: number }, corrective = false) => bestNodeFound(tree, (node) => scores[key(node)] ?? null, { corrective, floor: 0.25 })
    return best
  }

  test('best-node · of the nodes asked about by themselves and at least plausible: a descendant before its ancestor, then the higher score, then the more recent', () => {
    const best = treeOf(deep)
    // The higher score.
    expect(best({ N1b: 0.4, N2b: 0.6, N3b: 0.3 })).toEqual({ sectionIds: sections(['N2b']), confidence: 0.6 })
    // A plausible descendant stands for its ancestor, whatever the ancestor scored: its context already holds it.
    expect(best({ N0: 0.65, N1a: 0.6, N3a: 0.3 })).toEqual({ sectionIds: sections(['N3a']), confidence: 0.3 })
    // Not for a correction, which may name the work its descendants only consumed.
    expect(best({ N0: 0.65, N1a: 0.6, N3a: 0.3 }, true)).toEqual({ sectionIds: sections(['N0']), confidence: 0.65 })
    // Equal scores: the more recent in conversation order.
    expect(best({ N1b: 0.45, N2b: 0.45, N3b: 0.45 })).toEqual({ sectionIds: sections(['N3b']), confidence: 0.45 })
    // A descendant below the floor does not stand for anything.
    expect(best({ N0: 0.5, N3a: 0.2 })).toEqual({ sectionIds: sections(['N0']), confidence: 0.5 })
  })

  test('best-node · the floor: nothing asked about by itself is plausible, so there is none; a node that was not asked about has no score', () => {
    const best = treeOf(deep)
    expect(best({ N0: 0.24, N1b: 0.1 })).toBeNull()
    expect(best({})).toBeNull()
    expect(best({ N1b: 0.25 })).toEqual({ sectionIds: sections(['N1b']), confidence: 0.25 })
  })

  test('best-node · a sibling group asked about as a whole is a node: it stands for its members and resolves to all of them', () => {
    const best = treeOf(tripFull)
    expect(best({ A: 0.6, B: 0.3, G: 0.4 })).toEqual({ sectionIds: sections(['A', 'B']), confidence: 0.4 })
    // Work built on the join-back stands for the group.
    expect(best({ A: 0.6, G: 0.4, J: 0.3 })).toEqual({ sectionIds: sections(['J']), confidence: 0.3 })
    // Without the group, one member alone.
    expect(best({ A: 0.6, B: 0.3 })).toEqual({ sectionIds: sections(['A']), confidence: 0.6 })
  })
})

describe('decision budget', () => {
  test('DA4 · the decision budget is a hard stop: no decision request beyond it, the best node found so far in place of a question to the user, and the same routing every time', async () => {
    // Four sections asked about by themselves are plausible and none is clear. N1a and N2a, which only the walk would ask about, are not reached.
    const rules: Rules = { own: { N0: 0.6, N1b: 0.45, N2b: 0.45, N3a: 0.3, N2a: 0.95 }, under: { N0: 0.9 } }
    const text = 'Expand that detail'

    // With budget to spare the walk finishes and the ambiguity is real: the user is asked, as always.
    const spare = await route(deep, text, { ...rules, own: { ...rules.own, N2a: 0.05 } })
    expect(spare.requests.length).toBeGreaterThan(1)
    expect(spare.outcome.kind).toBe('target-ambiguity')

    for (const [budget, limit] of [[{ requests: 0 }, 'requests'], [{ questions: 0 }, 'questions'], [{ inputTokens: 0 }, 'token-budget']] as const) {
      const routed = await route(deep, text, rules, { budget })
      // Nothing is sent beyond the routing request, and the user is not asked.
      expect(routed.requests).toHaveLength(1)
      expect(routed.outcome.kind).toBe('plan')
      // N0 is passed over for its plausible descendants; N1b and N2b score the same and N2b is the more recent.
      expect(unit(routed).targets).toEqual(sections(['N2b']))
      expect(unit(routed).placement).toEqual({ kind: 'continue', buildsOn: { kind: 'node', nodeId: sceneIds.node('N2b') } })
      const decision = planOf(routed).decision
      expect(decision.budgetStop).toEqual({ limit, fallback: 'partial', bestFound: [{ unit: 'message', sectionIds: sections(['N2b']), confidence: 0.45 }] })
      expect(decision.units[0]?.targets.mode).toBe('inferred')
      expect(decision.explanation).toContain('The decision budget is a hard stop, so the user was not asked which section is meant: the best node found so far was used, the message on "level 2b" (0.45).')
      // The same conversation and message: the same requests and the same routing.
      const again = await route(deep, text, rules, { budget })
      expect(again.requests).toEqual(routed.requests)
      expect(again.outcome).toEqual(routed.outcome)
    }

    // The fallback request, when it still fits, is inside the budget too, and what it scores counts: N1a was asked about by itself there.
    const fallback = await route(deep, text, { ...rules, own: { ...rules.own, N1a: 0.5, N2a: 0.05 } }, { budget: { requests: 1 } })
    expect(fallback.requests).toHaveLength(2)
    expect(fallback.outcome.kind).toBe('plan')
    expect(planOf(fallback).decision.budgetStop).toMatchObject({ limit: 'requests', fallback: 'one-pass', bestFound: [{ sectionIds: sections(['N2b']), confidence: 0.45 }] })

    // Nothing asked about by itself is plausible: the message refers to nothing there, and still nobody is asked.
    const nothing = await route(deep, text, { own: { N2a: 0.95 }, under: { N0: 0.9 } }, { budget: { requests: 0 } })
    expect(nothing.outcome.kind).toBe('plan')
    expect(unit(nothing).targets).toEqual([])
    expect(planOf(nothing).decision.budgetStop).toEqual({ limit: 'requests', fallback: 'partial', bestFound: [] })
  })

  test('guard · a strategy that reports a reached limit without naming a best node has its highest-scoring plausible section taken; one whose request the guard refused is stopped the same way', async () => {
    const scored = [
      { sectionId: sceneIds.section('A'), confidence: 0.5 },
      { sectionId: sceneIds.section('B'), confidence: 0.5 },
      { sectionId: sceneIds.section('brief'), confidence: 0.3 },
    ]
    const silent: ReferentStrategy = {
      name: 'silent',
      questions: () => ({}),
      resolve: async () => ({ ok: true, units: { m: { sections: scored, several: null } }, fallback: { limit: 'requests', to: 'partial' } }),
    }
    const routed = await route(tripClosed, 'Make that shorter', {}, { inject: silent })
    expect(unit(routed).targets).toEqual(sections(['B']))
    expect(planOf(routed).decision.budgetStop).toEqual({ limit: 'requests', fallback: 'partial', bestFound: [{ unit: 'message', sectionIds: sections(['B']), confidence: 0.5 }] })
    const refused: ReferentStrategy = {
      name: 'refused',
      questions: () => ({}),
      async resolve(request, _gate, ask) {
        await ask(request.stateText, { m_x: { type: 'noul', instructions: 'Again?' } })
        return { ok: true, units: { m: { sections: scored, several: null } }, fallback: null }
      },
    }
    const stopped = await route(tripClosed, 'Make that shorter', {}, { inject: refused, budget: { requests: 0 } })
    expect(stopped.requests).toHaveLength(1)
    expect(unit(stopped).targets).toEqual(sections(['B']))
    // Not stopped: the same scores are an ordinary ambiguity, and the user is asked.
    const asked = await route(tripClosed, 'Make that shorter', {}, { inject: { ...silent, resolve: async () => ({ ok: true, units: { m: { sections: scored, several: null } }, fallback: null }) } })
    expect(asked.outcome.kind).toBe('target-ambiguity')
  })

  test('guard · within the budget the walk reaches the leaf: one further request per branching level', async () => {
    const routed = await route(deep, 'Expand detail 3a', deepRules)
    // The last level, the two leaves, was asked about in the first pass: its request is not needed.
    expect(routed.requests).toHaveLength(3)
    expect(new Set(ownIds(routed, 0))).toEqual(new Set(ids(routed, 's', ['N0', 'N1b', 'N2b', 'N3a', 'N3b'])))
    expect(unit(routed).targets).toEqual(sections(['N3a']))
    expect(planOf(routed).decision.explanation).toContain('Referents by tree-walk: 2 further decision requests.')
    expect(planOf(routed).decision.budgetStop).toBeUndefined()
  })

  test('guard · a walk that would exceed its request budget stops and asks the remaining candidates in one request instead', async () => {
    const routed = await route(deep, 'Expand detail 3a', deepRules, { budget: { requests: 2 } })
    // The pipeline's request, one level of the walk, then the one-pass questions not asked yet. Never a fourth.
    expect(routed.requests).toHaveLength(3)
    expect(new Set(routed.asked[2])).toEqual(new Set(ids(routed, 's', ['N2a'])))
    expect(routed.requests[2]?.state).toBe(routed.requests[0]?.state)
    expect(unit(routed).targets).toEqual(sections(['N3a']))
    expect(planOf(routed).decision.explanation).toContain('its request budget was reached, so the remaining candidates were asked about in one request')
    // The target was clear, so the best node found so far was not needed.
    expect(planOf(routed).decision.budgetStop).toEqual({ limit: 'requests', fallback: 'one-pass', bestFound: [] })
  })

  test('guard · the question and token budgets stop the walk the same way', async () => {
    const byQuestions = await route(deep, 'Expand detail 3a', deepRules, { budget: { questions: 4 } })
    expect(byQuestions.requests).toHaveLength(3)
    expect(planOf(byQuestions).decision.explanation).toContain('its question budget was reached')
    expect(unit(byQuestions).targets).toEqual(sections(['N3a']))

    // Room for the first level and for the fallback as it stands before that level, not for the second level as well.
    const whole = await route(deep, 'Expand detail 3a', deepRules)
    const firstLevel = whole.requests[1]
    const onePass = await route(deep, 'Expand detail 3a', deepRules, { strategy: 'one-pass' })
    const notYetAsked = Object.fromEntries(Object.entries(onePass.requests[0]?.questions ?? {}).filter(([id]) => /^m_s\d+$/.test(id) && !(id in (whole.requests[0]?.questions ?? {}))))
    const reserve = estimateDecisionTokens(whole.requests[0]?.state ?? '', notYetAsked as never)
    const byTokens = await route(deep, 'Expand detail 3a', deepRules, {
      budget: { inputTokens: estimateDecisionTokens(firstLevel?.state ?? '', (firstLevel?.questions ?? {}) as never) + reserve },
    })
    expect(byTokens.requests).toHaveLength(3)
    expect(planOf(byTokens).decision.explanation).toContain('its input-token budget was reached')
    expect(planOf(byTokens).decision.budgetStop?.limit).toBe('token-budget')
    expect(unit(byTokens).targets).toEqual(sections(['N3a']))
  })

  test('guard · with no room for even that request, the referents are what was asked about by itself, the first pass and the nodes reached, and nothing further is sent', async () => {
    // N2a was never asked about: its yes is not heard. N3a is in the first pass, and stands for its ancestor N0.
    const routed = await route(deep, 'Expand detail 3a', { own: { N0: 0.9, N2a: 0.95, N3a: 0.9 }, under: deepRules.under ?? {} }, { budget: { requests: 0 } })
    expect(routed.requests).toHaveLength(1)
    expect(unit(routed).targets).toEqual(sections(['N3a']))
    expect(planOf(routed).decision.budgetStop).toEqual({ limit: 'requests', fallback: 'partial', bestFound: [] })
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
    // B is not in the first pass (B2 was built on it), so the walk needs a further request to ask about it.
    const sc = trip()
      .chain('b2', 'branch', 'cheaper activities')
      .add('B2', { chain: 'b2', on: 'B', label: 'cheaper activities', request: 'Give me three cheaper alternatives', answer: 'Free shrines.', consumed: ['brief', 'B'] })
      .build()
    const cheap = await route(sc, text, rules, { costGuard: { expectedOutputTokens: 5 } })
    expect(cheap.requests).toHaveLength(1)
    expect(planOf(cheap).decision.explanation).toContain('its input-token budget was reached')
    expect(planOf(cheap).decision.budgetStop?.limit).toBe('price-guard')
    // Off, or with an answer of ordinary length, the walk is as before.
    for (const costGuard of [{ expectedOutputTokens: 5, maxAnswerCostRatio: 0 }, {}]) {
      const routed = await route(sc, text, rules, { costGuard })
      expect(routed.requests).toHaveLength(2)
      expect(new Set(unit(routed).targets)).toEqual(new Set(sections(['A', 'B'])))
    }
    // The allowance: 2 × (14 tokens of message × $0.10 + 1,700 × $0.50) ÷ $0.042, per piece of work.
    expect(decisionAllowance(DEFAULT_SETTINGS.routing.costGuard, { messageLength: 55, answerLengths: [], units: 1 })).toBe(40_542)
    // Five completed answers or more: their median length, not below 100 tokens.
    expect(decisionAllowance(DEFAULT_SETTINGS.routing.costGuard, { messageLength: 0, answerLengths: [400, 4000, 4000, 4000, 40_000], units: 1 })).toBe(Math.floor((2 * 1000 * 0.5) / 0.042))
    expect(decisionAllowance(DEFAULT_SETTINGS.routing.costGuard, { messageLength: 0, answerLengths: [40, 40, 40, 40, 40], units: 2 })).toBe(Math.floor((2 * 2 * 100 * 0.5) / 0.042))
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
const allTokens = (routed: Routed): number => routed.requests.reduce((sum, r) => sum + estimateRequestTokens(r.state, r.questions), 0)
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
    expect(allTokens(routed)).toBeLessThanOrEqual(resolveTokenBudget(DEFAULT_SETTINGS.routing.tokenBudget, 0))

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

  test('DA3 · a yes to a question about several sections only says where to look next: a message is placed on a section only if that section was asked about by itself', async () => {
    // Within the budget the chunk that names T40 is followed, its sections are asked about one by one, and the reply is placed on T40.
    const found = await route(flat(200), 'Make the answer to question 40 shorter', { own: { T40: 0.9 } })
    expect(chunkIds(found, 1).length).toBeGreaterThan(0)
    expect(ownIds(found, 2)).toContain(`m_s${found.numberOf.get('T40') ?? '?'}`)
    expect(unit(found).targets).toEqual(sections(['T40']))

    // The budget ends the search between the chunk and its sections: the request that would list them is never sent.
    const routed = await route(flat(200), 'Make the answer to question 40 shorter', { own: { T40: 0.9 } }, { budget: { requests: 1 } })
    expect(routed.requests).toHaveLength(2)
    const chunk = Object.entries(routed.requests[1]?.questions ?? {}).find(([, q]) => q.instructions.includes('"Question 40"'))
    expect(chunk?.[0]).toMatch(/^m_c\d+_\d+$/)
    // The chunk was answered yes, and no section it names was asked about by itself: none of them is a candidate.
    expect(routed.requests.flatMap((r) => Object.keys(r.questions))).not.toContain(`m_s${routed.numberOf.get('T40') ?? '?'}`)
    expect(routed.outcome.kind).toBe('plan')
    expect(unit(routed).targets).toEqual([])
    const decision = planOf(routed).decision
    expect(decision.units[0]?.targets.candidates.map((c) => c.sectionId)).not.toContain(sceneIds.section('T40'))
    for (const neighbour of ['T39', 'T41', 'T36', 'T44']) expect(decision.units[0]?.targets.candidates.map((c) => c.sectionId)).not.toContain(sceneIds.section(neighbour))
    // Nothing asked about by itself was plausible, so nothing was taken, and the user was not asked.
    expect(decision.budgetStop).toEqual({ limit: 'requests', fallback: 'one-pass', bestFound: [] })
  })

  test('search · the budget guard holds: a search never sends more than the budget allows, whatever the tree', async () => {
    for (const budget of [{ requests: 0 }, { requests: 1 }, { requests: 2 }, { questions: 10 }, { inputTokens: 900 }]) {
      const routed = await route(wide(300), 'Compare the answer on topic 3 with the one on topic 150', { own: { T3: 0.9, T150: 0.9 }, several: 0.9 }, { budget })
      const allowed = { ...DEFAULT_SETTINGS.routing.referentBudget, inputTokens: resolveTokenBudget(DEFAULT_SETTINGS.routing.tokenBudget, 0), ...budget }
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
    // X and Y, which nothing was built on, are the first pass of every routing.
    expect(new Set(off.asked[0])).toEqual(new Set([...ids(off, 's', ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'X', 'Y']), ...ids(off, 'u', ['T9'])]))
    const routed = await route(trunk, 'Explain how volcanoes form', { relation: 'new' }, { treeWalk: on })
    expect(routed.requests).toHaveLength(1)
    expect(new Set(routed.asked[0])).toEqual(new Set([...ids(routed, 's', ['T9', 'X', 'Y']), ...ids(routed, 'u', ['T9']), `m_c${routed.numberOf.get('T0') ?? '?'}_${routed.numberOf.get('T8') ?? '?'}`]))
  })

  test('trunk · a reply to a section in the middle of the trunk is resolved exactly: its chunk is relevant, so its sections are asked about one by one', async () => {
    const routed = await route(trunk, 'Make the answer to question 4 shorter', { own: { T4: 0.9 } }, { treeWalk: on })
    expect(routed.requests).toHaveLength(2)
    // The chunk's sections, and the base again beside them. What is built on the base was asked about in the first pass.
    expect(new Set(ownIds(routed, 1))).toEqual(new Set(ids(routed, 's', ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9'])))
    expect(unit(routed).targets).toEqual(sections(['T4']))
    expect(unit(routed).placement).toEqual({ kind: 'continue', buildsOn: { kind: 'node', nodeId: sceneIds.node('T4') } })
  })

  test('trunk · with no budget to look inside the trunk, a reply to a section in it is not placed on a section of the trunk, and the user is not asked', async () => {
    const routed = await route(trunk, 'Make the answer to question 4 shorter', { own: { T4: 0.9 } }, { treeWalk: on, budget: { requests: 0 } })
    expect(routed.requests).toHaveLength(1)
    // The chunk above the base was answered yes; no section of it was asked about by itself, and the base is not plausible.
    expect(routed.outcome.kind).toBe('plan')
    expect(unit(routed).targets).toEqual([])
    expect(planOf(routed).decision.budgetStop).toEqual({ limit: 'requests', fallback: 'partial', bestFound: [] })
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
    // The ends of the lines (P, Q and B3) were asked about in the first pass, in the pipeline's request.
    expect(new Set(ownIds(off, 0))).toEqual(new Set(ids(off, 's', ['brief', 'P', 'Q', 'B3'])))
    expect(new Set(off.asked[1])).toEqual(new Set([...ids(off, 's', ['A', 'A1', 'A2', 'A3', 'A4', 'B', 'B1', 'B2']), ...ids(off, 'u', ['A4'])]))
    const routed = await route(runs, 'Change variant P', { own: { P: 0.9 }, under: { brief: 0.9, A4: 0.9 } }, { treeWalk: on })
    const chunk = (from: string, to: string) => `m_c${routed.numberOf.get(from) ?? '?'}_${routed.numberOf.get(to) ?? '?'}`
    expect(new Set(routed.asked[1])).toEqual(new Set([...ids(routed, 's', ['A4']), ...ids(routed, 'u', ['A4']), chunk('A', 'A3'), chunk('B', 'B2')]))
    // The lines of the skipped sections are not sent.
    expect(routed.requests[1]?.state).not.toContain('"press 2"')
    // P and Q were asked about in the first pass: no request is needed below the hop.
    expect(routed.requests).toHaveLength(2)
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
    // Asked about before the run it ends is looked into (here in the first pass), B3 scores 0.8 for a reply to B1; beside the run it does not.
    // B3 is built on B1, so its first score would have taken the reply.
    const routed = await route(runs, 'Redo pricing step 1', { own: { B1: 0.9 }, alone: { B3: 0.8 }, under: { brief: 0.9 } }, { treeWalk: on })
    expect(routed.asked[0]).toContain(`m_s${routed.numberOf.get('B3') ?? '?'}`)
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
    expect(new Set(routed.asked[2])).toEqual(new Set(ids(routed, 's', ['A', 'A1', 'A2', 'A3', 'A4'])))
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
        const allowed = { ...DEFAULT_SETTINGS.routing.referentBudget, inputTokens: resolveTokenBudget(DEFAULT_SETTINGS.routing.tokenBudget, 0), ...budget }
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
      const allowed = { ...DEFAULT_SETTINGS.routing.referentBudget, inputTokens: resolveTokenBudget(DEFAULT_SETTINGS.routing.tokenBudget, 0), ...budget }
      expect(routed.requests.length - 1).toBeLessThanOrEqual(allowed.requests)
      expect(furtherTokens(routed)).toBeLessThanOrEqual(allowed.inputTokens)
    }
  })
})

describe('token budget', () => {
  /** One chain of `n` exchanges whose requests are 80 characters and whose answers are `answerTokens` long, each shown by its opening as a live section is. */
  const chain = (n: number, answerTokens: number): Scene => {
    const s = scene().chain('chat', 'root', 'chat')
    for (let i = 0; i < n; i++) {
      s.add(`T${i}`, { chain: 'chat', on: i === 0 ? null : `T${i - 1}`, label: `turn ${i}`, request: `Please go into point ${i} of the plan in detail, with examples `.repeat(2).slice(0, 80), answer: `Answer ${i}: here is what matters about that point of the plan. `.repeat(6).slice(0, Math.min(280, answerTokens * 4)), answerLength: answerTokens * 4 })
    }
    return s.build()
  }
  const logOf = (sc: Scene, text: string): number => sceneLogTokens({ scene: sc, text })

  test('budget · a routing may use the smaller of the token budget and the price guard\'s allowance, whichever mode the budget is in', () => {
    const routing = DEFAULT_SETTINGS.routing
    const run = { messageLength: 55, answerLengths: [], units: 1 }
    // Few answers yet: the allowance is that of a 1,700-token answer (40,542), so the budget binds.
    expect(routingTokenBudget(routing, { ...run, sessionLogTokens: 0 })).toEqual({ total: 16_000, limitedBy: 'token-budget' })
    expect(routingTokenBudget(routing, { ...run, sessionLogTokens: 1_500_000 })).toEqual({ total: 30_000, limitedBy: 'token-budget' })
    // A huge conversation is not unbounded: the ceiling, still under the allowance.
    expect(routingTokenBudget(routing, { ...run, sessionLogTokens: 50_000_000 })).toEqual({ total: 40_000, limitedBy: 'token-budget' })
    // Short answers: twice a 300-token answer buys 7,209 decision tokens, less than any budget.
    const short = { ...run, answerLengths: [1200, 1200, 1200, 1200, 1200] }
    expect(routingTokenBudget(routing, { ...short, sessionLogTokens: 1_500_000 })).toEqual({ total: 7_209, limitedBy: 'price-guard' })
    expect(routingTokenBudget({ ...routing, tokenBudget: { mode: 'absolute', inputTokens: 5_000 } }, { ...short, sessionLogTokens: 1_500_000 })).toEqual({ total: 5_000, limitedBy: 'token-budget' })
    // The price guard off: the budget alone.
    expect(routingTokenBudget({ ...routing, costGuard: { ...routing.costGuard, maxAnswerCostRatio: 0 } }, { ...short, sessionLogTokens: 0 })).toEqual({ total: 16_000, limitedBy: 'token-budget' })
  })

  test('budget · every decision request of a routing counts, the pipeline\'s own included: the total never passes the budget', async () => {
    for (const tokenBudget of [{ mode: 'absolute', inputTokens: 4_000 }, { mode: 'absolute', inputTokens: 9_000 }, DEFAULT_SETTINGS.routing.tokenBudget] as const) {
      const sc = chain(300, 1_700)
      const text = 'Make the answer to point 40 shorter'
      const routed = await route(sc, text, { own: { T40: 0.9 } }, { tokenBudget })
      expect(allTokens(routed)).toBeLessThanOrEqual(resolveTokenBudget(tokenBudget, logOf(sc, text)))
      expect(routed.requests.length).toBeGreaterThanOrEqual(1)
    }
  })

  test('budget · relative to the log, a search reaches an old section of a long conversation that a fixed budget of the same floor does not', async () => {
    const sc = chain(700, 1_700)
    const text = 'Make the answer to point 40 shorter'
    // 700 exchanges of 1,720 tokens: 2% of the log is 24,080 tokens.
    expect(resolveTokenBudget(DEFAULT_SETTINGS.routing.tokenBudget, logOf(sc, text))).toBe(24_080)
    const relative = await route(sc, text, { own: { T40: 0.9 } })
    expect(unit(relative).targets).toEqual(sections(['T40']))
    expect(planOf(relative).decision.explanation).not.toContain('budget was reached')
    expect(allTokens(relative)).toBeLessThanOrEqual(24_080)
    // The same floor as a fixed budget: the chunks of the search do not fit, the walk falls back and the section is not reached.
    const fixed = await route(sc, text, { own: { T40: 0.9 } }, { tokenBudget: { mode: 'absolute', inputTokens: 16_000 } })
    expect(planOf(fixed).decision.explanation).toContain('its input-token budget was reached')
    expect(unit(fixed).targets).not.toEqual(sections(['T40']))
    expect(allTokens(fixed)).toBeLessThanOrEqual(16_000)
    // In a conversation short enough for the floor, the two are the same routing.
    const small = chain(200, 1_700)
    const a = await route(small, text, { own: { T40: 0.9 } })
    const b = await route(small, text, { own: { T40: 0.9 } }, { tokenBudget: { mode: 'absolute', inputTokens: 16_000 } })
    expect(a.outcome).toEqual(b.outcome)
    expect(a.requests).toEqual(b.requests)
  })

  describe.each(STRATEGIES)('referents by %s', (strategy) => {
    test('guard · with short answers the pipeline\'s own request lists fewer answer sections, the most recent, so that routing costs at most twice the answer', async () => {
      // Answers of 110 tokens: twice one buys about 2,700 decision tokens, and the request with its full window costs more.
      const sc = chain(40, 110)
      const text = 'Make that shorter'
      const unguarded = await route(sc, text, { own: { T39: 0.9 } }, { strategy, costGuard: { maxAnswerCostRatio: 0 } })
      const allowance = decisionAllowance(DEFAULT_SETTINGS.routing.costGuard, { messageLength: text.length, answerLengths: Array.from({ length: 40 }, () => 440), units: 1 })
      expect(estimateRequestTokens(unguarded.requests[0]?.state ?? '', unguarded.requests[0]?.questions ?? {})).toBeGreaterThan(allowance)

      const routed = await route(sc, text, { own: { T39: 0.9 } }, { strategy })
      expect(allTokens(routed)).toBeLessThanOrEqual(allowance)
      const listed = [...(routed.requests[0]?.state ?? '').matchAll(/^S\d+\. "turn (\d+)"/gm)].map((m) => Number(m[1]))
      expect(listed.length).toBeLessThan(24)
      expect(listed.length).toBeGreaterThanOrEqual(MIN_SECTIONS)
      // The most recent ones, and as many as fit: one more would not have.
      expect(listed).toEqual(Array.from({ length: listed.length }, (_, i) => 40 - listed.length + i))
      expect(unit(routed).targets).toEqual(sections(['T39']))
      expect(planOf(routed).decision.explanation).toContain(`The routing request listed the ${listed.length} most recent answer sections and lines of work, not 24, to stay within the price guard on decision cost.`)
      // Deterministic: the same routing again is the same requests.
      expect((await route(sc, text, { own: { T39: 0.9 } }, { strategy })).requests).toEqual(routed.requests)
    })

    test('guard · a fixed token budget cuts the pipeline\'s request the same way, and with answers of ordinary length nothing is cut', async () => {
      const sc = chain(40, 1_700)
      const whole = await route(sc, 'Make that shorter', { own: { T39: 0.9 } }, { strategy })
      expect(whole.requests[0]?.state).toContain('S24. ')
      expect(planOf(whole).decision.explanation).not.toContain('most recent answer sections')
      const cut = await route(sc, 'Make that shorter', { own: { T39: 0.9 } }, { strategy, tokenBudget: { mode: 'absolute', inputTokens: 3_000 } })
      expect(allTokens(cut)).toBeLessThanOrEqual(3_000)
      expect(cut.requests[0]?.state).not.toContain('S24. ')
      expect(unit(cut).targets).toEqual(sections(['T39']))
      expect(planOf(cut).decision.explanation).toContain('to stay within the decision token budget.')
    })

    test('guard · a request that cannot be made small enough is still sent, with the fewest sections it lists, and the explanation says so', async () => {
      const routed = await route(chain(40, 1_700), 'Make that shorter', { own: { T39: 0.9 } }, { strategy, tokenBudget: { mode: 'absolute', inputTokens: 300 } })
      expect(routed.requests).toHaveLength(1)
      // The smallest request lists the first-pass sections alone: on one chain, the latest answer.
      expect([...(routed.requests[0]?.state ?? '').matchAll(/^S\d+\. /gm)]).toHaveLength(1)
      expect(unit(routed).targets).toEqual(sections(['T39']))
      expect(planOf(routed).decision.explanation).toContain('listed only the most recent answer section, the fewest it lists, and still costs more than the decision token budget allows (300 tokens)')
    })
  })

  test('guard · a composite is as many answers as it has parts: the request about its parts is cut to that budget', async () => {
    const sc = chain(40, 110)
    const text = 'Make that shorter and explain how volcanoes form'
    const example: CorpusExample = {
      id: 'composite',
      covers: ['splits'],
      note: 'two independent requests',
      scene: sc,
      text,
      decomposition: { fragments: [{ part: 'Make that shorter', instruction: 'Make that shorter', label: 'shorter' }, { part: 'explain how volcanoes form', instruction: 'Explain how volcanoes form', label: 'volcanoes' }] },
      expect: { composition: 'independent-composite', parts: [{ kind: 'unit', targets: ['T39'] }, { kind: 'unit', relation: 'new', targets: [] }] },
    }
    const input = corpusInput(example, DEFAULT_SETTINGS)
    const requests: DecisionRequest<DecisionQuestions>[] = []
    const oracle = oracleDecisionProvider(example, input)
    const provider: DecisionProvider = { decide: (request, signal) => (requests.push(request), oracle.decide(request, signal)) }
    const outcome = await createRouter({ decisionProvider: provider, decomposer: referenceDecomposer(example) }).route(input, NEVER_CANCELLED)
    expect(compare(example, outcome)).toEqual([])
    const allowance = (units: number): number => decisionAllowance(DEFAULT_SETTINGS.routing.costGuard, { messageLength: text.length, answerLengths: Array.from({ length: 40 }, () => 440), units })
    const tokens = requests.map((r) => estimateRequestTokens(r.state, r.questions))
    // The gate is held to one answer; the gate and the request about the two parts together to two.
    expect(tokens[0]).toBeLessThanOrEqual(allowance(1))
    expect(tokens.reduce((sum, n) => sum + n, 0)).toBeLessThanOrEqual(allowance(2))
    expect(requests[1]?.state).not.toContain('S24. ')
  })
})

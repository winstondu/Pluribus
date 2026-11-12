import { DEFAULT_SETTINGS, resolveTokenBudget, type NodeId, type DecisionBudget, type DecisionCostGuard, type DecisionTokenBudget, type ReferentStrategyName, type RoutingSettings, type TreeWalkSettings } from '@pluribus/protocol'
import { describe, expect, test } from 'vitest'
import { NEVER_CANCELLED, type CandidateQuery, type CandidateSource, type DecisionContext, type RoutingInput, type DecisionProvider, type DecisionQuestions, type DecisionRequest, type DecisionResult, type ReferentRequest, type ReferentStrategy, type RoutingOutcome, type RoutingPlan } from '../../../src/ports'
import { compareWithLabel as compare, corpusInput, oracleDecisionProvider, referenceDecomposer, scene, sceneIds, sceneLogTokens, suppliedIn, type CorpusExample, type Scene } from '../../../testing/routing/corpus'
import { createRouter } from '../../../src/routing/pipeline'
import { MIN_SECTIONS, numberedAnswerSections, supply } from '../../../src/routing/supply'
import { FIRST_PASS_SECTIONS, ancestorsOf, bestNodeFound, branchingDepth, buildTree, createDecisionOperations, probe, decisionAllowance, estimateDecisionTokens, estimateRequestTokens, firstPassSectionIds, routingTokenBudget, segmentFrom, type TreeNode } from '../../../src/routing/referents/index'

/**
 * The two referent strategies over a scripted decision provider
 * (docs/build/dependency-decisioning.md). Decisions are stated by section
 * handle: `own` is "does the message refer to this section" (Point),
 * `together` "does it build on this group as a whole" (Group); a Segment
 * scores the highest `own` of the sections it names. Anything not stated
 * is answered no.
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
        else if (/^c\d+_\d+(_\d+)?$/.test(question)) {
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
  /** IDs of the yes/no questions about sections, groups and parts of runs, per request. */
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
  /** A scripted candidate source: section handles a tree walk starts at besides the roots. */
  readonly candidates?: readonly string[] | CandidateSource
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
    candidateSource: 'none',
    orderedMessages: DEFAULT_SETTINGS.routing.orderedMessages,
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
  const candidateSource: CandidateSource | undefined =
    routing.candidates === undefined ? undefined : 'candidates' in routing.candidates ? routing.candidates : { name: 'scripted', candidates: async () => (routing.candidates as readonly string[]).map((handle) => ({ sectionId: sceneIds.section(handle), score: null })) }
  const router = createRouter({
    decisionProvider: provider,
    decomposer: referenceDecomposer(example),
    ...(routing.inject ? { referentStrategy: routing.inject } : {}),
    ...(candidateSource ? { candidateSource } : {}),
  })
  const outcome = await router.route(input, NEVER_CANCELLED)
  const asked = requests.map((r) => Object.keys(r.questions).filter((id) => /^m_((s|j)\d+|c\d+_\d+(_\d+)?)$/.test(id)))
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
/** What the candidate source handed the routing, as the decision records it. */
const candidateRecord = (outcome: RoutingOutcome) => (outcome.kind === 'plan' ? (outcome.plan.decision.candidateSource ?? null) : null)
/** The outcome without that record: what is compared with a routing that had no source. */
function withoutCandidateRecord(outcome: RoutingOutcome): RoutingOutcome {
  if (outcome.kind !== 'plan') return outcome
  const { candidateSource: _record, ...decision } = outcome.plan.decision
  return { ...outcome, plan: { ...outcome.plan, decision } }
}
const ids = (routed: Routed, _kind: 's', handles: readonly string[]) => handles.map((h) => `m_s${routed.numberOf.get(h) ?? '?'}`)

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
    const routed = await route(tripClosed, 'Use those recommendations to make a five-day itinerary.', { own: { A: 0.77, B: 0.3, brief: 0.5 }, several: 0.4, together: { G: 0.86 } }, { strategy })
    expect(new Set(unit(routed).targets)).toEqual(new Set(sections(['A', 'B'])))
    expect(unit(routed).placement).toEqual({ kind: 'continue', buildsOn: { kind: 'sibling-group', groupId: sceneIds.group('G') } })
    expect(unit(routed).prerequisites).toEqual([])
  })

  test('C9 · J needs both running siblings: it depends on the whole group, never on a subset', async () => {
    const routed = await route(tripRunning, 'Use those recommendations to make a five-day itinerary.', { relation: 'dependent', own: { A: 0.77, B: 0.2 }, together: { G: 0.86 } }, { strategy })
    expect(new Set(unit(routed).targets)).toEqual(new Set(sections(['A', 'B'])))
    expect(unit(routed).placement).toEqual({ kind: 'continue', buildsOn: { kind: 'sibling-group', groupId: sceneIds.group('G') } })
    expect(unit(routed).prerequisites).toEqual([{ kind: 'sibling-group', groupId: sceneIds.group('G') }])
    expect(unit(routed).relation).toBe('result-dependent')
  })

  test('C20 · a follow-up that names an earlier node of one line and another line is a join chain; validation moves its parents to leaves', async () => {
    // B is not a leaf: B2 continues it. S is a leaf of a separate tree.
    const routed = await route(tripFull, 'Put the activities and the sky explanation into one handout', { own: { B: 0.9, S: 0.9, brief: 0.3 }, several: 0.9 }, { strategy })
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
    const scores: Rules = { own: { brief: 0.9, A: 0.85 } }
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
    const routed = await route(tripFull, 'Use those recommendations to make a five-day itinerary.', { own: { brief: 0.4, A: 0.8, B: 0.3 }, together: { G: 0.9 } })
    // In the pipeline's request: the roots, each asked about by itself. With them the first pass: the most recent sections that no
    // later one builds on (S is one of them and a root).
    expect(new Set(routed.asked[0])).toEqual(new Set(ids(routed, 's', ['brief', 'S', 'J', 'B2'])))
    // The brief is plausible, so the runs below it are examined in one request: the siblings and the join group. Their ends were
    // asked about in the first pass.
    expect(routed.requests).toHaveLength(2)
    expect(new Set(routed.asked[1])).toEqual(new Set([...ids(routed, 's', ['A', 'B']), 'm_j1']))
    const state = routed.requests[1]?.state ?? ''
    expect(state).toContain('"neighborhoods"')
    expect(state).toContain('were requested in parallel')
    expect(state).not.toContain('"sky"')
    expect(state).not.toContain('Lines of work')
    // A section asked about by itself is shown with what it was built on, named by its request and not asked about.
    expect(state).toContain(`S${routed.numberOf.get('A')} and S${routed.numberOf.get('B')} build on S${routed.numberOf.get('brief')} ("${BRIEF}").`)
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

  test('tree-walk · nothing is examined below a run that is not plausible; the first-pass sections are asked about all the same', async () => {
    // The brief is not plausible, so the siblings below it are never asked about. J and B2 are the ends of their lines: the first pass.
    const routed = await route(tripFull, 'Fit the cheaper alternatives into the itinerary', { own: { J: 0.9, B2: 0.85, A: 0.9 }, several: 0.8 })
    expect(routed.requests).toHaveLength(1)
    expect(new Set(unit(routed).targets)).toEqual(new Set(sections(['J', 'B2'])))
    expect(unit(routed).placement.kind).toBe('join-chain')
  })

  test('tree-walk · ancestors of a relevant node are removed: J stands for the group and the siblings it was built on', async () => {
    const routed = await route(tripFull, 'Make the itinerary shorter', { own: { brief: 0.8, A: 0.75, B: 0.75, J: 0.9 }, together: { G: 0.8 } })
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
/** The line down to the leaf is plausible at every level: that is what a walk descends on. */
const deepRules: Rules = { own: { N0: 0.3, N1a: 0.3, N2a: 0.3, N3a: 0.9 } }

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
    const rules: Rules = { own: { N0: 0.6, N1b: 0.45, N2b: 0.45, N3a: 0.3, N2a: 0.95 } }
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

    // Nothing asked about by itself is plausible: the walk has nothing further to ask, so no limit is reached. The message
    // refers to nothing there, and nobody is asked.
    const nothing = await route(deep, text, { own: { N2a: 0.95 } }, { budget: { requests: 0 } })
    expect(nothing.outcome.kind).toBe('plan')
    expect(unit(nothing).targets).toEqual([])
    expect(planOf(nothing).decision.budgetStop).toBeUndefined()
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
    // Like every round, it shows only the sections it asks about.
    expect(routed.requests[2]?.state).toContain('"level 2a"')
    expect(routed.requests[2]?.state).not.toContain('"level 3b"')
    expect(unit(routed).targets).toEqual(sections(['N3a']))
    expect(planOf(routed).decision.explanation).toContain('its request budget was reached, so the remaining candidates were asked about in one request')
    // The target was clear, so the best node found so far was not needed.
    expect(planOf(routed).decision.budgetStop).toEqual({ limit: 'requests', fallback: 'one-pass', bestFound: [] })
  })

  test('guard · the question and token budgets stop the walk the same way', async () => {
    // The first level is one question and its fallback two: with room for two questions the fallback is what is asked.
    const byQuestions = await route(deep, 'Expand detail 3a', deepRules, { budget: { questions: 2 } })
    expect(byQuestions.requests).toHaveLength(2)
    expect(planOf(byQuestions).decision.explanation).toContain('its question budget was reached')
    expect(unit(byQuestions).targets).toEqual(sections(['N3a']))

    // Room for the first level and for the fallback as it stands before that level, not for the second level as well.
    const whole = await route(deep, 'Expand detail 3a', deepRules)
    const firstLevel = whole.requests[1]
    // With one request allowed the walk asks its fallback at once: the listed sections it has not asked about.
    const reserve = (await route(deep, 'Expand detail 3a', deepRules, { budget: { requests: 1 } })).requests[1]
    const cost = (request: DecisionRequest<DecisionQuestions> | undefined): number => estimateDecisionTokens(request?.state ?? '', (request?.questions ?? {}) as never)
    const byTokens = await route(deep, 'Expand detail 3a', deepRules, { budget: { inputTokens: cost(firstLevel) + cost(reserve) } })
    expect(byTokens.requests).toHaveLength(3)
    expect(planOf(byTokens).decision.explanation).toContain('its input-token budget was reached')
    expect(planOf(byTokens).decision.budgetStop?.limit).toBe('token-budget')
    expect(unit(byTokens).targets).toEqual(sections(['N3a']))
  })

  test('guard · with no room for even that request, the referents are what was asked about by itself, the first pass and the nodes reached, and nothing further is sent', async () => {
    // N2a was never asked about: its yes is not heard. N3a is in the first pass, and stands for its ancestor N0.
    const routed = await route(deep, 'Expand detail 3a', { own: { N0: 0.9, N2a: 0.95, N3a: 0.9 },  }, { budget: { requests: 0 } })
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
    // Two trees: a root with an aside and a line of two. The walk asks about K, the top of the line below the plausible root; its
    // fallback would ask about M as well.
    const sc = scene()
    for (const [root, aside, middle, leaf] of [['R1', 'X', 'K', 'K2'], ['R2', 'Y', 'M', 'M2']] as const) {
      sc.chain(root, 'root', root).add(root, { chain: root, on: null, label: `step ${root}`, request: `Request ${root}`, answer: `Answer ${root}` })
      sc.chain(aside, 'branch', aside).add(aside, { chain: aside, on: root, label: `step ${aside}`, request: `Request ${aside}`, answer: `Answer ${aside}` })
      sc.chain(middle, 'branch', middle)
      sc.add(middle, { chain: middle, on: root, label: `step ${middle}`, request: `Request ${middle}`, answer: `Answer ${middle}` })
      sc.add(leaf, { chain: middle, on: middle, label: `step ${leaf}`, request: `Request ${leaf}`, answer: `Answer ${leaf}` })
    }
    const rules: Rules = { own: { R1: 0.3, K: 0.9 } }
    const whole = await route(sc.build(), 'Change step K', rules)
    const level = whole.requests[1]
    expect(new Set(whole.asked[1])).toEqual(new Set(ids(whole, 's', ['K'])))
    // Room for the level and nothing else: the fallback, a request about K and M, costs more.
    const routed = await route(sc.build(), 'Change step K', rules, { budget: { inputTokens: estimateDecisionTokens(level?.state ?? '', (level?.questions ?? {}) as never) } })
    expect(routed.requests).toHaveLength(2)
    expect(unit(routed).targets).toEqual(sections(['K']))
    expect(planOf(routed).decision.explanation).not.toContain('budget was reached')
  })

  test('guard · the strategy\'s token budget is what twice the answer\'s price leaves after the pipeline\'s own request', async () => {
    const rules: Rules = { own: { brief: 0.4, A: 0.8, B: 0.3 }, together: { G: 0.9 } }
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
    const rules: Rules = { own: { A: 0.9, B: 0.85 }, several: 0.9 }
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

  test('DA3 · a yes to a question about several sections only says where to look next; with hop between branch points on, a unit that refers to an unbranched run is placed on the run\'s last section and on no other; a correction is never placed this way', async () => {
    const t40 = (routed: Routed): string => `m_s${routed.numberOf.get('T40') ?? '?'}`
    const candidatesOf = (routed: Routed) => planOf(routed).decision.units[0]?.targets.candidates.map((c) => c.sectionId) ?? []
    const askedIds = (routed: Routed): string[] => routed.requests.flatMap((r) => Object.keys(r.questions))

    // Off. Within the budget the chunk that names T40 is followed, its sections are asked about one by one, and the reply is placed on T40.
    const found = await route(flat(200), 'Make the answer to question 40 shorter', { own: { T40: 0.9 } })
    expect(chunkIds(found, 1).length).toBeGreaterThan(0)
    expect(ownIds(found, 2)).toContain(t40(found))
    expect(unit(found).targets).toEqual(sections(['T40']))
    expect(planOf(found).decision.runEnds).toBeUndefined()

    // The budget ends the search between the chunk and its sections: the request that would list them is never sent.
    const routed = await route(flat(200), 'Make the answer to question 40 shorter', { own: { T40: 0.9 } }, { budget: { requests: 1 } })
    expect(routed.requests).toHaveLength(2)
    const chunk = Object.entries(routed.requests[1]?.questions ?? {}).find(([, q]) => q.instructions.includes('"Question 40"'))
    expect(chunk?.[0]).toMatch(/^m_c\d+_\d+$/)
    // The chunk was answered yes, and no section it names was asked about by itself: none of them is a candidate.
    expect(askedIds(routed)).not.toContain(t40(routed))
    expect(routed.outcome.kind).toBe('plan')
    expect(unit(routed).targets).toEqual([])
    const decision = planOf(routed).decision
    expect(candidatesOf(routed)).not.toContain(sceneIds.section('T40'))
    for (const neighbour of ['T39', 'T41', 'T36', 'T44']) expect(candidatesOf(routed)).not.toContain(sceneIds.section(neighbour))
    // Nothing asked about by itself was plausible, so nothing was taken, and the user was not asked.
    expect(decision.budgetStop).toEqual({ limit: 'requests', fallback: 'one-pass', bestFound: [] })

    // On. The same yes places the message on the last section of the run, T199, whose context holds T40: no part is opened.
    const hop: RouteOptions = { treeWalk: { hopBetweenBranchPoints: true } }
    const hopped = await route(flat(200), 'Make the answer to question 40 shorter', { own: { T40: 0.9 } }, hop)
    expect(hopped.requests).toHaveLength(2)
    expect(ownIds(hopped, 1)).toEqual([])
    expect(unit(hopped).targets).toEqual(sections(['T199']))
    expect(unit(hopped).placement).toEqual({ kind: 'continue', buildsOn: { kind: 'node', nodeId: sceneIds.node('T199') } })
    // Never on another section of the run: the one it refers to and its neighbours were not asked about by themselves and are not candidates.
    expect(askedIds(hopped)).not.toContain(t40(hopped))
    for (const other of ['T40', 'T39', 'T41', 'T36', 'T44', 'T175']) expect(candidatesOf(hopped)).not.toContain(sceneIds.section(other))
    // The decision records which run, which section and on what evidence.
    const [end, ...more] = planOf(hopped).decision.runEnds ?? []
    expect(more).toEqual([])
    expect(end).toMatchObject({ unit: 'message', sectionId: sceneIds.section('T199'), confidence: 0.9, run: { firstSectionId: sceneIds.section('T0'), lastSectionId: sceneIds.section('T199'), sections: 200 }, limitedByContext: false })
    // The evidence is the question that named T40 among the sections of its part.
    const yes = Object.values(hopped.requests[1]?.questions ?? {}).find((q) => q.instructions.includes('"Question 40"'))
    expect(yes?.instructions).toContain(`: S${hopped.numberOf.get((end?.evidence.firstSectionId ?? '').replace(/^sec_/, '')) ?? '?'} (`)
    expect(end?.evidence.sections).toBeGreaterThan(1)
    expect(planOf(hopped).decision.explanation).toContain('Hop between branch points is on, so no answer inside a run was searched for: the message on "turn 199", the last answer of a run of 200')
    // Without a yes about the run nothing is placed on it: the hop is not a guess. Here the budget allows no question about the run.
    const unasked = await route(flat(200), 'Make the answer to question 40 shorter', { own: { T40: 0.9 } }, { ...hop, budget: { requests: 0 } })
    expect(unasked.requests).toHaveLength(1)
    expect(unit(unasked).targets).toEqual([])
    expect(planOf(unasked).decision.runEnds).toBeUndefined()

    // A correction needs the exact section it revises: it is searched for whatever the switch says, request for request.
    const rules: Rules = { own: { T40: 0.9 }, corrective: 0.95 }
    const corrected = await route(flat(200), 'Actually, the answer to question 40 should say four days, not five', rules, hop)
    const searched = await route(flat(200), 'Actually, the answer to question 40 should say four days, not five', rules)
    expect(corrected.requests).toEqual(searched.requests)
    expect(corrected.outcome).toEqual(searched.outcome)
    expect(planOf(corrected).revisions[0]?.targetDirectiveIds).toEqual([sceneIds.directive('T40')])
    expect(planOf(corrected).decision.runEnds).toBeUndefined()
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
    expect(new Set(off.asked[0])).toEqual(new Set([...ids(off, 's', ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'X', 'Y'])]))
    const routed = await route(trunk, 'Explain how volcanoes form', { relation: 'new' }, { treeWalk: on })
    expect(routed.requests).toHaveLength(1)
    expect(new Set(routed.asked[0])).toEqual(new Set([...ids(routed, 's', ['T9', 'X', 'Y']), `m_c${routed.numberOf.get('T0') ?? '?'}_${routed.numberOf.get('T8') ?? '?'}`]))
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
    const routed = await route(trunk, 'Actually, question 0 was about four days, not five', { own: { T0: 0.9, X: 0.85 }, corrective: 0.95 }, { treeWalk: on })
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
  const chunk = (routed: Routed, from: string, to: string) => `m_c${routed.numberOf.get(from) ?? '?'}_${routed.numberOf.get(to) ?? '?'}`

  test('hops · off, the sections of a run are asked about by themselves and the reply goes to the one it names; on, each run is one question and the reply goes to the run\'s last section', async () => {
    // The brief is plausible: the line the walk descends along.
    const rules: Rules = { own: { brief: 0.3, B1: 0.9 } }
    const off = await route(runs, 'Tell me more about pricing step 1', rules)
    // The ends of the lines (P, Q and B3) were asked about in the first pass, in the pipeline's request.
    expect(new Set(ownIds(off, 0))).toEqual(new Set(ids(off, 's', ['brief', 'P', 'Q', 'B3'])))
    expect(new Set(off.asked[1])).toEqual(new Set(ids(off, 's', ['A', 'A1', 'A2', 'A3', 'A4', 'B', 'B1', 'B2'])))
    expect(unit(off).targets).toEqual(sections(['B1']))
    expect(planOf(off).decision.runEnds).toBeUndefined()

    const routed = await route(runs, 'Tell me more about pricing step 1', rules, { treeWalk: on })
    // The pipeline's request is the same. Then one question per run about the sections not asked about yet, and nothing after it.
    expect(routed.requests[0]).toEqual(off.requests[0])
    expect(routed.requests).toHaveLength(2)
    expect(new Set(routed.asked[1])).toEqual(new Set([chunk(routed, 'A', 'A4'), chunk(routed, 'B', 'B2')]))
    // A part of a run is shown with what the run was built on, as context; the lines of its sections are not sent.
    expect(routed.requests[1]?.state).toContain(`S${routed.numberOf.get('B')} to S${routed.numberOf.get('B2')} are consecutive answers of one line of work that builds on S${routed.numberOf.get('brief')}`)
    expect(routed.requests[1]?.state).not.toContain('"pricing 1"')
    expect(furtherTokens(routed)).toBeLessThan(furtherTokens(off))
    // The reply continues from B3, the last section of the run, which reads B1 and everything after it.
    expect(unit(routed).targets).toEqual(sections(['B3']))
    expect(unit(routed).placement).toEqual({ kind: 'continue', buildsOn: { kind: 'node', nodeId: sceneIds.node('B3') } })
    expect(planOf(routed).decision.runEnds).toEqual([
      {
        unit: 'message',
        sectionId: sceneIds.section('B3'),
        confidence: 0.9,
        run: { firstSectionId: sceneIds.section('B'), lastSectionId: sceneIds.section('B3'), sections: 4 },
        evidence: { firstSectionId: sceneIds.section('B'), lastSectionId: sceneIds.section('B2'), sections: 3 },
        limitedByContext: false,
      },
    ])
    expect(planOf(routed).decision.explanation).toContain(
      'Hop between branch points is on, so no answer inside a run was searched for: the message on "pricing 3", the last answer of a run of 4 ("pricing 0" to "pricing 3"): a question about 3 of its answers together, "pricing 0" to "pricing 2", scored 0.90. That answer was not asked about by itself; its context holds the whole run.',
    )
  })

  test('hops · the last section carries the score of the question about its run: a clear run places without asking the user, a weakly plausible one is a weak referent and the user is asked', async () => {
    const clear = await route(runs, 'Tell me more about pricing step 1', { own: { brief: 0.3 }, chunk: { B1: 0.75 } }, { treeWalk: on })
    expect(clear.outcome.kind).toBe('plan')
    expect(unit(clear).targets).toEqual(sections(['B3']))
    const weak = await route(runs, 'Tell me more about pricing step 1', { own: { brief: 0.3 }, chunk: { B1: 0.4 } }, { treeWalk: on })
    expect(weak.outcome).toEqual({ kind: 'target-ambiguity', candidates: [{ sectionId: sceneIds.section('B3'), confidence: 0.4 }, { sectionId: sceneIds.section('brief'), confidence: 0.3 }] })
    // Off, a section that is weakly plausible by itself is asked about the same way.
    const off = await route(runs, 'Tell me more about pricing step 1', { own: { brief: 0.3, B1: 0.4 } })
    expect(off.outcome).toEqual({ kind: 'target-ambiguity', candidates: [{ sectionId: sceneIds.section('B1'), confidence: 0.4 }, { sectionId: sceneIds.section('brief'), confidence: 0.3 }] })
  })

  test('hops · a relevant descendant stands for the run above it: the walk goes on below a run that is referred to, and the last section of that run is not a target', async () => {
    const routed = await route(runs, 'Compare press step 2 with variant Q', { own: { brief: 0.3, A2: 0.9, Q: 0.9 }, several: 0.9 }, { treeWalk: on })
    expect(routed.requests).toHaveLength(2)
    expect(new Set(routed.asked[1])).toEqual(new Set([chunk(routed, 'A', 'A4'), chunk(routed, 'B', 'B2')]))
    // Q was built on A…A4 and was asked about by itself in the first pass.
    expect(unit(routed).targets).toEqual(sections(['Q']))
    expect(planOf(routed).decision.runEnds).toBeUndefined()
  })

  test('hops · a trunk is a run like any other: in a long flat conversation a reply to an old answer continues from the latest one, for one request less', async () => {
    const off = await route(flat(200), 'Tell me more about question 40', { own: { T40: 0.9 } })
    const routed = await route(flat(200), 'Tell me more about question 40', { own: { T40: 0.9 } }, { treeWalk: on })
    expect(off.requests).toHaveLength(3)
    expect(routed.requests).toEqual(off.requests.slice(0, 2))
    expect(unit(off).placement).toEqual({ kind: 'continue', buildsOn: { kind: 'node', nodeId: sceneIds.node('T40') } })
    expect(unit(routed).placement).toEqual({ kind: 'continue', buildsOn: { kind: 'node', nodeId: sceneIds.node('T199') } })
  })

  test('hops · a correction keeps the search: the section it revises is found by itself, request for request as with the switch off', async () => {
    const rules: Rules = { own: { brief: 0.3, B1: 0.9 }, corrective: 0.95 }
    const off = await route(runs, 'Actually, pricing step 1 should be in euros, not dollars', rules)
    const routed = await route(runs, 'Actually, pricing step 1 should be in euros, not dollars', rules, { treeWalk: on })
    expect(routed.requests).toEqual(off.requests)
    expect(routed.outcome).toEqual(off.outcome)
    expect(planOf(routed).revisions[0]?.targetDirectiveIds).toEqual([sceneIds.directive('B1')])
  })

  test('hops · room is kept only for a fallback the round at hand does not stand for: with one request left the runs are asked about, not their sections one by one', async () => {
    const off = await route(runs, 'Tell me more about pricing step 1', { own: { brief: 0.3, B1: 0.9 } }, { budget: { requests: 1 } })
    // Off, the walk keeps room for its fallback, so with one request left it asks the one-pass questions instead of walking on.
    expect(off.requests).toHaveLength(2)
    expect(planOf(off).decision.explanation).toContain('its request budget was reached, so the remaining candidates were asked about in one request')
    expect(unit(off).targets).toEqual(sections(['B1']))
    // On, the question about the two runs stands for every listed section the fallback would ask about: nothing is left to keep room for.
    const routed = await route(runs, 'Tell me more about pricing step 1', { own: { brief: 0.3, B1: 0.9 } }, { treeWalk: on, budget: { requests: 1 } })
    expect(routed.requests).toHaveLength(2)
    expect(new Set(routed.asked[1])).toEqual(new Set([chunk(routed, 'A', 'A4'), chunk(routed, 'B', 'B2')]))
    expect(planOf(routed).decision.budgetStop).toBeUndefined()
    expect(unit(routed).targets).toEqual(sections(['B3']))
    // With no request left a run is not asked about, and nothing is placed on it: the best node found so far is the brief, asked about by itself.
    const none = await route(runs, 'Tell me more about pricing step 1', { own: { brief: 0.3, B1: 0.9 } }, { treeWalk: on, budget: { requests: 0 } })
    expect(none.requests).toHaveLength(1)
    expect(unit(none).targets).toEqual(sections(['brief']))
    expect(planOf(none).decision.runEnds).toBeUndefined()
  })

  test('hops · when the budget ends after a run was asked about, its last section is the best node found so far and the user is not asked', async () => {
    // As `runs`, with B…B3 split into C…C2 and D…D2 below it, and C2 split again: more levels than the budget reaches.
    const s = scene().chain('c', 'root', 'brief').add('brief', { chain: 'c', on: null, label: 'brief', request: 'Plan a product launch', answer: 'Noted.' })
    const line = (chain: string, handles: readonly string[], on: string, label: string): void => {
      s.chain(chain, 'branch', chain)
      handles.forEach((h, i) => s.add(h, { chain, on: i === 0 ? on : (handles[i - 1] ?? null), label: `${label} ${i}`, request: `${label} step ${i}`, answer: `Done ${h}` }))
    }
    line('a', ['A', 'A1', 'A2'], 'brief', 'press')
    line('b', ['B', 'B1', 'B2', 'B3'], 'brief', 'pricing')
    line('x', ['C', 'C1', 'C2'], 'B3', 'discounts')
    line('y', ['D', 'D1', 'D2'], 'B3', 'bundles')
    line('v', ['E', 'E1', 'E2'], 'C2', 'coupons')
    line('w', ['F', 'F1', 'F2'], 'C2', 'vouchers')
    // The run B…B3 is weakly plausible, which would be put to the user. After the request about it, the next one and its fallback do not both fit.
    const rules: Rules = { own: { brief: 0.3 }, chunk: { B1: 0.4 } }
    const routed = await route(s.build(), 'Tell me more about pricing step 1', rules, { treeWalk: on, budget: { requests: 2 } })
    expect(routed.requests).toHaveLength(3)
    // A2, D2, E2 and F2 end their lines and were asked about by themselves in the first pass.
    expect(chunkIds(routed, 1)).toEqual([chunk(routed, 'A', 'A1'), chunk(routed, 'B', 'B3')])
    // The fallback asks about the listed sections by themselves, except those of the two runs that were asked about as runs.
    expect(new Set(routed.asked[2])).toEqual(new Set(ids(routed, 's', ['C', 'C1', 'C2', 'D', 'D1', 'E', 'E1', 'F', 'F1'])))
    expect(routed.outcome.kind).toBe('plan')
    expect(planOf(routed).decision.budgetStop).toEqual({ limit: 'requests', fallback: 'one-pass', bestFound: [{ unit: 'message', sectionIds: sections(['B3']), confidence: 0.4 }] })
    expect(unit(routed).targets).toEqual(sections(['B3']))
    expect(planOf(routed).decision.runEnds?.[0]).toMatchObject({ sectionId: sceneIds.section('B3'), confidence: 0.4 })
    // With room to finish, the same weak run is put to the user.
    expect((await route(s.build(), 'Tell me more about pricing step 1', rules, { treeWalk: on })).outcome.kind).toBe('target-ambiguity')
  })
})

describe.each(COMBINATIONS)('long runs · %s', (_name, treeWalk) => {
  test('C19 · J builds on the group as a whole: both siblings are referents and J continues from the join-back', async () => {
    const routed = await route(tripClosed, 'Use those recommendations to make a five-day itinerary.', { own: { A: 0.77, B: 0.3, brief: 0.5 }, several: 0.4, together: { G: 0.86 } }, { treeWalk })
    expect(new Set(unit(routed).targets)).toEqual(new Set(sections(['A', 'B'])))
    expect(unit(routed).placement).toEqual({ kind: 'continue', buildsOn: { kind: 'sibling-group', groupId: sceneIds.group('G') } })
    expect(unit(routed).prerequisites).toEqual([])
  })

  test('C9 · J needs both running siblings: it depends on the whole group, never on a subset', async () => {
    const routed = await route(tripRunning, 'Use those recommendations to make a five-day itinerary.', { relation: 'dependent', own: { A: 0.77, B: 0.2 }, together: { G: 0.86 } }, { treeWalk })
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
    const routed = await route(s.build(), 'Use those recommendations to make a five-day itinerary.', { own: { A: 0.77, B: 0.3 }, together: { G: 0.86 } }, { treeWalk })
    expect(new Set(unit(routed).targets)).toEqual(new Set(sections(['A', 'B'])))
    expect(unit(routed).placement).toEqual({ kind: 'continue', buildsOn: { kind: 'sibling-group', groupId: sceneIds.group('G') } })
  })

  test('referents · a reply to a section in the middle of a run is resolved exactly, in the trunk and in a branch; with hops, it goes to the last section of a run that was not asked about section by section', async () => {
    const hops = treeWalk.hopBetweenBranchPoints === true
    const inTrunk = await route(trunk, 'Make the answer to question 4 shorter', { own: { T4: 0.9 } }, { treeWalk })
    // Every section of the trunk is listed and rides in the pipeline's request by itself, unless the trunk base stands in for them.
    expect(unit(inTrunk).targets).toEqual(sections([hops && treeWalk.startAtTrunkBase ? 'T9' : 'T4']))
    const inBranch = await route(runs, 'Redo press step 2', { own: { brief: 0.3, A2: 0.9 } }, { treeWalk })
    expect(unit(inBranch).targets).toEqual(sections([hops ? 'A4' : 'A2']))
  })

  test('referents · a correction keeps the ancestor it revises beside its relevant descendant', async () => {
    const routed = await route(runs, 'Actually, the launch is in March, not May', { own: { brief: 0.9, A2: 0.85 }, corrective: 0.95 }, { treeWalk })
    expect(planOf(routed).units).toEqual([])
    expect(new Set(planOf(routed).revisions[0]?.targetDirectiveIds)).toEqual(new Set([sceneIds.directive('brief'), sceneIds.directive('A2')]))
  })

  test('guard · the budget holds: no request beyond it, and the walk falls back deterministically', async () => {
    for (const [sc, rules] of [[runs, { own: { brief: 0.3, A4: 0.3, P: 0.9, B1: 0.9 }, several: 0.9 }], [flat(120), { own: { T30: 0.9 } }]] as const) {
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

// ───────────────────────────── start candidates ─────────────────────────────

describe('start candidates', () => {
  /** A trunk of ten that splits into X (four answers) and Y (four answers). */
  const forked = (() => {
    const s = scene().chain('chat', 'root', 'chat')
    for (let i = 0; i < 10; i++) s.add(`T${i}`, { chain: 'chat', on: i === 0 ? null : `T${i - 1}`, label: `turn ${i}`, request: `Question ${i}`, answer: `Answer ${i}` })
    for (const side of ['X', 'Y']) {
      s.chain(side, 'branch', side)
      for (let i = 0; i < 4; i++) s.add(`${side}${i}`, { chain: side, on: i === 0 ? 'T9' : `${side}${i - 1}`, label: `side ${side}${i}`, request: `Branch ${side} step ${i}`, answer: `Answer ${side}${i}` })
    }
    return s.build()
  })()

  test('candidates · a candidate is where the walk starts instead of the root above it: its run from the top down to it rides in the routing request, and the trunk is not asked about', async () => {
    const routed = await route(forked, 'Redo step 1 of branch X', { own: { X1: 0.9 } }, { candidates: ['X2'] })
    // X0 … X2, each by itself, with the first pass (X3 and Y3). Nothing of the trunk: X2's context holds it.
    expect(new Set(routed.asked[0])).toEqual(new Set(ids(routed, 's', ['X0', 'X1', 'X2', 'X3', 'Y3'])))
    expect(routed.requests).toHaveLength(1)
    expect(unit(routed).targets).toEqual(sections(['X1']))
    expect(unit(routed).placement).toEqual({ kind: 'continue', buildsOn: { kind: 'node', nodeId: sceneIds.node('X1') } })
    // With no candidate the walk starts at the root: the trunk is asked about, and nothing below it, because it is not plausible.
    const plain = await route(forked, 'Redo step 1 of branch X', { own: { X1: 0.9 } })
    expect(new Set(plain.asked[0])).toEqual(new Set(ids(plain, 's', ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'X3', 'Y3'])))
    expect(unit(plain).targets).toEqual([])
  })

  test('candidates · a candidate is a place to look, never a referent: one the decision model does not confirm is not a target', async () => {
    const routed = await route(forked, 'Explain how volcanoes form', { relation: 'new' }, { candidates: ['X2', 'Y1'] })
    expect(unit(routed).targets).toEqual([])
    expect(unit(routed).placement).toEqual({ kind: 'new-chain' })
  })

  test('candidates · a start that is not plausible hands over to the root it displaced, in a further request that does not ask again', async () => {
    // The candidate is in X; the message is about the trunk and Y.
    const routed = await route(forked, 'Redo step 1 of branch Y', { own: { T9: 0.3, Y1: 0.9 } }, { candidates: ['X2'] })
    expect(new Set(routed.asked[0])).toEqual(new Set(ids(routed, 's', ['X0', 'X1', 'X2', 'X3', 'Y3'])))
    // The root: its trunk. Then, the trunk being plausible, the runs below it: Y, and of X only what was not asked about.
    expect(new Set(routed.asked[1])).toEqual(new Set(ids(routed, 's', ['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9'])))
    expect(new Set(routed.asked[2])).toEqual(new Set(ids(routed, 's', ['Y0', 'Y1', 'Y2'])))
    expect(unit(routed).targets).toEqual(sections(['Y1']))
    const all = routed.asked.flat()
    expect(new Set(all).size).toBe(all.length)
  })

  test('candidates · when the message refers to several sections, the root a plausible start displaced is started too: a second referent in another branch is found', async () => {
    const rules: Rules = { own: { T9: 0.3, X1: 0.9, Y1: 0.9 } }
    const one = await route(forked, 'Compare step 1 of branch X with step 1 of branch Y', { ...rules, several: 0.2 }, { candidates: ['X2'] })
    expect(unit(one).targets).toEqual(sections(['X1']))
    expect(one.requests).toHaveLength(1)
    const both = await route(forked, 'Compare step 1 of branch X with step 1 of branch Y', { ...rules, several: 0.9 }, { candidates: ['X2'] })
    expect(new Set(unit(both).targets)).toEqual(new Set(sections(['X1', 'Y1'])))
    expect(unit(both).placement.kind).toBe('join-chain')
  })

  test('candidates · a candidate older than the routing request lists is asked about in the first further request, with what it was built on as context', async () => {
    const sc = flat(200)
    const routed = await route(sc, 'Make the answer to question 40 shorter', { own: { T40: 0.9 } }, { candidates: ['T40'] })
    // The run from its top down to T40 is 41 answers: searched for its last relevant one, then that part asked about one by one.
    expect(routed.requests).toHaveLength(3)
    const named = Object.values(routed.requests[1]?.questions ?? {}).flatMap((q) => [...q.instructions.matchAll(/\("Question (\d+)"\)/g)].map((m) => Number(m[1])))
    expect(Math.max(...named)).toBe(40)
    expect(unit(routed).targets).toEqual(sections(['T40']))
    // Without the candidate the whole run of 176 older answers is searched: more is named in the first further request.
    const plain = await route(sc, 'Make the answer to question 40 shorter', { own: { T40: 0.9 } })
    expect(furtherTokens(routed)).toBeLessThan(furtherTokens(plain))
  })

  test('candidates · only answer sections of this conversation are accepted, at most twelve, and a source that fails is a source with nothing to say', async () => {
    const asked: CandidateQuery[] = []
    const source: CandidateSource = {
      name: 'scripted',
      candidates: async (query) => {
        asked.push(query)
        return [sceneIds.section('nowhere'), sceneIds.section('X2'), sceneIds.section('X2')].map((sectionId) => ({ sectionId, score: null }))
      },
    }
    const routed = await route(forked, 'Redo step 1 of branch X', { own: { X1: 0.9 } }, { candidates: source })
    expect(unit(routed).targets).toEqual(sections(['X1']))
    // The source is asked once per unit, with the unit's text and the conversation's answer sections.
    expect(asked.map((q) => ({ key: q.unit.key, text: q.text, sections: q.sections.length }))).toEqual([{ key: 'm', text: 'Redo step 1 of branch X', sections: 18 }])
    const failing: CandidateSource = { name: 'failing', candidates: async () => Promise.reject(new Error('retrieval is down')) }
    const plain = await route(forked, 'Redo step 1 of branch X', { own: { X1: 0.9 } })
    const failed = await route(forked, 'Redo step 1 of branch X', { own: { X1: 0.9 } }, { candidates: failing })
    expect(failed.requests).toEqual(plain.requests)
    // The routing is the one without a source; its record says which source was asked and that it named nothing.
    expect(withoutCandidateRecord(failed.outcome)).toEqual(plain.outcome)
    expect(candidateRecord(failed.outcome)).toEqual({ source: 'failing', units: [{ unit: 'message', candidates: [] }] })
    expect(candidateRecord(plain.outcome)).toBeNull()
    // What was accepted is recorded, in the source's order, with the scores it gave (this one gave none).
    expect(candidateRecord(routed.outcome)).toEqual({ source: 'scripted', units: [{ unit: 'message', candidates: [{ sectionId: sceneIds.section('X2'), score: null }] }] })
    // One pass does not walk: candidates change nothing for it.
    const onePass = await route(forked, 'Redo step 1 of branch X', { own: { X1: 0.9 } }, { strategy: 'one-pass' })
    expect((await route(forked, 'Redo step 1 of branch X', { own: { X1: 0.9 } }, { strategy: 'one-pass', candidates: ['X2'] })).requests).toEqual(onePass.requests)
    // An explicit reply target is used as given: the source is not asked.
    expect(asked).toHaveLength(1)
  })

  test('candidates · no source: the start set is the roots, request for request what a source with nothing to say gives', async () => {
    const rules: Rules = { own: { brief: 0.4, A: 0.8, B: 0.3 }, together: { G: 0.9 } }
    const plain = await route(tripFull, 'Use those recommendations to make a five-day itinerary.', rules)
    const empty = await route(tripFull, 'Use those recommendations to make a five-day itinerary.', rules, { candidates: [] })
    expect(empty.requests).toEqual(plain.requests)
    expect(withoutCandidateRecord(empty.outcome)).toEqual(plain.outcome)
  })

  test('C19 · a candidate that is one sibling still lands J on the full sibling group: the join-back is asked about beside its member', async () => {
    // A is the candidate. B was continued, so neither sibling is in the first pass and the brief is not started.
    const sc = trip()
      .chain('b2', 'branch', 'cheaper activities')
      .add('B2', { chain: 'b2', on: 'B', label: 'cheaper activities', request: 'Give me three cheaper alternatives', answer: 'Free shrines.', consumed: ['brief', 'B'] })
      .chain('a2', 'branch', 'quieter neighborhoods')
      .add('A2', { chain: 'a2', on: 'A', label: 'quieter neighborhoods', request: 'Which is quietest?', answer: 'Higashiyama.', consumed: ['brief', 'A'] })
      .build()
    const routed = await route(sc, 'Use those recommendations to make a five-day itinerary.', { own: { A: 0.77, B: 0.3 }, several: 0.4, together: { G: 0.86 } }, { candidates: ['A'] })
    expect(routed.asked[0]).toContain('m_j1')
    expect(routed.asked[0]).not.toContain(`m_s${routed.numberOf.get('brief') ?? '?'}`)
    expect(new Set(unit(routed).targets)).toEqual(new Set(sections(['A', 'B'])))
    expect(unit(routed).placement).toEqual({ kind: 'continue', buildsOn: { kind: 'sibling-group', groupId: sceneIds.group('G') } })
  })
})

// ───────────────────────────── the decision-backed operations ─────────────────────────────

describe('operations over the decision provider', () => {
  const opsFor = (sc: Scene) => {
    const input = corpusInput({ id: 'ops', covers: ['targets'], note: 'operations', scene: sc, text: 'Make that shorter', expect: {} })
    const sectionsOfInput = numberedAnswerSections(input, supply(input, []))
    const tree = buildTree({ sections: sectionsOfInput, candidates: input.candidates })
    const request: ReferentRequest = {
      units: [UNIT],
      sections: sectionsOfInput,
      candidates: input.candidates,
      stateText: '',
      subject: 'New message: "Make that shorter"',
      relevance: { clear: 0.7, floor: 0.25 },
      useSummaryIfAvailable: false,
      decisionContext: () => null,
      treeWalk: DEFAULT_SETTINGS.routing.treeWalk,
      startCandidates: {},
    }
    const node = (h: string) => {
      const found = tree.bySection.get(sceneIds.section(h))
      if (!found) throw new Error(h)
      return found
    }
    return { ops: createDecisionOperations({ request, tree, gate: null, ask: null }), tree, node }
  }
  const UNIT = { key: 'm', name: 'the new message' }

  test('operations · Point, Group, Segment and Several are one yes/no question each; a Segment names its sections by their requests and confirms nothing', () => {
    const { ops, tree, node } = opsFor(tripFull)
    const group = tree.byGroup.get(sceneIds.group('G'))
    if (!group) throw new Error('G')
    const questions = ops.questions([probe.several(UNIT), probe.point(UNIT, node('A')), probe.group(UNIT, group), probe.segment(UNIT, [node('B'), node('B2')])])
    expect(Object.keys(questions)).toEqual(['m_several', `m_s${node('A').n}`, 'm_j1', `m_c${node('B').n}_${node('B2').n}`])
    expect(questions[`m_c${node('B').n}_${node('B2').n}`]?.instructions).toContain(`S${node('B').n} ("Suggest rainy-day activities"), S${node('B2').n} ("Give me three cheaper alternatives")`)
    // Nothing is known before a request is answered; the estimate is neutral: there is none.
    expect(ops.known(probe.point(UNIT, node('A')))).toBeNull()
    expect(ops.estimate(UNIT, [node('A')])).toBeNull()
    expect(ops.describe(node('A'))).toContain('"neighborhoods": request "Suggest neighborhoods to stay in"')
    expect(ops.rides(probe.point(UNIT, node('A')))).toBe(true)
    // What a probe adds to a round: a Point its line and its question, a Segment its question alone.
    expect(ops.size(probe.point(UNIT, node('A')))).toBeGreaterThan(ops.size(probe.several(UNIT)))
  })

  test('operations · two parts of a run that share their first and last section are different questions', () => {
    const { ops, node } = opsFor(flat(30))
    const whole = probe.segment(UNIT, [node('T1'), node('T2'), node('T3'), node('T4')])
    const thinner = probe.segment(UNIT, [node('T1'), node('T4')])
    const questions = ops.questions([whole, thinner, whole])
    expect(Object.keys(questions)).toHaveLength(2)
  })

  test('operations · a section asked about by itself is shown with the nearest answers it was built on; a part of a run with the first answers of the run', async () => {
    // T40 is a start candidate: its run is searched from the top down to it, then the rest of the run.
    const routed = await route(flat(200), 'Make the answer to question 40 shorter', { own: { T40: 0.9 } }, { candidates: ['T40'] })
    const n = (h: string) => routed.numberOf.get(h) ?? '?'
    const points = routed.requests[2]?.state ?? ''
    const first = Math.min(...ownIds(routed, 2).map((id) => Number(id.slice(3))))
    const firstHandle = [...routed.numberOf].find(([, number]) => number === first)?.[0] ?? ''
    const before = (steps: number) => `T${Number(firstHandle.slice(1)) - steps}`
    // The sections of the opened part follow one another; the first is shown with the two answers before it, by their requests.
    expect(points).toContain('Where they come from, for context only')
    expect(points).toContain(`S${first} builds on S${n(before(1))} ("Question ${before(1).slice(1)}"), which builds on S${n(before(2))} ("Question ${before(2).slice(1)}").`)
    expect(points).toContain(`S${first} to S${n('T40')} are consecutive answers of one line of work.`)
    // The answers named as context are not asked about and their lines are not sent.
    expect(points).not.toContain(`S${n(before(1))}. "`)
    expect(Object.keys(routed.requests[2]?.questions ?? {})).not.toContain(`m_s${n(before(1))}`)
    // The parts of the rest of the run, in the same request: the question is about the part, the top of the run is context.
    expect(points).toContain(`are consecutive answers of one line of work that starts with S${n('T0')} ("Question 0"), S${n('T1')} ("Question 1").`)
    // A part that starts at the top of a run that was built on nothing needs no such line.
    expect(routed.requests[1]?.state).not.toContain('Where they come from')
  })

  test('operations · a section whose line shows a stored summary is not shown its ancestry again', async () => {
    const rules: Rules = { own: { brief: 0.4, A: 0.8, B: 0.3 }, together: { G: 0.9 } }
    const routed = await route(tripFull, 'Use those recommendations to make a five-day itinerary.', rules, { summaries: summarised(['A']) })
    const state = routed.requests[1]?.state ?? ''
    expect(state).toContain(`S${routed.numberOf.get('B')} builds on S${routed.numberOf.get('brief')} ("${BRIEF}").`)
    expect(state).not.toContain(`S${routed.numberOf.get('A')} and S${routed.numberOf.get('B')} build on`)
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
  const rules: Rules = { own: { A: 0.77, B: 0.3, brief: 0.5 }, several: 0.4, together: { G: 0.86 } }

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
    expect(routingTokenBudget(routing, { ...run, sessionLogTokens: 1_000_000 })).toEqual({ total: 30_000, limitedBy: 'token-budget' })
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
    // Answers of 2,500 tokens: the search round over 700 sections is about 21,900 tokens by the guard's estimate (fitted
    // 2026-11-12 never to count below the decision model's reported figure), so the log must be large enough for 3% of it
    // to hold the routing request and the round. With 1,700-token answers (24,080) it held only under the earlier estimate.
    const sc = chain(700, 2_500)
    const text = 'Make the answer to point 40 shorter'
    // 700 exchanges of 2,520 tokens: 3% of the log is 52,920 tokens, over the ceiling, so the budget is the ceiling.
    expect(resolveTokenBudget(DEFAULT_SETTINGS.routing.tokenBudget, logOf(sc, text))).toBe(40_000)
    const relative = await route(sc, text, { own: { T40: 0.9 } })
    expect(unit(relative).targets).toEqual(sections(['T40']))
    expect(planOf(relative).decision.explanation).not.toContain('budget was reached')
    expect(allTokens(relative)).toBeLessThanOrEqual(35_280)
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

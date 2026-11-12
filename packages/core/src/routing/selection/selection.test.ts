import { DEFAULT_SETTINGS, providerError, type RoutingSettings, type Settings, type StrategySelectionMode, type StrategyChoice, type StrategySelectionRecord } from '@committee/protocol'
import { describe, expect, test } from 'vitest'
import { NEVER_CANCELLED, type DecisionProvider, type DecisionQuestions, type DecisionRequest, type DecisionResult, type RoutingInput, type RoutingOutcome, type RoutingPlan, type StrategySelector } from '../../ports'
import { compareWithLabel, corpusInput, oracleDecisionProvider, referenceDecomposer, scene, sceneIds, type CorpusExample, type Scene } from '../corpus'
import { createRouter } from '../pipeline'
import { estimateRequestTokens, routingTokenBudget } from '../referents'
import { numberedAnswerSections, supply } from '../supply'
import { applyChoice, chooseByRules, configuredChoice, describeShape, genealogyShape, shapeSignature, NEVER_SEARCH_RUNS } from './index'

/**
 * Strategy selection (docs/build/dependency-decisioning.md · "Strategy
 * selection"): the shape a selector reads, the rules, the decision-model
 * selector and its fallbacks, reuse by shape signature, and that a routing
 * with a selector is the routing the chosen strategy gives when it is
 * configured directly. Decisions about sections are answered as the
 * example's label says; the selector's own questions as each test scripts.
 */

const BRIEF = 'Trip brief: Kyoto, five days, November, moderate budget'

/** The running example of 01 and 04 after `before` unrelated one-answer lines: brief → A, B (siblings). */
const trip = (before: number, open = false): Scene => {
  const s = scene()
  for (let i = 0; i < before; i++) s.chain(`old${i}`, 'root', `topic ${i}`).add(`O${i}`, { chain: `old${i}`, on: null, label: `topic ${i}`, request: `Question ${i} about something else`, answer: `Answer ${i}` })
  s.chain('trip', 'root', 'trip')
    .add('brief', { chain: 'trip', on: null, label: 'brief', request: BRIEF, answer: 'Noted.' })
    .chain('A', 'fork', 'neighborhoods')
    .add('A', { chain: 'A', on: 'brief', label: 'neighborhoods', request: 'Suggest neighborhoods to stay in', consumed: ['brief'], ...(open ? { state: 'running' as const } : { answer: 'Gion or Higashiyama.' }) })
    .chain('B', 'fork', 'activities')
    .add('B', { chain: 'B', on: 'brief', label: 'activities', request: 'Suggest rainy-day activities', consumed: ['brief'], ...(open ? { state: 'running' as const } : { answer: 'Museums and tea houses.' }) })
    .group('G', { base: 'trip', start: 'brief', members: ['A', 'B'], open })
  return s.build()
}

/** One chain of `n` answers. */
const flat = (n: number): Scene => {
  const s = scene().chain('chat', 'root', 'chat')
  for (let i = 0; i < n; i++) s.add(`T${i}`, { chain: 'chat', on: i === 0 ? null : `T${i - 1}`, label: `turn ${i}`, request: `Question ${i}`, answer: `Answer ${i}` })
  return s.build()
}

/** A trunk of `n` (T0…) that splits at its end into X and Y. */
const trunkThatSplits = (n: number): Scene => {
  const s = scene().chain('chat', 'root', 'chat')
  for (let i = 0; i < n; i++) s.add(`T${i}`, { chain: 'chat', on: i === 0 ? null : `T${i - 1}`, label: `turn ${i}`, request: `Question ${i}`, answer: `Answer ${i}` })
  for (const side of ['X', 'Y']) s.chain(side, 'branch', side).add(side, { chain: side, on: `T${n - 1}`, label: `side ${side}`, request: `Branch ${side}`, answer: `Answer ${side}` })
  return s.build()
}

/** `before` old one-answer lines, then a brief with a branch run of seven (A0…A6) and one of three (B0…B2). */
const longBranches = (before: number): Scene => {
  const s = scene()
  for (let i = 0; i < before; i++) s.chain(`old${i}`, 'root', `topic ${i}`).add(`O${i}`, { chain: `old${i}`, on: null, label: `topic ${i}`, request: `Question ${i}`, answer: `Answer ${i}` })
  s.chain('c', 'root', 'brief').add('brief', { chain: 'c', on: null, label: 'brief', request: 'Plan a product launch', answer: 'Noted.' })
  s.chain('a', 'branch', 'a')
  for (let i = 0; i < 7; i++) s.add(`A${i}`, { chain: 'a', on: i === 0 ? 'brief' : `A${i - 1}`, label: `press ${i}`, request: `Press step ${i}`, answer: `Done A${i}` })
  s.chain('b', 'branch', 'b')
  for (let i = 0; i < 3; i++) s.add(`B${i}`, { chain: 'b', on: i === 0 ? 'brief' : `B${i - 1}`, label: `pricing ${i}`, request: `Pricing step ${i}`, answer: `Done B${i}` })
  return s.build()
}

const shapeOf = (sc: Scene) => {
  const input = corpusInput({ id: 'shape', covers: ['targets'], note: 'a shape', scene: sc, text: 'x', expect: {} })
  return genealogyShape({ sections: numberedAnswerSections(input, supply(input, [])), candidates: input.candidates })
}

interface SelectorScript {
  /** The strategy the decision model picks and its confidence; `fail` makes the request fail. */
  readonly strategy?: readonly ['one-pass' | 'tree-walk', number]
  readonly trunk?: number
  readonly hops?: number
  readonly search?: number
  readonly fail?: boolean
}

interface Routed {
  readonly outcome: RoutingOutcome
  /** Every decision request, in order. */
  readonly requests: DecisionRequest<DecisionQuestions>[]
  /** The strategy selector's requests among them. */
  readonly selector: DecisionRequest<DecisionQuestions>[]
  /** The rest: the pipeline's own and the referent strategy's. */
  readonly routing: DecisionRequest<DecisionQuestions>[]
  readonly input: RoutingInput
}

const isSelector = (request: DecisionRequest<DecisionQuestions>): boolean => Object.keys(request.questions).some((id) => id.startsWith('sel_'))

/**
 * Routes `text`, which refers to `targets`, with decisions as that label says and the selector's questions as scripted.
 * Strategy selection is off unless a test turns it on, so that a strategy a test configures is the one that runs.
 */
async function route(
  sc: Scene,
  text: string,
  targets: readonly string[],
  routing: Partial<RoutingSettings> = {},
  options: { readonly script?: SelectorScript; readonly onRecord?: StrategySelectionRecord | null; readonly inject?: StrategySelector; /** False when the routing is expected to miss the label. */ readonly asLabelled?: boolean } = {},
): Promise<Routed> {
  const example: CorpusExample = { id: 'test', covers: ['targets'], note: 'a test scene', scene: sc, text, expect: { parts: [{ kind: 'unit', targets }] } }
  const settings: Settings = { ...DEFAULT_SETTINGS, routing: { ...DEFAULT_SETTINGS.routing, strategySelection: 'off', ...routing } }
  const input: RoutingInput = { ...corpusInput(example, settings), strategySelectionOnRecord: options.onRecord ?? null }
  const oracle = oracleDecisionProvider(example, input)
  const requests: DecisionRequest<DecisionQuestions>[] = []
  const script = options.script ?? {}
  const provider: DecisionProvider = {
    async decide<Q extends DecisionQuestions>(request: DecisionRequest<Q>, signal: Parameters<DecisionProvider['decide']>[1]): Promise<DecisionResult<Q>> {
      requests.push(request)
      if (!isSelector(request)) return oracle.decide(request, signal)
      if (script.fail) return { ok: false, error: providerError('service-unavailable', 'The decision model is unavailable') }
      const [strategy, confidence] = script.strategy ?? ['tree-walk', 0.9]
      const answers: { [id: string]: unknown } = {
        sel_strategy: { type: 'choice', choice: strategy, confidence, probabilities: { 'one-pass': strategy === 'one-pass' ? confidence : 1 - confidence, 'tree-walk': strategy === 'tree-walk' ? confidence : 1 - confidence } },
        sel_trunk: { type: 'noul', probability: script.trunk ?? 0.05 },
        sel_hops: { type: 'noul', probability: script.hops ?? 0.05 },
        sel_search: { type: 'noul', probability: script.search ?? 0.95 },
      }
      return { ok: true, model: 'scripted', answers: answers as never, usage: null }
    },
  }
  const router = createRouter({ decisionProvider: provider, decomposer: referenceDecomposer(example), ...(options.inject ? { strategySelector: options.inject } : {}) })
  const outcome = await router.route(input, NEVER_CANCELLED)
  if (options.asLabelled !== false) expect(compareWithLabel(example, outcome)).toEqual([])
  return { outcome, requests, selector: requests.filter(isSelector), routing: requests.filter((r) => !isSelector(r)), input }
}

const planOf = (routed: Routed): RoutingPlan => {
  if (routed.outcome.kind !== 'plan') throw new Error(`Expected a plan, got ${routed.outcome.kind}`)
  return routed.outcome.plan
}
const selectionOf = (routed: Routed): StrategySelectionRecord | null => planOf(routed).decision.strategySelection ?? null
/** A plan without what records how the strategy was chosen: what must be the same whoever chose it. */
const placed = (routed: Routed) => {
  const plan = planOf(routed)
  return { units: plan.units, revisions: plan.revisions, composition: plan.composition, decisions: plan.decision.units }
}
/** The routing's token budget in a scene of default-length answers: the relative budget's floor. */
const BUDGET = 16_000
const signatureOf = (sc: Scene, tokenBudget = BUDGET): string => shapeSignature(shapeOf(sc), tokenBudget)
const TREE_WALK: StrategyChoice = { strategy: 'tree-walk', startAtTrunkBase: false, hopBetweenBranchPoints: false, searchLongRuns: true }
const J = 'Use those recommendations to make a five-day itinerary.'

describe('the shape of the genealogy', () => {
  test('shape · counts and structure of the trip tree: one line that splits once into a finished sibling group', () => {
    expect(shapeOf(trip(0))).toEqual({
      sections: 3,
      beyondWindow: 0,
      roots: 1,
      oldSingleRoots: 0,
      branchPoints: 1,
      depth: 2,
      siblingGroups: { open: 0, closed: 1 },
      tokens: shapeOf(trip(0)).tokens,
      trunks: 1,
      longestTrunk: { sections: 1, listedBeforeEnd: 0, unlisted: 0, tokens: shapeOf(trip(0)).longestTrunk?.tokens, endsInSplit: true },
      branchRuns: 2,
      longestBranchRun: { sections: 1, listedBeforeEnd: 0, unlisted: 0, tokens: shapeOf(trip(0)).longestBranchRun?.tokens, endsInSplit: false },
    })
    expect(shapeOf(trip(0, true)).siblingGroups).toEqual({ open: 1, closed: 0 })
  })

  test('shape · a long chain is one trunk whose older answers lie beyond the window; old one-answer lines are counted as such', () => {
    const chain = shapeOf(flat(40))
    expect(chain).toMatchObject({ sections: 40, beyondWindow: 16, roots: 1, branchPoints: 0, depth: 1, trunks: 1, branchRuns: 0, longestBranchRun: null })
    expect(chain.longestTrunk).toMatchObject({ sections: 40, listedBeforeEnd: 23, unlisted: 16, endsInSplit: false })
    // Every section is a request and an answer of the scene's default length: tokens are what the log would hold for them.
    expect(chain.tokens).toBe(chain.longestTrunk?.tokens)
    expect(chain.tokens).toBeGreaterThan(40 * 1_700)

    const old = shapeOf(trip(30))
    expect(old).toMatchObject({ sections: 33, beyondWindow: 9, roots: 31, oldSingleRoots: 9, branchPoints: 1, depth: 2, trunks: 31, branchRuns: 2 })

    const split = shapeOf(trunkThatSplits(30))
    expect(split).toMatchObject({ sections: 32, beyondWindow: 8, branchPoints: 1, depth: 2, branchRuns: 2 })
    expect(split.longestTrunk).toMatchObject({ sections: 30, listedBeforeEnd: 21, unlisted: 8, endsInSplit: true })

    const branches = shapeOf(longBranches(20))
    expect(branches.longestBranchRun).toMatchObject({ sections: 7, endsInSplit: false })
    expect(branches).toMatchObject({ branchRuns: 2, oldSingleRoots: 7 })
  })

  test('shape · the description is counts only: nothing of what was asked or answered is in it, and it is the same every time', () => {
    const sc = trip(30)
    const text = describeShape(shapeOf(sc), BUDGET)
    expect(text).toBe(describeShape(shapeOf(sc), BUDGET))
    for (const section of sc.candidates.sections) {
      expect(text).not.toContain(section.request)
      expect(text).not.toContain(section.title)
      if (section.excerpt) expect(text).not.toContain(section.excerpt)
    }
    expect(text).toContain('33 answers')
    expect(text).toContain('9 answers are older than the ones the routing request lists.')
    expect(text).toContain('31 lines of work started from nothing, 9 of them a single old answer that nothing was built on.')
    expect(text).toContain('0 still running, 1 finished')
    expect(text).toContain('Routing may use 16,000 decision tokens for this message')
    // One small request: the description and the four questions are a few hundred tokens.
    expect(text.length).toBeLessThan(1_400)
  })

  test('shape · the signature changes only when the shape changes materially: counts by their power of two', () => {
    const at = (n: number): string => signatureOf(flat(n))
    // 40 to 55 answers on one chain: 16 to 31 beyond the window and 32 to 63 in all, the same buckets.
    expect(at(41)).toBe(at(40))
    expect(at(55)).toBe(at(40))
    // 56: 32 beyond the window is the next power of two. 64: the next for the total.
    expect(at(56)).not.toBe(at(55))
    expect(at(64)).not.toBe(at(63))
    // A different structure of the same size is a different shape.
    expect(signatureOf(trunkThatSplits(38))).not.toBe(at(40))
    expect(signatureOf(trip(0))).not.toBe(signatureOf(trip(0, true)))
    // What the routing may spend is part of it: with no room for a further request the choice is another.
    expect(signatureOf(flat(40), 5_000)).not.toBe(at(40))
    expect(signatureOf(flat(40), 3_000)).toBe(signatureOf(flat(40), 5_000))
    expect(signatureOf(flat(40), 17_000)).toBe(at(40))
    expect(at(40)).toMatch(/^v1\|s6\|w5\|/)
  })
})

describe('the rules', () => {
  test('rules · one pass when every answer is listed; the tree walk, searching long runs, when answers are older than the window', () => {
    expect(chooseByRules(shapeOf(trip(0))).choice).toEqual({ strategy: 'one-pass' })
    expect(chooseByRules(shapeOf(flat(24))).choice).toEqual({ strategy: 'one-pass' })
    expect(chooseByRules(shapeOf(flat(25))).choice).toEqual(TREE_WALK)
    expect(chooseByRules(shapeOf(trip(30))).choice).toEqual(TREE_WALK)
    expect(chooseByRules(shapeOf(trip(30))).reason).toContain('9 answers are older than the routing request lists')
  })

  test('rules · the trunk base when a trunk with a dozen listed answers has split, never for a trunk that has not; hops when a branch run has six answers', () => {
    // A chain that never splits is the conversation itself: replies to its earlier answers are the normal case.
    expect(chooseByRules(shapeOf(flat(200))).choice).toEqual(TREE_WALK)
    expect(chooseByRules(shapeOf(trunkThatSplits(30))).choice).toEqual({ ...TREE_WALK, startAtTrunkBase: true })
    // Eleven listed answers before the split are not enough to pay for the further request a reply to one of them costs.
    const short = scene()
    for (let i = 0; i < 14; i++) short.chain(`old${i}`, 'root', `topic ${i}`).add(`O${i}`, { chain: `old${i}`, on: null, label: `topic ${i}`, request: `Question ${i}`, answer: `Answer ${i}` })
    short.chain('chat', 'root', 'chat')
    for (let i = 0; i < 12; i++) short.add(`T${i}`, { chain: 'chat', on: i === 0 ? null : `T${i - 1}`, label: `turn ${i}`, request: `Question ${i}`, answer: `Answer ${i}` })
    for (const side of ['X', 'Y']) short.chain(side, 'branch', side).add(side, { chain: side, on: 'T11', label: `side ${side}`, request: `Branch ${side}`, answer: `Answer ${side}` })
    expect(shapeOf(short.build()).longestTrunk).toMatchObject({ listedBeforeEnd: 11, endsInSplit: true })
    expect(chooseByRules(shapeOf(short.build())).choice).toEqual(TREE_WALK)
    expect(chooseByRules(shapeOf(longBranches(20))).choice).toEqual({ ...TREE_WALK, hopBetweenBranchPoints: true })
    expect(chooseByRules(shapeOf(longBranches(20))).reason).toContain('hopping between branch points (a run of 7 answers below a split)')
  })

  test('rules · a choice is applied as a strategy and tree-walk settings; the configured settings are a choice too', () => {
    const configured = DEFAULT_SETTINGS.routing.treeWalk
    expect(configuredChoice(DEFAULT_SETTINGS.routing)).toEqual(TREE_WALK)
    expect(configuredChoice({ referentStrategy: 'one-pass', treeWalk: configured })).toEqual({ strategy: 'one-pass' })
    expect(applyChoice({ strategy: 'one-pass' }, configured)).toMatchObject({ strategy: { name: 'one-pass' }, treeWalk: configured })
    expect(applyChoice({ ...TREE_WALK, hopBetweenBranchPoints: true }, configured)).toMatchObject({
      strategy: { name: 'tree-walk' },
      treeWalk: { startAtTrunkBase: false, hopBetweenBranchPoints: true, searchRunsOverTokens: 1_500 },
    })
    // Search off: no run is ever large enough to be searched.
    expect(applyChoice({ ...TREE_WALK, searchLongRuns: false }, configured).treeWalk.searchRunsOverTokens).toBe(NEVER_SEARCH_RUNS)
    expect(configuredChoice({ referentStrategy: 'tree-walk', treeWalk: { ...configured, searchRunsOverTokens: NEVER_SEARCH_RUNS } })).toEqual({ ...TREE_WALK, searchLongRuns: false })
  })
})

describe('strategy selection in the pipeline', () => {
  test('selection · off: the configured strategy is used as before, nothing is asked and nothing is recorded', async () => {
    const routed = await route(trip(30), J, ['A', 'B'], { strategySelection: 'off' })
    expect(routed.selector).toEqual([])
    expect(selectionOf(routed)).toBeNull()
    expect(planOf(routed).decision.explanation).not.toContain('Referent strategy chosen')
  })

  test('selection · rules, the default: no request; the choice, the shape signature and the reason are recorded with the routing decision', async () => {
    expect(DEFAULT_SETTINGS.routing.strategySelection).toBe('rules')
    const routed = await route(trip(30), J, ['A', 'B'], { strategySelection: DEFAULT_SETTINGS.routing.strategySelection })
    expect(routed.selector).toEqual([])
    expect(selectionOf(routed)).toEqual({
      selector: 'rules',
      choice: TREE_WALK,
      signature: signatureOf(trip(30)),
      reason: '9 answers are older than the routing request lists, which only the tree walk reaches; long runs are searched.',
      scores: null,
      fallback: null,
      reused: false,
    })
    expect(planOf(routed).decision.explanation).toContain('Referent strategy chosen by the rules: the tree walk (long runs searched). 9 answers are older')
    const small = await route(trip(0), J, ['A', 'B'], { strategySelection: 'rules' })
    expect(selectionOf(small)?.choice).toEqual({ strategy: 'one-pass' })
    expect(planOf(small).decision.explanation).toContain('Referent strategy chosen by the rules: one pass.')
  })

  test('DA2 · a strategy selector only chooses: the routing is, request for request and in its plan, the one obtained when the same strategy and switches are configured directly', async () => {
    const cases = [
      ['one pass, for a conversation inside the window', trip(0), J, ['A', 'B'], { referentStrategy: 'one-pass' }, { strategy: ['one-pass', 0.9] }],
      ['the tree walk, for answers beyond the window', trip(30), J, ['A', 'B'], { referentStrategy: 'tree-walk' }, { strategy: ['tree-walk', 0.9] }],
      ['the tree walk from the trunk base, for a long trunk that has split', trunkThatSplits(30), 'Make the answer to question 3 shorter', ['T3'], { referentStrategy: 'tree-walk', treeWalk: { ...DEFAULT_SETTINGS.routing.treeWalk, startAtTrunkBase: true } }, { strategy: ['tree-walk', 0.9], trunk: 0.9 }],
      ['the tree walk with hops, for a long branch run', longBranches(20), 'Redo press step 2', ['A2'], { referentStrategy: 'tree-walk', treeWalk: { ...DEFAULT_SETTINGS.routing.treeWalk, hopBetweenBranchPoints: true } }, { strategy: ['tree-walk', 0.9], hops: 0.9 }],
    ] as const
    for (const [name, sc, text, targets, configured, script] of cases) {
      const direct = await route(sc, text, targets, { ...configured, strategySelection: 'off' })
      expect(selectionOf(direct), name).toBeNull()
      // Configured the other way round, so that the result can only come from the selector.
      const opposite: Partial<RoutingSettings> = configured.referentStrategy === 'one-pass' ? { referentStrategy: 'tree-walk' } : { referentStrategy: 'one-pass' }
      // By the rules: no request of its own, so every request is the routing's.
      const byRules = await route(sc, text, targets, { ...opposite, strategySelection: 'rules' })
      expect(selectionOf(byRules)?.selector, name).toBe('rules')
      expect(byRules.requests, name).toEqual(direct.requests)
      expect(placed(byRules), name).toEqual(placed(direct))
      expect(planOf(byRules).decision.questions, name).toEqual(planOf(direct).decision.questions)
      // By the decision model: its one request about the shape, and after it the same requests and the same plan.
      const byModel = await route(sc, text, targets, { ...opposite, strategySelection: 'decision-model' }, { script })
      expect(selectionOf(byModel), name).toMatchObject({ selector: 'decision-model', fallback: null })
      expect(byModel.selector, name).toHaveLength(1)
      expect(byModel.routing, name).toEqual(direct.requests)
      expect(placed(byModel), name).toEqual(placed(direct))
      expect(planOf(byModel).decision.questions.filter((q) => !q.id.startsWith('sel_')), name).toEqual(planOf(direct).decision.questions)
    }
  })

  test('selection · decision model: one small request about the shape alone, typed questions, and then the routing of the strategy it chose', async () => {
    const sc = trunkThatSplits(30)
    const text = 'Make the answer to question 3 shorter'
    const selected = await route(sc, text, ['T3'], { referentStrategy: 'one-pass', strategySelection: 'decision-model' }, { script: { strategy: ['tree-walk', 0.92], trunk: 0.88, hops: 0.1, search: 0.97 } })
    expect(selected.selector).toHaveLength(1)
    expect(selected.requests[0]).toBe(selected.selector[0])
    const asked = selected.selector[0]
    // The shape only: no request, answer, title or message text.
    expect(asked?.state).toBe(describeShape(shapeOf(sc), BUDGET))
    expect(asked?.state).not.toContain(text)
    expect(Object.entries(asked?.questions ?? {}).map(([id, q]) => [id, q.type])).toEqual([['sel_strategy', 'choice'], ['sel_trunk', 'noul'], ['sel_hops', 'noul'], ['sel_search', 'noul']])
    expect(Object.keys((asked?.questions['sel_strategy'] as { options: object }).options)).toEqual(['one-pass', 'tree-walk'])
    expect(estimateRequestTokens(asked?.state ?? '', asked?.questions ?? {})).toBeLessThan(900)
    expect(selectionOf(selected)).toEqual({
      selector: 'decision-model',
      choice: { strategy: 'tree-walk', startAtTrunkBase: true, hopBetweenBranchPoints: false, searchLongRuns: true },
      signature: signatureOf(sc),
      reason: 'The decision model chose the tree walk for this shape (confidence 0.92): long runs searched, starting at the trunk base.',
      scores: { strategy: 0.92, startAtTrunkBase: 0.88, hopBetweenBranchPoints: 0.1, searchLongRuns: 0.97 },
      fallback: null,
      reused: false,
    })
    // The selector's questions are in the decision record with every other question.
    expect(planOf(selected).decision.questions.map((q) => q.id).slice(0, 4)).toEqual(['sel_strategy', 'sel_trunk', 'sel_hops', 'sel_search'])
    // After the selector's request, the routing is that of the chosen strategy configured directly.
    const direct = await route(sc, text, ['T3'], { referentStrategy: 'tree-walk', treeWalk: { ...DEFAULT_SETTINGS.routing.treeWalk, startAtTrunkBase: true } })
    expect(selected.routing).toEqual(direct.requests)
    expect(placed(selected)).toEqual(placed(direct))

    const onePass = await route(trip(30), 'Explain how volcanoes form', [], { strategySelection: 'decision-model' }, { script: { strategy: ['one-pass', 0.85] } })
    expect(selectionOf(onePass)).toMatchObject({ selector: 'decision-model', choice: { strategy: 'one-pass' }, scores: { strategy: 0.85 } })
    expect(onePass.routing).toEqual((await route(trip(30), 'Explain how volcanoes form', [], { referentStrategy: 'one-pass' })).requests)
  })

  test('selection · the search of long runs is turned off only on a confident no, and a switch on only on a confident yes', async () => {
    const run = (script: SelectorScript) => route(flat(40), 'Explain how volcanoes form', [], { strategySelection: 'decision-model' }, { script })
    expect(selectionOf(await run({ search: 0.5, trunk: 0.69, hops: 0.7 }))?.choice).toEqual({ strategy: 'tree-walk', startAtTrunkBase: false, hopBetweenBranchPoints: true, searchLongRuns: true })
    expect(selectionOf(await run({ search: 0.31 }))?.choice).toMatchObject({ searchLongRuns: true })
    expect(selectionOf(await run({ search: 0.2 }))?.choice).toMatchObject({ searchLongRuns: false })
  })

  test('selection · the decision request fails: the rules choose, the routing still succeeds, and the record says so', async () => {
    const routed = await route(trip(30), J, ['A', 'B'], { referentStrategy: 'one-pass', strategySelection: 'decision-model' }, { script: { fail: true } })
    expect(routed.selector).toHaveLength(1)
    expect(selectionOf(routed)).toMatchObject({ selector: 'rules', choice: TREE_WALK, fallback: 'failed', scores: null, reused: false })
    expect(selectionOf(routed)?.reason).toBe('The decision model could not be asked about the shape. By the rules: 9 answers are older than the routing request lists, which only the tree walk reaches; long runs are searched.')
    expect(routed.routing).toEqual((await route(trip(30), J, ['A', 'B'], { referentStrategy: 'tree-walk' })).requests)
  })

  test('selection · the decision model is not confident: its choice is not used, the rules choose, and its confidence is recorded', async () => {
    const routed = await route(trip(30), J, ['A', 'B'], { strategySelection: 'decision-model' }, { script: { strategy: ['one-pass', 0.55] } })
    expect(selectionOf(routed)).toMatchObject({ selector: 'rules', choice: TREE_WALK, fallback: 'low-confidence', scores: { strategy: 0.55 } })
    expect(selectionOf(routed)?.reason).toContain('The decision model chose one-pass with confidence 0.55, below 0.70. By the rules:')
    // At the threshold it stands.
    const atThreshold = await route(trip(30), 'Explain how volcanoes form', [], { strategySelection: 'decision-model' }, { script: { strategy: ['one-pass', 0.7] } })
    expect(selectionOf(atThreshold)).toMatchObject({ selector: 'decision-model', fallback: null })
  })

  test('selection · no room in the routing\'s token budget: nothing is asked and the rules choose', async () => {
    // The selector's request may take 15% of the budget: about 750 tokens do not fit 15% of 4,500.
    const routed = await route(trip(30), 'Explain how volcanoes form', [], { strategySelection: 'decision-model', tokenBudget: { mode: 'absolute', inputTokens: 4_500 } })
    expect(routed.selector).toEqual([])
    expect(selectionOf(routed)).toMatchObject({ selector: 'rules', fallback: 'no-budget', reused: false })
    expect(selectionOf(routed)?.reason).toContain('The routing\'s token budget had no room to ask the decision model about the shape.')
    // With room it is asked.
    expect((await route(trip(30), J, ['A', 'B'], { strategySelection: 'decision-model', tokenBudget: { mode: 'absolute', inputTokens: 8_000 } })).selector).toHaveLength(1)
  })

  test('selection · rules: with no room for a further request the walk could not descend, so one pass is chosen and the listed siblings are still asked about', async () => {
    const sc = trip(30)
    expect(chooseByRules(shapeOf(sc), 5_999).choice).toEqual({ strategy: 'one-pass' })
    expect(chooseByRules(shapeOf(sc), 6_000).choice).toEqual(TREE_WALK)
    const tokenBudget = { mode: 'absolute', inputTokens: 3_000 } as const
    const selected = await route(sc, J, ['A', 'B'], { referentStrategy: 'tree-walk', strategySelection: 'rules', tokenBudget })
    expect(selectionOf(selected)).toMatchObject({ selector: 'rules', choice: { strategy: 'one-pass' } })
    expect(selectionOf(selected)?.reason).toContain('This routing may use 3,000 decision tokens, too few for a further request')
    expect(new Set(planOf(selected).units[0]?.targets)).toEqual(new Set([sceneIds.section('A'), sceneIds.section('B')]))
    // The configured tree walk cannot pay for a level below the roots either. The siblings are the most recent answers, so the
    // first pass of every routing asks about them in the pipeline's request, and the walk has nothing left to ask.
    const walked = await route(sc, J, ['A', 'B'], { referentStrategy: 'tree-walk', tokenBudget })
    expect(walked.requests).toHaveLength(1)
    expect(new Set(planOf(walked).units[0]?.targets)).toEqual(new Set([sceneIds.section('A'), sceneIds.section('B')]))
  })

  test('selection · a choice on record for the same shape signature is reused without a request; a shape that changed materially is asked about again', async () => {
    const first = await route(flat(40), 'Explain how volcanoes form', [], { strategySelection: 'decision-model' }, { script: { strategy: ['tree-walk', 0.9], trunk: 0.9 } })
    const onRecord = selectionOf(first)
    expect(first.selector).toHaveLength(1)
    // Five answers later the shape is the same shape: the recorded choice stands and nothing is asked.
    const again = await route(flat(45), 'Explain how tides work', [], { strategySelection: 'decision-model' }, { onRecord, script: { strategy: ['one-pass', 0.99] } })
    expect(again.selector).toEqual([])
    expect(selectionOf(again)).toEqual({ ...onRecord, reused: true })
    expect(planOf(again).decision.explanation).toContain('Referent strategy chosen by the decision model, as chosen earlier for a conversation of this shape: the tree walk (long runs searched, starting at the trunk base).')
    // At 56 answers the signature is another: asked again, and the new answer is the choice.
    const changed = await route(flat(56), 'Explain how tides work', [], { strategySelection: 'decision-model' }, { onRecord, script: { strategy: ['one-pass', 0.99] } })
    expect(changed.selector).toHaveLength(1)
    expect(selectionOf(changed)).toMatchObject({ selector: 'decision-model', choice: { strategy: 'one-pass' }, reused: false })
    // A fallback on record is not reused: the decision model is asked again.
    const failed = selectionOf(await route(flat(40), 'Explain how volcanoes form', [], { strategySelection: 'decision-model' }, { script: { fail: true } }))
    expect((await route(flat(41), 'Explain how tides work', [], { strategySelection: 'decision-model' }, { onRecord: failed })).selector).toHaveLength(1)
    // The rules cost nothing and are worked out every time.
    expect(selectionOf(await route(flat(45), 'Explain how tides work', [], { strategySelection: 'rules' }, { onRecord }))).toMatchObject({ selector: 'rules', reused: false })
  })

  test('selection · explicit reply targets are used as given: nothing is selected and nothing asked', async () => {
    const sc = trip(30)
    const example: CorpusExample = { id: 'explicit', covers: ['targets'], note: 'a reply to A', scene: sc, text: 'Make that shorter', replyTo: ['A'], expect: { parts: [{ kind: 'unit', targets: ['A'] }] } }
    const input = corpusInput(example, { ...DEFAULT_SETTINGS, routing: { ...DEFAULT_SETTINGS.routing, strategySelection: 'decision-model' } })
    const requests: DecisionRequest<DecisionQuestions>[] = []
    const oracle = oracleDecisionProvider(example, input)
    const outcome = await createRouter({ decisionProvider: { decide: (request, signal) => (requests.push(request), oracle.decide(request, signal)) }, decomposer: referenceDecomposer(example) }).route(input, NEVER_CANCELLED)
    expect(compareWithLabel(example, outcome)).toEqual([])
    expect(requests.filter(isSelector)).toEqual([])
    expect(outcome.kind === 'plan' ? (outcome.plan.decision.strategySelection ?? null) : 'no plan').toBeNull()
  })

  test('selection · an injected selector replaces the one the settings name, and its choice is what runs', async () => {
    const always: StrategySelector = {
      name: 'always one pass',
      reusable: false,
      select: async () => ({ selector: 'rules', choice: { strategy: 'one-pass' }, reason: 'Always.', scores: null, fallback: null }),
    }
    const routed = await route(trip(0), J, ['A', 'B'], { referentStrategy: 'tree-walk', strategySelection: 'off' }, { inject: always })
    expect(selectionOf(routed)).toMatchObject({ choice: { strategy: 'one-pass' }, reason: 'Always.' })
    expect(routed.requests).toEqual((await route(trip(0), J, ['A', 'B'], { referentStrategy: 'one-pass' })).requests)
  })

  test('DA1 · with either referent strategy, and with strategy selection off, by rules or by the decision model, a continuation requiring multiple siblings depends on their full join-back (C9) and J continues on the chain A and B forked from (C19)', async () => {
    const selectorAnswers = (strategy: 'one-pass' | 'tree-walk', switches: number) =>
      ({ sel_strategy: { type: 'choice', choice: strategy, confidence: 0.9, probabilities: {} }, sel_trunk: { type: 'noul', probability: switches }, sel_hops: { type: 'noul', probability: switches }, sel_search: { type: 'noul', probability: 0.9 } }) as never
    // Each strategy as it is reached in each mode: configured, chosen by the rules from the shape, or chosen by the decision model.
    const runs: (readonly [StrategySelectionMode, 'one-pass' | 'tree-walk', number, number])[] = [
      ['off', 'one-pass', 0, 0.1],
      ['off', 'tree-walk', 0, 0.1],
      ['off', 'tree-walk', 30, 0.1],
      ['rules', 'one-pass', 0, 0.1],
      ['rules', 'tree-walk', 30, 0.1],
      ['decision-model', 'one-pass', 0, 0.1],
      ['decision-model', 'tree-walk', 0, 0.1],
      ['decision-model', 'tree-walk', 30, 0.1],
      ['decision-model', 'tree-walk', 30, 0.9],
    ]
    for (const [strategySelection, strategy, before, switches] of runs) {
      const name = `${strategySelection}, ${strategy}, ${before} earlier answers, switches ${switches}`
      const routing: RoutingSettings = { ...DEFAULT_SETTINGS.routing, strategySelection, referentStrategy: strategySelection === 'off' ? strategy : strategy === 'one-pass' ? 'tree-walk' : 'one-pass' }
      const routeJ = async (example: CorpusExample) => {
        const input = corpusInput(example, { ...DEFAULT_SETTINGS, routing })
        const oracle = oracleDecisionProvider(example, input)
        const provider: DecisionProvider = {
          decide: async (request, signal) => (isSelector(request) ? { ok: true, model: 'scripted', answers: selectorAnswers(strategy, switches), usage: null } : oracle.decide(request, signal)),
        }
        const outcome = await createRouter({ decisionProvider: provider, decomposer: referenceDecomposer(example) }).route(input, NEVER_CANCELLED)
        expect(compareWithLabel(example, outcome), name).toEqual([])
        if (outcome.kind !== 'plan') throw new Error(`Expected a plan, got ${outcome.kind}`)
        // The strategy under test is the one that ran.
        if (strategySelection === 'off') expect(outcome.plan.decision.strategySelection ?? null, name).toBeNull()
        else expect(outcome.plan.decision.strategySelection, name).toMatchObject({ selector: strategySelection, choice: { strategy } })
        return outcome.plan.units[0]
      }
      // C19: the group has closed. Both siblings are referents and J continues from the join-back, on the chain they forked from.
      const closed = await routeJ({ id: 'c19', covers: ['placement'], note: 'J after A and B', scene: trip(before), text: J, expect: { parts: [{ kind: 'unit', targets: ['A', 'B'] }] } })
      expect(new Set(closed?.targets), name).toEqual(new Set([sceneIds.section('A'), sceneIds.section('B')]))
      expect(closed?.placement, name).toEqual({ kind: 'continue', buildsOn: { kind: 'sibling-group', groupId: sceneIds.group('G') } })
      expect(closed?.prerequisites, name).toEqual([])
      // C9: both siblings are running. J depends on the whole group, never on a subset.
      const running = await routeJ({ id: 'c9', covers: ['dependencies'], note: 'J while A and B run', scene: trip(before, true), text: J, expect: { parts: [{ kind: 'unit', relation: 'result-dependent', targets: ['A', 'B'], prerequisites: ['group:G'] }] } })
      expect(running?.prerequisites, name).toEqual([{ kind: 'sibling-group', groupId: sceneIds.group('G') }])
    }
  })

  describe.each(['rules', 'decision-model'] as const)('selected by %s', (strategySelection) => {
    test('guard · with a selector on, every decision request of the routing, the selector\'s included, stays within the routing\'s token budget', async () => {
      for (const tokenBudget of [{ mode: 'absolute', inputTokens: 6_000 }, DEFAULT_SETTINGS.routing.tokenBudget] as const) {
        const sc = flat(300)
        // Under the small budget the old section may be out of reach; what is asserted is the spend.
        const { requests } = await route(sc, 'Make the answer to question 40 shorter', ['T40'], { strategySelection, tokenBudget }, { script: { strategy: ['tree-walk', 0.9] }, asLabelled: false })
        const total = requests.reduce((sum, r) => sum + estimateRequestTokens(r.state, r.questions), 0)
        const input = corpusInput({ id: 'b', covers: ['targets'], note: 'budget', scene: sc, text: 'Make the answer to question 40 shorter', expect: {} }, { ...DEFAULT_SETTINGS, routing: { ...DEFAULT_SETTINGS.routing, tokenBudget } })
        const budget = routingTokenBudget(input.settings.routing, { sessionLogTokens: input.sessionLogTokens, messageLength: input.text.length, answerLengths: sc.candidates.sections.map((s) => s.answerLength), units: 1 })
        expect(total).toBeLessThanOrEqual(budget.total)
        expect(requests.length).toBeGreaterThanOrEqual(1)
      }
    })
  })
})

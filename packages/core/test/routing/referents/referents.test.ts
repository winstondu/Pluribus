import { DEFAULT_SETTINGS, type ReferentStrategyName, type RoutingSettings, type TreeWalkSettings } from '@pluribus/protocol'
import { describe, expect, test } from 'vitest'
import { NEVER_CANCELLED, type RoutingInput, type DecisionProvider, type DecisionQuestions, type DecisionRequest, type DecisionResult, type ReferentRequest, type ReferentStrategy, type RoutingOutcome, type RoutingPlan } from '../../../src/ports'
import { compareWithLabel as compare, corpusInput, oracleDecisionProvider, referenceDecomposer, scene, sceneIds, type CorpusExample, type Scene } from '../../../testing/routing/corpus'
import { createRouter } from '../../../src/routing/pipeline'
import { numberedAnswerSections, supply } from '../../../src/routing/supply'
import { FIRST_PASS_SECTIONS, ancestorsOf, branchingDepth, buildTree, createDecisionOperations, probe, estimateDecisionTokens, firstPassSectionIds, segmentFrom, type TreeNode } from '../../../src/routing/referents/index'

/**
 * The two referent strategies over a scripted decision provider. Decisions are stated by section
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
 * numbered them.
 */
function scripted(sc: Scene, rules: Rules, numberOf: Map<string, number>, input: RoutingInput) {
  const requests: DecisionRequest<DecisionQuestions>[] = []
  const seen = new Set<string>()
  let handleOf = new Map([...numberOf].map(([h, n]) => [n, h]))
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

interface RouteOptions {
  readonly strategy?: ReferentStrategyName
  readonly inject?: ReferentStrategy
  readonly treeWalk?: Partial<TreeWalkSettings>
}

async function route(sc: Scene, text: string, rules: Rules, routing: RouteOptions = {}): Promise<Routed> {
  const example: CorpusExample = { id: 'test', covers: ['targets'], note: 'a test scene', scene: sc, text, expect: {} }
  const settings: RoutingSettings = {
    referentStrategy: routing.strategy ?? 'tree-walk',
    treeWalk: { ...DEFAULT_SETTINGS.routing.treeWalk, ...routing.treeWalk },
  }
  const input: RoutingInput = corpusInput(example, { ...DEFAULT_SETTINGS, routing: settings })
  const numberOf = new Map(numberedAnswerSections(input, supply(input, [])).map((s) => [sc.handles.get(s.section.sectionId) ?? '', s.n]))
  const { provider, requests } = scripted(sc, rules, numberOf, input)
  const router = createRouter({
    decisionProvider: provider,
    decomposer: referenceDecomposer(example),
    ...(routing.inject ? { referentStrategy: routing.inject } : {}),
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
      resolve: async () => ({ ok: true, units: { m: { sections: [{ sectionId: sceneIds.section('nowhere'), confidence: 0.99 }], several: null } } }),
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
  })

  test('search · 200 unrelated one-answer lines: the old roots are searched as one run and the one referred to is found within the budget', async () => {
    const routed = await route(wide(200), 'Expand the answer on topic 17', { own: { T17: 0.9 } })
    expect(routed.requests).toHaveLength(3)
    expect(unit(routed).targets).toEqual(sections(['T17']))
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
    // A correction needs the exact section it revises: it is searched for whatever the switch says, request for request.
    const rules: Rules = { own: { T40: 0.9 }, corrective: 0.95 }
    const corrected = await route(flat(200), 'Actually, the answer to question 40 should say four days, not five', rules, hop)
    const searched = await route(flat(200), 'Actually, the answer to question 40 should say four days, not five', rules)
    expect(corrected.requests).toEqual(searched.requests)
    expect(corrected.outcome).toEqual(searched.outcome)
    expect(planOf(corrected).revisions[0]?.targetDirectiveIds).toEqual([sceneIds.directive('T40')])
    expect(planOf(corrected).decision.runEnds).toBeUndefined()
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
      treeWalk: DEFAULT_SETTINGS.routing.treeWalk,
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
})

import { describe, expect, test } from 'vitest'
import { NEVER_CANCELLED, type RoutingInput, type DecisionProvider, type DecisionQuestions, type DecisionRequest, type DecisionResult, type RoutingOutcome, type RoutingPlan } from '../../../src/ports'
import { compareWithLabel as compare, corpusInput, oracleDecisionProvider, referenceDecomposer, scene, sceneIds, type CorpusExample, type Scene } from '../../../testing/routing/corpus'
import { createRouter } from '../../../src/routing/pipeline'
import { numberedAnswerSections, supply } from '../../../src/routing/supply'
import { FIRST_PASS_SECTIONS, ancestorsOf, buildTree, firstPassSectionIds } from '../../../src/routing/referents/index'

/**
 * The referent strategy over a scripted decision provider. Decisions are stated by section
 * handle: `own` is "does the message refer to this section" (Point),
 * `together` "does it build on this group as a whole" (Group). Anything not stated
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
}

/**
 * Answers by handle and records every request. Sections are found by their number in the state text, as the pipeline
 * numbered them.
 */
function scripted(sc: Scene, rules: Rules, numberOf: Map<string, number>, input: RoutingInput) {
  const requests: DecisionRequest<DecisionQuestions>[] = []
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
        else if (/^s\d+$/.test(question)) p = rules.own?.[handleOf.get(number) ?? ''] ?? 0.05
        else if (/^j\d+$/.test(question)) p = rules.together?.[groupHandle(number)] ?? 0.05
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

async function route(sc: Scene, text: string, rules: Rules): Promise<Routed> {
  const example: CorpusExample = { id: 'test', covers: ['targets'], note: 'a test scene', scene: sc, text, expect: {} }
  const input: RoutingInput = corpusInput(example)
  const numberOf = new Map(numberedAnswerSections(input, supply(input, [])).map((s) => [sc.handles.get(s.section.sectionId) ?? '', s.n]))
  const { provider, requests } = scripted(sc, rules, numberOf, input)
  const router = createRouter({
    decisionProvider: provider,
    decomposer: referenceDecomposer(example),
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
  })
})

describe('referents', () => {
  test('C19 · J is clear about one sibling and weak about the other, and builds on the group as a whole: both are referents and J continues from the join-back', async () => {
    const routed = await route(tripClosed, 'Use those recommendations to make a five-day itinerary.', { own: { A: 0.77, B: 0.3, brief: 0.5 }, several: 0.4, together: { G: 0.86 } })
    expect(new Set(unit(routed).targets)).toEqual(new Set(sections(['A', 'B'])))
    expect(unit(routed).placement).toEqual({ kind: 'continue', buildsOn: { kind: 'sibling-group', groupId: sceneIds.group('G') } })
    expect(unit(routed).prerequisites).toEqual([])
  })

  test('C9 · J needs both running siblings: it depends on the whole group, never on a subset', async () => {
    const routed = await route(tripRunning, 'Use those recommendations to make a five-day itinerary.', { relation: 'dependent', own: { A: 0.77, B: 0.2 }, together: { G: 0.86 } })
    expect(new Set(unit(routed).targets)).toEqual(new Set(sections(['A', 'B'])))
    expect(unit(routed).placement).toEqual({ kind: 'continue', buildsOn: { kind: 'sibling-group', groupId: sceneIds.group('G') } })
    expect(unit(routed).prerequisites).toEqual([{ kind: 'sibling-group', groupId: sceneIds.group('G') }])
    expect(unit(routed).relation).toBe('result-dependent')
  })

  test('C20 · a follow-up that names an earlier node of one line and another line is a join chain; validation moves its parents to leaves', async () => {
    // B is not a leaf: B2 continues it. S is a leaf of a separate tree.
    const routed = await route(tripFull, 'Put the activities and the sky explanation into one handout', { own: { B: 0.9, S: 0.9, brief: 0.3 }, several: 0.9 })
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
    const followUp = await route(tripClosed, 'Which of those is quietest?', scores)
    expect(unit(followUp).targets).toEqual(sections(['A']))
    const correction = await route(tripClosed, 'Actually, the trip is four days, not five', { ...scores, corrective: 0.95 })
    expect(planOf(correction).units).toEqual([])
    expect(new Set(planOf(correction).revisions[0]?.targetDirectiveIds)).toEqual(new Set([sceneIds.directive('brief'), sceneIds.directive('A')]))
  })

  test('referents · nothing relevant: a new chain, and no further request', async () => {
    const routed = await route(tripFull, 'Explain how volcanoes form', { relation: 'new' })
    expect(unit(routed).placement).toEqual({ kind: 'new-chain' })
    expect(routed.requests).toHaveLength(1)
  })
})

describe('one pass', () => {
  test('one-pass · every listed section and every sibling group as a whole is asked about in the pipeline\'s own request, and nothing after it', async () => {
    const routed = await route(tripFull, 'Make that shorter', { own: { J: 0.9 } })
    expect(routed.requests).toHaveLength(1)
    expect(new Set(routed.asked[0])).toEqual(new Set([...ids(routed, 's', ['brief', 'A', 'B', 'J', 'B2', 'S']), 'm_j1']))
    expect(Object.keys(routed.requests[0]?.questions ?? {})).toContain('m_several')
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

  test('first-pass · the first-pass sections are asked about by themselves in the routing request, and a sibling group among them as a whole', async () => {
    const routed = await route(tripFull, 'Explain how volcanoes form', { relation: 'new' })
    for (const id of ids(routed, 's', ['J', 'B2', 'S'])) expect(routed.asked[0]).toContain(id)
    // The siblings are the most recent sections here: each by itself, and the group as a whole beside them.
    const siblings = await route(tripClosed, 'Explain how volcanoes form', { relation: 'new' })
    expect(siblings.requests).toHaveLength(1)
    for (const id of [...ids(siblings, 's', ['A', 'B']), 'm_j1']) expect(siblings.asked[0]).toContain(id)
    // Deep in a tree the walk would only reach the leaves level by level: they are asked about first.
    const leaves = await route(deep, 'Explain how volcanoes form', { relation: 'new' })
    for (const id of ids(leaves, 's', ['N1b', 'N2b', 'N3a', 'N3b'])) expect(leaves.asked[0]).toContain(id)
  })
})

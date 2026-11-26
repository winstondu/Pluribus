import { DEFAULT_SETTINGS, IN_FLIGHT_STATES, JOIN_CHOICE_OFF, createIdFactory, createSeededRandom, createUlidFactory, provisionalLabel, type Settings } from '@pluribus/protocol'
import type { CancelSignal, CandidateChain, CandidateSection, CandidateWork, DecisionProvider, DecisionQuestions, DecisionRequest, DecisionResult, RoutingOutcome } from '../../../src/ports'
import { NEVER_CANCELLED } from '../../../src/ports'
import { AMBIGUITY_FLOOR } from '../../../src/routing/derive'
import { createRouter } from '../../../src/routing/pipeline'
import { corpusInput, oracleDecisionProvider, referenceDecomposer } from '../corpus/evaluate'
import { ANSWER_LENGTH, ids, type Scene } from '../corpus/scene'
import type { CorpusExample, CorpusExpectation, Handle, PartExpectation } from '../corpus/types'

/**
 * Metamorphic transformations of a labelled example: a change to the
 * conversation, the message or the decision model's answers whose effect on
 * the routing is known without labelling anything again.
 *
 * Two kinds. An invariance leaves the routing as it was: the same plan,
 * handle for handle. A directional one changes it in a way the spec
 * states: the transformation rewrites the label as well as the input.
 *
 * Which transformations a variant gets, and their parameters, are drawn
 * from a seeded generator (`createSeededRandom`), so a run is random over
 * the corpus and exactly repeatable from its seed.
 */

type RoutingSettings = Pick<Settings, 'models' | 'thresholds' | 'routing'>

export interface Variant {
  /** The transformations applied, in order. */
  readonly name: string
  readonly kind: 'invariant' | 'directional'
  /** What is routed, and the label the routing is scored against. */
  readonly example: CorpusExample
  /**
   * The label the decision model answers by: the same conversation as
   * `example`, with the label of the example it was made from where the
   * transformation changes what Pluribus does with unchanged answers.
   */
  readonly decisions: CorpusExample
  readonly settings: RoutingSettings
  /** Seed of the generator that mints the plan's IDs. */
  readonly idSeed: number
  /** Seed for moving every answer of the decision model within its side of the thresholds; null leaves the answers as the oracle gives them. */
  readonly jitterSeed: number | null
  /** A handle of the variant as the base example names it. */
  readonly back: (handle: Handle) => Handle
}

// ───────────────────────────── handles and IDs ─────────────────────────────

const ID = /^(sec|dir|nod|chn|sib|msg|eli|req)_(.+)$/s
/** Free text of a candidate: never an ID, whatever it looks like. */
const TEXT_KEYS = new Set(['title', 'request', 'excerpt', 'label', 'instruction', 'text'])

/** Every ID in a value, through `f`. */
function mapIds<T>(value: T, f: (id: string) => string): T {
  if (typeof value === 'string') return (ID.test(value) ? f(value) : value) as T
  if (Array.isArray(value)) return value.map((v) => mapIds(v, f)) as T
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, TEXT_KEYS.has(k) ? v : mapIds(v, f)])) as T
}

/** A handle as labels write it, through a renaming of bare handles: `group:G` and a join-back `jb_G` follow `G`; `part:1` is a position, not a name. */
function throughHandles(rename: (bare: string) => string): (handle: Handle) => Handle {
  const bare = (h: string): string => (h.startsWith('jb_') ? `jb_${rename(h.slice(3))}` : rename(h))
  return (h) => (h.startsWith('part:') ? h : h.startsWith('group:') ? `group:${bare(h.slice(6))}` : bare(h))
}

function mapParts(parts: readonly PartExpectation[], h: (handle: Handle) => Handle): PartExpectation[] {
  return parts.map((p): PartExpectation => {
    if (p.kind === 'revision') {
      return { ...p, targets: p.targets.map(h), ...(p.requirements ? { requirements: p.requirements.map(h) } : {}), ...(p.affected ? { affected: p.affected.map(h) } : {}) }
    }
    const placement = p.placement === undefined || p.placement === 'new-chain' ? p.placement : 'continue' in p.placement ? { continue: h(p.placement.continue) } : { join: p.placement.join.map(h) }
    return {
      ...p,
      ...(p.targets ? { targets: p.targets.map(h) } : {}),
      ...(placement !== undefined ? { placement } : {}),
      ...(p.prerequisites ? { prerequisites: p.prerequisites.map(h) } : {}),
      ...(p.chain !== undefined ? { chain: h(p.chain) } : {}),
    }
  })
}

function mapExpectation(e: CorpusExpectation, h: (handle: Handle) => Handle): CorpusExpectation {
  return {
    ...e,
    ...(e.ambiguous ? { ambiguous: e.ambiguous.map(h) } : {}),
    ...(e.answers !== undefined ? { answers: h(e.answers) } : {}),
    ...(e.context ? { context: e.context.map(h) } : {}),
    ...(e.parts ? { parts: mapParts(e.parts, h) } : {}),
  }
}

// ───────────────────────────── invariances ─────────────────────────────

interface Step {
  readonly example: CorpusExample
  readonly back: (handle: Handle) => Handle
}

/**
 * Every entity gets another name. A handle is only how a label reads; the
 * IDs derived from it are opaque to routing, so nothing it concludes may
 * depend on their spelling or their order.
 */
export function renameHandles(example: CorpusExample, random: () => number): Step {
  const forward = new Map<string, string>()
  const backward = new Map<string, string>()
  const rename = (bare: string): string => {
    const known = forward.get(bare)
    if (known !== undefined) return known
    let fresh = ''
    do fresh = `h${Math.floor(random() * 36 ** 6).toString(36)}`
    while (backward.has(fresh))
    forward.set(bare, fresh)
    backward.set(fresh, bare)
    return fresh
  }
  const h = throughHandles(rename)
  const id = (value: string): string => {
    const match = ID.exec(value)
    return match ? `${match[1] ?? ''}_${h(match[2] ?? '')}` : value
  }
  const scene: Scene = {
    candidates: mapIds(example.scene.candidates, id),
    sessionRequirements: mapIds(example.scene.sessionRequirements, id),
    handles: new Map([...example.scene.handles].map(([key, handle]) => [id(key), h(handle)])),
    answers: new Map([...example.scene.answers].map(([key, text]) => [id(key) as typeof key, text])),
  }
  const renamed: CorpusExample = {
    ...example,
    scene,
    ...(example.replyTo ? { replyTo: example.replyTo.map(h) } : {}),
    expect: mapExpectation(example.expect, h),
  }
  return { example: renamed, back: throughHandles((bare) => backward.get(bare) ?? bare) }
}

/** Finished answers on subjects no scene touches, to put before a conversation. */
const DISTRACTORS: readonly (readonly [string, string])[] = [
  ['How do noise-cancelling headphones work?', 'A microphone samples the sound around you and the earcup plays its mirror image, so the two waves cancel before they reach your ear.'],
  ['Why do golf balls have dimples?', 'The dimples keep a thin layer of air attached to the ball for longer, which shrinks the wake behind it and cuts drag roughly in half.'],
  ['What is the Dewey Decimal system?', 'A library classification that gives every subject a number from 000 to 999, with decimals for finer subdivisions.'],
  ['How does a sundial tell the time?', 'The shadow of its gnomon moves across marked hour lines as the Sun crosses the sky.'],
  ['Why do flamingos stand on one leg?', 'Most likely to lose less body heat: a tucked leg is a leg that is not standing in cold water.'],
  ['What is a palindrome?', 'A word or phrase that reads the same backwards as forwards, such as "level" or "never odd or even".'],
]

/**
 * One to three finished, unrelated answers are put before everything else,
 * each on its own line. They are older than the whole conversation, so
 * "that" and "your last answer" still mean what they meant, and the message
 * is about none of them: the routing is unchanged. What changes is every
 * number the decision model is shown (`S1`, `L1`), which routing has to
 * read back to the same sections and lines.
 */
export function olderDistractors(example: CorpusExample, random: () => number): Step {
  const count = 1 + Math.floor(random() * 3)
  const first = Math.floor(random() * DISTRACTORS.length)
  const sections: CandidateSection[] = []
  const work: CandidateWork[] = []
  const chains: CandidateChain[] = []
  const handles = new Map(example.scene.handles)
  for (let i = 0; i < count; i++) {
    const [request, answer] = DISTRACTORS[(first + i) % DISTRACTORS.length] ?? ['', '']
    const handle = `zz_d${i}`
    for (const make of [ids.section, ids.directive, ids.node, ids.chain]) handles.set(make(handle), handle)
    sections.push({
      sectionId: ids.section(handle),
      directiveId: ids.directive(handle),
      messageId: ids.message(handle),
      title: provisionalLabel(request),
      request,
      excerpt: answer,
      answerLength: ANSWER_LENGTH,
      state: 'completed',
      chainId: ids.chain(handle),
      nodeId: ids.node(handle),
      asksElicitationId: null,
    })
    work.push({
      directiveId: ids.directive(handle),
      label: provisionalLabel(request),
      instruction: request,
      state: 'completed',
      sectionId: ids.section(handle),
      nodeId: ids.node(handle),
      chainId: ids.chain(handle),
      startNodeId: null,
      groupId: null,
      consumed: [],
      consumedRequirements: [],
    })
    chains.push({ chainId: ids.chain(handle), kind: 'root', label: provisionalLabel(request), headNodeId: ids.node(handle), tipNodeId: ids.node(handle), busy: false })
  }
  const c = example.scene.candidates
  const scene: Scene = { ...example.scene, handles, candidates: { ...c, sections: [...sections, ...c.sections], work: [...work, ...c.work], chains: [...chains, ...c.chains] } }
  return { example: { ...example, scene }, back: (handle) => handle }
}

const BEFORE = ['Please, ', 'Hey, ', 'Quick one: ', 'OK. ', '  '] as const
const AFTER = [' Thanks!', ' please', ' 🙏', '  ', '\n'] as const

/**
 * Words of address are put around the message, and its own words are left
 * as typed. Every part of it a label quotes is still there, further along:
 * the routing is unchanged, and each fragment still quotes the same words
 * (Q3, "the original message is always preserved exactly as typed").
 */
export function reframeMessage(example: CorpusExample, random: () => number): Step {
  const before = BEFORE[Math.floor(random() * BEFORE.length)] ?? ''
  const after = AFTER[Math.floor(random() * AFTER.length)] ?? ''
  return { example: { ...example, text: `${before}${example.text}${after}` }, back: (handle) => handle }
}

/** The settings every variant routes with unless its transformation changes one: the defaults, with no candidate source, as the corpus suites run. */
export const VARIANT_SETTINGS: RoutingSettings = { ...DEFAULT_SETTINGS, routing: { ...DEFAULT_SETTINGS.routing, candidateSource: 'none' } }

/**
 * The ways referents are found that a label has to hold under: the
 * strategy the rules select (the default), and each strategy as configured.
 * An invariant variant is routed under one of them, drawn like its
 * transformations, and read against the base example routed the same way.
 */
export const REFERENT_CONFIGURATIONS = {
  rules: VARIANT_SETTINGS,
  'one-pass': { ...VARIANT_SETTINGS, routing: { ...VARIANT_SETTINGS.routing, strategySelection: 'off', referentStrategy: 'one-pass' } },
  'tree-walk': { ...VARIANT_SETTINGS, routing: { ...VARIANT_SETTINGS.routing, strategySelection: 'off', referentStrategy: 'tree-walk' } },
} as const satisfies { readonly [name: string]: RoutingSettings }
export type ReferentConfiguration = keyof typeof REFERENT_CONFIGURATIONS
const CONFIGURATION_NAMES = Object.keys(REFERENT_CONFIGURATIONS) as ReferentConfiguration[]

const INVARIANCES = { rename: renameHandles, distract: olderDistractors, reframe: reframeMessage } as const
export type InvarianceName = keyof typeof INVARIANCES | 'jitter'
export const INVARIANCE_NAMES: readonly InvarianceName[] = ['rename', 'distract', 'reframe', 'jitter']

const seedFrom = (random: () => number): number => Math.floor(random() * 0xffffffff)

/**
 * One invariant variant: each invariance is applied with probability one
 * half, at least one of them, in a fixed order; the plan's IDs are always
 * minted from another seed, and the referents are found in one of the
 * `REFERENT_CONFIGURATIONS`.
 */
export function invariantVariant(example: CorpusExample, random: () => number): Variant {
  let chosen = INVARIANCE_NAMES.filter(() => random() < 0.5)
  if (chosen.length === 0) chosen = [INVARIANCE_NAMES[Math.floor(random() * INVARIANCE_NAMES.length)] ?? 'rename']
  let step: Step = { example, back: (handle) => handle }
  for (const name of chosen) {
    if (name === 'jitter') continue
    const next = INVARIANCES[name](step.example, random)
    const earlier = step.back
    step = { example: next.example, back: (handle) => earlier(next.back(handle)) }
  }
  const configuration = CONFIGURATION_NAMES[Math.floor(random() * CONFIGURATION_NAMES.length)] ?? 'rules'
  return {
    name: `${chosen.join('+')} by ${configuration}`,
    kind: 'invariant',
    example: step.example,
    decisions: step.example,
    settings: REFERENT_CONFIGURATIONS[configuration],
    idSeed: seedFrom(random),
    jitterSeed: chosen.includes('jitter') ? seedFrom(random) : null,
    back: step.back,
  }
}

/** Whether the invariances apply: a small conversation whose label holds for every referent strategy. */
export function invariancesApply(example: CorpusExample): boolean {
  return !example.below && !example.beyondWindow && !example.hop && example.scene.candidates.sections.length <= 16
}

// ───────────────────────────── the decision model's answers, moved within their side ─────────────────────────────

/**
 * Every answer of a decision provider moved at random without crossing a
 * threshold: a yes stays above the highest of them, a no stays below the
 * ambiguity floor, an unsure answer stays between the floor and the
 * target-choice threshold. Thresholds turn confidences into selections
 * (Q74), so a routing may depend on which side of a threshold an answer is
 * on and on nothing else about it. An answer placed between two thresholds
 * on purpose (the oracle's "plausible") is left where it is.
 */
export function jitteredDecisions(provider: DecisionProvider, random: () => number, thresholds: Settings['thresholds'] = DEFAULT_SETTINGS.thresholds): DecisionProvider {
  const highest = Math.max(...Object.values(thresholds).filter((t) => t < JOIN_CHOICE_OFF))
  const within = (low: number, high: number): number => low + random() * (high - low)
  const moved = (p: number): number => {
    if (p >= 0.9) return within(highest + 0.04, 1)
    if (p <= 0.1) return within(0, AMBIGUITY_FLOOR - 0.04)
    if (p === 0.5) return within(AMBIGUITY_FLOOR + 0.04, Math.min(thresholds.targetChoice, thresholds.dependency) - 0.04)
    return p
  }
  return {
    async decide<Q extends DecisionQuestions>(request: DecisionRequest<Q>, signal: CancelSignal): Promise<DecisionResult<Q>> {
      const result = await provider.decide(request, signal)
      if (!result.ok) return result
      const answers: { [id: string]: unknown } = {}
      // In the order the questions were asked, so one seed moves the same answer the same way on every run.
      for (const id of Object.keys(request.questions)) {
        const a = (result.answers as { [k: string]: { type: string; probability?: number; choice?: string; confidence?: number; probabilities?: { [o: string]: number } } })[id]
        if (!a) continue
        if (a.type === 'noul' && typeof a.probability === 'number') answers[id] = { ...a, probability: moved(a.probability) }
        else if (a.type === 'choice' && typeof a.confidence === 'number' && a.choice !== undefined) {
          const confidence = moved(a.confidence)
          const others = Object.keys(a.probabilities ?? {}).filter((o) => o !== a.choice)
          answers[id] = { ...a, confidence, probabilities: Object.fromEntries([[a.choice, confidence], ...others.map((o) => [o, (1 - confidence) / Math.max(1, others.length)])]) }
        } else answers[id] = a
      }
      return { ...result, answers: answers as never }
    },
  }
}

// ───────────────────────────── directional transformations ─────────────────────────────

const unchanged = (handle: Handle): Handle => handle

function directional(name: string, example: CorpusExample, decisions: CorpusExample, random: () => number, settings: RoutingSettings = VARIANT_SETTINGS): Variant {
  return { name, kind: 'directional', example, decisions, settings, idSeed: seedFrom(random), jitterSeed: null, back: unchanged }
}

/**
 * "Reply to this" on the section a message was inferred to mean changes
 * nothing; on one of the sections Pluribus would have asked about, it is
 * the user's answer given in advance: that section is the target and the
 * work continues from it (T1). The decision model answers as before: an
 * explicit target is used as given, whatever it scored.
 *
 * Null where it does not apply: a message that already has an explicit
 * target, or whose routing is not one unit with one target.
 */
export function pinTarget(example: CorpusExample, random: () => number): Variant | null {
  if (example.replyTo) return null
  const e = example.expect
  if (e.outcome === 'target-ambiguity' && e.ambiguous && e.ambiguous.length >= 2) {
    const chosen = e.ambiguous[Math.floor(random() * e.ambiguous.length)] ?? ''
    const pinned: CorpusExample = { ...example, replyTo: [chosen], expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'addition', targets: [chosen], placement: { continue: chosen } }] } }
    return directional(`pin:${chosen}`, pinned, { ...pinned, expect: example.expect }, random)
  }
  const part = e.parts?.length === 1 ? e.parts[0] : undefined
  if ((e.outcome ?? 'plan') !== 'plan' || e.answers !== undefined || !part || part.targets?.length !== 1 || e.joinsLines) return null
  const pinned: CorpusExample = { ...example, replyTo: [...part.targets] }
  return directional(`pin:${part.targets[0] ?? ''}`, pinned, pinned, random)
}

/**
 * With the join threshold at 1 the question is not asked and Pluribus
 * always asks the user (T4): a message that joined lines instead of asking
 * is put to the user, with the sections it would have joined as the
 * candidates. The decision model answers as before.
 */
export function refuseJoin(example: CorpusExample, random: () => number): Variant | null {
  const part = example.expect.parts?.[0]
  if (!example.expect.joinsLines || !part?.targets) return null
  const asked: CorpusExample = { ...example, expect: { outcome: 'target-ambiguity', ambiguous: part.targets } }
  const settings = { ...VARIANT_SETTINGS, thresholds: { ...VARIANT_SETTINGS.thresholds, joinChoice: JOIN_CHOICE_OFF } }
  return directional('join-threshold-off', asked, example, random, settings)
}

/**
 * Everything in flight finishes before the message is sent: running work
 * is completed and its answer is there to read, and an open sibling group
 * closes and gets its join-back. A unit keeps what it refers to and where
 * it is placed, and waits for nothing in the conversation any more: "work
 * that is free to proceed is never shown as dependency-queued" (P6). A
 * part still waits for an earlier part of its own message. The decision
 * model answers as before, "needs a result that is not available yet"
 * included: with nothing in flight there is nothing for that to select.
 *
 * Null where it does not apply: nothing is in flight; a unit is placed by
 * its line of work and not by a target (the line's head moves when its work
 * finishes); or the message answers a clarification question (the work it
 * unblocks has not started).
 */
export function settle(example: CorpusExample, random: () => number): Variant | null {
  const c = example.scene.candidates
  const flying = new Set(c.work.filter((w) => IN_FLIGHT_STATES.includes(w.state)).map((w) => w.directiveId))
  const e = example.expect
  if (flying.size === 0 || (e.outcome ?? 'plan') !== 'plan' || e.answers !== undefined || c.sections.some((s) => s.asksElicitationId !== null)) return null
  if ((e.parts ?? []).some((p) => p.kind === 'unit' && p.chain !== undefined)) return null
  const handles = new Map(example.scene.handles)
  const groups = c.groups.map((g) => {
    if (!g.open) return g
    const joinBack = ids.node(`jb_${(handles.get(g.groupId) ?? '').slice(6)}`)
    handles.set(joinBack, handles.get(g.groupId) ?? '')
    return { ...g, open: false, joinBackNodeId: joinBack }
  })
  const scene: Scene = {
    ...example.scene,
    handles,
    candidates: {
      sections: c.sections.map((s) => (flying.has(s.directiveId) ? { ...s, state: 'completed' as const, excerpt: s.excerpt === '' ? 'Here it is.' : s.excerpt, answerLength: Math.max(ANSWER_LENGTH, s.answerLength) } : s)),
      work: c.work.map((w) => (flying.has(w.directiveId) ? { ...w, state: 'completed' as const } : w)),
      // A chain whose group closed ends at the join-back, where work on it continues (C19).
      chains: c.chains.map((chain) => {
        const closed = groups.find((g) => g.baseChainId === chain.chainId && g.joinBackNodeId !== null && c.groups.some((was) => was.groupId === g.groupId && was.open))
        const tip = closed?.joinBackNodeId ?? chain.tipNodeId
        return { ...chain, busy: false, tipNodeId: tip, headNodeId: tip }
      }),
      groups,
    },
  }
  const parts = (e.parts ?? []).map((p): PartExpectation => {
    if (p.kind !== 'unit') return p
    const waits = (p.prerequisites ?? []).filter((h) => h.startsWith('part:'))
    return { ...p, ...(p.prerequisites ? { prerequisites: waits } : {}), ...(p.relation === 'result-dependent' && waits.length === 0 ? { relation: 'addition' as const } : {}) }
  })
  const settled: CorpusExample = { ...example, scene, expect: { ...e, parts } }
  return directional('settle', settled, { ...settled, expect: e }, random)
}

export const DIRECTIONS = { pin: pinTarget, 'join-off': refuseJoin, settle } as const

// ───────────────────────────── routing a variant, and reading two routings side by side ─────────────────────────────

/** Routes a variant with decisions as its `decisions` label says. */
export async function routeVariant(variant: Variant): Promise<RoutingOutcome> {
  const input = corpusInput(variant.example, variant.settings, createIdFactory(createUlidFactory(() => 0, createSeededRandom(variant.idSeed))))
  const oracle = oracleDecisionProvider(variant.decisions, input)
  const decisionProvider = variant.jitterSeed === null ? oracle : jitteredDecisions(oracle, createSeededRandom(variant.jitterSeed), variant.settings.thresholds)
  return createRouter({ decisionProvider, decomposer: referenceDecomposer(variant.example) }).route(input, NEVER_CANCELLED)
}

/** The example as it is routed with nothing transformed: the routing a variant is read against. */
export function baseVariant(example: CorpusExample, settings: RoutingSettings = VARIANT_SETTINGS): Variant {
  return { name: 'base', kind: 'invariant', example, decisions: example, settings, idSeed: 11, jitterSeed: null, back: unchanged }
}

/**
 * Everything a routing concluded, with every candidate named by handle and
 * every ID the plan minted for itself left out: what two routings of the
 * same message must agree on. `back` reads a variant's handles as the base
 * example names them. Fuller than a label, which states only what its case
 * is about: an invariance has to preserve all of it.
 */
export function fingerprint(example: CorpusExample, outcome: RoutingOutcome, back: (handle: Handle) => Handle = unchanged): unknown {
  const named = (id: string): string => back(example.scene.handles.get(id) ?? id)
  const sorted = (list: readonly string[]): string[] => [...list].sort()
  if (outcome.kind === 'target-ambiguity') return { kind: outcome.kind, candidates: sorted(outcome.candidates.map((c) => named(c.sectionId))) }
  if (outcome.kind !== 'plan') return { kind: outcome.kind }
  const plan = outcome.plan
  const text = example.text
  const own = new Map(plan.units.map((u, i) => [u.directiveId as string, `unit:${i}`]))
  const ref = (id: string): string => own.get(id) ?? named(id)
  const point = (p: { kind: string; nodeId?: string; groupId?: string; directiveId?: string }): string => (p.kind === 'node' ? named(p.nodeId ?? '') : p.kind === 'sibling-group' ? named(p.groupId ?? '') : ref(p.directiveId ?? ''))
  const quoted = (spans: readonly { start: number; end: number }[] | undefined): string[] => (spans ?? []).map((s) => text.slice(s.start, s.end))
  return {
    kind: 'plan',
    composition: plan.composition,
    answers: plan.answersElicitationId ? named(plan.answersElicitationId) : null,
    barrier: plan.barrier !== null,
    decomposed: plan.decompositionModel !== null,
    sessionRequirements: plan.sessionRequirements.map((r) => ({ text: r.requirement.text, replaces: r.replacesRequirementId ? named(r.replacesRequirementId) : null })),
    units: plan.units.map((u) => ({
      relation: u.relation,
      targets: sorted(u.targets.map(named)),
      placement: u.placement.kind === 'new-chain' ? 'new-chain' : u.placement.kind === 'continue' ? `continue ${point(u.placement.buildsOn)}` : `join ${sorted(u.placement.parents.map(point)).join('+')}`,
      prerequisites: sorted(u.prerequisites.map((p) => (p.kind === 'directive' ? ref(p.directiveId) : named(p.groupId)))),
      quotes: quoted(u.fragment?.sourceSpans),
    })),
    revisions: plan.revisions.map((r) => ({
      scope: r.scope,
      targets: sorted(r.targetDirectiveIds.map(named)),
      requirements: sorted(r.targetRequirementIds.map(named)),
      preselected: sorted(r.affected.filter((a) => a.preselected).map((a) => named(a.directiveId))),
      quotes: quoted(r.fragment?.sourceSpans),
    })),
    clarifications: plan.clarifications.map((c) => ({ reason: c.reason, blocks: sorted(c.blockedDirectiveIds.map(ref)) })),
  }
}

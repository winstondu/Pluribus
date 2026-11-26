import { DEFAULT_SETTINGS, IN_FLIGHT_STATES, JOIN_CHOICE_OFF, createIdFactory, createSeededRandom, createUlidFactory, provisionalLabel, type Settings, type TextSpan } from '@pluribus/protocol'
import type { CancelSignal, CandidateChain, CandidateSection, CandidateWork, DecisionProvider, DecisionQuestions, DecisionRequest, DecisionResult, RoutingOutcome } from '../../../src/ports'
import { NEVER_CANCELLED } from '../../../src/ports'
import { AMBIGUITY_FLOOR } from '../../../src/routing/derive'
import { createRouter } from '../../../src/routing/pipeline'
import { corpusInput, oracleDecisionProvider, referenceDecomposer } from '../corpus/evaluate'
import { ANSWER_LENGTH, ids, type Scene } from '../corpus/scene'
import type { CorpusExample, CorpusExpectation, Handle, PartExpectation, ReferenceDecomposition } from '../corpus/types'
import type { Reference } from './types'

/**
 * Metamorphic transformations of a labelled example: a change to the
 * conversation, the message or the decision model's answers whose effect on
 * the routing is known without labelling anything again.
 *
 * Two kinds. An invariance leaves the routing as it was: the same plan,
 * handle for handle. A directional one changes it in a way the spec
 * states: the transformation rewrites the label as well as the input.
 *
 * The reading transformations (`READINGS`) change the text the decision
 * model reads: the conversation, the message, the titles, the answers.
 * With decisions as labelled they test the pipeline like the others; their
 * purpose is the live decision model
 * (`packages/providers/test/smoke/conversation-metamorphic.smoke.test.ts`).
 * For some ways of referring the spec expects such a change to move the
 * routing, or allows it, and gives no single label: those variants are
 * `unlabelled`, read for how the routing moved (`readingRelation`).
 *
 * Which transformations a variant gets, and their parameters, are drawn
 * from a seeded generator (`createSeededRandom`), so a run is random over
 * the corpus and exactly repeatable from its seed.
 */

type RoutingSettings = Pick<Settings, 'models' | 'thresholds' | 'routing'>

export interface Variant {
  /** The transformations applied, in order. */
  readonly name: string
  /**
   * `unlabelled`: the spec expects the routing to change, or allows it to,
   * and gives no single label for the result (`readingRelation`). Such a
   * variant is read for how it changed, never scored as a failure.
   */
  readonly kind: 'invariant' | 'directional' | 'unlabelled'
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
  /** The words of the base message a span of the variant's message quotes, where the transformation moved them; default: the variant's own text. */
  readonly quote?: (span: TextSpan) => string
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

/** An example transformed, with how to read the routing of the result back as the example's. */
export interface Transformed {
  readonly example: CorpusExample
  readonly back: (handle: Handle) => Handle
  /** As `Variant.quote`. */
  readonly quote?: (span: TextSpan) => string
}
type Step = Transformed

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

/**
 * A variant with every ID of its conversation spelt anew, read back as
 * before: `renameHandles` over both labels, with one seed so they agree.
 * Live suites route every variant this way, so that no two routings of a
 * process share an ID they do not share in the app, where IDs are minted
 * once (and a cache keyed by section ID cannot carry an answer across).
 */
export function withFreshIds(variant: Variant, seed: number): Variant {
  const renamed = renameHandles(variant.example, createSeededRandom(seed))
  const decisions = variant.decisions === variant.example ? renamed.example : renameHandles(variant.decisions, createSeededRandom(seed)).example
  const earlier = variant.back
  return { ...variant, example: renamed.example, decisions, back: (handle) => earlier(renamed.back(handle)) }
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
/** A finished answer on a line of its own, for a distractor: its section, its work and its chain. */
function distractorLine(handle: string, request: string, answer: string, handles: Map<string, string>): { section: CandidateSection; work: CandidateWork; chain: CandidateChain } {
  for (const make of [ids.section, ids.directive, ids.node, ids.chain]) handles.set(make(handle), handle)
  return {
    section: {
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
    },
    work: {
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
    },
    chain: { chainId: ids.chain(handle), kind: 'root', label: provisionalLabel(request), headNodeId: ids.node(handle), tipNodeId: ids.node(handle), busy: false },
  }
}

export function olderDistractors(example: CorpusExample, random: () => number): Step {
  const count = 1 + Math.floor(random() * 3)
  const first = Math.floor(random() * DISTRACTORS.length)
  const handles = new Map(example.scene.handles)
  const lines = Array.from({ length: count }, (_, i) => {
    const [request, answer] = DISTRACTORS[(first + i) % DISTRACTORS.length] ?? ['', '']
    return distractorLine(`zz_d${i}`, request, answer, handles)
  })
  const c = example.scene.candidates
  const scene: Scene = {
    ...example.scene,
    handles,
    candidates: { ...c, sections: [...lines.map((l) => l.section), ...c.sections], work: [...lines.map((l) => l.work), ...c.work], chains: [...lines.map((l) => l.chain), ...c.chains] },
  }
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

// ───────────────────────────── what the decision model reads, changed ─────────────────────────────

/**
 * Handles a label depends on: every section, piece of work, chain and
 * group it names, and the reply targets.
 */
function namedHandles(example: CorpusExample): Set<string> {
  const e = example.expect
  const out = new Set<string>([...(example.replyTo ?? []), ...(e.ambiguous ?? []), ...(e.context ?? []), ...(e.answers !== undefined ? [e.answers] : [])])
  const add = (h: string): void => {
    if (h.startsWith('part:')) return
    out.add(h.startsWith('group:') ? h.slice(6) : h)
  }
  for (const p of [...(e.parts ?? []), ...(example.hop?.parts ?? [])]) {
    if (p.kind === 'revision') [...p.targets, ...(p.requirements ?? []), ...(p.affected ?? [])].forEach(add)
    else {
      ;[...(p.targets ?? []), ...(p.prerequisites ?? []), ...(p.chain !== undefined ? [p.chain] : [])].forEach(add)
      if (p.placement !== undefined && p.placement !== 'new-chain') ('continue' in p.placement ? [p.placement.continue] : p.placement.join).forEach(add)
    }
  }
  return out
}

/**
 * One finished, unrelated answer on a line of its own is put after
 * everything else: it is the newest answer in the conversation, and the
 * message is about none of it.
 *
 * A prompt that names its subject, refers to an answer by a detail of its
 * text, refers to nothing or was sent with "Reply to this" refers to the
 * same work as before: the routing is unchanged. A prompt that refers by
 * "that" or "your last answer" is another matter, and the change is what
 * is measured: "Make that shorter with several recent answers: target
 * inferred if clear; otherwise the user picks among the candidate
 * sections" (05 · Edge cases). The newest answer may now be the clear
 * target, or one of the candidates the user is asked to choose among; the
 * spec gives no single label (`readingRelation`).
 */
export function newerDistractor(example: CorpusExample, random: () => number): Step {
  const [request, answer] = DISTRACTORS[Math.floor(random() * DISTRACTORS.length)] ?? ['', '']
  const handles = new Map(example.scene.handles)
  const line = distractorLine('zz_n0', request, answer, handles)
  const c = example.scene.candidates
  const scene: Scene = { ...example.scene, handles, candidates: { ...c, sections: [...c.sections, line.section], work: [...c.work, line.work], chains: [...c.chains, line.chain] } }
  return { example: { ...example, scene }, back: (handle) => handle }
}

/** A text with characters changed, and where each position went. */
interface Edited {
  readonly text: string
  /** The new position of every old one, the end included. */
  readonly forward: readonly number[]
  /** The old position of every new one, the end included. */
  readonly backward: readonly number[]
}

/** `pieces[i]` replaces the old character `i`. */
function edited(old: string, pieces: readonly string[]): Edited {
  const forward: number[] = []
  const backward: number[] = []
  let text = ''
  pieces.forEach((piece, i) => {
    forward.push(text.length)
    for (let k = 0; k < piece.length; k++) backward.push(i)
    text += piece
  })
  forward.push(text.length)
  backward.push(old.length)
  return { text, forward, backward }
}

/** A part of the old text, as the same words read in the new one. */
function movedPart(old: string, e: Edited, part: string): string {
  const start = old.indexOf(part)
  if (start < 0) return part
  return e.text.slice(e.forward[start] ?? 0, e.forward[start + part.length] ?? e.text.length)
}

function movedDecomposition(old: string, e: Edited, d: ReferenceDecomposition): ReferenceDecomposition {
  const part = (p: string): string => movedPart(old, e, p)
  return {
    ...d,
    fragments: d.fragments.map((f) => ({
      ...f,
      part: typeof f.part === 'string' ? part(f.part) : f.part.map(part),
      ...(f.requirements ? { requirements: f.requirements.map((r) => (r.part !== undefined ? { ...r, part: part(r.part) } : r)) } : {}),
    })),
    ...(d.combinedLimit !== undefined ? { combinedLimit: part(d.combinedLimit) } : {}),
  }
}

/** The fewest words a message must have for typing noise to apply. */
export const MIN_NOISY_WORDS = 3

/** Words that may be misspelt: four letters or more, not an identifier written in mixed case ("KeyError"), no digits around them. */
const NOISY_WORD = /(?<![\p{L}\p{N}_$`])\p{Ll}?\p{L}\p{Ll}{2,}(?![\p{L}\p{N}_`])/gu

/**
 * Typing noise in the message: one or two words misspelt (two letters
 * swapped, one dropped or one doubled, never the first or the last of a
 * word), and, one time in two, the whole message in lower case. Digits,
 * punctuation, identifiers in mixed case and short words are left alone,
 * and so is a message of fewer than `MIN_NOISY_WORDS` words.
 *
 * Routing reads what a message refers to and what kind of work it is
 * (05), not how it is spelt: the corpus files typos and texting shorthand
 * as a register (`noisy`) and labels those prompts as it labels the plain
 * ones. The routing is unchanged, and each fragment quotes the same words,
 * misspelt as they were typed (Q3).
 */
export function typingNoise(example: CorpusExample, random: () => number): Step | null {
  const old = example.text
  // A message of one or two words is mostly the words a typo would change ("acme"): not applied.
  if (old.trim().split(/\s+/).length < MIN_NOISY_WORDS) return null
  const words = [...old.matchAll(NOISY_WORD)].map((m) => ({ start: m.index, word: m[0] }))
  if (words.length === 0) return null
  const pieces = [...old].length === old.length ? old.split('') : null
  // A message with characters outside the basic plane is left alone: positions are counted in UTF-16 units.
  if (!pieces) return null
  const count = Math.min(words.length, 1 + Math.floor(random() * 2))
  const chosen = new Set<number>()
  while (chosen.size < count) chosen.add(Math.floor(random() * words.length))
  for (const index of chosen) {
    const w = words[index]
    if (!w) continue
    // An inner position: never the first or last letter.
    const at = w.start + 1 + Math.floor(random() * (w.word.length - 2))
    const op = Math.floor(random() * 3)
    if (op === 0 && at + 1 < w.start + w.word.length - 1) {
      const a = pieces[at] ?? ''
      pieces[at] = pieces[at + 1] ?? ''
      pieces[at + 1] = a
    } else if (op === 1) pieces[at] = ''
    else pieces[at] = `${pieces[at] ?? ''}${pieces[at] ?? ''}`
  }
  if (random() < 0.5) for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i] ?? ''
    const lower = piece.toLowerCase()
    if (lower.length === piece.length) pieces[i] = lower
  }
  const e = edited(old, pieces)
  if (e.text === old) return null
  return {
    example: { ...example, text: e.text, ...(example.decomposition ? { decomposition: movedDecomposition(old, e, example.decomposition) } : {}) },
    back: (handle) => handle,
    quote: (span) => old.slice(e.backward[span.start] ?? 0, e.backward[span.end] ?? old.length),
  }
}

/**
 * The same request in other words, written by hand for each case: the
 * same subject, named by the same name or pointed at in the same way, the
 * same corrective or additive wording, the same register as near as it
 * goes. Generated paraphrases are not used: whether one preserves the
 * meaning is the question being asked.
 *
 * Only cases whose message is one fragment (no reference decomposition)
 * have one, so no quoted part has to be found in the new words. Cases of
 * the held-out partition have none: writing them would mean reading them.
 */
export const PARAPHRASES: { readonly [caseId: string]: string } = {
  'new-first-message-terse': 'regular expression to match uk postcodes',
  'new-same-domain': 'What’s the flexbox way to center a div?',
  'new-while-running': 'What is 350°F in Celsius?',
  'new-non-english': '¿Cómo funciona la regla del fuera de juego en el fútbol?',
  'new-wordy-change-of-subject': 'Totally unrelated, sorry: I have to give a toast at my sister’s wedding in June. Could you write a two-minute one? She’s a nurse and she loves hiking.',
  'continue-named': 'Make the pytest test also cover the case where the password is missing',
  'continue-deictic-terse': 'ok what if rent rises by 200',
  'continue-positional': 'What does the caret at the beginning do, in the answer you just gave?',
  'continue-positional-first-section': 'Now rewrite the first one for ten-year-olds',
  'continue-explicit': 'Which one of these gives the most for the money?',
  'continue-hedged': 'This might be overkill, but could you perhaps show the same budget in percentages?',
  'continue-additive-not-revision': 'How would the test look written with unittest?',
  'continue-beside-open-question': 'Put an emoji in the second subject line',
  'branch-content-mid-line': 'Why does that give a KeyError instead of simply returning None?',
  'branch-explicit-sibling': 'Split these up by region',
  'branch-actually-is-praise': 'This is actually really good. What side would go with it?',
  'branch-doubt-is-not-correction': 'Hmm, maybe the starter would be nicer warm? Could you perhaps suggest a warm one as well?',
  'fork-mentions-running-work': 'While those are running, also look for duplicate order IDs in the file',
  'fork-shares-subject-with-running': 'What is AWS short for?',
  'fork-wordy': 'Also, sorry, I know I keep adding things: my manager said the company will pay for one paid course, so which one would you say is most worth it for this exam?',
  'wait-deictic-terse': 'when its finished cut that down to one page',
  'wait-hedged': 'No hurry, but once the top-five list is done, could you maybe add each product’s share of total units?',
  'wait-group-subset': 'Make sure no ingredient appears in both the starter and the dessert',
  'wait-group-all-deictic': 'Make a shopping list out of all three',
  'join-back-all': 'Put together a shopping list covering all three courses',
  'join-back-subset': 'Are there ingredients the starter and the main have in common that I could buy in bulk?',
  'join-back-both-analyses': 'Based on both analyses, in which region should we promote the trail mug?',
  'join-chain-separate-trees': 'Validate a created_at field in the Flask handler with the date regex',
  'join-chain-cousins': 'Put the return-rate finding into the sales memo',
  'join-chain-non-english': 'Prepárame un menú de cena con la paella y el vino que me recomendaste',
  'join-lines-non-english': 'Con todo esto, organízame la cena del sábado',
  'ask-table': 'Turn that into a comparison table',
  'ask-best-value': 'Which one of these gives the most for the money?',
  'ask-two-sections-of-one-reply': 'Now make a version for ten-year-olds',
  'ask-which-course': 'Suggest a different option for that one',
  'ask-noisy': 'wich one is teh cheapest',
  'revise-inferred': 'Actually, use unittest for the test instead of pytest',
  'revise-explicit': 'No, swap it for something with no nuts instead',
  'revise-running': 'Make that a six-week plan instead of four',
  'revise-positional': 'Replace the last course with something lighter instead',
  'revise-shared-brief': 'Actually, we’ll be eight people, not six',
  'revise-shared-salary': 'Actually, I take home $3,900, not $3,400',
  'answer-inferred': 'The March one, for Acme',
  'answer-first-reply-wordy': 'Sorry, I should have said! She’s turning seven, and probably about twelve kids from her class, plus maybe a couple of cousins. If the weather holds we have the garden.',
  'clarify-incompatible': 'Plan a three-course dinner that is strictly vegan, with beef as the main course',
  'clarify-not-needed': 'What should I name my new puppy?',
  'clarify-missing-non-english': 'Resérvame mesa para el sábado',
  'clarify-incompatible-follow-up': 'Rework the budget so I save $2,000 a month while still spending $1,700 on needs and $1,020 on wants',
  'atomic-contrast': 'What’s the difference between baking soda and baking powder, and when should I use each one?',
  'atomic-combined-limit': 'Define entropy and enthalpy in under 60 words in total',
  'atomic-steps-of-one-task': 'Rewrite the test so that it first posts an empty body and then checks for a 400',
}

/** The case's paraphrase from `PARAPHRASES`; null for a case without one, or whose message is decomposed. */
export function paraphrase(example: CorpusExample): Step | null {
  const text = PARAPHRASES[example.id]
  if (text === undefined || example.decomposition !== undefined || text === example.text) return null
  return { example: { ...example, text }, back: (handle) => handle }
}

/**
 * A finished line of work the label does not name is moved to the start
 * of the conversation, older than every other line: its sections, its
 * work and its chain, in their own order. It must be a root whose work has
 * all finished, that nothing else was built on, and that is not the
 * oldest line already.
 *
 * The line each section is on, what was built on what and everything in
 * flight are as they were, and the message names nothing on the moved
 * line: a prompt that names its subject, refers by a detail of an answer,
 * refers to nothing or was sent with "Reply to this" is routed as before.
 * A prompt that refers by "that" or by position ("your last answer", "the
 * first one") reads the order of the conversation, which has changed (the
 * moved line may have held the newest answer): it is not applied there.
 */
export function reorderLines(example: CorpusExample, random: () => number): Step | null {
  const c = example.scene.candidates
  const named = namedHandles(example)
  const movable = c.chains.filter((chain, i) => {
    if (i === 0 || chain.kind !== 'root') return false
    const work = c.work.filter((w) => w.chainId === chain.chainId)
    const nodes = new Set(work.map((w) => w.nodeId))
    const handlesOf = [chain.chainId, ...work.flatMap((w) => [w.directiveId, w.nodeId, w.sectionId ?? ''])].map((id) => example.scene.handles.get(id) ?? '')
    return (
      work.length > 0 &&
      work.every((w) => w.state === 'completed' && w.groupId === null) &&
      !c.work.some((w) => w.chainId !== chain.chainId && w.startNodeId !== null && nodes.has(w.startNodeId)) &&
      !c.groups.some((g) => g.baseChainId === chain.chainId) &&
      !c.sections.some((s) => s.chainId === chain.chainId && s.asksElicitationId !== null) &&
      !handlesOf.some((h) => named.has(h))
    )
  })
  const chain = movable[Math.floor(random() * movable.length)]
  if (!chain) return null
  const on = <T extends { readonly chainId: string | null }>(xs: readonly T[]): T[] => [...xs.filter((x) => x.chainId === chain.chainId), ...xs.filter((x) => x.chainId !== chain.chainId)]
  const scene: Scene = { ...example.scene, candidates: { ...c, sections: on(c.sections), work: on(c.work), chains: on(c.chains) } }
  return { example: { ...example, scene }, back: (handle) => handle }
}

/**
 * Every section's title, every piece of work's label and every line's
 * label made shorter (the request's first two words) or longer (the whole
 * request). A title is a provisional label of the request, its first
 * words (scenes.ts; `provisionalLabel`), and the request is listed beside
 * it: a title carries nothing the decision model is not shown anyway. The
 * routing is unchanged, however the prompt refers.
 */
export function retitle(example: CorpusExample, length: 'short' | 'long'): Step {
  const c = example.scene.candidates
  const label = (request: string): string => (length === 'short' ? provisionalLabel(request, 2) : request.replace(/\s+/g, ' ').trim())
  const requestOf = new Map(c.work.map((w) => [w.directiveId, w.instruction]))
  const firstOn = new Map<string, string>()
  for (const w of c.work) if (!firstOn.has(w.chainId)) firstOn.set(w.chainId, w.instruction)
  const scene: Scene = {
    ...example.scene,
    candidates: {
      ...c,
      sections: c.sections.map((s) => (s.asksElicitationId !== null ? s : { ...s, title: label(requestOf.get(s.directiveId) ?? s.request) })),
      work: c.work.map((w) => ({ ...w, label: label(w.instruction) })),
      chains: c.chains.map((chain) => {
        const first = firstOn.get(chain.chainId)
        return first === undefined ? chain : { ...chain, label: label(first) }
      }),
    },
  }
  return { example: { ...example, scene }, back: (handle) => handle }
}

/** An answer cut to its first sentence, and to at most this many characters at a word boundary. */
export const TRUNCATED_ANSWER = 90

function truncated(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const sentence = /^.*?[.!?:](?=\s|$)/u.exec(flat)?.[0] ?? flat
  if (sentence.length <= TRUNCATED_ANSWER) return sentence
  const cut = sentence.slice(0, TRUNCATED_ANSWER)
  const space = cut.lastIndexOf(' ')
  return space > 0 ? cut.slice(0, space) : cut
}

/**
 * Every answer the decision model is shown cut to its first sentence, at
 * most `TRUNCATED_ANSWER` characters: the opening and any whole answer
 * written out. The length of the answer is as it was; a question
 * Pluribus asked the user is left whole.
 *
 * A prompt that names its subject, points at it by "that" or by position,
 * refers to nothing, or was sent with "Reply to this" does not depend on
 * the answer's text past its opening: the routing is unchanged. A prompt
 * that refers by a detail of the answer's text (`content`) may lose the
 * detail it refers by: it is not applied there.
 */
export function truncateAnswers(example: CorpusExample): Step {
  const c = example.scene.candidates
  const scene: Scene = {
    ...example.scene,
    answers: new Map([...example.scene.answers].map(([id, text]) => [id, truncated(text)])),
    candidates: { ...c, sections: c.sections.map((s) => (s.asksElicitationId !== null || s.excerpt === '' ? s : { ...s, excerpt: truncated(s.excerpt) })) },
  }
  return { example: { ...example, scene }, back: (handle) => handle }
}

/**
 * The transformations that change what the decision model reads: the text
 * of its requests. Renaming handles and minting other IDs do not (the
 * model is shown sections, lines and work by number), and jittering its
 * answers is a statement about the thresholds: those are for the oracle
 * only.
 */
export const READINGS = {
  distract: { apply: olderDistractors },
  reframe: { apply: reframeMessage },
  newer: { apply: newerDistractor },
  noise: { apply: typingNoise },
  paraphrase: { apply: (e: CorpusExample) => paraphrase(e) },
  reorder: { apply: reorderLines },
  'titles-short': { apply: (e: CorpusExample) => retitle(e, 'short') },
  'titles-long': { apply: (e: CorpusExample) => retitle(e, 'long') },
  truncate: { apply: (e: CorpusExample) => truncateAnswers(e) },
} as const satisfies { readonly [name: string]: { readonly apply: (example: CorpusExample, random: () => number) => Step | null } }
export type ReadingName = keyof typeof READINGS
export const READING_NAMES = Object.keys(READINGS) as ReadingName[]

/**
 * What a reading transformation is expected to do to the routing of a
 * prompt that refers the way `reference` says, from the spec: leave it as
 * it was (`invariant`), change it or allow it to change in a way the spec
 * does not label (`unlabelled`), or nothing to say (null: not applied).
 * Each transformation's comment gives the rule.
 */
export function readingRelation(name: ReadingName, reference: Reference): 'invariant' | 'unlabelled' | null {
  switch (name) {
    case 'newer':
      return reference === 'deictic' || reference === 'positional' ? 'unlabelled' : 'invariant'
    case 'distract':
      // "The very first draft" counts from the start of the conversation, where the distractors now are.
      return reference === 'positional' ? 'unlabelled' : 'invariant'
    case 'reorder':
      return reference === 'positional' || reference === 'deictic' ? null : 'invariant'
    case 'truncate':
      return reference === 'content' ? null : 'invariant'
    default:
      return 'invariant'
  }
}

/**
 * A conversation case with one reading transformation applied; null where
 * the transformation does not apply to it. An `unlabelled` variant keeps
 * the case's label as its `decisions`, so the oracle answers as before, and
 * is never scored against it.
 */
export function readingVariant(example: CorpusExample & { readonly reference: Reference }, name: ReadingName, random: () => number, settings: RoutingSettings = VARIANT_SETTINGS): Variant | null {
  const relation = readingRelation(name, example.reference)
  if (relation === null) return null
  const step = READINGS[name].apply(example, random)
  if (!step) return null
  return {
    name,
    kind: relation,
    example: step.example,
    decisions: step.example,
    settings,
    idSeed: seedFrom(random),
    jitterSeed: null,
    back: step.back,
    ...(step.quote ? { quote: step.quote } : {}),
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
 * Except which members of a sibling group a unit waiting for the group
 * refers to. While the group is open the unit waits for the full join-back
 * and reads every member, the ones it did not name included (C9, "no
 * subset bypass"); once the group has closed, work that needs some of its
 * members continues from the join-back and refers to the members it names
 * (C19; the corpus's `join-back-subset`). Which those are is in the
 * message, not in the label: the settled label leaves the targets of such
 * a unit unstated, and states its placement.
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
    const onGroup = (p.prerequisites ?? []).some((h) => h.startsWith('group:'))
    const { targets: _members, ...unstated } = p
    return { ...(onGroup ? unstated : p), ...(p.prerequisites ? { prerequisites: waits } : {}), ...(p.relation === 'result-dependent' && waits.length === 0 ? { relation: 'addition' as const } : {}) }
  })
  const settled: CorpusExample = { ...example, scene, expect: { ...e, parts } }
  return directional('settle', settled, { ...settled, expect: e }, random)
}

export const DIRECTIONS = { pin: pinTarget, 'join-off': refuseJoin, settle } as const

// ───────────────────────────── routing a variant, and reading two routings side by side ─────────────────────────────

/**
 * Routes a variant with decisions as its `decisions` label says, or, given
 * a decision provider, with that provider's answers as they come (a live
 * decision model: the jitter is then not applied).
 */
export async function routeVariant(variant: Variant, provider?: DecisionProvider): Promise<RoutingOutcome> {
  const input = corpusInput(variant.example, variant.settings, createIdFactory(createUlidFactory(() => 0, createSeededRandom(variant.idSeed))))
  const oracle = (): DecisionProvider => oracleDecisionProvider(variant.decisions, input)
  const decisionProvider = provider ?? (variant.jitterSeed === null ? oracle() : jitteredDecisions(oracle(), createSeededRandom(variant.jitterSeed), variant.settings.thresholds))
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
export function fingerprint(example: CorpusExample, outcome: RoutingOutcome, back: (handle: Handle) => Handle = unchanged, quote?: (span: TextSpan) => string): unknown {
  const named = (id: string): string => back(example.scene.handles.get(id) ?? id)
  const sorted = (list: readonly string[]): string[] => [...list].sort()
  if (outcome.kind === 'target-ambiguity') return { kind: outcome.kind, candidates: sorted(outcome.candidates.map((c) => named(c.sectionId))) }
  if (outcome.kind !== 'plan') return { kind: outcome.kind }
  const plan = outcome.plan
  const text = example.text
  const own = new Map(plan.units.map((u, i) => [u.directiveId as string, `unit:${i}`]))
  const ref = (id: string): string => own.get(id) ?? named(id)
  const point = (p: { kind: string; nodeId?: string; groupId?: string; directiveId?: string }): string => (p.kind === 'node' ? named(p.nodeId ?? '') : p.kind === 'sibling-group' ? named(p.groupId ?? '') : ref(p.directiveId ?? ''))
  const quoted = (spans: readonly TextSpan[] | undefined): string[] => (spans ?? []).map((s) => (quote ? quote(s) : text.slice(s.start, s.end)))
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

import { createSeededRandom } from '@pluribus/protocol'
import { describe, expect, test } from 'vitest'
import type { DecisionProvider } from '../../../src/ports'
import { CONVERSATION_CORPUS } from '../../../testing/routing/conversations/cases'
import {
  DIRECTIONS,
  INVARIANCE_NAMES,
  PARAPHRASES,
  READING_NAMES,
  REFERENT_CONFIGURATIONS,
  TRUNCATED_ANSWER,
  baseVariant,
  fingerprint,
  invariancesApply,
  invariantVariant,
  newerDistractor,
  olderDistractors,
  paraphrase,
  pinTarget,
  readingVariant,
  refuseJoin,
  renameHandles,
  reframeMessage,
  reorderLines,
  retitle,
  routeVariant,
  settle,
  truncateAnswers,
  typingNoise,
  withFreshIds,
  type ReadingName,
  type ReferentConfiguration,
  type Variant,
} from '../../../testing/routing/conversations/metamorphic'
import { partitionOf } from '../../../testing/routing/conversations/splits'
import type { ConversationCase } from '../../../testing/routing/conversations/types'
import { compare, corpusInput, oracleDecisionProvider } from '../../../testing/routing/corpus/evaluate'
import { ROUTING_CORPUS } from '../../../testing/routing/corpus/examples'
import type { CorpusExample } from '../../../testing/routing/corpus/types'

/**
 * Metamorphic tests of routing (`testing/routing/conversations/metamorphic.ts`).
 * A labelled example says what one message in one conversation should
 * come to. These say what must not change when the conversation, the
 * message or the decision model's answers are changed in a way that does
 * not matter, and what must change, and how, when they are changed in a
 * way the spec gives a rule for.
 *
 * The transformations are random and seeded. The seed is in every test
 * title; set `METAMORPHIC_SEED` to explore another draw, and to reproduce a
 * failure. Both corpora are transformed: the conversation corpus, and every
 * example of the routing corpus whose label holds for every strategy in a
 * small conversation.
 */

/** Core has no Node types (it does no I/O): the one variable is read off the global, where the test runner has it. */
const env = (globalThis as { process?: { env?: { [name: string]: string | undefined } } }).process?.env ?? {}
const SEED = Number(env['METAMORPHIC_SEED'] ?? 20261126)
/** Invariant variants drawn for each example. */
const VARIANTS = 3

/** A generator of its own for each example, so adding an example changes no other example's draw. */
function randomFor(id: string, purpose: string): () => number {
  let h = SEED >>> 0
  for (const ch of `${purpose}:${id}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0
  return createSeededRandom(h)
}

const EXAMPLES: readonly CorpusExample[] = [...CONVERSATION_CORPUS, ...ROUTING_CORPUS.filter(invariancesApply)]

const invariants: (readonly [string, string, CorpusExample, Variant])[] = EXAMPLES.filter(invariancesApply).flatMap((example) => {
  const random = randomFor(example.id, 'invariant')
  return Array.from({ length: VARIANTS }, () => invariantVariant(example, random)).map((variant) => [example.id, variant.name, example, variant] as const)
})

const directions = (Object.keys(DIRECTIONS) as (keyof typeof DIRECTIONS)[]).flatMap((name) =>
  EXAMPLES.flatMap((example) => {
    const variant = DIRECTIONS[name](example, randomFor(example.id, name))
    return variant ? [[example.id, variant.name, example, variant] as const] : []
  }),
)

describe(`metamorphic · invariances (seed ${SEED})`, () => {
  test('metamorphic · the draw covers every invariance and every way of finding referents, on both corpora', () => {
    const names = invariants.map(([, name]) => name)
    for (const invariance of INVARIANCE_NAMES) expect(names.filter((n) => n.split(' by ')[0]?.split('+').includes(invariance)).length, invariance).toBeGreaterThanOrEqual(40)
    for (const configuration of Object.keys(REFERENT_CONFIGURATIONS)) expect(names.filter((n) => n.endsWith(` by ${configuration}`)).length, configuration).toBeGreaterThanOrEqual(40)
    expect(new Set(invariants.map(([id]) => id)).size).toBe(EXAMPLES.length)
    expect(EXAMPLES.length - CONVERSATION_CORPUS.length).toBeGreaterThanOrEqual(40)
  })

  test.each(invariants)('metamorphic · %s, %s: routed as labelled, and to the same plan as the example untransformed', async (_id, _name, example, variant) => {
    const base = baseVariant(example, variant.settings)
    const routed = await routeVariant(variant)
    // As its (renamed) label says.
    expect(compare(variant.example, routed)).toEqual([])
    // And, beyond what the label states, the same in everything a routing concludes.
    expect(fingerprint(variant.example, routed, variant.back)).toEqual(fingerprint(example, await routeVariant(base)))
  })
})

describe(`metamorphic · directional transformations (seed ${SEED})`, () => {
  test('metamorphic · each transformation applies to enough examples to mean something', () => {
    const count = (prefix: string): number => directions.filter(([, name]) => name.startsWith(prefix)).length
    expect(count('pin:')).toBeGreaterThanOrEqual(30)
    expect(count('settle')).toBeGreaterThanOrEqual(12)
    expect(count('join-threshold-off')).toBeGreaterThanOrEqual(3)
  })

  test.each(directions)('metamorphic · %s, %s: routed as the transformed label says', async (_id, _name, _example, variant) => {
    expect(compare(variant.example, await routeVariant(variant))).toEqual([])
  })

  test.each(directions.filter(([, name]) => name === 'settle' || name === 'join-threshold-off'))('metamorphic · %s, %s: the transformation changed the routing', async (_id, name, example, variant) => {
    const before = fingerprint(example, await routeVariant(baseVariant(example)))
    const after = fingerprint(variant.example, await routeVariant(variant))
    // Finishing work changes a routing only where something waited for it; refusing a join always does.
    const waited = (example.expect.parts ?? []).some((p) => p.kind === 'unit' && (p.prerequisites ?? []).some((h) => !h.startsWith('part:')))
    if (name === 'join-threshold-off' || waited) expect(after).not.toEqual(before)
    else expect(after).toEqual(before)
  })
})

describe('metamorphic · the transformations themselves', () => {
  const example = CONVERSATION_CORPUS.find((c) => c.id === 'join-back-subset')
  const waiting = CONVERSATION_CORPUS.find((c) => c.id === 'wait-group-subset')
  const asking = CONVERSATION_CORPUS.find((c) => c.id === 'ask-table')
  const joining = CONVERSATION_CORPUS.find((c) => c.id === 'join-lines-deictic')
  if (!example || !waiting || !asking || !joining) throw new Error('missing case')

  test('metamorphic · rename: no ID of the conversation survives, the text does, and every handle reads back', () => {
    const { example: renamed, back } = renameHandles(example, createSeededRandom(1))
    const idsOf = (e: CorpusExample): string[] => [...e.scene.handles.keys()]
    expect(idsOf(renamed).filter((id) => idsOf(example).includes(id))).toEqual([])
    expect(idsOf(renamed)).toHaveLength(idsOf(example).length)
    expect(renamed.scene.candidates.sections.map((s) => [s.title, s.request, s.excerpt])).toEqual(example.scene.candidates.sections.map((s) => [s.title, s.request, s.excerpt]))
    expect([...renamed.scene.handles.values()].map(back).sort()).toEqual([...example.scene.handles.values()].sort())
    const part = renamed.expect.parts?.[0]
    expect(part?.kind === 'unit' ? [part.targets?.map(back), part.placement] : null).toEqual([['starter', 'main'], { continue: expect.stringMatching(/^group:h/) }])
  })

  test('metamorphic · distract: one to three finished answers on lines of their own, older than everything, and nothing else touched', () => {
    for (let seed = 0; seed < 12; seed++) {
      const { example: distracted } = olderDistractors(example, createSeededRandom(seed))
      const added = distracted.scene.candidates.sections.length - example.scene.candidates.sections.length
      expect(added).toBeGreaterThanOrEqual(1)
      expect(added).toBeLessThanOrEqual(3)
      expect(distracted.scene.candidates.sections.slice(added)).toEqual(example.scene.candidates.sections)
      expect(distracted.scene.candidates.chains.slice(added)).toEqual(example.scene.candidates.chains)
      expect(distracted.scene.candidates.sections.slice(0, added).every((s) => s.state === 'completed' && s.sectionId.startsWith('sec_zz_d'))).toBe(true)
      expect(distracted.expect).toBe(example.expect)
    }
  })

  test('metamorphic · reframe: the message as typed is inside the new one, whole', () => {
    for (let seed = 0; seed < 12; seed++) expect(reframeMessage(example, createSeededRandom(seed)).example.text).toContain(example.text)
  })

  test('metamorphic · settle: nothing is in flight afterwards, an open group has closed with its join-back on the chain it forked from, and the label waits for nothing', () => {
    const settled = settle(waiting, createSeededRandom(1))?.example
    if (!settled) throw new Error('settle does not apply')
    const c = settled.scene.candidates
    expect(c.work.map((w) => w.state)).toEqual(c.work.map(() => 'completed'))
    expect(c.sections.every((s) => s.state === 'completed' && s.excerpt !== '')).toBe(true)
    expect(c.groups.map((g) => [g.open, g.joinBackNodeId])).toEqual([[false, 'nod_jb_G']])
    expect(c.chains.find((chain) => chain.chainId === 'chn_dinner')).toMatchObject({ busy: false, tipNodeId: 'nod_jb_G', headNodeId: 'nod_jb_G' })
    // Which members it refers to, once the group has closed, is the message's to say (C19), not the open group's (C9).
    expect(settled.expect.parts).toEqual([{ kind: 'unit', relation: 'addition', placement: { continue: 'group:G' }, prerequisites: [] }])
    // Nothing in flight, nothing to settle.
    expect(settle(example, createSeededRandom(1))).toBeNull()
  })

  test('metamorphic · pin and join-off apply where they should and nowhere else', () => {
    expect(pinTarget(asking, createSeededRandom(1))?.example.replyTo).toHaveLength(1)
    // Two targets: there is no one section to press "Reply to this" on.
    expect(pinTarget(example, createSeededRandom(1))).toBeNull()
    expect(refuseJoin(joining, createSeededRandom(1))?.example.expect).toEqual({ outcome: 'target-ambiguity', ambiguous: ['laptop', 'phone'] })
    expect(refuseJoin(asking, createSeededRandom(1))).toBeNull()
  })

  test('metamorphic · the same seed draws the same variants', () => {
    const draw = (): string[] => {
      const random = createSeededRandom(7)
      return Array.from({ length: 5 }, () => invariantVariant(example, random)).map((v) => `${v.name} ${v.idSeed} ${String(v.jitterSeed)} ${v.example.text} ${[...v.example.scene.handles.keys()].join()}`)
    }
    expect(draw()).toEqual(draw())
  })
})

// ───────────────────────────── what the decision model reads ─────────────────────────────

const CONFIGURATION_NAMES = Object.keys(REFERENT_CONFIGURATIONS) as ReferentConfiguration[]

/** Every reading transformation of every conversation case it applies to, each routed in a configuration drawn like its parameters. */
const readings = READING_NAMES.flatMap((name) =>
  CONVERSATION_CORPUS.flatMap((c) => {
    const pick = randomFor(c.id, `reading-configuration:${name}`)
    const configuration = CONFIGURATION_NAMES[Math.floor(pick() * CONFIGURATION_NAMES.length)] ?? 'rules'
    const variant = readingVariant(c, name, randomFor(c.id, `reading:${name}`), REFERENT_CONFIGURATIONS[configuration])
    return variant ? [[c.id, `${name} by ${configuration}`, c, variant] as const] : []
  }),
)

/** Records the requests a routing sends, answering them as `answerer` does. */
function recording(answerer: DecisionProvider): DecisionProvider & { readonly sent: string[] } {
  const sent: string[] = []
  return {
    sent,
    async decide(request, signal) {
      sent.push(JSON.stringify({ state: request.state, questions: request.questions }))
      return answerer.decide(request, signal)
    },
  }
}

describe(`metamorphic · what the decision model reads (seed ${SEED})`, () => {
  test('metamorphic · every reading transformation applies to enough conversation cases to mean something', () => {
    const count = (name: ReadingName, kind?: Variant['kind']): number => readings.filter(([, n, , v]) => n.startsWith(`${name} by`) && (kind === undefined || v.kind === kind)).length
    const floors: { readonly [N in ReadingName]: number } = { distract: 60, reframe: 60, newer: 50, noise: 60, paraphrase: 40, reorder: 8, 'titles-short': 60, 'titles-long': 60, truncate: 50 }
    for (const name of READING_NAMES) expect(count(name, 'invariant'), name).toBeGreaterThanOrEqual(floors[name])
    // The newest answer is a different matter for "that" and "your last answer", and is read as such.
    expect(count('newer', 'unlabelled')).toBeGreaterThanOrEqual(10)
  })

  test.each(readings.filter(([, , , v]) => v.kind === 'invariant'))('metamorphic · %s, %s: routed as labelled, and to the same plan as the case untransformed', async (_id, _name, c, variant) => {
    const routed = await routeVariant(variant)
    expect(compare(variant.example, routed)).toEqual([])
    expect(fingerprint(variant.example, routed, variant.back, variant.quote)).toEqual(fingerprint(c, await routeVariant(baseVariant(c, variant.settings))))
  })

  test('metamorphic · rename: the decision model is shown exactly the same requests, so a live model has nothing new to read', async () => {
    // Two spellings of every ID, neither seen before in this process: the requests must not depend on which.
    for (const c of CONVERSATION_CORPUS) {
      const base = baseVariant(c, REFERENT_CONFIGURATIONS.rules)
      const sent = async (seed: number): Promise<string[]> => {
        const v = withFreshIds(base, seed)
        const provider = recording(oracleDecisionProvider(v.decisions, corpusInput(v.example, v.settings)))
        const routed = await routeVariant(v, provider)
        expect(fingerprint(v.example, routed, v.back), c.id).toEqual(fingerprint(c, await routeVariant(base)))
        return provider.sent
      }
      const random = randomFor(c.id, 'rename-requests')
      expect(await sent(Math.floor(random() * 2 ** 31)), c.id).toEqual(await sent(Math.floor(random() * 2 ** 31)))
    }
  })
})

describe('metamorphic · the reading transformations themselves', () => {
  const byId = (id: string): ConversationCase => {
    const found = CONVERSATION_CORPUS.find((c) => c.id === id)
    if (!found) throw new Error(`missing case ${id}`)
    return found
  }
  const named = byId('continue-named')
  const deictic = CONVERSATION_CORPUS.filter((c) => c.reference === 'deictic')
  const decomposed = CONVERSATION_CORPUS.filter((c) => c.decomposition !== undefined)
  const partsOf = (e: CorpusExample): string[] => (e.decomposition?.fragments ?? []).flatMap((f) => (typeof f.part === 'string' ? [f.part] : [...f.part]))

  test('metamorphic · newer: one finished answer on a line of its own, newer than everything, and nothing else touched; for "that" it is not an invariance', () => {
    for (let seed = 0; seed < 6; seed++) {
      const { example: newer } = newerDistractor(named, createSeededRandom(seed))
      const now = newer.scene.candidates
      const was = named.scene.candidates
      expect(now.sections.slice(0, -1)).toEqual(was.sections)
      expect(now.chains.slice(0, -1)).toEqual(was.chains)
      expect(now.work.slice(0, -1)).toEqual(was.work)
      expect(now.sections.at(-1)).toMatchObject({ sectionId: 'sec_zz_n0', state: 'completed', chainId: 'chn_zz_n0' })
      expect(now.chains.at(-1)).toMatchObject({ kind: 'root', busy: false })
      expect(newer.expect).toBe(named.expect)
      expect(newer.text).toBe(named.text)
    }
    expect(deictic.length).toBeGreaterThan(0)
    for (const c of deictic) expect(readingVariant(c, 'newer', createSeededRandom(1))?.kind, c.id).toBe('unlabelled')
    expect(readingVariant(named, 'newer', createSeededRandom(1))?.kind).toBe('invariant')
  })

  test('metamorphic · noise: a word or two misspelt, perhaps in lower case, digits and identifiers left alone, and every quoted part still found and read back', () => {
    const digits = (t: string): string => t.replace(/\D/g, '')
    let noised = 0
    for (const c of CONVERSATION_CORPUS) {
      for (let seed = 0; seed < 4; seed++) {
        const step = typingNoise(c, createSeededRandom(seed))
        if (!step) continue
        noised += 1
        const noisy = step.example
        expect(noisy.text, c.id).not.toBe(c.text)
        expect(Math.abs(noisy.text.length - c.text.length), c.id).toBeLessThanOrEqual(2)
        expect(digits(noisy.text), c.id).toBe(digits(c.text))
        for (const word of c.text.match(/\b\w*[a-z][A-Z]\w*\b/g) ?? []) expect(noisy.text.toLowerCase(), `${c.id}: ${word}`).toContain(word.toLowerCase())
        for (const part of partsOf(noisy)) {
          const start = noisy.text.indexOf(part)
          expect(start, `${c.id}: ${part}`).toBeGreaterThanOrEqual(0)
        }
        // The quotes read the words as the user typed them in the base message.
        expect(partsOf(noisy).map((p) => {
          const start = noisy.text.indexOf(p)
          return step.quote?.({ start, end: start + p.length })
        }), c.id).toEqual(partsOf(c))
        expect(noisy.expect).toBe(c.expect)
      }
    }
    expect(noised).toBeGreaterThanOrEqual(CONVERSATION_CORPUS.length * 3)
    expect(decomposed.filter((c) => typingNoise(c, createSeededRandom(2)) !== null).length).toBeGreaterThanOrEqual(5)
  })

  test('metamorphic · paraphrase: hand-written, different from the message, for tune cases whose message is one fragment, and for most of them', () => {
    const side = partitionOf(CONVERSATION_CORPUS)
    const covered = CONVERSATION_CORPUS.filter((c) => PARAPHRASES[c.id] !== undefined)
    expect(covered.length).toBeGreaterThanOrEqual(40)
    for (const c of covered) {
      expect(side.get(c.id), c.id).toBe('tune')
      expect(PARAPHRASES[c.id], c.id).not.toBe(c.text)
      expect(paraphrase(c)?.example.text ?? null, c.id).toBe(c.decomposition ? null : PARAPHRASES[c.id])
    }
    for (const c of decomposed) expect(paraphrase(c), c.id).toBeNull()
  })

  test('metamorphic · reorder: an unnamed finished line moves to the start, everything else keeps its order, and a prompt that reads the order is left alone', () => {
    const moved = CONVERSATION_CORPUS.flatMap((c) => {
      const step = reorderLines(c, createSeededRandom(1))
      return step ? [[c, step.example] as const] : []
    })
    expect(moved.length).toBeGreaterThanOrEqual(8)
    for (const [c, reordered] of moved) {
      const was = c.scene.candidates
      const now = reordered.scene.candidates
      const line = now.chains[0]?.chainId
      expect(line, c.id).not.toBe(was.chains[0]?.chainId)
      expect(was.chains.find((chain) => chain.chainId === line)?.kind, c.id).toBe('root')
      // The moved line first, in its own order; every other section, piece of work and line as it was.
      const on = was.sections.filter((s) => s.chainId === line)
      expect(now.sections, c.id).toEqual([...on, ...was.sections.filter((s) => s.chainId !== line)])
      expect(now.work, c.id).toEqual([...was.work.filter((w) => w.chainId === line), ...was.work.filter((w) => w.chainId !== line)])
      expect(on.every((s) => s.state === 'completed'), c.id).toBe(true)
      expect(reordered.expect, c.id).toBe(c.expect)
    }
    for (const c of CONVERSATION_CORPUS.filter((x) => x.reference === 'positional' || x.reference === 'deictic')) expect(readingVariant(c, 'reorder', createSeededRandom(1)), c.id).toBeNull()
  })

  test('metamorphic · titles: shortened to two words or lengthened to the request, every label with them, and the requests and answers untouched', () => {
    const c = byId('join-chain-cousins')
    const short = retitle(c, 'short').example.scene.candidates
    const long = retitle(c, 'long').example.scene.candidates
    for (const s of short.sections) expect(s.title.replace(/…$/, '').split(/\s+/).length).toBeLessThanOrEqual(2)
    for (const s of long.sections) expect(s.title).toBe(s.request.replace(/\s+/g, ' ').trim())
    for (const w of long.work) expect(w.label).toBe(w.instruction.replace(/\s+/g, ' ').trim())
    const text = (x: typeof short): string[] => x.sections.map((s) => `${s.request} ${s.excerpt}`)
    expect(text(short)).toEqual(text(c.scene.candidates))
    expect(text(long)).toEqual(text(c.scene.candidates))
  })

  test('metamorphic · truncate: every answer cut to its opening sentence, a question to the user left whole, and a prompt that refers by an answer’s detail left alone', () => {
    for (const c of CONVERSATION_CORPUS) {
      const cut = truncateAnswers(c).example.scene
      cut.candidates.sections.forEach((s, i) => {
        const was = c.scene.candidates.sections[i]
        if (!was) throw new Error('lost a section')
        if (was.asksElicitationId !== null) expect(s).toEqual(was)
        else {
          expect(s.excerpt.length, c.id).toBeLessThanOrEqual(TRUNCATED_ANSWER)
          expect(was.excerpt.replace(/\s+/g, ' ').startsWith(s.excerpt), c.id).toBe(true)
          expect(s.answerLength).toBe(was.answerLength)
        }
      })
      for (const text of cut.answers.values()) expect(text.length, c.id).toBeLessThanOrEqual(TRUNCATED_ANSWER)
      if (c.reference === 'content') expect(readingVariant(c, 'truncate', createSeededRandom(1)), c.id).toBeNull()
    }
  })
})

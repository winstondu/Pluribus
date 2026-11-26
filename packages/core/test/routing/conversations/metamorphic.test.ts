import { createSeededRandom } from '@pluribus/protocol'
import { describe, expect, test } from 'vitest'
import { CONVERSATION_CORPUS } from '../../../testing/routing/conversations/cases'
import {
  DIRECTIONS,
  INVARIANCE_NAMES,
  REFERENT_CONFIGURATIONS,
  baseVariant,
  fingerprint,
  invariancesApply,
  invariantVariant,
  olderDistractors,
  pinTarget,
  refuseJoin,
  renameHandles,
  reframeMessage,
  routeVariant,
  settle,
  type Variant,
} from '../../../testing/routing/conversations/metamorphic'
import { compare } from '../../../testing/routing/corpus/evaluate'
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
    expect(settled.expect.parts).toEqual([{ kind: 'unit', relation: 'addition', targets: ['starter', 'main', 'dessert'], placement: { continue: 'group:G' }, prerequisites: [] }])
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

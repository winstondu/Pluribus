import { DEFAULT_SETTINGS } from '@pluribus/protocol'
import { describe, expect, test } from 'vitest'
import { NEVER_CANCELLED } from '../../../src/ports'
import { createRouter } from '../../../src/routing/pipeline'
import { MAX_SECTIONS } from '../../../src/routing/supply'
import { CONVERSATION_CORPUS } from '../../../testing/routing/conversations/cases'
import { SCENES } from '../../../testing/routing/conversations/scenes'
import { SPLIT_AXES, behaviorProblems, countBy, formatSplitReport, partitionOf, scoreBySplit, scoreFamilies, shapeOf, splitsOf, type SplitAxis } from '../../../testing/routing/conversations/splits'
import { BEHAVIORS, REFERENCES, REGISTERS, ROLES, SHAPES } from '../../../testing/routing/conversations/types'
import { compare, corpusInput, evaluateCorpus, oracleDecisionProvider, referenceDecomposer } from '../../../testing/routing/corpus/evaluate'
import { ROUTING_CORPUS } from '../../../testing/routing/corpus/examples'

/**
 * The conversation corpus (`testing/routing/conversations/`): labelled
 * conversation prompts held apart from the routing corpus the thresholds
 * were tuned on, stratified so a result can be read by split.
 *
 * Three things are checked here, none of them with a model. That the corpus
 * is what it says it is: every case is filed under the behavior its label
 * shows, the splits are covered, and the tuning boundary divides no family.
 * That with decisions as labelled the pipeline routes every case as
 * labelled, however the referents are found. And that a result is read by
 * split as documented. The live decision model is scored on the same cases
 * in `packages/providers/test/smoke/conversation-corpus.smoke.test.ts`.
 */

const cases = CONVERSATION_CORPUS
const byId = (id: string) => {
  const found = cases.find((c) => c.id === id)
  if (!found) throw new Error(`no case ${id}`)
  return found
}

describe('conversation corpus · what it holds', () => {
  test('conversations · every case has a unique ID, a note that cites the spec, and a scene of the corpus', () => {
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length)
    const scenes = new Set<unknown>(Object.values(SCENES))
    for (const c of cases) {
      // A rule of 01 to 08 by chapter, an acceptance condition, or a recorded decision (Q…).
      expect(c.note, c.id).toMatch(/\b(0[1-8]|Q\d+|[CDEPRT]\d+)\b/)
      expect(scenes.has(c.scene), c.id).toBe(true)
      expect(c.text.trim().length, c.id).toBeGreaterThan(0)
      for (const h of c.replyTo ?? []) expect(c.scene.candidates.sections.some((s) => s.sectionId === `sec_${h}`), c.id).toBe(true)
    }
  })

  test('conversations · every handle a label names is in its scene', () => {
    for (const c of cases) {
      const known = new Set(c.scene.handles.values())
      const named = [
        ...(c.expect.ambiguous ?? []),
        ...(c.expect.context ?? []),
        ...(c.expect.answers !== undefined ? [c.expect.answers] : []),
        ...(c.expect.parts ?? []).flatMap((p) =>
          p.kind === 'revision'
            ? [...p.targets, ...(p.requirements ?? []), ...(p.affected ?? [])]
            : [
                ...(p.targets ?? []),
                ...(p.prerequisites ?? []),
                ...(p.chain !== undefined ? [p.chain] : []),
                ...(p.placement === undefined || p.placement === 'new-chain' ? [] : 'continue' in p.placement ? [p.placement.continue] : p.placement.join),
              ],
        ),
      ]
      for (const h of named) if (!h.startsWith('part:')) expect(known.has(h), `${c.id}: ${h}`).toBe(true)
    }
  })

  test('conversations · no case is in the routing corpus: nothing here was tuned on', () => {
    const tunedIds = new Set(ROUTING_CORPUS.map((e) => e.id))
    expect(cases.filter((c) => tunedIds.has(c.id)).map((c) => c.id)).toEqual([])
    const tuned = new Set(ROUTING_CORPUS.map((e) => e.text.toLowerCase()))
    expect(cases.filter((c) => tuned.has(c.text.toLowerCase())).map((c) => c.id)).toEqual([])
    const tunedScenes = new Set(ROUTING_CORPUS.map((e) => e.scene))
    // The empty conversation is the one scene the two could share, and each builds its own.
    expect(cases.filter((c) => tunedScenes.has(c.scene)).map((c) => c.id)).toEqual([])
  })

  test('conversations · every conversation fits the window the pipeline lists, so no label depends on how far back a strategy reaches', () => {
    for (const scene of Object.values(SCENES)) expect(scene.candidates.sections.length).toBeLessThanOrEqual(MAX_SECTIONS)
  })
})

describe('conversation corpus · splits', () => {
  test.each(cases.map((c) => [c.id, c] as const))('conversations · %s is filed under the behavior its label shows', (_id, c) => {
    expect(behaviorProblems(c)).toEqual([])
  })

  test('conversations · behavior: every behavior has at least two cases, in conversations of at least two shapes or domains', () => {
    const counts = countBy(cases, 'behavior')
    expect(Object.keys(counts)).toEqual([...BEHAVIORS])
    for (const behavior of BEHAVIORS) {
      expect(counts[behavior], behavior).toBeGreaterThanOrEqual(2)
      const of = cases.filter((c) => c.behavior === behavior)
      const settings = new Set(of.flatMap((c) => [`shape:${shapeOf(c.scene)}`, `domain:${c.domain}`]))
      // More than one shape, or more than one domain: the behavior is not one scene's.
      expect(settings.size, behavior).toBeGreaterThanOrEqual(3)
    }
  })

  test('conversations · reference, register, role, shape: every value has cases, and the plain default is not all there is', () => {
    const floors: { readonly [A in SplitAxis]?: number } = { reference: 4, register: 3, role: 8, shape: 3 }
    for (const [axis, values] of [['reference', REFERENCES], ['register', REGISTERS], ['role', ROLES], ['shape', SHAPES]] as const) {
      const counts = countBy(cases, axis)
      for (const value of values) expect(counts[value], `${axis} ${value}`).toBeGreaterThanOrEqual(floors[axis] ?? 1)
    }
    // At least a fifth of the prompts are not written in the plain register, and at least a quarter are not the canonical form of their behavior.
    expect(cases.filter((c) => c.register !== 'plain').length / cases.length).toBeGreaterThanOrEqual(1 / 5)
    expect(cases.filter((c) => c.role !== 'canonical').length / cases.length).toBeGreaterThanOrEqual(1 / 4)
  })

  test('conversations · reference: a prompt that refers to nothing never has a reply target, and an explicit one always has', () => {
    for (const c of cases) {
      if (c.reference === 'explicit') expect(c.replyTo?.length, c.id).toBe(1)
      else expect(c.replyTo, c.id).toBeUndefined()
      if (c.reference === 'none') expect((c.expect.parts ?? []).flatMap((p) => p.targets ?? []), c.id).toEqual([])
    }
  })

  test('conversations · role: a contrast family holds near-identical prompts in one conversation whose labels differ', () => {
    const families = new Map<string, typeof cases[number][]>()
    for (const c of cases) if (c.role === 'contrast') families.set(c.family, [...(families.get(c.family) ?? []), c])
    expect(families.size).toBeGreaterThanOrEqual(4)
    for (const [family, members] of families) {
      // A trap may sit in a contrast family; a family of one contrast case is not a contrast.
      const all = cases.filter((c) => c.family === family)
      expect(all.length, family).toBeGreaterThanOrEqual(2)
      expect(new Set(all.map((c) => c.domain)).size, family).toBe(1)
      expect(new Set(all.map((c) => JSON.stringify(c.expect))).size, family).toBe(all.length)
      expect(members.length, family).toBeGreaterThanOrEqual(1)
    }
    // The pair that differs in nothing but the reply target: the same words, routed two ways.
    expect(byId('ask-best-value').text).toBe(byId('continue-explicit').text)
    expect(byId('ask-best-value').scene).toBe(byId('continue-explicit').scene)
    // The pair that differs in nothing but whether the work it names has finished.
    expect(byId('wait-named').text).toBe(byId('continue-finished-not-waiting').text)
  })

  test('conversations · partition: no family is on both sides of the tuning boundary, and every behavior is held out somewhere', () => {
    const side = partitionOf(cases)
    const families = new Map<string, Set<string>>()
    for (const c of cases) families.set(c.family, (families.get(c.family) ?? new Set()).add(side.get(c.id) ?? ''))
    for (const [family, sides] of families) expect(sides.size, family).toBe(1)
    for (const partition of ['tune', 'held-out'] as const) {
      const behaviors = new Set(cases.filter((c) => side.get(c.id) === partition).map((c) => c.behavior))
      expect(BEHAVIORS.filter((b) => !behaviors.has(b)), partition).toEqual([])
    }
    const heldOut = cases.filter((c) => side.get(c.id) === 'held-out').length / cases.length
    expect(heldOut).toBeGreaterThanOrEqual(0.25)
    expect(heldOut).toBeLessThanOrEqual(0.45)
  })

  test('conversations · partition: the boundary depends on the families and their behaviors only, not on the order the cases are written in', () => {
    const side = Object.fromEntries(partitionOf(cases))
    expect(Object.fromEntries(partitionOf([...cases].reverse()))).toEqual(side)
    expect(Object.fromEntries(partitionOf([...cases].sort((a, b) => a.text.localeCompare(b.text))))).toEqual(side)
  })

  test('conversations · partition: a new case of one behavior moves no family of another across the boundary', () => {
    const side = partitionOf(cases)
    const added = { ...byId('new-while-running'), id: 'one-more', family: 'one-more' }
    const after = partitionOf([...cases, added])
    const counted = (family: string): string => cases.find((c) => c.family === family && c.behavior !== 'new-chain')?.behavior ?? 'new-chain'
    for (const c of cases) if (counted(c.family) !== 'new-chain') expect(after.get(c.id), c.id).toBe(side.get(c.id))
  })
})

// The referents found each way the settings allow, and by the defaults as they ship (the lexical candidate source on).
const CONFIGURATIONS = {
  'one pass': { strategySelection: 'off', referentStrategy: 'one-pass', candidateSource: 'none' },
  'tree walk': { strategySelection: 'off', referentStrategy: 'tree-walk', candidateSource: 'none' },
  'the strategy the rules select': { strategySelection: 'rules', referentStrategy: 'one-pass', candidateSource: 'none' },
  'the default settings': {},
} as const

describe.each(Object.entries(CONFIGURATIONS))('conversation corpus · referents by %s', (_name, routing) => {
  const settings = { ...DEFAULT_SETTINGS, routing: { ...DEFAULT_SETTINGS.routing, ...routing } }
  test.each(cases.map((c) => [c.id, c] as const))('conversations · with decisions as labelled, the pipeline routes %s as labelled', async (_id, c) => {
    const input = corpusInput(c, settings)
    const router = createRouter({ decisionProvider: oracleDecisionProvider(c, input), decomposer: referenceDecomposer(c) })
    expect(compare(c, await router.route(input, NEVER_CANCELLED))).toEqual([])
  })
})

describe('conversation corpus · reading a result by split', () => {
  /** Says no to everything, and takes the first option of every choice: the decision model that never recognises anything. */
  const no = {
    async decide(request: { questions: Record<string, { type: string; options?: Record<string, string> }> }) {
      const answers: Record<string, unknown> = {}
      for (const [id, q] of Object.entries(request.questions)) {
        answers[id] = q.type === 'choice' ? { type: 'choice', choice: Object.keys(q.options ?? {})[0], confidence: 0.4, probabilities: {} } : { type: 'noul', probability: 0 }
      }
      return { ok: true, model: 'never', answers, usage: null }
    },
  }

  test('conversations · a report is read on every axis, each axis accounts for every case once, and the values are the axis’s own', async () => {
    const report = await evaluateCorpus({ decisionProvider: no as never, examples: cases })
    const scores = scoreBySplit(report, cases)
    for (const axis of Object.keys(SPLIT_AXES) as SplitAxis[]) {
      const values = Object.keys(scores[axis])
      expect(values.every((v) => (SPLIT_AXES[axis] as readonly string[]).includes(v)), axis).toBe(true)
      expect(Object.values(scores[axis]).reduce((sum, s) => sum + s.total, 0), axis).toBe(cases.length)
      expect(Object.values(scores[axis]).reduce((sum, s) => sum + s.passed, 0), axis).toBe(report.passed)
    }
    const text = formatSplitReport(report, cases)
    expect(text).toContain(`Conversation corpus: ${report.passed}/${cases.length}`)
    for (const axis of Object.keys(SPLIT_AXES)) expect(text).toContain(`by ${axis}:`)
  })

  test('conversations · a model that never recognises anything is right only where nothing is to be recognised, and the split says so', async () => {
    const report = await evaluateCorpus({ decisionProvider: no as never, examples: cases })
    const scores = scoreBySplit(report, cases)
    // It starts a new chain for everything: right for unrelated work, wrong for every behavior that reads the conversation,
    // unless the user said which section is meant ("Reply to this" is used as given, whatever the model answers).
    const reads = ['continue', 'branch', 'wait', 'wait-group', 'join-back', 'join-chain', 'join-lines', 'ask-target', 'revise-work', 'revise-shared', 'answer-question'] as const
    const right = new Set(report.results.filter((r) => r.passed).map((r) => r.id))
    expect(cases.filter((c) => (reads as readonly string[]).includes(c.behavior) && !c.replyTo && right.has(c.id)).map((c) => c.id)).toEqual([])
    for (const behavior of ['wait', 'wait-group', 'join-back', 'join-chain', 'join-lines', 'ask-target', 'revise-shared'] as const) expect(scores.behavior[behavior]?.passed, behavior).toBe(0)
    expect(scores.behavior['new-chain']?.passed).toBe(scores.behavior['new-chain']?.total)
    // One overall number hides that: it is well above zero.
    expect(report.passed).toBeGreaterThan(0)
    // Every contrast family has a case that reads the conversation, so none is wholly right.
    const families = scoreFamilies(report, cases)
    expect(families.total).toBeGreaterThanOrEqual(4)
    expect(families.passed).toBeLessThan(families.total)
    expect(formatSplitReport(report, cases)).toContain('contrast families with every case right:')
  })

  test('conversations · every case sits at one place on every axis', () => {
    const splits = splitsOf(cases)
    expect(splits.size).toBe(cases.length)
    for (const [id, at] of splits) for (const axis of Object.keys(SPLIT_AXES) as SplitAxis[]) expect((SPLIT_AXES[axis] as readonly string[]).includes(at[axis]), `${id} ${axis}`).toBe(true)
  })
})

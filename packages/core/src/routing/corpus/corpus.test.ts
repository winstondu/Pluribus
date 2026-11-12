import { DEFAULT_SETTINGS, REFERENT_STRATEGY_NAMES } from '@committee/protocol'
import { describe, expect, test } from 'vitest'
import { ROUTING_CORPUS } from './examples'
import { compare, corpusInput, evaluateCorpus, formatCorpusReport, oracleDecisionProvider, referenceDecomposer } from './evaluate'
import { createRouter } from '../pipeline'
import { NEVER_CANCELLED, type CandidateSource } from '../../ports'
import { ids as sceneIds } from './scene'
import type { CorpusExample } from './types'

describe('routing corpus', () => {
  test('corpus · every example is well formed, has a unique ID and says why its label is right', () => {
    const ids = ROUTING_CORPUS.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ROUTING_CORPUS.length).toBeGreaterThanOrEqual(36)
    for (const e of ROUTING_CORPUS) {
      expect(e.note.length).toBeGreaterThan(10)
      expect(e.covers.length).toBeGreaterThan(0)
      for (const h of e.replyTo ?? []) expect(e.scene.candidates.sections.some((s) => s.sectionId === `sec_${h}`)).toBe(true)
    }
    const topics = new Set(ROUTING_CORPUS.flatMap((e) => e.covers))
    for (const t of ['targets', 'placement', 'revision', 'splits', 'dependencies']) expect(topics.has(t as never)).toBe(true)
  })

  describe.each(REFERENT_STRATEGY_NAMES)('referents by %s', (referentStrategy) => {
    // Strategy selection is off here: each strategy is tested as configured. So is the candidate source: what the walk reaches by itself.
    const settings = { ...DEFAULT_SETTINGS, routing: { ...DEFAULT_SETTINGS.routing, referentStrategy, strategySelection: 'off' as const, candidateSource: 'none' as const } }
    test.each(ROUTING_CORPUS.map((e) => [e.id, e] as const))('corpus · with decisions as labelled, the pipeline routes %s as labelled', async (_id, example) => {
      const input = corpusInput(example, settings)
      const router = createRouter({ decisionProvider: oracleDecisionProvider(example, input), decomposer: referenceDecomposer(example) })
      const outcome = await router.route(input, NEVER_CANCELLED)
      // One pass asks only about the sections the pipeline lists: a referent beyond the window is out of its reach.
      if (example.beyondWindow && referentStrategy === 'one-pass') expect(compare(example, outcome)).not.toEqual([])
      // The tree walk examines nothing below a run that is not plausible: a referent below work the message does not refer to is out of its reach.
      else if (example.below && referentStrategy === 'tree-walk') expect(compare(example, outcome)).not.toEqual([])
      else expect(compare(example, outcome)).toEqual([])
    })
  })

  // What the tree walk does not reach with decisions strictly as labelled, it reaches in two ways. A third is the lexical
  // candidate source, with nothing scripted: `candidates/lexical.test.ts`.
  describe('referents by tree-walk, a referent below work the message does not refer to', () => {
    const settings = { ...DEFAULT_SETTINGS, routing: { ...DEFAULT_SETTINGS.routing, referentStrategy: 'tree-walk' as const, strategySelection: 'off' as const, candidateSource: 'none' as const } }
    const below = ROUTING_CORPUS.filter((e) => e.below)
    test('corpus · three examples have such a referent', () => expect(below.map((e) => e.id)).toEqual(['live-referent-beyond-window', 'deep-run-middle-section', 'deep-run-other-branch']))

    test.each(below.map((e) => [e.id, e] as const))('corpus · %s is routed as labelled when the decision model finds the line above the referent plausible', async (_id, example) => {
      const plausible: CorpusExample = { ...example, expect: { ...example.expect, context: example.below ?? [] } }
      const input = corpusInput(plausible, settings)
      const router = createRouter({ decisionProvider: oracleDecisionProvider(plausible, input), decomposer: referenceDecomposer(plausible) })
      expect(compare(plausible, await router.route(input, NEVER_CANCELLED))).toEqual([])
    })

    test.each(below.map((e) => [e.id, e] as const))('corpus · %s is routed as labelled when a candidate source names the referent as a place to start', async (_id, example) => {
      const input = corpusInput(example, settings)
      const targets = (example.expect.parts ?? []).flatMap((part) => part.targets ?? [])
      const candidateSource: CandidateSource = { name: 'scripted', candidates: async () => targets.map((handle) => ({ sectionId: sceneIds.section(handle), score: null })) }
      const router = createRouter({ decisionProvider: oracleDecisionProvider(example, input), decomposer: referenceDecomposer(example), candidateSource })
      expect(compare(example, await router.route(input, NEVER_CANCELLED))).toEqual([])
    })
  })

  // Start at the trunk base: with decisions as labelled every example is still routed as labelled.
  describe('referents by tree-walk, start at the trunk base', () => {
    const settings = { ...DEFAULT_SETTINGS, routing: { ...DEFAULT_SETTINGS.routing, strategySelection: 'off' as const, candidateSource: 'none' as const, treeWalk: { ...DEFAULT_SETTINGS.routing.treeWalk, startAtTrunkBase: true } } }
    test.each(ROUTING_CORPUS.map((e) => [e.id, e] as const))('corpus · with decisions as labelled, the pipeline routes %s as labelled', async (_id, example) => {
      const input = corpusInput(example, settings)
      const router = createRouter({ decisionProvider: oracleDecisionProvider(example, input), decomposer: referenceDecomposer(example) })
      if (example.below) expect(compare(example, await router.route(input, NEVER_CANCELLED))).not.toEqual([])
      else expect(compare(example, await router.route(input, NEVER_CANCELLED))).toEqual([])
    })
  })

  // Hop between branch points places a unit on the last section of the run it refers to. The corpus is labelled with the
  // section referred to, so one example is not routed as labelled, by design: its label is left as it is.
  describe.each([
    ['hop between branch points', { hopBetweenBranchPoints: true }],
    ['trunk base and hop between branch points', { startAtTrunkBase: true, hopBetweenBranchPoints: true }],
  ] as const)('referents by tree-walk, %s', (_name, switches) => {
    const settings = { ...DEFAULT_SETTINGS, routing: { ...DEFAULT_SETTINGS.routing, strategySelection: 'off' as const, candidateSource: 'none' as const, treeWalk: { ...DEFAULT_SETTINGS.routing.treeWalk, ...switches } } }
    /** The examples whose referent is inside a run that is not asked about section by section, and where the unit goes instead. */
    const moved: { readonly [id: string]: string } = { 'long-chain-old-section': 'E198' }
    test.each(ROUTING_CORPUS.map((e) => [e.id, e] as const))('corpus · with decisions as labelled, the pipeline routes %s as labelled, or to the last section of the run the label is in', async (id, example) => {
      const input = corpusInput(example, settings)
      const router = createRouter({ decisionProvider: oracleDecisionProvider(example, input), decomposer: referenceDecomposer(example) })
      const outcome = await router.route(input, NEVER_CANCELLED)
      const end = moved[id]
      if (end !== undefined) {
        expect(compare(example, outcome)).not.toEqual([])
        expect(outcome.kind === 'plan' ? outcome.plan.units.map((unit) => [unit.targets, unit.placement]) : outcome.kind).toEqual([[[sceneIds.section(end)], { kind: 'continue', buildsOn: { kind: 'node', nodeId: sceneIds.node(end) } }]])
        expect(outcome.kind === 'plan' ? outcome.plan.decision.runEnds?.map((taken) => taken.sectionId) : null).toEqual([sceneIds.section(end)])
      } else if (example.below) expect(compare(example, outcome)).not.toEqual([])
      else expect(compare(example, outcome)).toEqual([])
    })
  })

  // A strategy selector in front, by the rules, which is the default: every example is routed as labelled, the ones beyond the window included,
  // because the rules choose the tree walk exactly there. The one exception is the referent that is both beyond the window and below work
  // the message does not refer to: with no candidate source the walk does not reach it. The record names the choice.
  describe('referents by the strategy the rules select (the default)', () => {
    test('corpus · the default settings select by rules', () => expect(DEFAULT_SETTINGS.routing.strategySelection).toBe('rules'))
    const settings = { ...DEFAULT_SETTINGS, routing: { ...DEFAULT_SETTINGS.routing, referentStrategy: 'one-pass' as const, strategySelection: 'rules' as const, candidateSource: 'none' as const } }
    test.each(ROUTING_CORPUS.map((e) => [e.id, e] as const))('corpus · with decisions as labelled, the pipeline routes %s as labelled', async (_id, example) => {
      const input = corpusInput(example, settings)
      const router = createRouter({ decisionProvider: oracleDecisionProvider(example, input), decomposer: referenceDecomposer(example) })
      const outcome = await router.route(input, NEVER_CANCELLED)
      if (example.below && example.beyondWindow) expect(compare(example, outcome)).not.toEqual([])
      else expect(compare(example, outcome)).toEqual([])
      if (outcome.kind !== 'plan' || (example.replyTo ?? []).length > 0 || example.scene.candidates.sections.every((s) => s.asksElicitationId !== null)) return
      // No explicit target and answers to refer to: a selection was made and recorded.
      if (outcome.plan.answersElicitationId === null) expect(outcome.plan.decision.strategySelection?.choice.strategy).toBe(example.scene.candidates.sections.filter((s) => !s.asksElicitationId).length > 24 ? 'tree-walk' : 'one-pass')
    })
  })

  test('corpus · the evaluator reports per topic, and a provider that always says no fails the labels it should', async () => {
    const no = {
      async decide(request: { questions: Record<string, { type: string; options?: Record<string, string> }> }) {
        const answers: Record<string, unknown> = {}
        for (const [id, q] of Object.entries(request.questions)) {
          answers[id] =
            q.type === 'choice'
              ? { type: 'choice', choice: Object.keys(q.options ?? {})[0], confidence: 0.4, probabilities: {} }
              : { type: 'noul', probability: 0 }
        }
        return { ok: true, model: 'never', answers, usage: null }
      },
    }
    const report = await evaluateCorpus({ decisionProvider: no as never })
    expect(report.total).toBe(ROUTING_CORPUS.length)
    expect(report.passed).toBeLessThan(report.total)
    expect(report.byTopic.targets?.total).toBeGreaterThan(0)
    expect(formatCorpusReport(report)).toContain('Routing corpus:')
  })
})

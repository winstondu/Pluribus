import { DEFAULT_SETTINGS, REFERENT_STRATEGY_NAMES } from '@pluribus/protocol'
import { describe, expect, test } from 'vitest'
import { ROUTING_CORPUS } from '../../../testing/routing/corpus/examples'
import { compare, corpusInput, evaluateCorpus, expectationSetFor, formatCorpusReport, oracleDecisionProvider, referenceDecomposer } from '../../../testing/routing/corpus/evaluate'
import { createRouter } from '../../../src/routing/pipeline'
import { NEVER_CANCELLED } from '../../../src/ports'
import { ids as sceneIds } from '../../../testing/routing/corpus/scene'
import type { CorpusExample } from '../../../testing/routing/corpus/types'

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
    const settings = { ...DEFAULT_SETTINGS, routing: { ...DEFAULT_SETTINGS.routing, referentStrategy } }
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

  // What the tree walk does not reach with decisions strictly as labelled, it reaches in two ways.
  describe('referents by tree-walk, a referent below work the message does not refer to', () => {
    const settings = { ...DEFAULT_SETTINGS, routing: { ...DEFAULT_SETTINGS.routing, referentStrategy: 'tree-walk' as const } }
    const below = ROUTING_CORPUS.filter((e) => e.below)
    test('corpus · three examples have such a referent', () => expect(below.map((e) => e.id)).toEqual(['live-referent-beyond-window', 'deep-run-middle-section', 'deep-run-other-branch']))

    test.each(below.map((e) => [e.id, e] as const))('corpus · %s is routed as labelled when the decision model finds the line above the referent plausible', async (_id, example) => {
      const plausible: CorpusExample = { ...example, expect: { ...example.expect, context: example.below ?? [] } }
      const input = corpusInput(plausible, settings)
      const router = createRouter({ decisionProvider: oracleDecisionProvider(plausible, input), decomposer: referenceDecomposer(plausible) })
      expect(compare(plausible, await router.route(input, NEVER_CANCELLED))).toEqual([])
    })
  })

  // Start at the trunk base: with decisions as labelled every example is still routed as labelled.
  describe('referents by tree-walk, start at the trunk base', () => {
    const settings = { ...DEFAULT_SETTINGS, routing: { ...DEFAULT_SETTINGS.routing, treeWalk: { ...DEFAULT_SETTINGS.routing.treeWalk, startAtTrunkBase: true } } }
    test.each(ROUTING_CORPUS.map((e) => [e.id, e] as const))('corpus · with decisions as labelled, the pipeline routes %s as labelled', async (_id, example) => {
      const input = corpusInput(example, settings)
      const router = createRouter({ decisionProvider: oracleDecisionProvider(example, input), decomposer: referenceDecomposer(example) })
      if (example.below) expect(compare(example, await router.route(input, NEVER_CANCELLED))).not.toEqual([])
      else expect(compare(example, await router.route(input, NEVER_CANCELLED))).toEqual([])
    })
  })

  // Hop between branch points places a unit that refers to an unbranched run, and to nothing built on it, on the run's last
  // section (11 · "Referent strategies", DA3). The corpus has a second set of expectations for it: an example whose placement
  // the hop moves carries its own (`CorpusExample.hop`), every other one keeps its default. The decisions stay as labelled.
  /** The examples whose placement the hop moves, by the spec's rule, and where it goes: the last section of the run the label is in. */
  const MOVED = { 'long-chain-old-section': 'E198', 'deep-run-middle-section': 'D5', 'deep-run-other-branch': 'H4' } as const
  const hopSettings = (switches: { readonly startAtTrunkBase?: boolean }) => ({
    ...DEFAULT_SETTINGS,
    routing: { ...DEFAULT_SETTINGS.routing, treeWalk: { ...DEFAULT_SETTINGS.routing.treeWalk, ...switches, hopBetweenBranchPoints: true } },
  })
  const routedTo = (outcome: Awaited<ReturnType<ReturnType<typeof createRouter>['route']>>) => (outcome.kind === 'plan' ? outcome.plan.units.map((unit) => [unit.targets, unit.placement]) : outcome.kind)
  const placedOn = (end: string) => [[[sceneIds.section(end)], { kind: 'continue', buildsOn: { kind: 'node', nodeId: sceneIds.node(end) } }]]

  test('corpus · three examples have a hop-on expectation of their own: the last section of the run their default target is in', () => {
    expect(Object.fromEntries(ROUTING_CORPUS.filter((e) => e.hop).map((e) => [e.id, e.hop?.parts]))).toEqual(
      Object.fromEntries(Object.entries(MOVED).map(([id, end]) => [id, [{ kind: 'unit', targets: [end], placement: { continue: end } }]])),
    )
    for (const e of ROUTING_CORPUS.filter((x) => x.hop)) expect(e.hop?.note.length).toBeGreaterThan(10)
  })

  describe.each([
    ['hop between branch points', {}],
    ['trunk base and hop between branch points', { startAtTrunkBase: true }],
  ] as const)('referents by tree-walk, %s', (_name, switches) => {
    const settings = hopSettings(switches)
    test.each(ROUTING_CORPUS.map((e) => [e.id, e] as const))('corpus · with decisions as labelled, the pipeline routes %s as the hop-on expectations say', async (id, example) => {
      const input = corpusInput(example, settings)
      const router = createRouter({ decisionProvider: oracleDecisionProvider(example, input), decomposer: referenceDecomposer(example) })
      const outcome = await router.route(input, NEVER_CANCELLED)
      expect(expectationSetFor(settings, outcome)).toBe('hop')
      // Out of the walk's reach with no candidate source, as with the switch off.
      if (example.below) expect(compare(example, outcome, 'hop')).not.toEqual([])
      else expect(compare(example, outcome, 'hop')).toEqual([])
      if (id === 'long-chain-old-section') {
        // Not where the default expectation has it: on the run's last section, which the hop took for the run.
        expect(compare(example, outcome)).not.toEqual([])
        expect(routedTo(outcome)).toEqual(placedOn(MOVED[id]))
        expect(outcome.kind === 'plan' ? outcome.plan.decision.runEnds?.map((taken) => taken.sectionId) : null).toEqual([sceneIds.section(MOVED[id])])
      }
    })
  })

  test('corpus · the evaluator scores a routing by the tree walk with the hop on against the hop-on expectations, and every other one against the default', async () => {
    const example = ROUTING_CORPUS.find((e) => e.id === 'long-chain-old-section')
    if (!example) throw new Error('missing example')
    const run = async (e: CorpusExample, settings: NonNullable<Parameters<typeof corpusInput>[1]>) => {
      const report = await evaluateCorpus({ decisionProvider: oracleDecisionProvider(e, corpusInput(e, settings)), settings, examples: [e] })
      return { result: report.results[0], report }
    }
    const on = await run(example, hopSettings({}))
    expect(on.result).toMatchObject({ passed: true, expectations: 'hop' })
    expect(on.report.expectations).toEqual({ default: 0, hop: 1, hopDiffering: 1 })
    expect(formatCorpusReport(on.report)).toContain('against the hop-on expectations')
    const off = await run(example, { ...DEFAULT_SETTINGS, routing: { ...DEFAULT_SETTINGS.routing, referentStrategy: 'tree-walk' } })
    expect(off.result).toMatchObject({ passed: true, expectations: 'default' })
    expect(formatCorpusReport(off.report)).toContain('against the default expectations')
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

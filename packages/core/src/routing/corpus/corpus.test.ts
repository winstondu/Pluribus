import { DEFAULT_SETTINGS, REFERENT_STRATEGY_NAMES } from '@committee/protocol'
import { describe, expect, test } from 'vitest'
import { ROUTING_CORPUS } from './examples'
import { compare, corpusInput, evaluateCorpus, formatCorpusReport, oracleDecisionProvider, referenceDecomposer } from './evaluate'
import { createRouter } from '../pipeline'
import { NEVER_CANCELLED } from '../../ports'

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
      else expect(compare(example, outcome)).toEqual([])
    })
  })

  // The tree walk's two switches, alone and together: with decisions as labelled every example is still routed as labelled.
  describe.each([
    ['start at the trunk base', { startAtTrunkBase: true }],
    ['hops between branch points', { hopBetweenBranchPoints: true }],
    ['trunk base and hops', { startAtTrunkBase: true, hopBetweenBranchPoints: true }],
  ] as const)('referents by tree-walk, %s', (_name, switches) => {
    const settings = { ...DEFAULT_SETTINGS, routing: { ...DEFAULT_SETTINGS.routing, treeWalk: { ...DEFAULT_SETTINGS.routing.treeWalk, ...switches } } }
    test.each(ROUTING_CORPUS.map((e) => [e.id, e] as const))('corpus · with decisions as labelled, the pipeline routes %s as labelled', async (_id, example) => {
      const input = corpusInput(example, settings)
      const router = createRouter({ decisionProvider: oracleDecisionProvider(example, input), decomposer: referenceDecomposer(example) })
      expect(compare(example, await router.route(input, NEVER_CANCELLED))).toEqual([])
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

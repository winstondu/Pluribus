import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, REFERENT_STRATEGY_NAMES, type ReferentStrategyName } from '@committee/protocol'
import { ROUTING_CORPUS, evaluateCorpus, formatCorpusReport } from '@committee/core'
import { createOpenRouterDecisionProvider } from './index'

/**
 * The referent strategies against the live decision model
 * (docs/build/dependency-decisioning.md). Run with `pnpm smoke`; skipped
 * when OPENROUTER_KEY is absent. The key reaches the provider through
 * `getKey` only.
 *
 * - The corpus, once per strategy, with what it cost in decision calls.
 * - The spec's J request and a follow-up naming two sections, with titles
 *   as a live run records them, several times with each strategy.
 */

const key = process.env['OPENROUTER_KEY'] ?? ''
const getKey = async () => (key === '' ? null : key)
const withStrategy = (referentStrategy: ReferentStrategyName) => ({ ...DEFAULT_SETTINGS, routing: { ...DEFAULT_SETTINGS.routing, referentStrategy } })

/** Below the last observed results, so one borderline answer does not fail the suite while a regression does. */
const CORPUS_FLOOR = 0.85
const RUNS = 5
const J_CASES = ['live-j-those-recommendations', 'live-j-named', 'live-j-those-recommendations-running', 'live-j-named-running', 'live-j-among-other-answers']
const TWO_SECTION_CASES = ['live-two-sections-siblings', 'live-two-sections-separate-trees']

describe.skipIf(key === '')('referent strategies, live', () => {
  it.each(REFERENT_STRATEGY_NAMES)('routes the corpus with referents by %s', { timeout: 600_000 }, async (name) => {
    const report = await evaluateCorpus({ decisionProvider: createOpenRouterDecisionProvider({ getKey }), settings: withStrategy(name) })
    console.log(`referents by ${name}\n${formatCorpusReport(report)}`)
    expect(report.total).toBe(ROUTING_CORPUS.length)
    expect(report.passed / report.total).toBeGreaterThanOrEqual(CORPUS_FLOOR)
  })

  it.each(REFERENT_STRATEGY_NAMES)(`places the J request on both siblings with referents by %s, ${RUNS} runs of each case`, { timeout: 600_000 }, async (name) => {
    const examples = ROUTING_CORPUS.filter((e) => [...J_CASES, ...TWO_SECTION_CASES].includes(e.id))
    expect(examples.length).toBe(J_CASES.length + TWO_SECTION_CASES.length)
    const passes = new Map<string, number>()
    for (let run = 0; run < RUNS; run++) {
      const report = await evaluateCorpus({ decisionProvider: createOpenRouterDecisionProvider({ getKey }), examples, settings: withStrategy(name) })
      for (const r of report.results) {
        passes.set(r.id, (passes.get(r.id) ?? 0) + (r.passed ? 1 : 0))
        if (!r.passed) console.log(`run ${run + 1} ✗ ${r.id}: ${r.mismatches.join('; ')}`)
      }
    }
    const count = (ids: readonly string[]): number => ids.reduce((sum, id) => sum + (passes.get(id) ?? 0), 0)
    console.log(
      [
        `referents by ${name}${name === DEFAULT_SETTINGS.routing.referentStrategy ? ' (the default)' : ''}, ${RUNS} runs:`,
        ...[...passes].map(([id, n]) => `  ${id}: ${n}/${RUNS}`),
        `J on both siblings: ${count(J_CASES)}/${J_CASES.length * RUNS}`,
        `follow-up naming two sections: ${count(TWO_SECTION_CASES)}/${TWO_SECTION_CASES.length * RUNS}`,
      ].join('\n'),
    )
    // Every J case, every run: this is the blocker the strategies were written for.
    expect(count(J_CASES)).toBe(J_CASES.length * RUNS)
  })
})

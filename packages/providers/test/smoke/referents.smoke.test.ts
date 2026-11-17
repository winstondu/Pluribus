import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type ReferentStrategyName, type Settings, type TreeWalkSettings } from '@pluribus/protocol'
import { ROUTING_CORPUS, evaluateCorpus, formatCorpusReport } from '@pluribus/core/testing'
import { createOpenRouterDecisionProvider } from '@pluribus/providers'

/**
 * The referent strategies against the live decision model. Run with `pnpm smoke`; skipped
 * when OPENROUTER_KEY is absent. The key reaches the provider through
 * `getKey` only.
 *
 * - The corpus, once per strategy and per combination of the tree walk's
 *   switches, with what it cost in decision calls, and the cost of each
 *   example that has a long run.
 * - The spec's J request and a follow-up naming two sections, with titles
 *   as a live run records them, several times with each of them.
 */

const key = process.env['OPENROUTER_KEY'] ?? ''
const getKey = async () => (key === '' ? null : key)
const withStrategy = (referentStrategy: ReferentStrategyName, treeWalk: Partial<TreeWalkSettings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  routing: { ...DEFAULT_SETTINGS.routing, referentStrategy, treeWalk: { ...DEFAULT_SETTINGS.routing.treeWalk, ...treeWalk } },
})

/** One pass, the tree walk as it was (runs always listed), the default, and the two switches alone and together. */
const CONFIGURATIONS: readonly (readonly [string, Settings])[] = [
  ['one-pass', withStrategy('one-pass')],
  ['tree-walk, runs listed', withStrategy('tree-walk', { searchRunsOverTokens: 1_000_000_000 })],
  ['tree-walk (the default)', withStrategy('tree-walk')],
  ['tree-walk + trunk base', withStrategy('tree-walk', { startAtTrunkBase: true })],
  ['tree-walk + hops', withStrategy('tree-walk', { hopBetweenBranchPoints: true })],
  ['tree-walk + trunk base + hops', withStrategy('tree-walk', { startAtTrunkBase: true, hopBetweenBranchPoints: true })],
]
const LONG = /^(long-|deep-|live-referent-beyond-window|live-unrelated-in-long)/
/** The examples whose placement hop between branch points moves, with their hop-on expectation (`CorpusExample.hop`). */
const HOP_MOVED = ROUTING_CORPUS.filter((e) => e.hop)

/** Below the last observed results, so one borderline answer does not fail the suite while a regression does. */
const CORPUS_FLOOR = 0.85
const RUNS = 5
const J_CASES = ['live-j-those-recommendations', 'live-j-named', 'live-j-those-recommendations-running', 'live-j-named-running', 'live-j-among-other-answers']
const TWO_SECTION_CASES = ['live-two-sections-siblings', 'live-two-sections-separate-trees']

describe.skipIf(key === '')('referent strategies, live', () => {
  it.each(CONFIGURATIONS)('routes the corpus with referents by %s', { timeout: 600_000 }, async (name, settings) => {
    const report = await evaluateCorpus({ decisionProvider: createOpenRouterDecisionProvider({ getKey }), settings })
    const long = report.results.filter((r) => LONG.test(r.id)).map((r) => `  ${r.passed ? '✓' : '✗'} ${r.id}: ${r.decisions.requests} requests, ${r.decisions.questions} questions, ${r.decisions.inputTokens} tokens`)
    // Hop between branch points: the targets that are the last section of a run, taken without a search inside the run.
    const hopped = report.results.filter((r) => r.runEnds.length > 0).map((r) => `  ${r.passed ? '✓' : '✗'} ${r.id}: ${r.runEnds.map((e) => `${e.unit} → ${e.sectionId.replace(/^sec_/, '')} (${e.confidence.toFixed(2)}, run of ${e.run.sections})`).join('; ')}`)
    // With the hop on, every routing is scored against the hop-on expectations, and the examples it moves are shown with where they went.
    const hopOn = settings.routing.treeWalk.hopBetweenBranchPoints
    const moved = HOP_MOVED.map((e) => {
      const r = report.results.find((x) => x.id === e.id)
      const want = (e.hop?.parts ?? []).flatMap((p) => p.targets ?? []).join(', ')
      return `  ${r?.passed ? '✓' : '✗'} ${e.id}: expected under the hop ${want}; run end taken ${r?.runEnds.map((end) => end.sectionId.replace(/^sec_/, '')).join(', ') || 'none'}${r?.passed ? '' : `; ${r?.mismatches.join('; ') ?? ''}`}`
    })
    if (hopOn) console.log(`referents by ${name}: the examples the hop moves\n${moved.join('\n')}`)
    console.log(`referents by ${name}: ${report.passed}/${report.total} (${hopOn ? 'hop-on' : 'default'} expectations), ${report.decisions.requests} requests, ${report.decisions.questions} questions, ${report.decisions.inputTokens} input tokens${hopped.length ? `\nrun ends taken in ${hopped.length} routings\n${hopped.join('\n')}` : ''}`)
    console.log(`referents by ${name}\n${formatCorpusReport(report)}\n${long.join('\n')}`)
    expect(report.total).toBe(ROUTING_CORPUS.length)
    // The configurations that name the tree walk with the hop on are scored against the hop-on expectations throughout.
    if (hopOn) expect(report.expectations.hop).toBe(report.total)
    if (!hopOn) expect(report.expectations.hop).toBe(0)
    expect(report.passed / report.total).toBeGreaterThanOrEqual(CORPUS_FLOOR)
  })

  it.each(CONFIGURATIONS)(`places the J request on both siblings with referents by %s, ${RUNS} runs of each case`, { timeout: 600_000 }, async (name, settings) => {
    const examples = ROUTING_CORPUS.filter((e) => [...J_CASES, ...TWO_SECTION_CASES].includes(e.id))
    expect(examples.length).toBe(J_CASES.length + TWO_SECTION_CASES.length)
    const passes = new Map<string, number>()
    for (let run = 0; run < RUNS; run++) {
      const report = await evaluateCorpus({ decisionProvider: createOpenRouterDecisionProvider({ getKey }), examples, settings })
      for (const r of report.results) {
        passes.set(r.id, (passes.get(r.id) ?? 0) + (r.passed ? 1 : 0))
        if (!r.passed) console.log(`run ${run + 1} ✗ ${r.id}: ${r.mismatches.join('; ')}`)
      }
    }
    const count = (ids: readonly string[]): number => ids.reduce((sum, id) => sum + (passes.get(id) ?? 0), 0)
    console.log(
      [
        `referents by ${name}, ${RUNS} runs:`,
        ...[...passes].map(([id, n]) => `  ${id}: ${n}/${RUNS}`),
        `J on both siblings: ${count(J_CASES)}/${J_CASES.length * RUNS}`,
        `follow-up naming two sections: ${count(TWO_SECTION_CASES)}/${TWO_SECTION_CASES.length * RUNS}`,
      ].join('\n'),
    )
    // Every J case, every run: this is the blocker the strategies were written for.
    expect(count(J_CASES)).toBe(J_CASES.length * RUNS)
  })
})

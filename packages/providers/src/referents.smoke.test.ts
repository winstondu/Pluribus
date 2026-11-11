import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type ReferentStrategyName, type Settings, type StrategySelectionMode, type TreeWalkSettings } from '@committee/protocol'
import {
  COST_GRID_ROWS_PER_SIZE,
  COST_GRID_SIZES,
  ROUTING_CORPUS,
  costGridRows,
  createDecisionSelector,
  evaluateCorpus,
  formatCorpusReport,
  formatCostGrid,
  type CorpusResult,
  type CostGridRow,
  type StrategySelector,
} from '@committee/core'
import { createOpenRouterDecisionProvider } from './index'

/**
 * The referent strategies against the live decision model
 * (docs/build/dependency-decisioning.md). Run with `pnpm smoke`; skipped
 * when OPENROUTER_KEY is absent. The key reaches the provider through
 * `getKey` only.
 *
 * - The corpus, once per strategy and per combination of the tree walk's
 *   switches, with what it cost in decision calls, and the cost of each
 *   example that has a long run.
 * - The spec's J request and a follow-up naming two sections, with titles
 *   as a live run records them, several times with each of them.
 * - The same with a strategy selector in front: the rules, the decision
 *   model, and the decision model shown the message as well.
 * - The cost grid of the price guard (no live call).
 */

const key = process.env['OPENROUTER_KEY'] ?? ''
const getKey = async () => (key === '' ? null : key)
const withStrategy = (referentStrategy: ReferentStrategyName, treeWalk: Partial<TreeWalkSettings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  routing: { ...DEFAULT_SETTINGS.routing, referentStrategy, treeWalk: { ...DEFAULT_SETTINGS.routing.treeWalk, ...treeWalk } },
})

const withSelection = (strategySelection: StrategySelectionMode): Settings => ({ ...DEFAULT_SETTINGS, routing: { ...DEFAULT_SETTINGS.routing, strategySelection } })

/**
 * One pass, the tree walk as it was (runs always listed), the default, the two switches alone and together; then a
 * strategy selector in front: the rules, the decision model on the shape alone, and the decision model shown the
 * message as well (an injected selector: it is not a setting).
 */
const CONFIGURATIONS: readonly (readonly [string, Settings, StrategySelector | null])[] = [
  ['one-pass', withStrategy('one-pass'), null],
  ['tree-walk, runs listed', withStrategy('tree-walk', { searchRunsOverTokens: 1_000_000_000 }), null],
  ['tree-walk (the default)', withStrategy('tree-walk'), null],
  ['tree-walk + trunk base', withStrategy('tree-walk', { startAtTrunkBase: true }), null],
  ['tree-walk + hops', withStrategy('tree-walk', { hopBetweenBranchPoints: true }), null],
  ['tree-walk + trunk base + hops', withStrategy('tree-walk', { startAtTrunkBase: true, hopBetweenBranchPoints: true }), null],
  ['strategy selected by rules', withSelection('rules'), null],
  ['strategy selected by the decision model', withSelection('decision-model'), null],
  ['strategy selected by the decision model, shown the message', withSelection('decision-model'), createDecisionSelector({ includeMessage: true })],
]

/** How the selections of a corpus run came out: who chose, what, and why the rules stood in. */
function selectionTally(results: readonly CorpusResult[]): string {
  const counts = new Map<string, number>()
  for (const r of results) {
    const s = r.selection
    if (!s) continue
    const choice = s.choice.strategy === 'one-pass' ? 'one-pass' : `tree-walk${s.choice.startAtTrunkBase ? '+trunk' : ''}${s.choice.hopBetweenBranchPoints ? '+hops' : ''}${s.choice.searchLongRuns ? '' : ', runs listed'}`
    const key = `${s.selector}${s.fallback ? ` (fallback: ${s.fallback})` : ''} → ${choice}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts].map(([key, n]) => `  ${n} × ${key}`).join('\n')
}
const LONG = /^(long-|deep-|live-referent-beyond-window|live-unrelated-in-long)/

/** Below the last observed results, so one borderline answer does not fail the suite while a regression does. */
const CORPUS_FLOOR = 0.85
const RUNS = 5
const J_CASES = ['live-j-those-recommendations', 'live-j-named', 'live-j-those-recommendations-running', 'live-j-named-running', 'live-j-among-other-answers']
const TWO_SECTION_CASES = ['live-two-sections-siblings', 'live-two-sections-separate-trees']

describe.skipIf(key === '')('referent strategies, live', () => {
  it.each(CONFIGURATIONS)('routes the corpus with referents by %s', { timeout: 600_000 }, async (name, settings, strategySelector) => {
    const report = await evaluateCorpus({ decisionProvider: createOpenRouterDecisionProvider({ getKey }), settings, ...(strategySelector ? { strategySelector } : {}) })
    const long = report.results.filter((r) => LONG.test(r.id)).map((r) => `  ${r.passed ? '✓' : '✗'} ${r.id}: ${r.decisions.requests} requests, ${r.decisions.questions} questions, ${r.decisions.inputTokens} tokens`)
    const tally = selectionTally(report.results)
    console.log(`referents by ${name}\n${formatCorpusReport(report)}\n${long.join('\n')}${tally ? `\nselections\n${tally}` : ''}`)
    expect(report.total).toBe(ROUTING_CORPUS.length)
    expect(report.passed / report.total).toBeGreaterThanOrEqual(CORPUS_FLOOR)
  })

  it.each(CONFIGURATIONS)(`places the J request on both siblings with referents by %s, ${RUNS} runs of each case`, { timeout: 600_000 }, async (name, settings, strategySelector) => {
    const examples = ROUTING_CORPUS.filter((e) => [...J_CASES, ...TWO_SECTION_CASES].includes(e.id))
    expect(examples.length).toBe(J_CASES.length + TWO_SECTION_CASES.length)
    const passes = new Map<string, number>()
    for (let run = 0; run < RUNS; run++) {
      const report = await evaluateCorpus({ decisionProvider: createOpenRouterDecisionProvider({ getKey }), examples, settings, ...(strategySelector ? { strategySelector } : {}) })
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

describe('decision cost grid', () => {
  it('prints what the worst message costs each strategy in conversations of up to a million tokens, unguarded and guarded', { timeout: 600_000 }, async () => {
    const rows: CostGridRow[] = []
    for (const [sections, exchange] of COST_GRID_SIZES) rows.push(...(await costGridRows(sections, exchange)))
    console.log(`worst shape per size and strategy\n${formatCostGrid(rows, true)}\n\nevery cell\n${formatCostGrid(rows, false)}`)
    expect(rows.length).toBe(COST_GRID_SIZES.length * COST_GRID_ROWS_PER_SIZE)
  })
})

import { describe, expect, it } from 'vitest'
import { ROUTING_CORPUS, evaluateCorpus, formatCorpusReport } from '@committee/core'
import { createOpenRouterDecisionProvider, createOpenRouterDecomposer } from './index'

/**
 * The routing corpus (`packages/core/src/routing/corpus/`) against the live
 * decision model. Run with `pnpm smoke`; skipped when OPENROUTER_KEY is
 * absent. The key reaches the providers through `getKey` only.
 *
 * The first test evaluates the decision model alone: each example's
 * reference decomposition stands in for the decomposer. The second runs the
 * real decomposer (the default decomposition model) as well. Both print the
 * report; the floors are below the last observed results so that one
 * borderline answer does not fail the suite, while a regression does.
 */

const key = process.env['OPENROUTER_KEY'] ?? ''
const getKey = async () => (key === '' ? null : key)

/** 42 of 44 on 2026-11-11 (PLAN §7). */
const DECISION_FLOOR = 0.85
/** The real decomposer adds its own variance. */
const WITH_DECOMPOSER_FLOOR = 0.75

describe.skipIf(key === '')('routing corpus, live', () => {
  it('routes the corpus with the live decision model', { timeout: 600_000 }, async () => {
    const report = await evaluateCorpus({ decisionProvider: createOpenRouterDecisionProvider({ getKey }) })
    console.log(formatCorpusReport(report))
    expect(report.total).toBe(ROUTING_CORPUS.length)
    expect(report.passed / report.total).toBeGreaterThanOrEqual(DECISION_FLOOR)
  })

  it('routes the corpus with the live decision model and the live decomposer', { timeout: 900_000 }, async () => {
    const report = await evaluateCorpus({
      decisionProvider: createOpenRouterDecisionProvider({ getKey }),
      decomposer: createOpenRouterDecomposer({ getKey }),
    })
    console.log(formatCorpusReport(report))
    expect(report.total).toBe(ROUTING_CORPUS.length)
    expect(report.passed / report.total).toBeGreaterThanOrEqual(WITH_DECOMPOSER_FLOOR)
  })
})

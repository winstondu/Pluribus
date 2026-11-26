import { describe, expect, it } from 'vitest'
import { CONVERSATION_CORPUS, evaluateCorpus, formatSplitReport, scoreBySplit } from '@pluribus/core/testing'
import { createOpenRouterDecisionProvider, createOpenRouterDecomposer } from '@pluribus/providers'

/**
 * The conversation corpus (`packages/core/testing/routing/conversations/`)
 * against the live decision model. Run with `pnpm smoke`; skipped when
 * OPENROUTER_KEY is absent. The key reaches the providers through `getKey`
 * only.
 *
 * The routing corpus beside it is what the thresholds were tuned on; this
 * one was not, and its `held-out` partition is never to be. Both tests
 * print the result by split (behavior, reference, register, role, domain,
 * shape, partition) and by contrast family. The first evaluates the
 * decision model alone, each case's reference decomposition standing in
 * for the decomposer; the second runs the real decomposer as well.
 *
 * The floors are below the observed results, as for the routing corpus, so
 * that one borderline answer does not fail the suite while a regression
 * does. Three cases changed sides between runs on the same day.
 */

const key = process.env['OPENROUTER_KEY'] ?? ''
const getKey = async () => (key === '' ? null : key)

/** 77 of 85 on 2026-11-26, three runs (typesafe/jev-1.13, default thresholds). */
const DECISION_FLOOR = 0.8
/** 22 of 26 on 2026-11-26, three runs. A smaller sample, so a wider margin. */
const HELD_OUT_FLOOR = 0.7
/** 79 of 85 on 2026-11-26, one run. The real decomposer adds its own variance. */
const WITH_DECOMPOSER_FLOOR = 0.7

describe.skipIf(key === '')('conversation corpus, live', () => {
  it('routes the conversation corpus with the live decision model, read by split', { timeout: 900_000 }, async () => {
    const report = await evaluateCorpus({ decisionProvider: createOpenRouterDecisionProvider({ getKey }), examples: CONVERSATION_CORPUS })
    console.log(formatSplitReport(report, CONVERSATION_CORPUS))
    expect(report.total).toBe(CONVERSATION_CORPUS.length)
    // A routing that failed is not a wrong answer: it is a provider error or a plan the pipeline refused.
    expect(report.results.filter((r) => r.outcome === 'failed').map((r) => r.id)).toEqual([])
    expect(report.passed / report.total).toBeGreaterThanOrEqual(DECISION_FLOOR)
    const heldOut = scoreBySplit(report, CONVERSATION_CORPUS).partition['held-out'] ?? { passed: 0, total: 1 }
    expect(heldOut.passed / heldOut.total).toBeGreaterThanOrEqual(HELD_OUT_FLOOR)
  })

  it('routes the conversation corpus with the live decision model and the live decomposer', { timeout: 900_000 }, async () => {
    const report = await evaluateCorpus({
      decisionProvider: createOpenRouterDecisionProvider({ getKey }),
      decomposer: createOpenRouterDecomposer({ getKey }),
      examples: CONVERSATION_CORPUS,
    })
    console.log(formatSplitReport(report, CONVERSATION_CORPUS))
    expect(report.total).toBe(CONVERSATION_CORPUS.length)
    expect(report.passed / report.total).toBeGreaterThanOrEqual(WITH_DECOMPOSER_FLOOR)
  })
})

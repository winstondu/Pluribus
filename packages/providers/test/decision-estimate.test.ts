import { describe, expect, test } from 'vitest'
import { estimateRequestTokens } from '@committee/core'
import { ESTIMATE_FIXTURE, estimateInput } from '../testing/openrouter/estimate-fixture'

/**
 * The guard's request-size estimate against the input tokens the live
 * decision model reported (recorded in `estimate-fixture.data.ts`, re-sent by
 * `decision-estimate.smoke.test.ts`). No network.
 */
describe('decision request size, against recorded live counts', () => {
  test('tokens · the estimate is never below the input tokens the decision model reported, on any of 70 recorded requests', () => {
    expect(ESTIMATE_FIXTURE).toHaveLength(70)
    const ratios = ESTIMATE_FIXTURE.map((r) => {
      const estimate = estimateRequestTokens(...estimateInput(r))
      expect(estimate, `${r.source}: ${r.state} characters of state, ${r.questions.length} questions`).toBeGreaterThanOrEqual(r.reported)
      return estimate / r.reported
    })
    const round = (x: number): number => Math.round(x * 1000) / 1000
    // How much it overcounts, recorded: an estimate that drifts towards the reported counts, or far above them, shows here.
    expect({ min: round(Math.min(...ratios)), max: round(Math.max(...ratios)) }).toEqual({ min: 1.011, max: 1.299 })
  })
})

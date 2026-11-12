import { describe, expect, it } from 'vitest'
import { NEVER_CANCELLED } from '@pluribus/core/ports'
import { estimateRequestTokens } from '@pluribus/core'
import { createOpenRouterDecisionProvider } from '@pluribus/providers'
import { ESTIMATE_FIXTURE, estimateInput, estimateSample, sampleRow, type EstimateRow } from '../../testing/openrouter/estimate-fixture'
import { toPortRequest } from '../../testing/openrouter/decisions-api-mock'

/**
 * The live data the guard's request-size estimate (`estimateRequestTokens`)
 * is fitted to (docs/build/dependency-decisioning.md · "Measuring tokens").
 * Run with `pnpm smoke`; skipped when OPENROUTER_KEY is absent. The key
 * reaches the provider through `getKey` only and is never printed.
 *
 * Sends the sample of `estimateSample()` (corpus requests and cost-grid
 * requests of every size, built deterministically over the Decisions mock)
 * once each, prints the rows as JSON for `estimate-fixture.ts`, and asserts
 * that the estimate is not below any reported count. `decision-estimate.test.ts`
 * asserts the same over the recorded rows without the network.
 */

const key = process.env['OPENROUTER_KEY'] ?? ''
const getKey = async () => (key === '' ? null : key)
const MODEL = 'typesafe/jev-1.13'

describe.skipIf(key === '')('decision request size, live', () => {
  it('the estimate is not below the input tokens the decision model reports, on every request of the sample', { timeout: 600_000 }, async () => {
    const sample = await estimateSample()
    const provider = createOpenRouterDecisionProvider({ getKey })
    const rows: EstimateRow[] = []
    for (const { source, body } of sample) {
      const request = toPortRequest({ ...body, model: MODEL })
      const result = await provider.decide(request, NEVER_CANCELLED)
      expect(result.ok, result.ok ? '' : result.error.message).toBe(true)
      if (!result.ok || result.usage === null) continue
      rows.push(sampleRow(source, body, result.usage.inputTokens))
    }
    console.log(JSON.stringify(rows))
    const lines = rows.map((r) => {
      const estimate = estimateRequestTokens(...estimateInput(r))
      return `${r.source}: ${r.questions.length} questions, ${r.state} characters of state, reported ${r.reported}, estimate ${estimate} (${(r.reported / estimate).toFixed(3)})`
    })
    console.log(lines.join('\n'))
    console.log(`recorded fixture: ${ESTIMATE_FIXTURE.length} rows; this run: ${rows.length}`)
    expect(rows.length).toBe(sample.length)
    for (const r of rows) expect(estimateRequestTokens(...estimateInput(r)), r.source).toBeGreaterThanOrEqual(r.reported)
  })
})


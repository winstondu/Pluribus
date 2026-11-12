import { DEFAULT_SETTINGS, resolveTokenBudget } from '@pluribus/protocol'
import { describe, expect, test } from 'vitest'
import { COST_GRID_ROWS_PER_SIZE, COST_GRID_SIZES, costGridRows, decisionDollars, formatCostGrid } from '../../../testing/routing/referents/cost-grid'

describe('decision cost over conversations of up to a million tokens', () => {
  test.each(COST_GRID_SIZES.map(([n, exchange]) => [n, exchange] as const))(
    'guard · %i sections of %i tokens: with the guard on, no strategy and no shape costs more than twice the answer priced on the cheapest answer model, nor more than the token budget',
    { timeout: 300_000 },
    async (sections, exchange) => {
      // Unguarded, the worst message of the largest cell is thousands of requests: `pnpm smoke` prints it; here only the guard is run.
      const rows = await costGridRows(sections, exchange, { unguarded: sections <= 3_300 })
      expect(rows).toHaveLength(COST_GRID_ROWS_PER_SIZE)
      expect(COST_GRID_ROWS_PER_SIZE).toBe(5 * 8)
      for (const row of rows) {
        const at = `${sections} × ${exchange}, ${row.shape}, ${row.strategy}`
        expect(decisionDollars(row.guarded.tokens) / row.answer, at).toBeLessThanOrEqual(DEFAULT_SETTINGS.routing.costGuard.maxAnswerCostRatio)
        // The backstops hold whatever the prices are: the pipeline's request, at most the budget's further requests, and
        // the one request of a decision-model strategy selector.
        const selector = row.strategy === 'selected by the decision model' ? 1 : 0
        expect(row.guarded.requests, at).toBeLessThanOrEqual(1 + selector + DEFAULT_SETTINGS.routing.referentBudget.requests)
        expect(row.guarded.tokens, at).toBeLessThanOrEqual(row.unguarded.tokens)
        // A request was sent: the guard never routes by sending nothing.
        expect(row.guarded.requests, at).toBeGreaterThanOrEqual(1)
        // The token budget holds as well as the price: a share of the conversation's log, within its floor and ceiling.
        expect(row.guarded.tokens, at).toBeLessThanOrEqual(resolveTokenBudget(DEFAULT_SETTINGS.routing.tokenBudget, sections * exchange))
      }
      expect(formatCostGrid(rows, true).split('\n')).toHaveLength(2 + 8)
    },
  )
})

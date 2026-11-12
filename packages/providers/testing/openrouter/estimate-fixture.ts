import { COST_GRID_SIZES, costGridRows } from '@committee/core/testing'
import type { DecisionQuestions } from '@committee/core/ports'
import { createOpenRouterDecisionProvider } from '../../src/openrouter/decision-provider'
import { corpusThroughMock, settingsFor } from './corpus-through-mock'
import { contentCharacters, createDecisionsApiMock, type WireDecisionBody } from './decisions-api-mock'
import { ESTIMATE_FIXTURE } from './estimate-fixture.data'

/**
 * Test-only: the live sample the guard's request-size estimate is fitted to
 * and held to. `estimateSample()` builds it deterministically (corpus
 * requests and cost-grid requests, as the real provider sends them over the
 * Decisions mock); `decision-estimate.smoke.test.ts` sends it and prints the
 * rows; `estimate-fixture.data.ts` records them, so that the fit and the
 * check (`decision-estimate.test.ts`) are reproducible without the network.
 */

export { ESTIMATE_FIXTURE }

/** One live request by its size alone: what the estimate reads, and what the provider reported. */
export interface EstimateRow {
  readonly source: string
  /** Characters of the state. */
  readonly state: number
  /** Characters of each question: its ID, instructions, choice options and descriptions, score criteria. */
  readonly questions: readonly number[]
  readonly reported: number
}


export function sampleRow(source: string, body: WireDecisionBody, reported: number): EstimateRow {
  const questions = Object.entries(body.questions).map(([id, q]) => {
    let n = id.length + q.instructions.length
    if (q.type === 'choice') for (const [o, t] of Object.entries(q.criteria)) n += o.length + t.length
    if (q.type === 'score') for (const c of q.criteria) n += c.length
    return n
  })
  return { source, state: body.state.length, questions, reported }
}

/** A request of the row's sizes, for an estimator that reads sizes only. */
export function estimateInput(r: EstimateRow): [string, DecisionQuestions] {
  return ['x'.repeat(r.state), Object.fromEntries(r.questions.map((n, i) => [`q${i}`, { type: 'noul' as const, instructions: 'x'.repeat(Math.max(0, n - `q${i}`.length)) }]))]
}

const pick = <T>(sorted: readonly T[], quantiles: readonly number[]): T[] => [
  ...new Set(quantiles.map((q) => sorted[Math.round(q * (sorted.length - 1))]).filter((x): x is T => x !== undefined)),
]

/** The request recorded in CLAUDE.md: tiny, with a choice and a score question. */
const SAMPLE: WireDecisionBody = {
  model: 'typesafe/jev-1.13',
  state: 'Hi there!',
  questions: {
    isGreeting: { type: 'noul', instructions: 'Is this message a greeting?' },
    kind: { type: 'choice', instructions: 'What kind of message is it?', criteria: { greet: 'a greeting', ask: 'a question' } },
    tone: { type: 'score', instructions: 'How polite is it?', criteria: ['polite', 'warm'] },
  },
}

/** The sample: the CLAUDE.md request, 14 corpus requests across sizes, and the smallest, middle and largest guarded request of each cost-grid size. */
export async function estimateSample(): Promise<{ readonly source: string; readonly body: WireDecisionBody }[]> {
  const out: { source: string; body: WireDecisionBody }[] = [{ source: 'CLAUDE.md sample', body: SAMPLE }]
  const corpus = new Map<string, WireDecisionBody>()
  for (const name of ['selected by rules (the default)', 'tree walk, long runs searched'] as const) {
    for (const e of await corpusThroughMock(settingsFor(name))) for (const c of e.calls) corpus.set(JSON.stringify(c.body), c.body)
  }
  const sorted = [...corpus.values()].sort((a, b) => contentCharacters(a) - contentCharacters(b))
  for (const body of pick(sorted, Array.from({ length: 14 }, (_, i) => i / 13))) out.push({ source: 'corpus', body })
  for (const [sections, exchange] of COST_GRID_SIZES) {
    const captured = new Map<string, WireDecisionBody>()
    await costGridRows(sections, exchange, {
      unguarded: false,
      through: (worstCase) => {
        const api = createDecisionsApiMock({ answerer: worstCase })
        return {
          provider: createOpenRouterDecisionProvider({ getKey: async () => 'sk-or-v1-mock', fetch: api.fetch }),
          inputTokens: () => {
            for (const c of api.calls) captured.set(JSON.stringify(c.body), c.body)
            return 0
          },
        }
      },
    })
    const grid = [...captured.values()].sort((a, b) => contentCharacters(a) - contentCharacters(b))
    for (const body of pick(grid, [0, 0.5, 1])) out.push({ source: `grid ${sections} × ${exchange}`, body })
  }
  return out
}

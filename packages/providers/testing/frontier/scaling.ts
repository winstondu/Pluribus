import type { DecisionProvider, DecisionQuestions, DecisionRequest, DecisionResult } from '@pluribus/core/ports'
import { COST_GRID_MESSAGE, COST_GRID_SEEDED_MESSAGE, evaluateCorpus, scene, type CorpusExample, type Scene } from '@pluribus/core/testing'
import { createOpenRouterDecisionProvider } from '../../src/openrouter/decision-provider'
import { FITTED_CALIBRATION, createDecisionsApiMock } from '../openrouter/decisions-api-mock'
import type { Arm } from './arms'
import { setAmbiguityFloor, STATED_AMBIGUITY_FLOOR } from './floor'
import { cheapestAnswerDollars, decisionDollarsPerToken } from './prices'

/**
 * Test-only: what an arm's most expensive message costs as the conversation
 * grows, with no network. The corpus has six long conversations; this asks
 * the question the corpus cannot: is an arm that is cheap at 5 sections
 * still cheap at 1,000?
 *
 * Every yes/no is answered "plausible" (0.5) as in the cost grid
 * (`core/testing/routing/referents/cost-grid.ts`), so every line is walked
 * into and every part of a search opened: an upper bound on what one
 * routing spends under the arm's guard. Requests go through the real
 * decision provider over the tokenizer-counting Decisions mock, so tokens
 * are the calibrated count (`FITTED_CALIBRATION`), comparable with the live
 * figures of the corpus.
 */

export type ScalingShape = 'flat' | 'early split' | 'bushy' | 'nested forks' | 'many roots'
export const SCALING_SHAPES: readonly ScalingShape[] = ['flat', 'early split', 'bushy', 'nested forks', 'many roots']
export const SCALING_SECTIONS: readonly number[] = [5, 24, 50, 200, 1_000]
/** Tokens per exchange: a short answer and an ordinary one. */
export const SCALING_EXCHANGES: readonly number[] = [300, 2_000]

const filler = (seed: string, length: number): string => `${seed} `.repeat(Math.ceil(length / (seed.length + 1))).slice(0, length)

/** The cost grid's five shapes, written with the corpus scene builder. */
export function scalingScene(shape: ScalingShape, n: number, exchange: number): Scene {
  const s = scene()
  const answerLength = Math.round(exchange * 0.85 * 4)
  let count = 0
  const add = (handle: string, chain: string, on: string | null): void => {
    count += 1
    s.add(handle, {
      chain,
      on,
      label: filler(`topic ${count}`, 30),
      request: filler(`Please go into point ${count} of the plan in detail`, Math.round(exchange * 0.15 * 4)),
      answerText: filler(`Here is what matters about point ${count}.`, answerLength),
    })
  }
  if (shape === 'flat') {
    s.chain('c', 'root', 'chat')
    for (let i = 0; i < n; i++) add(`T${i}`, 'c', i === 0 ? null : `T${i - 1}`)
  } else if (shape === 'many roots') {
    for (let i = 0; i < n; i++) {
      s.chain(`c${i}`, 'root', `topic ${i}`)
      add(`T${i}`, `c${i}`, null)
    }
  } else if (shape === 'early split') {
    s.chain('c', 'root', 'chat')
    const trunk = Math.min(5, n)
    for (let i = 0; i < trunk; i++) add(`T${i}`, 'c', i === 0 ? null : `T${i - 1}`)
    const length = Math.floor((n - trunk) / 2)
    for (const side of length > 0 ? ['a', 'b'] : []) {
      s.chain(side, 'branch', side)
      for (let i = 0; i < length; i++) add(`${side}${i}`, side, i === 0 ? `T${trunk - 1}` : `${side}${i - 1}`)
    }
  } else if (shape === 'nested forks') {
    s.chain('c0', 'root', 'chat')
    add('N0', 'c0', null)
    for (let i = 1; count + 2 <= n; i++) {
      s.chain(`leaf${i}`, 'branch', `aside ${i}`)
      add(`L${i}`, `leaf${i}`, `N${i - 1}`)
      s.chain(`c${i}`, 'branch', `deeper ${i}`)
      add(`N${i}`, `c${i}`, `N${i - 1}`)
    }
  } else {
    s.chain('c', 'root', 'chat')
    add('J0', 'c', null)
    for (let i = 1; count + 3 <= n; i++) {
      for (const side of ['a', 'b']) {
        s.chain(`${side}${i}`, 'fork', `${side}${i}`)
        add(`${side}${i}`, `${side}${i}`, i === 1 ? 'J0' : `J${i - 1}`)
      }
      s.group(`G${i}`, { base: 'c', start: i === 1 ? 'J0' : `J${i - 1}`, members: [`a${i}`, `b${i}`], open: false })
      add(`J${i}`, 'c', `jb_G${i}`)
    }
  }
  return s.build()
}

const worstCase: DecisionProvider = {
  async decide<Q extends DecisionQuestions>(request: DecisionRequest<Q>): Promise<DecisionResult<Q>> {
    const answers: { [id: string]: unknown } = {}
    for (const [id, q] of Object.entries(request.questions)) {
      if (q.type === 'choice') {
        const options = Object.keys(q.options)
        const chosen = options.includes('addition') ? 'addition' : (options[0] ?? '')
        answers[id] = { type: 'choice', choice: chosen, confidence: 0.5, probabilities: Object.fromEntries(options.map((o) => [o, o === chosen ? 0.5 : 0])) }
      } else answers[id] = { type: 'noul', probability: 0.5 }
    }
    return { ok: true, model: 'worst-case', answers: answers as never, usage: null }
  },
}

export interface ScalingCell {
  readonly sections: number
  readonly exchange: number
  /** The shape and message that cost most. */
  readonly shape: ScalingShape
  readonly requests: number
  readonly questions: number
  /** Calibrated input tokens over every decision request of the routing. */
  readonly tokens: number
  readonly dollars: number
  /** Decision dollars ÷ the message's answer on the cheapest answer model. */
  readonly ofAnswer: number
}

const getKey = async (): Promise<string> => 'sk-or-v1-mock'

/** The worst routing of every size for one arm: the costliest of the five shapes and two messages. */
export async function scalingCells(arm: Arm, sizes: readonly number[] = SCALING_SECTIONS, exchanges: readonly number[] = SCALING_EXCHANGES): Promise<ScalingCell[]> {
  const out: ScalingCell[] = []
  setAmbiguityFloor(arm.floor)
  try {
    for (const exchange of exchanges) {
      for (const sections of sizes) {
        let worst: ScalingCell | null = null
        for (const shape of SCALING_SHAPES) {
          const sc = scalingScene(shape, sections, exchange)
          for (const text of [COST_GRID_MESSAGE, COST_GRID_SEEDED_MESSAGE]) {
            const example: CorpusExample = { id: `scale-${shape}-${sections}`, covers: ['targets'], note: 'a scaling cell', scene: sc, text, expect: {} }
            const api = createDecisionsApiMock({ answerer: worstCase, calibration: FITTED_CALIBRATION })
            await evaluateCorpus({ decisionProvider: createOpenRouterDecisionProvider({ getKey, fetch: api.fetch }), settings: arm.settings, examples: [example] })
            const t = api.totals()
            const dollars = t.inputTokens * decisionDollarsPerToken()
            const cell: ScalingCell = { sections, exchange, shape, requests: t.requests, questions: t.questions, tokens: t.inputTokens, dollars, ofAnswer: dollars / cheapestAnswerDollars(text.length, exchange * 0.85) }
            if (worst === null || cell.tokens > worst.tokens) worst = cell
          }
        }
        if (worst) out.push(worst)
      }
    }
  } finally {
    setAmbiguityFloor(STATED_AMBIGUITY_FLOOR)
  }
  return out
}

/** One row per arm: the worst routing's calibrated tokens and its ratio to the answer, by size. */
export function formatScaling(rows: readonly { readonly arm: Arm; readonly cells: readonly ScalingCell[] }[]): string {
  const first = rows[0]?.cells ?? []
  const header = first.map((c) => `${c.sections.toLocaleString('en-US')} × ${c.exchange.toLocaleString('en-US')}`)
  return [
    `| Arm | ${header.join(' | ')} |`,
    `|---|${header.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.arm.name} | ${r.cells.map((c) => `${c.requests} / ${Math.round(c.tokens).toLocaleString('en-US')} (${c.ofAnswer.toFixed(2)}×)`).join(' | ')} |`),
  ].join('\n')
}

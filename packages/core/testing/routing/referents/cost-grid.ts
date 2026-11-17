import { DEFAULT_SETTINGS, type RoutingSettings } from '@pluribus/protocol'
import { NEVER_CANCELLED, type CandidateSource, type DecisionProvider, type DecisionQuestions, type DecisionRequest, type DecisionResult } from '../../../src/ports'
import { corpusInput, referenceDecomposer } from '../corpus/evaluate'
import { scene, type Scene } from '../corpus/scene'
import type { CorpusExample } from '../corpus/types'
import { createRouter } from '../../../src/routing/pipeline'
import { estimateRequestTokens } from '../../../src/routing/referents/ask'

/**
 * The price guard over a grid of conversations of up to a million tokens
 * with the default
 * token budget (relative to the conversation's log). Each cell routes
 * the message that costs a strategy most: every question is answered
 * "plausible" (0.5), so every line of work is walked into and every chunk
 * of a search is followed. Tokens are the guard's own estimate, summed over
 * every decision request of the routing, the pipeline's included.
 *
 * `cost-grid.test.ts` asserts the bound on every cell; `pnpm smoke` prints
 * the tables of the document (`referents.smoke.test.ts`, no live call).
 */

const DECISION_PRICE = DEFAULT_SETTINGS.routing.costGuard.decisionInputPrice
const HAIKU = { input: DEFAULT_SETTINGS.routing.costGuard.answerInputPrice, output: DEFAULT_SETTINGS.routing.costGuard.answerOutputPrice }
/** The message every cell routes. */
export const COST_GRID_MESSAGE = 'Look at that again and tell me what you would change'
const MESSAGE = COST_GRID_MESSAGE
/**
 * A message that names answers of the grid's conversations in their own
 * words, so that the lexical candidate source has candidate sections to
 * hand a tree walk: the worst message with seed hints on top.
 */
export const COST_GRID_SEEDED_MESSAGE = 'Go into points 3, 7 and 12 of the plan in detail and tell me what you would change'

export type CostGridShape = 'flat' | 'early split' | 'bushy' | 'nested forks' | 'many roots'
const SHAPES: readonly CostGridShape[] = ['flat', 'early split', 'bushy', 'nested forks', 'many roots']

/**
 * Sections × tokens per exchange: every cell is a conversation of at most a
 * million tokens. The 120-token exchanges have answers of 102 tokens, just
 * above the shortest the price guard is held to (`SHORTEST_ANSWER_TOKENS`):
 * there the pipeline's own request has to list fewer answer sections to fit.
 */
export const COST_GRID_SIZES: readonly (readonly [number, number])[] = [
  [50, 120],
  [500, 120],
  [8_000, 120],
  [50, 300],
  [50, 2_000],
  [50, 10_000],
  [500, 300],
  [500, 2_000],
  [3_300, 300],
]

const filler = (seed: string, length: number): string => `${seed} `.repeat(Math.ceil(length / (seed.length + 1))).slice(0, length)

/** A conversation of `n` answer sections whose exchanges are `exchange` tokens: 15% request, 85% answer. */
function conversation(shape: CostGridShape, n: number, exchange: number): Scene {
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
      // The whole answer, written out: a question about a section by itself shows as much of it as the budget allows.
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
    for (let i = 0; i < 5; i++) add(`T${i}`, 'c', i === 0 ? null : `T${i - 1}`)
    for (const side of ['a', 'b']) {
      s.chain(side, 'branch', side)
      const length = Math.floor((n - 5) / 2)
      for (let i = 0; i < length; i++) add(`${side}${i}`, side, i === 0 ? 'T4' : `${side}${i - 1}`)
    }
  } else if (shape === 'nested forks') {
    // Every answer is continued twice: once by an answer nothing follows, once by the line that goes on.
    s.chain('c0', 'root', 'chat')
    add('N0', 'c0', null)
    for (let i = 1; count + 2 <= n; i++) {
      s.chain(`leaf${i}`, 'branch', `aside ${i}`)
      add(`L${i}`, `leaf${i}`, `N${i - 1}`)
      s.chain(`c${i}`, 'branch', `deeper ${i}`)
      add(`N${i}`, `c${i}`, `N${i - 1}`)
    }
  } else {
    // Many small sibling groups: two parallel answers, joined back, one answer on the join-back, and again.
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

/** Every yes/no is "plausible": at the floor that makes a walk descend and a search follow, below what would settle anything. */
function worstCase(): { readonly provider: DecisionProvider; readonly requests: DecisionRequest<DecisionQuestions>[] } {
  const requests: DecisionRequest<DecisionQuestions>[] = []
  const provider: DecisionProvider = {
    async decide<Q extends DecisionQuestions>(request: DecisionRequest<Q>): Promise<DecisionResult<Q>> {
      requests.push(request)
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
  return { provider, requests }
}

const UNGUARDED: Pick<RoutingSettings, 'referentBudget' | 'tokenBudget' | 'costGuard'> = {
  referentBudget: { requests: 1_000_000, questions: 100_000_000 },
  tokenBudget: { mode: 'absolute', inputTokens: 1_000_000_000 },
  costGuard: { ...DEFAULT_SETTINGS.routing.costGuard, maxAnswerCostRatio: 0 },
}
const NO_SEARCH = 1_000_000_000
/** A row names its strategy: strategy selection is off unless the row turns it on. */
const FIXED: RoutingSettings = { ...DEFAULT_SETTINGS.routing, strategySelection: 'off' }

const STRATEGIES: readonly (readonly [string, Partial<RoutingSettings>])[] = [
  ['one pass', { referentStrategy: 'one-pass' }],
  ['tree walk, runs listed', { treeWalk: { startAtTrunkBase: false, hopBetweenBranchPoints: false, searchRunsOverTokens: NO_SEARCH } }],
  ['tree walk, long runs searched', {}],
  ['+ trunk base', { treeWalk: { ...DEFAULT_SETTINGS.routing.treeWalk, startAtTrunkBase: true } }],
  ['+ hops', { treeWalk: { ...DEFAULT_SETTINGS.routing.treeWalk, hopBetweenBranchPoints: true } }],
  ['+ trunk base and hops', { treeWalk: { ...DEFAULT_SETTINGS.routing.treeWalk, startAtTrunkBase: true, hopBetweenBranchPoints: true } }],
  // A strategy selector in front: the rules cost nothing; the decision model's request is counted like any other. The
  // worst-case provider is not confident about anything, so the rules choose after the request has been paid for.
  ['selected by rules (default)', { strategySelection: 'rules' }],
  ['selected by the decision model', { strategySelection: 'decision-model' }],
]

/** Rows per size: every shape with every strategy. */
export const COST_GRID_ROWS_PER_SIZE = SHAPES.length * STRATEGIES.length

export interface DecisionCost {
  readonly requests: number
  readonly questions: number
  /** Estimated input tokens of every decision request of the routing. */
  readonly tokens: number
  /** Input tokens the channel reported for the same requests, when the grid is run through one; null otherwise. */
  readonly measured: number | null
  /** Candidate sections the candidate source handed the routing; 0 when no source was asked. */
  readonly seeds: number
}

/** What a cell is routed with besides its strategy. */
export interface CostGridOptions {
  /** False leaves the unguarded run out. */
  readonly unguarded?: boolean
  readonly through?: (worstCase: DecisionProvider) => CostGridChannel
  /** The message every cell routes. `COST_GRID_MESSAGE` unless given. */
  readonly message?: string
  /** Routing settings on top of each row's own: for example the candidate source. */
  readonly routing?: Partial<RoutingSettings>
  /** Injected in place of the candidate source the settings name. */
  readonly candidateSource?: CandidateSource
}

/**
 * The candidate source that costs a walk most: as many candidate sections
 * as the pipeline accepts, spread evenly over the conversation, whatever
 * the message says. No real source is this unhelpful; the price guard has
 * to hold all the same.
 */
export const worstCaseCandidateSource: CandidateSource = {
  name: 'worst-case',
  candidates: async ({ sections }) => {
    const count = Math.min(12, sections.length)
    return Array.from({ length: count }, (_, i) => sections[Math.floor(((i + 0.5) * sections.length) / count)]).flatMap((section) => (section ? [{ sectionId: section.sectionId, score: null }] : []))
  },
}

/**
 * A decision provider the grid's requests go through instead of straight to
 * the worst-case answerer, and what it reports they cost. Used by a
 * measurement test to count the same requests with a tokenizer
 * (`packages/providers`, "Measuring tokens"); core itself counts nothing.
 */
export interface CostGridChannel {
  readonly provider: DecisionProvider
  readonly inputTokens: () => number
}

async function spend(sc: Scene, routing: RoutingSettings, options: CostGridOptions): Promise<DecisionCost> {
  const example: CorpusExample = { id: 'grid', covers: ['targets'], note: 'a cost grid cell', scene: sc, text: options.message ?? MESSAGE, expect: {} }
  const { provider, requests } = worstCase()
  const channel = options.through?.(provider)
  const router = createRouter({
    decisionProvider: channel?.provider ?? provider,
    decomposer: referenceDecomposer(example),
    ...(options.candidateSource ? { candidateSource: options.candidateSource } : {}),
  })
  const outcome = await router.route(corpusInput(example, { ...DEFAULT_SETTINGS, routing }), NEVER_CANCELLED)
  const handed = outcome.kind === 'plan' ? (outcome.plan.decision.candidateSource?.units ?? []) : []
  return {
    seeds: handed.reduce((sum, unit) => sum + unit.candidates.length, 0),
    requests: requests.length,
    questions: requests.reduce((sum, r) => sum + Object.keys(r.questions).length, 0),
    tokens: requests.reduce((sum, r) => sum + estimateRequestTokens(r.state, r.questions), 0),
    measured: channel ? channel.inputTokens() : null,
  }
}

/** The answer the message gets, priced on the cheapest answer model: it reads only the message and is as long as the conversation's answers. */
const haikuAnswer = (exchange: number, message: string = MESSAGE): number => (Math.ceil(message.length / 4) * HAIKU.input + exchange * 0.85 * HAIKU.output) / 1e6

/** Dollars of decision input tokens. */
export const decisionDollars = (tokens: number): number => (tokens * DECISION_PRICE) / 1e6

export interface CostGridRow {
  readonly sections: number
  /** Tokens per exchange. */
  readonly exchange: number
  readonly shape: CostGridShape
  readonly strategy: string
  readonly unguarded: DecisionCost
  readonly guarded: DecisionCost
  /** Dollars of the answer the message gets on the cheapest answer model. */
  readonly answer: number
}

/**
 * Every shape and strategy for one size, with the default guard and with
 * the guard off. `unguarded: false` leaves the second out (the row then
 * repeats the guarded figures): unguarded, the worst message in the largest
 * cells takes thousands of requests. `through` routes every request of a
 * cell through a channel built for it, whose count is the cost's `measured`.
 * `message`, `routing` and `candidateSource` route another message, with
 * other settings or with an injected candidate source.
 */
export async function costGridRows(sections: number, exchange: number, options: CostGridOptions = {}): Promise<CostGridRow[]> {
  const rows: CostGridRow[] = []
  for (const shape of SHAPES) {
    const sc = conversation(shape, sections, exchange)
    for (const [strategy, settings] of STRATEGIES) {
      const guarded = await spend(sc, { ...FIXED, ...settings, ...options.routing }, options)
      const unguarded = options.unguarded === false ? guarded : await spend(sc, { ...FIXED, ...settings, ...options.routing, ...UNGUARDED }, options)
      rows.push({ sections, exchange, shape, strategy, guarded, unguarded, answer: haikuAnswer(exchange, options.message) })
    }
  }
  return rows
}

function cell(cost: DecisionCost, answer: number): string {
  const price = decisionDollars(cost.tokens)
  return [`${cost.requests} / ${cost.questions} / ${cost.tokens}`, `$${price.toFixed(5)}`, `${(price / answer).toFixed(2)}×`].join(' | ')
}

/** The whole grid, or for each size and strategy only the shape that costs most unguarded. */
export function formatCostGrid(rows: readonly CostGridRow[], worstOnly: boolean): string {
  let shown = [...rows]
  if (worstOnly) {
    const worst = new Map<string, CostGridRow>()
    for (const row of rows) {
      const key = `${row.sections}×${row.exchange}·${row.strategy}`
      const held = worst.get(key)
      if (!held || row.unguarded.tokens > held.unguarded.tokens) worst.set(key, row)
    }
    shown = [...worst.values()]
  }
  return [
    '| Sections × tokens per exchange | Shape | Strategy | Unguarded: requests / questions / tokens | $ | ÷ Haiku answer | Guarded: requests / questions / tokens | $ | ÷ Haiku answer |',
    '|---|---|---|---|---|---|---|---|---|',
    ...shown.map((r) => `| ${r.sections} × ${r.exchange} | ${r.shape} | ${r.strategy} | ${cell(r.unguarded, r.answer)} | ${cell(r.guarded, r.answer)} |`),
  ].join('\n')
}

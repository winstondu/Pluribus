import type { ModelRole } from './model'

/**
 * User settings (10 · "User settings"). App-wide: retry policy, models and
 * the key apply to every conversation (Q70). Persisted as `settings-changed`
 * events in the app log. The OpenRouter key is not a setting value: it lives
 * in the secrets store and only its presence is ever reported (Q64, Q73).
 */

/** Q47. */
export type RetryPolicy = 'standard' | 'persistent' | 'manual'

/** OpenRouter model IDs, one per role (Q65). */
export type ModelSettings = { readonly [R in ModelRole]: string }

/**
 * Decision confidence thresholds (Q74). The defaults are tuned on the
 * routing corpus against the pinned decision model (docs/build/PLAN.md
 * section 7, "Threshold tuning"). All are probabilities in [0, 1].
 */
export interface DecisionThresholds {
  /** Below this confidence for the best target, Committee elicits the target instead of inferring it (Q20). */
  readonly targetChoice: number
  /** Below this, a reply is additional work, not a revision (Q37). */
  readonly clearlyCorrective: number
  /** At or above this, a message is treated as composite. Splitting is conservative (Q4). */
  readonly composite: number
  /** At or above this, a unit is result-dependent on a candidate. Topic overlap alone must stay below it (Q2). */
  readonly dependency: number
  /** At or above this, a unit is blocked on a clarification question (Q23, Q34). */
  readonly clarification: number
}

/**
 * How routing decides which earlier work a message refers to and depends on
 * (docs/build/dependency-decisioning.md). The strategies sit behind one
 * interface in core (`ReferentStrategy`); the rest of the pipeline does not
 * know which is in use.
 * - `one-pass`: the questions ride in the routing request the pipeline sends
 *   anyway. No further request.
 * - `tree-walk`: breadth-first over the context tree from each root, pruned
 *   where a line of work is not relevant, one further request per branching
 *   level, within `tokenBudget`, `referentBudget` and `costGuard`. Long runs of only
 *   children are searched (`treeWalk`).
 */
export type ReferentStrategyName = 'one-pass' | 'tree-walk'

export const REFERENT_STRATEGY_NAMES: readonly ReferentStrategyName[] = ['one-pass', 'tree-walk']

/**
 * What a referent strategy may still add to one routing, beyond the
 * requests the pipeline sends anyway. A strategy checks it before every
 * further request and falls back deterministically instead of exceeding it,
 * so decision cost stays a small fraction of the answer it routes. The
 * request and question limits are settings (`DecisionCaps`); the token
 * limit is what the routing's token budget and the price guard leave once
 * the pipeline's own requests are counted.
 */
export interface DecisionBudget {
  /** Further decision requests per routing. Whole number ≥ 0. */
  readonly requests: number
  /** Questions in those requests, in total. Whole number ≥ 0. */
  readonly questions: number
  /** Estimated input tokens of those requests, in total. Whole number ≥ 0. */
  readonly inputTokens: number
}

/** The backstops that hold whatever the token budget and the prices are: further requests and their questions. */
export type DecisionCaps = Pick<DecisionBudget, 'requests' | 'questions'>

/**
 * The decision input tokens one routing may use, in every decision request
 * it makes: the pipeline's own, the strategy selector's and the referent
 * strategy's (docs/build/dependency-decisioning.md · "The token budget").
 *
 * - `absolute`: a fixed number of tokens.
 * - `relative`: `fraction` of the tokens recorded in the conversation's log
 *   (every user message and the text of every attempt, superseded, failed,
 *   stopped and interrupted ones included; one token per four characters),
 *   never below `floor`, so a new conversation is not starved, and never
 *   above `ceiling`, so a huge one is not unbounded.
 *
 * The price guard (`DecisionCostGuard`) applies as well: a routing may use
 * the smaller of the two.
 */
export type DecisionTokenBudget =
  | { readonly mode: 'absolute'; /** Whole number ≥ 0. */ readonly inputTokens: number }
  | {
      readonly mode: 'relative'
      /** Decision tokens per token of the conversation's log. Greater than 0; above 1 it is a multiple. */
      readonly fraction: number
      /** Whole number ≥ 0. */
      readonly floor: number
      /** Whole number ≥ `floor`. */
      readonly ceiling: number
    }

/** Characters per token where text is sized without a tokenizer: the conversation's log, and an answer's expected length. */
export const CHARACTERS_PER_TOKEN = 4

/** The size in tokens of text of `characters` characters, as the token budget and the price guard count it. */
export function textTokens(characters: number): number {
  return Math.ceil(Math.max(0, characters) / CHARACTERS_PER_TOKEN)
}

export const TOKEN_BUDGET_MODES: readonly DecisionTokenBudget['mode'][] = ['relative', 'absolute']

/** The tokens a budget allows a routing in a conversation whose log holds `sessionLogTokens`. */
export function resolveTokenBudget(budget: DecisionTokenBudget, sessionLogTokens: number): number {
  if (budget.mode === 'absolute') return budget.inputTokens
  return Math.min(budget.ceiling, Math.max(budget.floor, Math.floor(budget.fraction * Math.max(0, sessionLogTokens))))
}

/**
 * How the tree walk treats a run of only children: the answers of one line
 * of work between two places where it splits. Read by the `tree-walk`
 * strategy only (docs/build/dependency-decisioning.md · "Long runs").
 */
export interface TreeWalkSettings {
  /**
   * Start at the trunk base. The trunk of a root is the run from the root
   * down to the first answer where the line splits, or to its last answer
   * when it never splits. On: only the base is asked about by itself; the
   * answers above it are searched (asked about in chunks, and one by one
   * only inside a chunk that is relevant). Off: they are asked about one by
   * one, unless the run is longer than `searchRunsOverTokens`.
   */
  readonly startAtTrunkBase: boolean
  /**
   * Hop between branch points. Below a branch point, on: of each branch's
   * run only its end (the next branch point, or the leaf) is asked about by
   * itself and the answers skipped are searched. Off: every answer of the
   * run is asked about, unless the run is longer than `searchRunsOverTokens`.
   */
  readonly hopBetweenBranchPoints: boolean
  /**
   * The size above which a run is searched whatever the two switches say,
   * and the size of a chunk small enough to ask about answer by answer:
   * the estimated input tokens of listing the answers one by one (about
   * 125 for a full-length answer). Whole number ≥ 1.
   */
  readonly searchRunsOverTokens: number
}

/**
 * The price guard on decision work: what routing one message may cost in
 * decision requests, as a multiple of what answering it costs. The
 * allowance is `maxAnswerCostRatio` × the price of one answer run per piece
 * of work routed (its least input, the message itself, and its expected
 * output), converted to decision input tokens. A routing may use the
 * smaller of this and `tokenBudget`: the pipeline's own request lists fewer
 * answers to fit, and what is left is what a referent strategy may add,
 * within `referentBudget`. Prices are US dollars per million tokens and
 * default to the cheapest answer model offered, so the bound holds on any
 * dearer one (docs/build/dependency-decisioning.md · "The guard").
 */
export interface DecisionCostGuard {
  /** Decision cost of one routing ÷ cost of the answer it routes, at most. 0 turns the price guard off. */
  readonly maxAnswerCostRatio: number
  readonly answerInputPrice: number
  readonly answerOutputPrice: number
  readonly decisionInputPrice: number
  /**
   * Output tokens an answer is expected to have when the conversation has
   * too few completed answers to go by. With five or more, the median
   * length of its completed answers is used.
   */
  readonly expectedOutputTokens: number
}

/**
 * Whether a strategy selector chooses the referent strategy, and the tree
 * walk's switches, for each routing from the shape of the conversation's
 * genealogy (docs/build/dependency-decisioning.md · "Strategy selection").
 * - `off`: the strategy and switches set here are used as they are.
 * - `rules` (the default): deterministic rules over the shape. No request.
 * - `decision-model`: one small decision request about the shape, reused
 *   while the shape does not change materially; the rules when it fails, is
 *   not confident, or does not fit the routing's token budget.
 */
export type StrategySelectionMode = 'off' | 'rules' | 'decision-model'

export const STRATEGY_SELECTION_MODES: readonly StrategySelectionMode[] = ['off', 'rules', 'decision-model']

export interface RoutingSettings {
  readonly referentStrategy: ReferentStrategyName
  readonly strategySelection: StrategySelectionMode
  readonly referentBudget: DecisionCaps
  readonly tokenBudget: DecisionTokenBudget
  readonly treeWalk: TreeWalkSettings
  readonly costGuard: DecisionCostGuard
  /**
   * Whether a referent strategy is shown a stored summary of a section's
   * context, and the content specific to the section, in place of the
   * section's usual line, where a summary is available
   * (docs/build/context-summaries.md). Decisions only: a run's context is
   * never a summary. No summaries are produced yet, so this changes nothing.
   */
  readonly useSummaryIfAvailable: boolean
  /**
   * Whether the backend offers finished work to the context summariser in
   * the background. The only summariser so far produces nothing.
   */
  readonly backgroundSummaries: boolean
}

/** Views behind debug toggles (Q87, Q94). Margin rails, Focus and the split link are always on and have no toggle. */
export interface DebugToggles {
  readonly miniMap: boolean
  readonly operationGraph: boolean
  readonly runInspector: boolean
  /** Compare for an independent composite. Compare for split messages is always available. */
  readonly compareIndependent: boolean
  /**
   * Where Compare is shown: in the debug side panel, or as a card on the
   * decomposed message in the transcript (10 · "User settings").
   */
  readonly comparePlacement: ComparePlacement
}

export type ComparePlacement = 'sidebar' | 'inline'

export const COMPARE_PLACEMENTS: readonly ComparePlacement[] = ['sidebar', 'inline']

/** The debug toggles that switch a view on or off; `comparePlacement` is a choice, not a toggle. */
export type DebugViewToggle = { [K in keyof DebugToggles]: DebugToggles[K] extends boolean ? K : never }[keyof DebugToggles]

export interface Settings {
  readonly retryPolicy: RetryPolicy
  /** Wait before a choice with default is carried out, in milliseconds (Q45). */
  readonly defaultChoiceWaitMs: number
  /** Answer and synthesis runs in flight at once, per provider (Q60). Integer ≥ 1. */
  readonly concurrencyLimit: number
  readonly models: ModelSettings
  readonly thresholds: DecisionThresholds
  readonly routing: RoutingSettings
  readonly debug: DebugToggles
}

/** The relative token budget a routing gets unless the user chose another. */
export const DEFAULT_RELATIVE_TOKEN_BUDGET: Extract<DecisionTokenBudget, { mode: 'relative' }> = { mode: 'relative', fraction: 0.02, floor: 16_000, ceiling: 40_000 }
/** The absolute token budget offered when the user switches to a fixed one: the relative budget's floor. */
export const DEFAULT_ABSOLUTE_TOKEN_BUDGET: Extract<DecisionTokenBudget, { mode: 'absolute' }> = { mode: 'absolute', inputTokens: 16_000 }

export const DEFAULT_SETTINGS: Settings = {
  retryPolicy: 'standard',
  defaultChoiceWaitMs: 30_000,
  concurrencyLimit: 4,
  models: {
    answer: 'anthropic/claude-sonnet-5.5',
    decomposition: 'anthropic/claude-haiku-5.5',
    synthesis: 'anthropic/claude-sonnet-5.5',
    // Pinned to a versioned model, never a moving alias (Q74).
    decision: 'typesafe/jev-1.13',
  },
  thresholds: {
    targetChoice: 0.7,
    clearlyCorrective: 0.8,
    composite: 0.65,
    dependency: 0.6,
    clarification: 0.75,
  },
  routing: {
    // Chosen on the routing corpus and on cost (docs/build/dependency-decisioning.md).
    referentStrategy: 'tree-walk',
    // Rules: on the corpus they match the configured tree walk's score at fewer requests, and the decision model does
    // not beat them (docs/build/dependency-decisioning.md · "Strategy selection"). `off` uses the strategy set above as it is.
    strategySelection: 'rules',
    referentBudget: { requests: 4, questions: 96 },
    // 2% of the conversation's log, at least what the pipeline's request and a search of a long run cost (16,000) and
    // at most what twice a 1,700-token answer on the cheapest answer model buys (40,000): the budget grows with what
    // there is to search. Evidence in docs/build/dependency-decisioning.md · "The token budget".
    tokenBudget: DEFAULT_RELATIVE_TOKEN_BUDGET,
    // Both switches cost a further request whenever a skipped answer is referred to and save little inside the
    // pipeline's window; a long run is searched anyway. Measured in docs/build/dependency-decisioning.md.
    treeWalk: { startAtTrunkBase: false, hopBetweenBranchPoints: false, searchRunsOverTokens: 1_500 },
    // Twice an answer priced on the cheapest answer model (0.10 in, 0.50 out per million); decisions cost 0.042 per
    // million input. 1,700 output tokens is the shortest of the answer runs measured live.
    costGuard: { maxAnswerCostRatio: 2, answerInputPrice: 0.1, answerOutputPrice: 0.5, decisionInputPrice: 0.042, expectedOutputTokens: 1_700 },
    useSummaryIfAvailable: false,
    backgroundSummaries: false,
  },
  debug: {
    miniMap: false,
    operationGraph: false,
    runInspector: false,
    compareIndependent: false,
    comparePlacement: 'sidebar',
  },
}

/** A partial change to the settings. Nested groups are merged key by key. */
export interface SettingsPatch {
  readonly retryPolicy?: RetryPolicy
  readonly defaultChoiceWaitMs?: number
  readonly concurrencyLimit?: number
  readonly models?: Partial<ModelSettings>
  readonly thresholds?: Partial<DecisionThresholds>
  readonly routing?: {
    readonly referentStrategy?: ReferentStrategyName
    readonly strategySelection?: StrategySelectionMode
    readonly referentBudget?: Partial<DecisionCaps>
    /** Replaced as a whole: the two modes share no field. */
    readonly tokenBudget?: DecisionTokenBudget
    readonly treeWalk?: Partial<TreeWalkSettings>
    readonly costGuard?: Partial<DecisionCostGuard>
    readonly useSummaryIfAvailable?: boolean
    readonly backgroundSummaries?: boolean
  }
  readonly debug?: Partial<DebugToggles>
}

/** Applies a patch. Pure; returns the same object when nothing changes. */
export function applySettingsPatch(settings: Settings, patch: SettingsPatch): Settings {
  const next: Settings = {
    retryPolicy: patch.retryPolicy ?? settings.retryPolicy,
    defaultChoiceWaitMs: patch.defaultChoiceWaitMs ?? settings.defaultChoiceWaitMs,
    concurrencyLimit: patch.concurrencyLimit ?? settings.concurrencyLimit,
    models: { ...settings.models, ...definedOnly(patch.models) },
    thresholds: { ...settings.thresholds, ...definedOnly(patch.thresholds) },
    routing: {
      referentStrategy: patch.routing?.referentStrategy ?? settings.routing.referentStrategy,
      strategySelection: patch.routing?.strategySelection ?? settings.routing.strategySelection,
      referentBudget: { ...settings.routing.referentBudget, ...definedOnly(patch.routing?.referentBudget) },
      tokenBudget: patch.routing?.tokenBudget ?? settings.routing.tokenBudget,
      treeWalk: { ...settings.routing.treeWalk, ...definedOnly(patch.routing?.treeWalk) },
      costGuard: { ...settings.routing.costGuard, ...definedOnly(patch.routing?.costGuard) },
      useSummaryIfAvailable: patch.routing?.useSummaryIfAvailable ?? settings.routing.useSummaryIfAvailable,
      backgroundSummaries: patch.routing?.backgroundSummaries ?? settings.routing.backgroundSummaries,
    },
    debug: { ...settings.debug, ...definedOnly(patch.debug) },
  }
  return JSON.stringify(next) === JSON.stringify(settings) ? settings : next
}

/** Returns a message for the first invalid value in a patch, or null when it is acceptable. */
export function validateSettingsPatch(patch: SettingsPatch): string | null {
  if (patch.concurrencyLimit !== undefined) {
    if (!Number.isInteger(patch.concurrencyLimit) || patch.concurrencyLimit < 1) {
      return 'Concurrency limit must be a whole number of at least 1'
    }
  }
  if (patch.defaultChoiceWaitMs !== undefined) {
    if (!Number.isFinite(patch.defaultChoiceWaitMs) || patch.defaultChoiceWaitMs < 0) {
      return 'Wait before a default choice runs cannot be negative'
    }
  }
  for (const [name, value] of Object.entries(patch.thresholds ?? {})) {
    if (typeof value === 'number' && (!(value >= 0) || value > 1)) {
      return `Threshold "${name}" must be between 0 and 1`
    }
  }
  if (patch.routing?.referentStrategy !== undefined && !REFERENT_STRATEGY_NAMES.includes(patch.routing.referentStrategy)) {
    return `Unknown referent strategy "${String(patch.routing.referentStrategy)}"`
  }
  if (patch.routing?.strategySelection !== undefined && !STRATEGY_SELECTION_MODES.includes(patch.routing.strategySelection)) {
    return `Unknown strategy selection "${String(patch.routing.strategySelection)}"`
  }
  for (const [name, value] of Object.entries(patch.routing?.referentBudget ?? {})) {
    if (typeof value === 'number' && (!Number.isInteger(value) || value < 0)) {
      return `Decision budget "${name}" must be a whole number of at least 0`
    }
  }
  const tokenBudget = patch.routing?.tokenBudget
  if (tokenBudget !== undefined) {
    const whole = (value: unknown): boolean => typeof value === 'number' && Number.isInteger(value) && value >= 0
    if (tokenBudget.mode === 'absolute') {
      if (!whole(tokenBudget.inputTokens)) return 'The decision token budget must be a whole number of at least 0'
    } else if (tokenBudget.mode === 'relative') {
      if (!(typeof tokenBudget.fraction === 'number' && Number.isFinite(tokenBudget.fraction) && tokenBudget.fraction > 0)) {
        return 'The decision token budget\'s share of the conversation must be greater than 0'
      }
      if (!whole(tokenBudget.floor) || !whole(tokenBudget.ceiling)) return 'The decision token budget\'s floor and ceiling must be whole numbers of at least 0'
      if (tokenBudget.ceiling < tokenBudget.floor) return 'The decision token budget\'s ceiling cannot be below its floor'
    } else {
      return `Unknown decision token budget mode "${String((tokenBudget as { mode?: unknown }).mode)}"`
    }
  }
  const searchOver = patch.routing?.treeWalk?.searchRunsOverTokens
  if (searchOver !== undefined && (!Number.isInteger(searchOver) || searchOver < 1)) {
    return 'The run size above which the tree walk searches must be a whole number of at least 1'
  }
  for (const [name, value] of Object.entries(patch.routing?.costGuard ?? {})) {
    if (typeof value === 'number' && !(value >= 0 && Number.isFinite(value))) return `Decision cost guard "${name}" cannot be negative`
  }
  if (patch.debug?.comparePlacement !== undefined && !COMPARE_PLACEMENTS.includes(patch.debug.comparePlacement)) {
    return `Unknown Compare placement "${String(patch.debug.comparePlacement)}"`
  }
  for (const [role, model] of Object.entries(patch.models ?? {})) {
    if (typeof model === 'string' && model.trim() === '') return `Model for "${role}" cannot be empty`
  }
  return null
}

/**
 * Settings as stored by an earlier version, completed with the defaults of
 * every group it does not have yet.
 */
export function normalizeSettings(stored: Partial<Settings>): Settings {
  const caps = stored.routing?.referentBudget as (Partial<DecisionCaps> & { readonly inputTokens?: unknown }) | undefined
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    models: { ...DEFAULT_SETTINGS.models, ...stored.models },
    thresholds: { ...DEFAULT_SETTINGS.thresholds, ...stored.thresholds },
    routing: {
      referentStrategy: stored.routing?.referentStrategy ?? DEFAULT_SETTINGS.routing.referentStrategy,
      strategySelection: STRATEGY_SELECTION_MODES.find((mode) => mode === stored.routing?.strategySelection) ?? DEFAULT_SETTINGS.routing.strategySelection,
      referentBudget: {
        requests: caps?.requests ?? DEFAULT_SETTINGS.routing.referentBudget.requests,
        questions: caps?.questions ?? DEFAULT_SETTINGS.routing.referentBudget.questions,
      },
      tokenBudget: normalizeTokenBudget(stored.routing?.tokenBudget, caps?.inputTokens),
      treeWalk: { ...DEFAULT_SETTINGS.routing.treeWalk, ...stored.routing?.treeWalk },
      costGuard: { ...DEFAULT_SETTINGS.routing.costGuard, ...stored.routing?.costGuard },
      useSummaryIfAvailable: stored.routing?.useSummaryIfAvailable ?? DEFAULT_SETTINGS.routing.useSummaryIfAvailable,
      backgroundSummaries: stored.routing?.backgroundSummaries ?? DEFAULT_SETTINGS.routing.backgroundSummaries,
    },
    debug: {
      ...DEFAULT_SETTINGS.debug,
      ...stored.debug,
      comparePlacement: COMPARE_PLACEMENTS.find((placement) => placement === stored.debug?.comparePlacement) ?? DEFAULT_SETTINGS.debug.comparePlacement,
    },
  }
}

/** What `referentBudget.inputTokens` was before the token budget became a setting of its own. */
export const LEGACY_REFERENT_INPUT_TOKENS = 12_000

/**
 * The stored token budget, or the one an earlier version stored as
 * `referentBudget.inputTokens`. Settings are stored whole, so the earlier
 * default (12,000) was never a choice and becomes the current default; any
 * other value was set by the user and is kept as an absolute budget.
 */
function normalizeTokenBudget(stored: DecisionTokenBudget | undefined, legacyInputTokens: unknown): DecisionTokenBudget {
  if (stored?.mode === 'absolute' && Number.isInteger(stored.inputTokens) && stored.inputTokens >= 0) return { mode: 'absolute', inputTokens: stored.inputTokens }
  if (stored?.mode === 'relative') {
    const fallback = DEFAULT_RELATIVE_TOKEN_BUDGET
    const fraction = Number.isFinite(stored.fraction) && stored.fraction > 0 ? stored.fraction : fallback.fraction
    const floor = Number.isInteger(stored.floor) && stored.floor >= 0 ? stored.floor : fallback.floor
    const ceiling = Number.isInteger(stored.ceiling) && stored.ceiling >= floor ? stored.ceiling : Math.max(floor, fallback.ceiling)
    return { mode: 'relative', fraction, floor, ceiling }
  }
  if (typeof legacyInputTokens === 'number' && Number.isInteger(legacyInputTokens) && legacyInputTokens >= 0 && legacyInputTokens !== LEGACY_REFERENT_INPUT_TOKENS) {
    return { mode: 'absolute', inputTokens: legacyInputTokens }
  }
  return DEFAULT_SETTINGS.routing.tokenBudget
}

function definedOnly<T extends object>(value: T | undefined): Partial<T> {
  const out: Partial<T> = {}
  if (!value) return out
  for (const key of Object.keys(value) as (keyof T)[]) {
    if (value[key] !== undefined) out[key] = value[key]
  }
  return out
}

/** Settings show only whether a key is configured (Q64). */
export interface KeyStatus {
  readonly configured: boolean
}

/**
 * Automatic retry behaviour per policy (Q47, Q54). 429 waits and interruption
 * recoveries count against the same limit. Delays are exact (no jitter) so
 * tests with a fake clock are deterministic.
 */
export interface RetryPolicyParameters {
  /** Automatic retries per section before the directive is marked failed. */
  readonly maxAutomaticRetries: number
  /** Backoff before automatic retry n (1-based); the last entry repeats. */
  readonly backoffMs: readonly number[]
  /**
   * Longest single wait accepted from `Retry-After`. A longer one fails the
   * directive instead of waiting.
   */
  readonly maxRetryAfterMs: number
  /** Wait used for 429 and 503 when the provider sends no `Retry-After`. */
  readonly defaultRetryAfterMs: number
}

export const RETRY_POLICIES: { readonly [P in RetryPolicy]: RetryPolicyParameters } = {
  standard: {
    maxAutomaticRetries: 3,
    backoffMs: [1_000, 2_000, 4_000],
    maxRetryAfterMs: 60_000,
    defaultRetryAfterMs: 5_000,
  },
  persistent: {
    maxAutomaticRetries: 8,
    backoffMs: [1_000, 2_000, 4_000, 8_000, 16_000, 30_000],
    maxRetryAfterMs: 600_000,
    defaultRetryAfterMs: 5_000,
  },
  manual: {
    maxAutomaticRetries: 0,
    backoffMs: [],
    maxRetryAfterMs: 0,
    defaultRetryAfterMs: 0,
  },
}

/** The user is warned when a run's input reaches this share of the model's context limit (Q67, Q82). */
export const CONTEXT_WARNING_RATIO = 0.8

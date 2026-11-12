import { MODEL_PROVIDER_NAMES, PROVIDER_SELECTABLE_ROLES, type ModelProviderName, type ModelRole, type ProviderSelectableRole } from './model'
import { LISTED_MODEL_ROLES, claudeApiCounterpart, compatibleModels, isCompatibleModel, isListedModelRole } from './models'

/**
 * User settings (10 · "User settings"). App-wide: retry policy, models and
 * the key apply to every conversation (Q70). Persisted as `settings-changed`
 * events in the app log. The OpenRouter key is not a setting value: it lives
 * in the secrets store and only its presence is ever reported (Q64, Q73).
 */

/** Q47. */
export type RetryPolicy = 'standard' | 'persistent' | 'manual'

/** Model IDs, one per role (Q65), as the role's provider names them. */
export type ModelSettings = { readonly [R in ModelRole]: string }

/**
 * The provider each role's model is reached through. Every role has the
 * field; `decision` is always `openrouter` (the Claude API has no Decisions
 * endpoint), which `validateSettingsPatch` and `normalizeSettings` enforce.
 */
export type ModelProviderSettings = { readonly [R in ModelRole]: ModelProviderName }

/**
 * Whether the user has chosen a provider for each role that has a choice.
 * Set by the backend when a `change-settings` names the role's provider;
 * never by a client directly, and never by the backend's own provider moves
 * (the Claude API default and the fallback when the Anthropic key goes).
 */
export type ProviderChoices = { readonly [R in ProviderSelectableRole]: boolean }

/**
 * The model a role gets when its provider is chosen: OpenRouter IDs for
 * OpenRouter, Claude API IDs for Anthropic. Decisions have no Anthropic
 * default.
 */
export const PROVIDER_DEFAULT_MODELS: {
  readonly openrouter: ModelSettings
  readonly anthropic: { readonly [R in ProviderSelectableRole]: string }
} = {
  openrouter: {
    answer: 'anthropic/claude-sonnet-5.5',
    decomposition: 'anthropic/claude-haiku-5.5',
    synthesis: 'anthropic/claude-sonnet-5.5',
    // Pinned to a versioned model, never a moving alias (Q74).
    decision: 'typesafe/jev-1.13',
  },
  anthropic: {
    answer: 'claude-sonnet-5-5',
    decomposition: 'claude-haiku-5-5',
    synthesis: 'claude-sonnet-5-5',
  },
}

/** The patch that moves `role` to `provider` with that provider's default model. */
export function providerChoicePatch(role: ProviderSelectableRole, provider: ModelProviderName): SettingsPatch {
  return { modelProviders: { [role]: provider }, models: { [role]: PROVIDER_DEFAULT_MODELS[provider][role] } }
}

/**
 * The patch that moves to the Claude API every role whose provider the user
 * has not chosen, that is on OpenRouter, and whose OpenRouter model has a
 * Claude API counterpart on the compatibility list; the model stays the
 * same model. Applied whenever an Anthropic key is configured (at start and
 * when the key is added), so the Claude API is the default for those roles
 * while the key is there. Null when no role qualifies.
 */
export function claudeApiDefaultPatch(settings: Pick<Settings, 'modelProviders' | 'models' | 'providerChosen'>): SettingsPatch | null {
  const modelProviders: { [R in ProviderSelectableRole]?: ModelProviderName } = {}
  const models: { [R in ProviderSelectableRole]?: string } = {}
  let any = false
  for (const role of PROVIDER_SELECTABLE_ROLES) {
    if (settings.providerChosen[role] || settings.modelProviders[role] !== 'openrouter') continue
    const counterpart = claudeApiCounterpart(settings.models[role])
    if (counterpart === null || !counterpart.roles.includes(role)) continue
    modelProviders[role] = 'anthropic'
    models[role] = counterpart.id
    any = true
  }
  return any ? { modelProviders, models } : null
}

/** `settings` with every role whose provider `patch` names marked as chosen by the user. */
export function markProviderChoices(settings: Settings, patch: SettingsPatch): Settings {
  const named = PROVIDER_SELECTABLE_ROLES.filter((role) => patch.modelProviders?.[role] !== undefined && !settings.providerChosen[role])
  if (named.length === 0) return settings
  const providerChosen = { ...settings.providerChosen }
  for (const role of named) providerChosen[role] = true
  return { ...settings, providerChosen }
}

/** The roles whose runs go to the Claude API under these settings. */
export function rolesOnAnthropic(settings: Pick<Settings, 'modelProviders'>): readonly ProviderSelectableRole[] {
  return PROVIDER_SELECTABLE_ROLES.filter((role) => settings.modelProviders[role] === 'anthropic')
}

/**
 * The patch that returns every role on the Claude API to OpenRouter and its
 * default model there, applied when the Anthropic key is removed. Null when
 * no role uses the Claude API.
 */
export function anthropicFallbackPatch(settings: Pick<Settings, 'modelProviders'>): SettingsPatch | null {
  const roles = rolesOnAnthropic(settings)
  if (roles.length === 0) return null
  const modelProviders: { [R in ProviderSelectableRole]?: ModelProviderName } = {}
  const models: { [R in ProviderSelectableRole]?: string } = {}
  for (const role of roles) {
    modelProviders[role] = 'openrouter'
    models[role] = PROVIDER_DEFAULT_MODELS.openrouter[role]
  }
  return { modelProviders, models }
}

/**
 * Decision confidence thresholds (Q74). The defaults are tuned on the
 * routing corpus against the pinned decision model (docs/build/PLAN.md
 * section 7, "Threshold tuning"). All are probabilities in [0, 1].
 */
export interface DecisionThresholds {
  /** Below this confidence for the best target, Pluribus elicits the target instead of inferring it (Q20). */
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
 * The strategies sit behind one
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
 * strategy's.
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
 * How the tree walk treats an unbranched run: the answers of one line of
 * work between two places where it splits. Read by the `tree-walk`
 * strategy only.
 */
export interface TreeWalkSettings {
  /**
   * Start at the trunk base. The trunk of a root is the run from the root
   * down to the first answer where the line splits, or to its last answer
   * when it never splits. On: only the base is asked about by itself at
   * once; the answers above it are searched for the last relevant one
   * (asked about in parts, and one by one only inside the latest part that
   * is relevant), however few they are. Off: they are asked about one by
   * one, unless the run is longer than `searchRunsOverTokens`.
   */
  readonly startAtTrunkBase: boolean
  /**
   * Hop between branch points. On: the walk does not look for the last
   * relevant answer inside a run. A unit that refers to a run, and to
   * nothing built on it, is placed on the run's last answer (or the deepest
   * one a run's context allows), which was not asked about by itself: its
   * context holds the whole run. The answers of the run that were not asked
   * about yet are asked about in parts only, to learn whether the run is
   * relevant. Fewer decision tokens; the answer then reads everything after
   * the relevant part of the run. A correction keeps the search: it needs
   * the exact answer it revises. Off: the last relevant answer of a run is
   * searched for. It is the user's setting: a strategy selector does not
   * choose it.
   */
  readonly hopBetweenBranchPoints: boolean
  /**
   * The size above which a run is searched whatever the two switches say,
   * and the size of a part small enough to ask about answer by answer:
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
 * dearer one.
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
 * genealogy.
 * - `off`: the strategy and switches set here are used as they are.
 * - `rules` (the default): deterministic rules over the shape. No request.
 * - `decision-model`: one small decision request about the shape, reused
 *   while the shape does not change materially; the rules when it fails, is
 *   not confident, or does not fit the routing's token budget.
 */
export type StrategySelectionMode = 'off' | 'rules' | 'decision-model'

export const STRATEGY_SELECTION_MODES: readonly StrategySelectionMode[] = ['off', 'rules', 'decision-model']

/**
 * Where a tree walk gets candidate sections from: places to start besides
 * the roots.
 * A candidate is a seed hint for the search and never a referent: it is
 * asked about by itself like any other section.
 * - `none`: no source. The walk starts at the roots.
 * - `lexical`: a word index over the conversation's answer sections, in the
 *   backend. It costs no decision tokens itself; each candidate may add
 *   questions to a walk, within the decision budget.
 */
export type CandidateSourceName = 'none' | 'lexical'

export const CANDIDATE_SOURCE_NAMES: readonly CandidateSourceName[] = ['none', 'lexical']

/**
 * Ordered-message decomposition (02 · "Messages and decomposition", Q104): a
 * decomposer option for a message that asks for its outputs in an explicit
 * order ("…, but put the translation first").
 * - `decompose` (the default): it is decomposed like any composite, and the
 *   output order and the whole-request barrier apply (D3).
 * - `atomic`: it is one request, answered by one directive; no barrier.
 * A combined total output limit keeps a message atomic whatever this says (Q102).
 */
export type OrderedMessageHandling = 'decompose' | 'atomic'

export const ORDERED_MESSAGE_HANDLINGS: readonly OrderedMessageHandling[] = ['decompose', 'atomic']

export interface RoutingSettings {
  readonly referentStrategy: ReferentStrategyName
  readonly strategySelection: StrategySelectionMode
  readonly candidateSource: CandidateSourceName
  /** Whether a message with an explicit output order is decomposed or kept atomic (Q104). */
  readonly orderedMessages: OrderedMessageHandling
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
  /** Answer and synthesis runs in flight at once, app-wide: one pool for every conversation (Q60, Q100). Integer ≥ 1. */
  readonly concurrencyLimit: number
  readonly models: ModelSettings
  readonly modelProviders: ModelProviderSettings
  readonly providerChosen: ProviderChoices
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
  models: PROVIDER_DEFAULT_MODELS.openrouter,
  // Everything on OpenRouter until an Anthropic key is configured; then the roles whose provider the user has not
  // chosen move to the Claude API (`claudeApiDefaultPatch`).
  modelProviders: { answer: 'openrouter', decomposition: 'openrouter', synthesis: 'openrouter', decision: 'openrouter' },
  providerChosen: { answer: false, decomposition: false, synthesis: false },
  thresholds: {
    targetChoice: 0.7,
    clearlyCorrective: 0.8,
    composite: 0.65,
    dependency: 0.6,
    clarification: 0.75,
  },
  routing: {
    // Chosen on the routing corpus and on cost.
    referentStrategy: 'tree-walk',
    // Rules: on the corpus they match the configured tree walk's score at fewer requests, and the decision model does
    // not beat them. `off` uses the strategy set above as it is.
    strategySelection: 'rules',
    // Seed hints for the tree walk from a word index over the answer sections. Live on the corpus the configured tree
    // walk routes two more examples with it and the default, by rules, the same number, for fewer decision tokens.
    // `none` starts the walk at the roots alone.
    candidateSource: 'lexical',
    // Today's behaviour: an ordered message is split, and the barrier keeps its outputs in the order asked for (D3).
    orderedMessages: 'decompose',
    referentBudget: { requests: 4, questions: 96 },
    // 2% of the conversation's log, at least what the pipeline's request and a search of a long run cost (16,000) and
    // at most what twice a 1,700-token answer on the cheapest answer model buys (40,000): the budget grows with what
    // there is to search.
    tokenBudget: DEFAULT_RELATIVE_TOKEN_BUDGET,
    // Both switches cost a further request whenever a skipped answer is referred to and save little inside the
    // pipeline's window; a long run is searched anyway.
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
  readonly modelProviders?: Partial<ModelProviderSettings>
  readonly thresholds?: Partial<DecisionThresholds>
  readonly routing?: {
    readonly referentStrategy?: ReferentStrategyName
    readonly strategySelection?: StrategySelectionMode
    readonly candidateSource?: CandidateSourceName
    readonly orderedMessages?: OrderedMessageHandling
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
    modelProviders: { ...settings.modelProviders, ...definedOnly(patch.modelProviders) },
    providerChosen: settings.providerChosen,
    thresholds: { ...settings.thresholds, ...definedOnly(patch.thresholds) },
    routing: {
      referentStrategy: patch.routing?.referentStrategy ?? settings.routing.referentStrategy,
      strategySelection: patch.routing?.strategySelection ?? settings.routing.strategySelection,
      candidateSource: patch.routing?.candidateSource ?? settings.routing.candidateSource,
      orderedMessages: patch.routing?.orderedMessages ?? settings.routing.orderedMessages,
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

/**
 * A patch with the model filled in for every role whose provider it changes
 * without naming a model: that provider's default for the role. So a client
 * can send the provider alone, and a role is never left with one provider's
 * model ID on the other.
 */
export function completeSettingsPatch(settings: Pick<Settings, 'modelProviders'>, patch: SettingsPatch): SettingsPatch {
  const models: { [R in ModelRole]?: string } = { ...definedOnly(patch.models) }
  let filled = false
  for (const role of PROVIDER_SELECTABLE_ROLES) {
    const provider = patch.modelProviders?.[role]
    if (provider === undefined || provider === settings.modelProviders[role] || models[role] !== undefined) continue
    if (!MODEL_PROVIDER_NAMES.includes(provider)) continue
    models[role] = PROVIDER_DEFAULT_MODELS[provider][role]
    filled = true
  }
  return filled ? { ...patch, models } : patch
}

/**
 * Returns a message for the first invalid value in a patch, or null when it
 * is acceptable. `current` is the settings the patch applies to: with it, a
 * model is checked against the list of the provider its role will have.
 */
export function validateSettingsPatch(patch: SettingsPatch, current?: Pick<Settings, 'modelProviders' | 'models'>): string | null {
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
  if (patch.routing?.candidateSource !== undefined && !CANDIDATE_SOURCE_NAMES.includes(patch.routing.candidateSource)) {
    return `Unknown candidate source "${String(patch.routing.candidateSource)}"`
  }
  if (patch.routing?.orderedMessages !== undefined && !ORDERED_MESSAGE_HANDLINGS.includes(patch.routing.orderedMessages)) {
    return `Unknown ordered-message handling "${String(patch.routing.orderedMessages)}"`
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
  for (const [role, provider] of Object.entries(patch.modelProviders ?? {})) {
    if (provider === undefined) continue
    if (!MODEL_PROVIDER_NAMES.includes(provider)) return `Unknown model provider "${String(provider)}"`
    if (role === 'decision' && provider !== 'openrouter') return 'Decisions run on OpenRouter only'
  }
  for (const [role, model] of Object.entries(patch.models ?? {})) {
    if (typeof model === 'string' && model.trim() === '') return `Model for "${role}" cannot be empty`
  }
  // MVP answer, decomposition and synthesis choices come from the tested compatibility list of the role's provider (Q107).
  for (const role of LISTED_MODEL_ROLES) {
    const provider = patch.modelProviders?.[role] ?? current?.modelProviders[role] ?? 'openrouter'
    const model = patch.models?.[role] ?? (patch.modelProviders?.[role] !== undefined ? current?.models[role] : undefined)
    if (typeof model === 'string' && isListedModelRole(role) && !isCompatibleModel(role, model, provider)) {
      return `Model for "${role}" must be one of the tested models: ${compatibleModels(role, provider).map((m) => m.id).join(', ')}`
    }
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
    modelProviders: normalizeModelProviders(stored.modelProviders),
    models: normalizeModels({ ...DEFAULT_SETTINGS.models, ...stored.models }, normalizeModelProviders(stored.modelProviders)),
    providerChosen: normalizeProviderChoices(stored.providerChosen),
    thresholds: { ...DEFAULT_SETTINGS.thresholds, ...stored.thresholds },
    routing: {
      referentStrategy: stored.routing?.referentStrategy ?? DEFAULT_SETTINGS.routing.referentStrategy,
      strategySelection: STRATEGY_SELECTION_MODES.find((mode) => mode === stored.routing?.strategySelection) ?? DEFAULT_SETTINGS.routing.strategySelection,
      candidateSource: CANDIDATE_SOURCE_NAMES.find((name) => name === stored.routing?.candidateSource) ?? DEFAULT_SETTINGS.routing.candidateSource,
      orderedMessages: ORDERED_MESSAGE_HANDLINGS.find((handling) => handling === stored.routing?.orderedMessages) ?? DEFAULT_SETTINGS.routing.orderedMessages,
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

/**
 * Stored models, with an answer, decomposition or synthesis model that is
 * not on the tested compatibility list of the role's provider replaced by
 * that provider's default for the role (Q107). The decision model is kept
 * as stored.
 */
export function normalizeModels(models: ModelSettings, providers: ModelProviderSettings = DEFAULT_SETTINGS.modelProviders): ModelSettings {
  let next = models
  for (const role of LISTED_MODEL_ROLES) {
    if (!isCompatibleModel(role, next[role], providers[role])) next = { ...next, [role]: PROVIDER_DEFAULT_MODELS[providers[role]][role] }
  }
  return next
}

/** Stored providers, with OpenRouter for every role an earlier version did not store one for, and for decisions always. */
function normalizeModelProviders(stored: Partial<ModelProviderSettings> | undefined): ModelProviderSettings {
  const of = (role: ProviderSelectableRole): ModelProviderName => MODEL_PROVIDER_NAMES.find((name) => name === stored?.[role]) ?? 'openrouter'
  return { answer: of('answer'), decomposition: of('decomposition'), synthesis: of('synthesis'), decision: 'openrouter' }
}

/** Stored provider choices; a role an earlier version stored nothing for has not been chosen. */
function normalizeProviderChoices(stored: Partial<ProviderChoices> | undefined): ProviderChoices {
  const of = (role: ProviderSelectableRole): boolean => stored?.[role] === true
  return { answer: of('answer'), decomposition: of('decomposition'), synthesis: of('synthesis') }
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

/** Settings show only whether a key is configured (Q64). One per provider: the OpenRouter key, and the optional Anthropic key. */
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

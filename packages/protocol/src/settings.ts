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
 *   level. Long runs of only
 *   children are searched (`treeWalk`).
 */
export type ReferentStrategyName = 'one-pass' | 'tree-walk'

export const REFERENT_STRATEGY_NAMES: readonly ReferentStrategyName[] = ['one-pass', 'tree-walk']

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
   * searched for.
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

export interface RoutingSettings {
  readonly referentStrategy: ReferentStrategyName
  readonly treeWalk: TreeWalkSettings
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
    // Chosen on the routing corpus and on cost.
    referentStrategy: 'tree-walk',
    // Both switches cost a further request whenever a skipped answer is referred to and save little inside the
    // pipeline's window; a long run is searched anyway.
    treeWalk: { startAtTrunkBase: false, hopBetweenBranchPoints: false, searchRunsOverTokens: 1_500 },
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
    readonly treeWalk?: Partial<TreeWalkSettings>
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
      treeWalk: { ...settings.routing.treeWalk, ...definedOnly(patch.routing?.treeWalk) },
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
  const searchOver = patch.routing?.treeWalk?.searchRunsOverTokens
  if (searchOver !== undefined && (!Number.isInteger(searchOver) || searchOver < 1)) {
    return 'The run size above which the tree walk searches must be a whole number of at least 1'
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
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    models: { ...DEFAULT_SETTINGS.models, ...stored.models },
    thresholds: { ...DEFAULT_SETTINGS.thresholds, ...stored.thresholds },
    routing: {
      referentStrategy: stored.routing?.referentStrategy ?? DEFAULT_SETTINGS.routing.referentStrategy,
      treeWalk: { ...DEFAULT_SETTINGS.routing.treeWalk, ...stored.routing?.treeWalk },
    },
    debug: {
      ...DEFAULT_SETTINGS.debug,
      ...stored.debug,
      comparePlacement: COMPARE_PLACEMENTS.find((placement) => placement === stored.debug?.comparePlacement) ?? DEFAULT_SETTINGS.debug.comparePlacement,
    },
  }
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

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

/** Views behind debug toggles (Q87, Q94). Margin rails, Focus and the split link are always on and have no toggle. */
export interface DebugToggles {
  readonly miniMap: boolean
  readonly operationGraph: boolean
  readonly runInspector: boolean
  /** Compare for an independent composite. Compare for split messages is always available. */
  readonly compareIndependent: boolean
}

export interface Settings {
  readonly retryPolicy: RetryPolicy
  /** Wait before a choice with default is carried out, in milliseconds (Q45). */
  readonly defaultChoiceWaitMs: number
  /** Answer and synthesis runs in flight at once, per provider (Q60). Integer ≥ 1. */
  readonly concurrencyLimit: number
  readonly models: ModelSettings
  readonly thresholds: DecisionThresholds
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
  debug: {
    miniMap: false,
    operationGraph: false,
    runInspector: false,
    compareIndependent: false,
  },
}

/** A partial change to the settings. Nested groups are merged key by key. */
export interface SettingsPatch {
  readonly retryPolicy?: RetryPolicy
  readonly defaultChoiceWaitMs?: number
  readonly concurrencyLimit?: number
  readonly models?: Partial<ModelSettings>
  readonly thresholds?: Partial<DecisionThresholds>
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
  for (const [role, model] of Object.entries(patch.models ?? {})) {
    if (typeof model === 'string' && model.trim() === '') return `Model for "${role}" cannot be empty`
  }
  return null
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

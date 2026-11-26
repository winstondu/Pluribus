import { DEFAULT_SETTINGS, applySettingsPatch, type DecisionThresholds, type Settings, type SettingsPatch } from '@pluribus/protocol'
import { STATED_AMBIGUITY_FLOOR } from './floor'

/**
 * Test-only: the arms of the referent frontier sweep. An arm is one point
 * of the existing configuration space: settings as `DEFAULT_SETTINGS` with
 * a patch, and the ambiguity floor. No arm changes an algorithm.
 *
 * - `strategy`: which requests are sent (strategy, strategy selection,
 *   candidate source, tree-walk switches, run size, summaries). Recorded
 *   live, once per replica.
 * - `budget`: the decision budget (backstops, token budget, price guard).
 *   They change requests only where a limit binds.
 * - `threshold` and `floor`: act on the answers; swept one at a time from
 *   the defaults over the cached answers.
 * - `joint`: combinations of the best values, checked together.
 */

export type ArmGroup = 'strategy' | 'budget' | 'threshold' | 'floor' | 'joint'

export interface Arm {
  readonly name: string
  readonly group: ArmGroup
  readonly settings: Settings
  /** The ambiguity floor (`AMBIGUITY_FLOOR`) in force while the arm runs. */
  readonly floor: number
  /** The patch on `DEFAULT_SETTINGS`, for the report. */
  readonly patch: SettingsPatch
}

export function arm(name: string, group: ArmGroup, patch: SettingsPatch, floor: number = STATED_AMBIGUITY_FLOOR): Arm {
  return { name, group, patch, floor, settings: applySettingsPatch(DEFAULT_SETTINGS, patch) }
}

export const DEFAULT_ARM = arm('default (rules, lexical)', 'strategy', {})

const off = (referentStrategy: 'one-pass' | 'tree-walk', rest: NonNullable<SettingsPatch['routing']> = {}): SettingsPatch => ({ routing: { strategySelection: 'off', referentStrategy, ...rest } })

/** Settings that change which requests are sent. */
export const STRATEGY_ARMS: readonly Arm[] = [
  DEFAULT_ARM,
  arm('rules, no candidate source', 'strategy', { routing: { candidateSource: 'none' } }),
  arm('rules, lexical, hops', 'strategy', { routing: { treeWalk: { hopBetweenBranchPoints: true } } }),
  arm('rules, lexical, search runs over 750', 'strategy', { routing: { treeWalk: { searchRunsOverTokens: 750 } } }),
  arm('rules, lexical, search runs over 3,000', 'strategy', { routing: { treeWalk: { searchRunsOverTokens: 3_000 } } }),
  arm('rules, lexical, summaries if available', 'strategy', { routing: { useSummaryIfAvailable: true } }),
  arm('decision-model selection, lexical', 'strategy', { routing: { strategySelection: 'decision-model' } }),
  arm('one pass', 'strategy', off('one-pass')),
  arm('tree walk, lexical', 'strategy', off('tree-walk')),
  arm('tree walk, no candidate source', 'strategy', off('tree-walk', { candidateSource: 'none' })),
  arm('tree walk, lexical, trunk base', 'strategy', off('tree-walk', { treeWalk: { startAtTrunkBase: true } })),
  arm('tree walk, lexical, hops', 'strategy', off('tree-walk', { treeWalk: { hopBetweenBranchPoints: true } })),
  arm('tree walk, lexical, trunk base + hops', 'strategy', off('tree-walk', { treeWalk: { startAtTrunkBase: true, hopBetweenBranchPoints: true } })),
  arm('tree walk, lexical, runs listed', 'strategy', off('tree-walk', { treeWalk: { searchRunsOverTokens: 1_000_000_000 } })),
]

/** The decision budget: backstops, token budget and price guard, from the defaults. */
export const BUDGET_ARMS: readonly Arm[] = [
  arm('referent requests 1', 'budget', { routing: { referentBudget: { requests: 1 } } }),
  arm('referent requests 2', 'budget', { routing: { referentBudget: { requests: 2 } } }),
  arm('referent requests 8', 'budget', { routing: { referentBudget: { requests: 8 } } }),
  arm('referent questions 24', 'budget', { routing: { referentBudget: { questions: 24 } } }),
  arm('referent questions 48', 'budget', { routing: { referentBudget: { questions: 48 } } }),
  arm('token budget absolute 6,000', 'budget', { routing: { tokenBudget: { mode: 'absolute', inputTokens: 6_000 } } }),
  arm('token budget absolute 10,000', 'budget', { routing: { tokenBudget: { mode: 'absolute', inputTokens: 10_000 } } }),
  arm('token budget absolute 16,000', 'budget', { routing: { tokenBudget: { mode: 'absolute', inputTokens: 16_000 } } }),
  arm('token budget absolute 40,000', 'budget', { routing: { tokenBudget: { mode: 'absolute', inputTokens: 40_000 } } }),
  arm('token budget relative 2%, floor 8,000', 'budget', { routing: { tokenBudget: { mode: 'relative', fraction: 0.02, floor: 8_000, ceiling: 40_000 } } }),
  arm('price guard 1× the answer', 'budget', { routing: { costGuard: { maxAnswerCostRatio: 1 } } }),
  arm('price guard 4× the answer', 'budget', { routing: { costGuard: { maxAnswerCostRatio: 4 } } }),
  arm('price guard off', 'budget', { routing: { costGuard: { maxAnswerCostRatio: 0 } } }),
  arm('price guard, expected answer 400 tokens', 'budget', { routing: { costGuard: { expectedOutputTokens: 400 } } }),
]

export type ThresholdName = keyof DecisionThresholds

export const THRESHOLD_NAMES: readonly ThresholdName[] = ['targetChoice', 'clearlyCorrective', 'composite', 'dependency', 'clarification', 'joinChoice']

/** The values each threshold is swept over, one at a time from the defaults. `joinChoice` 1 turns the join question off. */
export const THRESHOLD_VALUES: { readonly [T in ThresholdName]: readonly number[] } = {
  targetChoice: [0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95],
  clearlyCorrective: [0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95],
  composite: [0.3, 0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95],
  dependency: [0.3, 0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95],
  clarification: [0.3, 0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95],
  joinChoice: [0.5, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1],
}

export const FLOOR_VALUES: readonly number[] = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5]

export function thresholdArm(name: ThresholdName, value: number, base: SettingsPatch = {}, floor: number = STATED_AMBIGUITY_FLOOR): Arm {
  return arm(`${name} ${value}`, 'threshold', { ...base, thresholds: { ...base.thresholds, [name]: value } }, floor)
}

export function floorArm(value: number, base: SettingsPatch = {}): Arm {
  return arm(`ambiguity floor ${value}`, 'floor', base, value)
}

/** Every threshold arm of a one-at-a-time sweep from the defaults. */
export function thresholdSweep(): Arm[] {
  return THRESHOLD_NAMES.flatMap((name) => THRESHOLD_VALUES[name].map((value) => thresholdArm(name, value)))
}

export function floorSweep(): Arm[] {
  return FLOOR_VALUES.map((value) => floorArm(value))
}

/**
 * Combinations of the values the one-at-a-time sweeps found best, checked
 * together so that an interaction does not hide (docs/build/referent-frontier.md).
 */
export const JOINT_ARMS: readonly Arm[] = [
  // The two one-at-a-time sweeps that gained a case (each one case in some replicas): the middle of each plateau.
  arm('dependency 0.55, floor 0.2', 'joint', { thresholds: { dependency: 0.55 } }, 0.2),
  arm('dependency 0.5, floor 0.2', 'joint', { thresholds: { dependency: 0.5 } }, 0.2),
  arm('dependency 0.55, floor 0.2, targetChoice 0.65', 'joint', { thresholds: { dependency: 0.55, targetChoice: 0.65 } }, 0.2),
  arm('dependency 0.55, floor 0.2, joinChoice 0.85', 'joint', { thresholds: { dependency: 0.55, joinChoice: 0.85 } }, 0.2),
  // Spend: the cheapest settings that kept the score one at a time, together with the above.
  arm('dependency 0.55, floor 0.2, referent requests 2', 'joint', { thresholds: { dependency: 0.55 }, routing: { referentBudget: { requests: 2 } } }, 0.2),
  arm('dependency 0.55, floor 0.2, hops', 'joint', { thresholds: { dependency: 0.55 }, routing: { treeWalk: { hopBetweenBranchPoints: true } } }, 0.2),
]

/**
 * The configuration the report recommends; evaluated once on the held-out
 * partition beside the default. Fixed before that run, never after it.
 *
 * 2026-11-26: the defaults. No arm beat them on the tune cases by more than
 * the noise (two cases), and none spent less without losing a case or
 * changing where a message is placed (docs/build/referent-frontier.md).
 */
export const RECOMMENDED_ARM: Arm = { ...DEFAULT_ARM, name: 'recommended (the defaults)', group: 'joint' }

/**
 * The best arm on the tune cases, which the recommendation does not adopt
 * (its gain is within the noise). Routed on the held-out partition beside
 * the recommendation for the record only: that result may not move the
 * recommendation, or it would be tuning on held-out.
 */
export const TUNE_BEST_ARM: Arm = { ...(JOINT_ARMS[0] ?? DEFAULT_ARM), name: 'tune-best, not adopted (dependency 0.55, floor 0.2)' }

/** What the held-out phase routes: the default, the recommendation when it differs, and the tune-best arm. */
export const HELD_OUT_ARMS: readonly Arm[] = [DEFAULT_ARM, ...(patchText(RECOMMENDED_ARM) === patchText(DEFAULT_ARM) ? [] : [RECOMMENDED_ARM]), TUNE_BEST_ARM]

/** A short text for an arm's patch and floor. */
export function patchText(a: Arm): string {
  const parts: string[] = []
  const walk = (prefix: string, value: unknown): void => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value)) walk(prefix ? `${prefix}.${k}` : k, v)
    } else parts.push(`${prefix}=${String(value)}`)
  }
  walk('', a.patch)
  if (a.floor !== STATED_AMBIGUITY_FLOOR) parts.push(`AMBIGUITY_FLOOR=${a.floor}`)
  return parts.length ? parts.join(', ') : '(defaults)'
}

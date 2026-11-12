import {
  DEFAULT_SETTINGS,
  type AppSnapshot,
  type ConsumedContext,
  type ConsumedMessage,
  type DebugToggles,
  type DebugViewToggle,
  type RoutingDecision,
  type RunInspection,
  type UnitRoutingDecision,
} from '@committee/protocol'

/**
 * Helpers for the debug fixtures: app state with debug views switched on,
 * and run-inspection records written by hand. Fixture cases import the
 * builder from `@/fixtures` and these from here.
 */

/** App state for a fixture that shows debug views. Everything not named stays off. */
export function debugApp(debug: Partial<DebugToggles>): Partial<AppSnapshot> {
  return { settings: { ...DEFAULT_SETTINGS, debug: { ...DEFAULT_SETTINGS.debug, ...debug } } }
}

export const ALL_DEBUG_VIEWS: { readonly [K in DebugViewToggle]: boolean } = { miniMap: true, operationGraph: true, runInspector: true, compareIndependent: true }

/** A recorded model input. Token counts are given, never computed here. */
export function consumed(
  messages: ConsumedMessage[],
  rest: Pick<ConsumedContext, 'nodeIds' | 'inputs'> & Partial<ConsumedContext>,
): ConsumedContext {
  return {
    messages,
    corrections: [],
    sessionRequirementIds: [],
    inputTokens: 0,
    tokenLimit: 200_000,
    ...rest,
  }
}

/** A routing decision as a scripted router would have supplied it, or as the decision model recorded it. */
export function decision(unit: UnitRoutingDecision, rest: Partial<RoutingDecision> = {}): NonNullable<RunInspection['routing']> {
  return {
    decision: {
      source: 'decision-model',
      model: DEFAULT_SETTINGS.models.decision,
      composition: { value: 'atomic', confidence: 0.94 },
      units: [unit],
      thresholds: { ...DEFAULT_SETTINGS.thresholds },
      explanation: unit.explanation,
      questions: [],
      ...rest,
    },
    unit,
  }
}

export const PREAMBLE =
  'You are answering one request inside a larger conversation. You are given only the context this request builds on. Answer the request directly.'

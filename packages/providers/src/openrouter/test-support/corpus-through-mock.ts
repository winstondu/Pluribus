import { DEFAULT_SETTINGS, type ReferentStrategyName, type Settings, type StrategySelectionMode } from '@committee/protocol'
import { ROUTING_CORPUS, corpusInput, evaluateCorpus, oracleDecisionProvider, type CorpusExample } from '@committee/core'
import { createOpenRouterDecisionProvider } from '../decision-provider'
import { createDecisionsApiMock, type MeasuredCall, type TokenCalibration } from './decisions-api-mock'

/**
 * Test-only: the routing corpus routed by the real decision provider over
 * the tokenizer-counting Decisions mock, with decisions as labelled (the
 * corpus oracle answers). One mock per example, so each example's calls are
 * its own.
 */

export const MEASURED_CONFIGURATIONS = {
  'one pass': { strategySelection: 'off', referentStrategy: 'one-pass' },
  'tree walk, long runs searched': { strategySelection: 'off', referentStrategy: 'tree-walk' },
  'selected by rules (the default)': { strategySelection: 'rules', referentStrategy: DEFAULT_SETTINGS.routing.referentStrategy },
} as const satisfies Record<string, { readonly strategySelection: StrategySelectionMode; readonly referentStrategy: ReferentStrategyName }>

export type MeasuredConfiguration = keyof typeof MEASURED_CONFIGURATIONS

export function settingsFor(name: MeasuredConfiguration): Settings {
  return { ...DEFAULT_SETTINGS, routing: { ...DEFAULT_SETTINGS.routing, ...MEASURED_CONFIGURATIONS[name] } }
}

export interface MeasuredExample {
  readonly id: string
  readonly passed: boolean
  readonly calls: readonly MeasuredCall[]
  /** What the metered provider read back from `usage.input_tokens`. */
  readonly reportedInputTokens: number
}

const getKey = async (): Promise<string> => 'sk-or-v1-mock'

export async function corpusThroughMock(settings: Settings, calibration?: TokenCalibration, examples: readonly CorpusExample[] = ROUTING_CORPUS): Promise<MeasuredExample[]> {
  const out: MeasuredExample[] = []
  for (const example of examples) {
    const answerer = oracleDecisionProvider(example, corpusInput(example, settings))
    const api = createDecisionsApiMock({ answerer, ...(calibration ? { calibration } : {}) })
    const report = await evaluateCorpus({ decisionProvider: createOpenRouterDecisionProvider({ getKey, fetch: api.fetch }), settings, examples: [example] })
    const result = report.results[0]
    if (result === undefined) throw new Error(`no result for ${example.id}`)
    out.push({ id: example.id, passed: result.passed, calls: [...api.calls], reportedInputTokens: result.decisions.inputTokens })
  }
  return out
}

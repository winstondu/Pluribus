import { describe, expect, test } from 'vitest'
import { DEFAULT_SETTINGS } from '@pluribus/protocol'
import { corpusInput } from '../../testing/routing/corpus/evaluate'
import { ids, scene } from '../../testing/routing/corpus/scene'
import type { CorpusExample } from '../../testing/routing/corpus/types'
import { neededWork, unneededInFlight } from '../../src/routing/derive'
import type { UnitSignals } from '../../src/routing/questions'
import { supply } from '../../src/routing/supply'

/**
 * What is derived from the decision model's answers about work in flight
 * (04 · "Result dependencies", 05 · "Result-dependent work", C1, C2).
 */

function planRunning(): CorpusExample {
  const s = scene()
  s.chain('E', 'root', 'exam')
  s.add('goal', { chain: 'E', on: null, label: 'exam goal', request: 'I sit the cloud exam in six weeks', answerText: 'Six weeks is workable.' })
  s.add('plan', { chain: 'E', on: 'goal', label: 'study plan', request: 'Make me a study plan for it', answerText: 'Week 1 covers', state: 'running' })
  return { id: 'plan-running', covers: ['dependencies'], note: 'a plan running on the goal', scene: s.build(), text: 'Also recommend a paid course', expect: {} }
}

const t = DEFAULT_SETTINGS.thresholds

function signals(over: Partial<UnitSignals>): UnitSignals {
  return {
    key: 'm',
    corrective: 0.05,
    shared: 0.05,
    relation: null,
    targets: [],
    several: null,
    chain: null,
    lines: null,
    needsWork: [],
    needsGroups: [],
    sessionRequirements: [],
    asks: null,
    clarify: 0.05,
    clarifyReason: 'missing-information',
    after: [],
    ...over,
  }
}

describe('work in flight', () => {
  const input = corpusInput(planRunning())
  const supplied = supply(input, [])
  const plan = ids.section('plan')
  const goal = ids.section('goal')
  const planWork = supplied.sectionById.get(plan)?.directiveId
  if (!planWork) throw new Error('the plan is not supplied')

  test('C1 · a running section is an unneeded candidate when the unit is not result-dependent and does not plausibly need its result', () => {
    const addition = { value: 'addition' as const, confidence: 0.9, probabilities: { addition: 0.9 } }
    expect(unneededInFlight(signals({ relation: addition, needsWork: [{ id: planWork, confidence: 0.1 }] }), supplied, plan)).toBe(true)
    // Plausibly needed, result-dependent, not asked about, or not in flight: still a candidate.
    expect(unneededInFlight(signals({ relation: addition, needsWork: [{ id: planWork, confidence: 0.3 }] }), supplied, plan)).toBe(false)
    expect(unneededInFlight(signals({ relation: { value: 'result-dependent', confidence: 0.7, probabilities: { 'result-dependent': 0.7 } }, needsWork: [{ id: planWork, confidence: 0.1 }] }), supplied, plan)).toBe(false)
    expect(unneededInFlight(signals({ relation: addition }), supplied, plan)).toBe(false)
    expect(unneededInFlight(signals({ relation: addition, needsWork: [{ id: planWork, confidence: 0.1 }] }), supplied, goal)).toBe(false)
  })

  test('C2 · result-dependent at the threshold is read from the probability of that relation, on the same scale as the dependency questions', () => {
    // A choice's confidence can sit below the probability of the option chosen.
    const relation = { value: 'result-dependent' as const, confidence: 0.56, probabilities: { addition: 0.29, 'result-dependent': 0.71 } }
    expect(neededWork(signals({ relation, needsWork: [{ id: planWork, confidence: 0.57 }] }), [plan], supplied, t)).toEqual([planWork])
    const unsure = { value: 'result-dependent' as const, confidence: 0.4, probabilities: { addition: 0.45, 'result-dependent': 0.55 } }
    expect(neededWork(signals({ relation: unsure, needsWork: [{ id: planWork, confidence: 0.57 }] }), [plan], supplied, t)).toEqual([])
  })
})

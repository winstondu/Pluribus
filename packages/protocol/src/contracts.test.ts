import { describe, expect, test } from 'vitest'
import { COMMAND_TYPES } from './commands'
import { APP_EVENT_TYPES, APP_LOG, CONVERSATION_EVENT_TYPES, EVENT_SCHEMA_VERSION, upcastEvent } from './events'
import { IN_FLIGHT_STATES, NOT_STARTED_STATES, PROVIDER_ERROR_CLASS, providerError, providerErrorCodeForStatus } from './model'
import { DEFAULT_ABSOLUTE_TOKEN_BUDGET, DEFAULT_RELATIVE_TOKEN_BUDGET, DEFAULT_SETTINGS, LEGACY_REFERENT_INPUT_TOKENS, RETRY_POLICIES, applySettingsPatch, normalizeSettings, resolveTokenBudget, textTokens, validateSettingsPatch } from './settings'
import { groupCountText, pausedText, provisionalLabel, recoveryLabels, redoneByDefaultText, supersededInputText, waitingText } from './wording'

describe('commands', () => {
  test('the command set is exactly the one in 10 · Part 2, and revision is not a command', () => {
    expect([...COMMAND_TYPES].sort()).toEqual(
      [
        'submit-message',
        'stop',
        'retry',
        'regenerate',
        'continue-without',
        'cancel',
        'answer-elicitation',
        'undo-split',
        'change-settings',
        'create-conversation',
        'list-conversations',
        'delete-conversation',
      ].sort(),
    )
    expect(COMMAND_TYPES.some((type) => type.includes('revis'))).toBe(false)
  })
})

describe('events', () => {
  test('event type names are unique across both logs', () => {
    const all = [...CONVERSATION_EVENT_TYPES, ...APP_EVENT_TYPES]
    expect(new Set(all).size).toBe(all.length)
  })

  test('upcast accepts a current event and refuses unknown versions and types', () => {
    const stored = { id: '01', log: APP_LOG, seq: 1, v: EVENT_SCHEMA_VERSION, at: 5, type: 'key-status-changed', configured: true }
    expect(upcastEvent(stored)).toBe(stored)
    expect(() => upcastEvent({ ...stored, v: EVENT_SCHEMA_VERSION + 1 })).toThrow(/schema version/)
    expect(() => upcastEvent({ ...stored, type: 'revise' })).toThrow(/unknown type/)
    expect(() => upcastEvent({ ...stored, seq: 0 })).toThrow(/sequence/)
  })
})

describe('provider errors', () => {
  test('HTTP statuses map per the architecture error table', () => {
    for (const status of [408, 429, 502, 503, 500]) {
      expect(PROVIDER_ERROR_CLASS[providerErrorCodeForStatus(status)]).toBe('transient')
    }
    for (const status of [400, 401, 402, 403, 404]) {
      expect(PROVIDER_ERROR_CLASS[providerErrorCodeForStatus(status)]).toBe('non-retryable')
    }
    expect(providerErrorCodeForStatus(402)).toBe('out-of-credits')
    expect(providerErrorCodeForStatus(429)).toBe('rate-limited')
  })

  test('providerError fills in the class from the code', () => {
    expect(providerError('rate-limited', 'slow down', { httpStatus: 429, retryAfterMs: 2_000 })).toEqual({
      code: 'rate-limited',
      class: 'transient',
      message: 'slow down',
      httpStatus: 429,
      retryAfterMs: 2_000,
    })
    expect(providerError('context-length-exceeded', 'too long').class).toBe('non-retryable')
  })
})

describe('directive states', () => {
  test('retrying and paused members keep a sibling group open; settled ones do not', () => {
    expect(IN_FLIGHT_STATES).toContain('retrying')
    expect(IN_FLIGHT_STATES).toContain('paused')
    for (const settled of ['completed', 'failed', 'stopped', 'interrupted', 'cancelled', 'superseded'] as const) {
      expect(IN_FLIGHT_STATES).not.toContain(settled)
    }
    expect(NOT_STARTED_STATES).toContain('paused')
    expect(NOT_STARTED_STATES).not.toContain('running')
  })
})

describe('settings', () => {
  test('defaults match the specification', () => {
    expect(DEFAULT_SETTINGS.retryPolicy).toBe('standard')
    expect(DEFAULT_SETTINGS.defaultChoiceWaitMs).toBe(30_000)
    expect(DEFAULT_SETTINGS.concurrencyLimit).toBe(4)
    expect(DEFAULT_SETTINGS.models.decision).toBe('typesafe/jev-1.13')
    expect(Object.values(DEFAULT_SETTINGS.debug)).toEqual([false, false, false, false])
    expect(RETRY_POLICIES.standard.maxAutomaticRetries).toBe(3)
    expect(RETRY_POLICIES.manual.maxAutomaticRetries).toBe(0)
    expect(RETRY_POLICIES.persistent.maxAutomaticRetries).toBeGreaterThan(RETRY_POLICIES.standard.maxAutomaticRetries)
  })

  test('a patch merges nested groups and leaves the rest untouched', () => {
    const next = applySettingsPatch(DEFAULT_SETTINGS, { retryPolicy: 'manual', debug: { miniMap: true } })
    expect(next.retryPolicy).toBe('manual')
    expect(next.debug).toEqual({ ...DEFAULT_SETTINGS.debug, miniMap: true })
    expect(next.models).toEqual(DEFAULT_SETTINGS.models)
    expect(applySettingsPatch(DEFAULT_SETTINGS, {})).toBe(DEFAULT_SETTINGS)
  })

  test('invalid values are named', () => {
    expect(validateSettingsPatch({ concurrencyLimit: 0 })).toMatch(/Concurrency/)
    expect(validateSettingsPatch({ thresholds: { targetChoice: 1.2 } })).toMatch(/targetChoice/)
    expect(validateSettingsPatch({ models: { answer: ' ' } })).toMatch(/answer/)
    expect(validateSettingsPatch({ concurrencyLimit: 2, defaultChoiceWaitMs: 0 })).toBeNull()
  })

  test('the referent strategy and its decision budget are settings: merged key by key, validated, and filled in for settings stored before they existed', () => {
    const next = applySettingsPatch(DEFAULT_SETTINGS, { routing: { referentStrategy: 'one-pass', referentBudget: { requests: 2 } } })
    expect(next.routing).toEqual({ ...DEFAULT_SETTINGS.routing, referentStrategy: 'one-pass', referentBudget: { ...DEFAULT_SETTINGS.routing.referentBudget, requests: 2 } })
    expect(next.thresholds).toEqual(DEFAULT_SETTINGS.thresholds)
    expect(applySettingsPatch(DEFAULT_SETTINGS, { routing: {} })).toBe(DEFAULT_SETTINGS)
    expect(validateSettingsPatch({ routing: { referentStrategy: 'guess' as never } })).toMatch(/referent strategy/)
    expect(validateSettingsPatch({ routing: { referentBudget: { questions: -1 } } })).toMatch(/questions/)
    expect(validateSettingsPatch({ routing: { referentBudget: { requests: 1.5 } } })).toMatch(/requests/)
    expect(validateSettingsPatch({ routing: { referentStrategy: 'tree-walk', referentBudget: { requests: 0 } } })).toBeNull()
    const { routing: _dropped, ...stored } = { ...DEFAULT_SETTINGS, retryPolicy: 'manual' as const }
    expect(normalizeSettings(stored)).toEqual({ ...DEFAULT_SETTINGS, retryPolicy: 'manual' })
  })

  test('the tree walk\'s two switches, its search size and the price guard are settings: independent, validated, and defaulted for settings stored before they existed', () => {
    expect(DEFAULT_SETTINGS.routing.treeWalk).toEqual({ startAtTrunkBase: false, hopBetweenBranchPoints: false, searchRunsOverTokens: 1_500 })
    const trunk = applySettingsPatch(DEFAULT_SETTINGS, { routing: { treeWalk: { startAtTrunkBase: true } } })
    expect(trunk.routing.treeWalk).toEqual({ startAtTrunkBase: true, hopBetweenBranchPoints: false, searchRunsOverTokens: 1_500 })
    const both = applySettingsPatch(trunk, { routing: { treeWalk: { hopBetweenBranchPoints: true } } })
    expect(both.routing.treeWalk).toEqual({ startAtTrunkBase: true, hopBetweenBranchPoints: true, searchRunsOverTokens: 1_500 })
    expect(both.routing.referentStrategy).toBe(DEFAULT_SETTINGS.routing.referentStrategy)
    expect(validateSettingsPatch({ routing: { treeWalk: { searchRunsOverTokens: 0 } } })).toMatch(/whole number/)
    expect(validateSettingsPatch({ routing: { treeWalk: { searchRunsOverTokens: 800, hopBetweenBranchPoints: true } } })).toBeNull()
    expect(validateSettingsPatch({ routing: { costGuard: { maxAnswerCostRatio: -1 } } })).toMatch(/maxAnswerCostRatio/)
    expect(applySettingsPatch(DEFAULT_SETTINGS, { routing: { costGuard: { maxAnswerCostRatio: 1 } } }).routing.costGuard).toEqual({ ...DEFAULT_SETTINGS.routing.costGuard, maxAnswerCostRatio: 1 })
    // Stored by the version that had only the strategy and its budget.
    const old = { ...DEFAULT_SETTINGS, routing: { referentStrategy: 'one-pass', referentBudget: { requests: 1, questions: 10, inputTokens: 500 } } } as unknown as typeof DEFAULT_SETTINGS
    expect(normalizeSettings(old).routing).toEqual({
      referentStrategy: 'one-pass',
      referentBudget: { requests: 1, questions: 10 },
      tokenBudget: { mode: 'absolute', inputTokens: 500 },
      treeWalk: DEFAULT_SETTINGS.routing.treeWalk,
      costGuard: DEFAULT_SETTINGS.routing.costGuard,
      useSummaryIfAvailable: false,
      backgroundSummaries: false,
    })
    // Context summaries: two independent switches, both off until asked for.
    const summaries = applySettingsPatch(DEFAULT_SETTINGS, { routing: { useSummaryIfAvailable: true } })
    expect(summaries.routing.useSummaryIfAvailable).toBe(true)
    expect(summaries.routing.backgroundSummaries).toBe(false)
    expect(applySettingsPatch(summaries, { routing: { backgroundSummaries: true } }).routing).toMatchObject({ useSummaryIfAvailable: true, backgroundSummaries: true })
  })
})

describe('the decision token budget', () => {
  const relative = DEFAULT_RELATIVE_TOKEN_BUDGET

  test('budget · the default is relative to the conversation\'s log: 2% of it, never below 16,000 tokens and never above 40,000', () => {
    expect(DEFAULT_SETTINGS.routing.tokenBudget).toEqual({ mode: 'relative', fraction: 0.02, floor: 16_000, ceiling: 40_000 })
    expect(DEFAULT_ABSOLUTE_TOKEN_BUDGET).toEqual({ mode: 'absolute', inputTokens: 16_000 })
    expect(resolveTokenBudget(relative, 0)).toBe(16_000)
    expect(resolveTokenBudget(relative, 500_000)).toBe(16_000)
    expect(resolveTokenBudget(relative, 1_000_000)).toBe(20_000)
    expect(resolveTokenBudget(relative, 1_234_567)).toBe(24_691)
    expect(resolveTokenBudget(relative, 5_000_000)).toBe(40_000)
    // A multiple of the log is a fraction above 1.
    expect(resolveTokenBudget({ mode: 'relative', fraction: 2, floor: 0, ceiling: 1_000_000 }, 3_000)).toBe(6_000)
    expect(resolveTokenBudget({ mode: 'absolute', inputTokens: 9_000 }, 5_000_000)).toBe(9_000)
    // The log is sized at one token per four characters, rounded up.
    expect([textTokens(0), textTokens(1), textTokens(4), textTokens(5)]).toEqual([0, 1, 1, 2])
  })

  test('budget · it is one setting, replaced as a whole and validated by mode', () => {
    const fixed = applySettingsPatch(DEFAULT_SETTINGS, { routing: { tokenBudget: { mode: 'absolute', inputTokens: 9_000 } } })
    expect(fixed.routing.tokenBudget).toEqual({ mode: 'absolute', inputTokens: 9_000 })
    expect(fixed.routing.referentBudget).toEqual(DEFAULT_SETTINGS.routing.referentBudget)
    expect(applySettingsPatch(fixed, { routing: { tokenBudget: relative } }).routing.tokenBudget).toEqual(relative)
    expect(applySettingsPatch(DEFAULT_SETTINGS, { routing: { tokenBudget: { ...relative } } })).toBe(DEFAULT_SETTINGS)
    expect(validateSettingsPatch({ routing: { tokenBudget: { mode: 'absolute', inputTokens: 0 } } })).toBeNull()
    expect(validateSettingsPatch({ routing: { tokenBudget: { mode: 'absolute', inputTokens: -1 } } })).toMatch(/whole number/)
    expect(validateSettingsPatch({ routing: { tokenBudget: { mode: 'absolute', inputTokens: 1.5 } } })).toMatch(/whole number/)
    expect(validateSettingsPatch({ routing: { tokenBudget: { ...relative, fraction: 0 } } })).toMatch(/greater than 0/)
    expect(validateSettingsPatch({ routing: { tokenBudget: { ...relative, floor: 50_000 } } })).toMatch(/ceiling cannot be below/)
    expect(validateSettingsPatch({ routing: { tokenBudget: { ...relative, floor: 0.5 } } })).toMatch(/whole numbers/)
    expect(validateSettingsPatch({ routing: { tokenBudget: { ...relative, fraction: 3 } } })).toBeNull()
    expect(validateSettingsPatch({ routing: { tokenBudget: { mode: 'guess' } as never } })).toMatch(/Unknown decision token budget mode/)
  })

  test('budget · stored settings normalise: a token cap an earlier version stored under the referent budget becomes an absolute budget, its untouched default the relative one', () => {
    const stored = (routing: object): typeof DEFAULT_SETTINGS => ({ ...DEFAULT_SETTINGS, routing } as unknown as typeof DEFAULT_SETTINGS)
    // Chosen by the user under the earlier version.
    const chosen = normalizeSettings(stored({ referentStrategy: 'tree-walk', referentBudget: { requests: 4, questions: 96, inputTokens: 30_000 } })).routing
    expect(chosen.tokenBudget).toEqual({ mode: 'absolute', inputTokens: 30_000 })
    expect(chosen.referentBudget).toEqual({ requests: 4, questions: 96 })
    // Settings are stored whole: 12,000 was that version's default, not a choice.
    expect(LEGACY_REFERENT_INPUT_TOKENS).toBe(12_000)
    expect(normalizeSettings(stored({ referentStrategy: 'tree-walk', referentBudget: { requests: 4, questions: 96, inputTokens: 12_000 } })).routing.tokenBudget).toEqual(relative)
    // A budget stored by this version is kept, whatever the earlier field says; a broken one is repaired field by field.
    expect(normalizeSettings(stored({ referentBudget: { requests: 4, questions: 96, inputTokens: 30_000 }, tokenBudget: { mode: 'absolute', inputTokens: 7_000 } })).routing.tokenBudget).toEqual({ mode: 'absolute', inputTokens: 7_000 })
    expect(normalizeSettings(stored({ tokenBudget: { mode: 'relative', fraction: 0.05, floor: 8_000, ceiling: 4_000 } })).routing.tokenBudget).toEqual({ mode: 'relative', fraction: 0.05, floor: 8_000, ceiling: 40_000 })
    expect(normalizeSettings(stored({ tokenBudget: { mode: 'relative', fraction: -1, floor: 8_000, ceiling: 9_000 } })).routing.tokenBudget).toEqual({ mode: 'relative', fraction: 0.02, floor: 8_000, ceiling: 9_000 })
    expect(normalizeSettings(stored({})).routing.tokenBudget).toEqual(relative)
    // Normalised settings are valid as a patch.
    expect(validateSettingsPatch({ routing: { tokenBudget: chosen.tokenBudget } })).toBeNull()
  })
})

describe('fixed wording', () => {
  test('queue items', () => {
    expect(waitingText(['neighborhoods', 'activities'], false)).toBe('Waiting for neighborhoods + activities')
    expect(waitingText(['neighborhoods', 'activities'], true)).toBe('Revised · waiting for neighborhoods + activities')
    expect(pausedText({ label: 'activities', outcome: 'failed' })).toBe('Paused — activities failed')
    expect(pausedText({ label: 'activities', outcome: 'stopped' })).toBe('Paused — activities stopped')
    expect(recoveryLabels('activities', 'itinerary')).toEqual({
      retry: 'Retry activities',
      continueWithout: 'Continue without activities',
      cancel: 'Cancel itinerary',
    })
  })

  test('notes', () => {
    expect(supersededInputText(['neighborhood recommendations'])).toBe('Based on superseded neighborhood recommendations')
    expect(redoneByDefaultText('J')).toBe('Redid J by default')
  })

  test('group header counts appear only while results are mixed and never as an overall label', () => {
    const none = { done: 0, failed: 0, stopped: 0, interrupted: 0, cancelled: 0, inProgress: 0 }
    expect(groupCountText({ ...none, done: 2, failed: 1, stopped: 1 })).toBe('2 done · 1 failed · 1 stopped')
    expect(groupCountText({ ...none, done: 3 })).toBeNull()
    expect(groupCountText({ ...none, done: 1, inProgress: 2 })).toBeNull()
    expect(groupCountText({ ...none, failed: 2 })).toBe('2 failed')
  })

  test('provisional labels are short and deterministic', () => {
    expect(provisionalLabel('Suggest neighborhoods to stay in.')).toBe('Suggest neighborhoods to stay in')
    expect(provisionalLabel('Use those recommendations to make a five-day itinerary for the trip')).toBe(
      'Use those recommendations to make a…',
    )
    expect(provisionalLabel('   ')).toBe('request')
  })
})

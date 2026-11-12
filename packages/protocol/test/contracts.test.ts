import { describe, expect, test } from 'vitest'
import { COMMAND_TYPES } from '../src/commands'
import { APP_EVENT_TYPES, APP_LOG, CONVERSATION_EVENT_TYPES, EVENT_SCHEMA_VERSION, upcastEvent } from '../src/events'
import { IN_FLIGHT_STATES, NOT_STARTED_STATES, PROVIDER_ERROR_CLASS, providerError, providerErrorCodeForStatus } from '../src/model'
import { DEFAULT_SETTINGS, RETRY_POLICIES, applySettingsPatch, validateSettingsPatch } from '../src/settings'
import { groupCountText, pausedText, provisionalLabel, recoveryLabels, redoneByDefaultText, supersededInputText, waitingText } from '../src/wording'

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
    const { comparePlacement, ...debugToggles } = DEFAULT_SETTINGS.debug
    expect(Object.values(debugToggles)).toEqual([false, false, false, false])
    expect(comparePlacement).toBe('sidebar')
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

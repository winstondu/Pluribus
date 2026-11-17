import { describe, expect, test } from 'vitest'
import { buildLabel } from './build-info'

describe('the build stamp', () => {
  test('names the commit, marks uncommitted changes, and says unknown outside a checkout', () => {
    const at = '2026-11-17T12:00:00.000Z'
    expect(buildLabel({ commit: 'abc1234', dirty: false, builtAt: at })).toBe('abc1234')
    expect(buildLabel({ commit: 'abc1234', dirty: true, builtAt: at })).toBe('abc1234+')
    expect(buildLabel({ commit: '', dirty: false, builtAt: at })).toBe('unknown')
  })
})

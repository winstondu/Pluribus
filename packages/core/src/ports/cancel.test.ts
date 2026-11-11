import { describe, expect, test } from 'vitest'
import { NEVER_CANCELLED, createCancelSource } from './cancel'

describe('cancel source', () => {
  test('notifies each callback once, in registration order', () => {
    const source = createCancelSource()
    const calls: string[] = []
    source.signal.onCancel(() => calls.push('a'))
    source.signal.onCancel(() => calls.push('b'))
    expect(source.signal.cancelled).toBe(false)
    source.cancel()
    source.cancel()
    expect(source.signal.cancelled).toBe(true)
    expect(calls).toEqual(['a', 'b'])
  })

  test('a callback registered after cancellation runs at once', () => {
    const source = createCancelSource()
    source.cancel()
    let ran = false
    source.signal.onCancel(() => {
      ran = true
    })
    expect(ran).toBe(true)
  })

  test('a removed callback is not called', () => {
    const source = createCancelSource()
    let ran = false
    const remove = source.signal.onCancel(() => {
      ran = true
    })
    remove()
    source.cancel()
    expect(ran).toBe(false)
  })

  test('the never-cancelled signal stays that way', () => {
    let ran = false
    NEVER_CANCELLED.onCancel(() => {
      ran = true
    })()
    expect(NEVER_CANCELLED.cancelled).toBe(false)
    expect(ran).toBe(false)
  })
})

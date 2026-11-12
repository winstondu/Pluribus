import { describe, expect, test } from 'vitest'
import { BACKEND_LOCK, runAsOwner, type OwnershipLocks } from './ownership'

/** One origin's exclusive Web Locks, shared by the "tabs" of a test: held in order, granted on release. */
function fakeLocks(): OwnershipLocks & { holder(): string | null } {
  let held: string | null = null
  const queue: (() => void)[] = []
  let next = 0
  const grant = async (callback: (lock: unknown) => Promise<void>, name: string): Promise<void> => {
    const id = `${name}#${(next += 1)}`
    held = id
    try {
      await callback({ name })
    } finally {
      held = null
      queue.shift()?.()
    }
  }
  const request = (async (name: string, a: unknown, b?: unknown) => {
    const options = typeof a === 'function' ? {} : (a as { ifAvailable?: boolean })
    const callback = (typeof a === 'function' ? a : b) as (lock: unknown) => Promise<void>
    if (held === null) return grant(callback, name)
    if (options.ifAvailable) return callback(null)
    await new Promise<void>((resolve) => queue.push(resolve))
    return grant(callback, name)
  }) as OwnershipLocks['request']
  return { request, holder: () => held }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function tab(locks: OwnershipLocks) {
  const seen: string[] = []
  let close: () => void = () => {}
  const done = runAsOwner(locks, {
    standby: () => seen.push('standby'),
    serve: () => {
      seen.push('serving')
      // Serving lasts until the tab closes.
      return new Promise<void>((resolve) => (close = resolve))
    },
  })
  return { seen, close: () => close(), done }
}

describe('tab ownership (Q99)', () => {
  test('Q99 · the first tab owns execution; a second shows the already-open state and takes over once ownership is released', async () => {
    const locks = fakeLocks()
    const first = tab(locks)
    await tick()
    expect(first.seen).toEqual(['serving'])
    expect(locks.holder()).toMatch(new RegExp(`^${BACKEND_LOCK}`))

    const second = tab(locks)
    await tick()
    expect(second.seen).toEqual(['standby'])

    // A third tab waits behind the second.
    const third = tab(locks)
    await tick()
    expect(third.seen).toEqual(['standby'])

    // The first tab closes: the second, first in line, takes over; the third keeps standing by.
    first.close()
    await first.done
    await tick()
    expect(second.seen).toEqual(['standby', 'serving'])
    expect(third.seen).toEqual(['standby'])

    second.close()
    await second.done
    await tick()
    expect(third.seen).toEqual(['standby', 'serving'])
  })

  test('Q99 · without Web Locks a tab serves at once (there is no way to know about another tab)', async () => {
    const lone = tab(undefined as unknown as OwnershipLocks)
    await tick()
    expect(lone.seen).toEqual(['serving'])
  })
})

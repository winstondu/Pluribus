import { createIdFactory, createUlidFactory, type IdFactory } from '@committee/protocol'
import type { Clock, Timers } from '@committee/core/ports'

/**
 * The real time and identity ports for the embedded backend. Core never
 * reads the clock, sets a timer or draws a random number itself; in the
 * Worker these are the host's (PLAN §7).
 */
export const systemClock: Clock = {
  now: () => Date.now(),
}

export const systemTimers: Timers = {
  setTimeout(callback, delayMs) {
    const handle = setTimeout(callback, Math.max(0, delayMs))
    return () => clearTimeout(handle)
  },
}

/** IDs are `<prefix>_<ULID>`, monotonic within one millisecond. */
export function createSystemIds(): IdFactory {
  return createIdFactory(createUlidFactory(() => Date.now(), () => Math.random()))
}

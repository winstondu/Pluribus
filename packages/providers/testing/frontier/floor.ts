import { AMBIGUITY_FLOOR } from '@pluribus/core'

/**
 * Test-only: the ambiguity floor (`AMBIGUITY_FLOOR` in
 * `core/src/routing/derive.ts`) as a value the frontier sweep can change.
 *
 * The floor is a constant in core, and the sweep may not change core's
 * source. Under the frontier's own vitest config
 * (`testing/frontier/vitest.config.ts`) a load-time transform turns the
 * constant into a binding with a setter, published on `globalThis` under
 * {@link FLOOR_SETTER}; everywhere else the constant stays as written and
 * only its own value can be "set".
 */

export const FLOOR_SETTER = '__pluribusFrontierSetAmbiguityFloor'

/** The floor as core states it, before any sweep moves it. */
export const STATED_AMBIGUITY_FLOOR = 0.25

type Setter = (value: number) => void

function setter(): Setter | null {
  const value: unknown = (globalThis as Record<string, unknown>)[FLOOR_SETTER]
  return typeof value === 'function' ? (value as Setter) : null
}

/** Whether the floor can be moved in this process. */
export function floorIsSettable(): boolean {
  return setter() !== null
}

/** The floor routing reads now (a live binding when the transform is in place). */
export function currentAmbiguityFloor(): number {
  return AMBIGUITY_FLOOR
}

/** Moves the floor. Throws when the transform is not in place and the value is not the stated one. */
export function setAmbiguityFloor(value: number): void {
  const set = setter()
  if (set === null) {
    if (value === STATED_AMBIGUITY_FLOOR) return
    throw new Error(`The ambiguity floor can only be moved under testing/frontier/vitest.config.ts (asked for ${value})`)
  }
  set(value)
  if (AMBIGUITY_FLOOR !== value) throw new Error(`The ambiguity floor did not move: it reads ${AMBIGUITY_FLOOR}, not ${value}`)
}

/**
 * Time, injected. Core never calls `Date.now()` or `setTimeout` itself (it
 * could not: it compiles without those globals), so every test drives time
 * with the fake clock.
 */
export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number
}

/** Cancels a pending timer. Calling it after the timer fired, or twice, does nothing. */
export type CancelTimer = () => void

export interface Timers {
  /**
   * Calls `callback` once, `delayMs` milliseconds from now by the same clock
   * that `Clock.now()` reads. A delay of 0 still fires asynchronously, never
   * inside this call. Timers due at the same instant fire in the order they
   * were set.
   */
  setTimeout(callback: () => void, delayMs: number): CancelTimer
}

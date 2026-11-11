import type { CancelTimer, Clock, Timers } from '../ports'

interface PendingTimer {
  readonly due: number
  readonly order: number
  readonly callback: () => void
  cancelled: boolean
}

/**
 * Implements `Clock` and `Timers` on a clock that moves only when told.
 * `now()` never moves by itself. `advance(ms)` fires every timer due within
 * the span, in due order and then in the order set, with `now()` at each
 * timer's due time while it runs.
 */
export class FakeClock implements Clock, Timers {
  private time: number
  private sequence = 0
  private readonly timers: PendingTimer[] = []

  constructor(start = Date.UTC(2026, 10, 11, 9, 0, 0)) {
    this.time = start
  }

  now(): number {
    return this.time
  }

  setTimeout(callback: () => void, delayMs: number): CancelTimer {
    const timer: PendingTimer = { due: this.time + Math.max(0, delayMs), order: this.sequence++, callback, cancelled: false }
    this.timers.push(timer)
    return () => {
      timer.cancelled = true
    }
  }

  /** Clock time of the next timer that has not fired, or null. */
  nextDueAt(): number | null {
    const next = this.next()
    return next ? next.due : null
  }

  /** Number of timers that have not fired or been cancelled. */
  pending(): number {
    return this.timers.filter((t) => !t.cancelled).length
  }

  /** Fires the next timer if it is due at or before `limit`; returns whether one fired. */
  fireNext(limit = Number.POSITIVE_INFINITY): boolean {
    const next = this.next()
    if (!next || next.due > limit) return false
    this.timers.splice(this.timers.indexOf(next), 1)
    this.time = Math.max(this.time, next.due)
    next.callback()
    return true
  }

  /** Moves the clock forward by `ms`, firing every timer that falls due on the way. */
  advance(ms: number): void {
    const target = this.time + ms
    while (this.fireNext(target)) {
      // keep firing
    }
    this.time = Math.max(this.time, target)
  }

  /** Sets the clock to an absolute time without firing anything. */
  set(time: number): void {
    this.time = time
  }

  private next(): PendingTimer | undefined {
    let best: PendingTimer | undefined
    for (const timer of this.timers) {
      if (timer.cancelled) continue
      if (!best || timer.due < best.due || (timer.due === best.due && timer.order < best.order)) best = timer
    }
    for (let i = this.timers.length - 1; i >= 0; i--) if (this.timers[i]?.cancelled) this.timers.splice(i, 1)
    return best
  }
}

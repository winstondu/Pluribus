/**
 * Which tab executes work (11 · "Embedded", Q99): only one Pluribus tab per
 * browser profile and origin runs the backend. Ownership is the
 * `pluribus-backend` Web Lock. A tab that finds it held stands by, which
 * the page shows as the already-open state, and keeps waiting in the lock's
 * queue: when the owner releases it (its tab closes, ending its Worker), the
 * next tab in line takes over and starts serving.
 */

export const BACKEND_LOCK = 'pluribus-backend'

/** The part of `LockManager` this uses. */
export interface OwnershipLocks {
  request(name: string, options: { readonly ifAvailable: true }, callback: (lock: unknown) => Promise<void>): Promise<unknown>
  request(name: string, callback: (lock: unknown) => Promise<void>): Promise<unknown>
}

export interface OwnershipHooks {
  /** Another tab owns execution: show the already-open state. Called at most once. */
  standby(): void
  /**
   * This tab owns execution: build and serve the backend. Ownership lasts
   * until the returned promise settles; the Worker's serve never does, so the
   * lock is released only when the Worker ends.
   */
  serve(): Promise<void>
}

/** Serves as the owner at once when the lock is free; otherwise stands by and serves once it is released to this tab. */
export async function runAsOwner(locks: OwnershipLocks | undefined, hooks: OwnershipHooks): Promise<void> {
  if (!locks) {
    // No Web Locks (very old browsers): there is no way to know about another tab.
    await hooks.serve()
    return
  }
  let acquired = false
  await locks.request(BACKEND_LOCK, { ifAvailable: true }, async (lock) => {
    if (lock === null) return
    acquired = true
    await hooks.serve()
  })
  if (acquired) return
  hooks.standby()
  await locks.request(BACKEND_LOCK, async () => {
    await hooks.serve()
  })
}

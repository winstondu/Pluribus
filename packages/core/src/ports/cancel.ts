/**
 * Cancellation without the DOM. Core compiles without `AbortSignal`, so it
 * carries its own minimal signal; a real `AbortSignal` is not needed to
 * satisfy it, and a provider turns it into one for `fetch` with
 * `signal.onCancel(() => controller.abort())`.
 */
export interface CancelSignal {
  readonly cancelled: boolean
  /**
   * Registers a callback for cancellation. Called at most once; called
   * immediately if the signal is already cancelled. Returns a function that
   * removes the callback.
   */
  onCancel(callback: () => void): () => void
}

export interface CancelSource {
  readonly signal: CancelSignal
  /** Cancels the signal. Idempotent. */
  cancel(): void
}

export function createCancelSource(): CancelSource {
  let cancelled = false
  const callbacks = new Set<() => void>()
  return {
    signal: {
      get cancelled() {
        return cancelled
      },
      onCancel(callback) {
        if (cancelled) {
          callback()
          return () => {}
        }
        callbacks.add(callback)
        return () => {
          callbacks.delete(callback)
        }
      },
    },
    cancel() {
      if (cancelled) return
      cancelled = true
      const pending = [...callbacks]
      callbacks.clear()
      for (const callback of pending) callback()
    },
  }
}

/** A signal that is never cancelled, for calls nothing can stop. */
export const NEVER_CANCELLED: CancelSignal = {
  cancelled: false,
  onCancel: () => () => {},
}

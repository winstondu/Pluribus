import type { CachedState, ProjectionCache } from '@committee/core/ports'
import type { StorageAdapter } from './adapter'
import { EVENT_STORES } from './event-store'

function isCachedState(value: unknown): value is CachedState {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record['throughSeq'] === 'number' &&
    Number.isInteger(record['throughSeq']) &&
    typeof record['stateVersion'] === 'number' &&
    'state' in record
  )
}

/**
 * A {@link ProjectionCache} over the events database's `projections` store.
 * One entry per log; `save` replaces it. An entry that is not a well-formed
 * `CachedState` loads as `null`, so core rebuilds from the event log: losing
 * the cache loses nothing (Q58).
 */
export function createProjectionCache(adapter: StorageAdapter): ProjectionCache {
  const stores = [EVENT_STORES.projections]
  return {
    load(log) {
      return adapter.read(stores, async (tx) => {
        const value = await tx.get(EVENT_STORES.projections, [log])
        return isCachedState(value) ? value : null
      })
    },
    save(log, cached) {
      if (!isCachedState(cached)) return Promise.reject(new TypeError('A cached state needs an integer throughSeq, a stateVersion and a state'))
      const entry: CachedState = { throughSeq: cached.throughSeq, stateVersion: cached.stateVersion, state: cached.state }
      return adapter.write(stores, (tx) => {
        tx.put(EVENT_STORES.projections, [log], entry)
        return Promise.resolve()
      })
    },
    delete(log) {
      return adapter.write(stores, (tx) => {
        tx.delete(EVENT_STORES.projections, [log])
        return Promise.resolve()
      })
    },
  }
}

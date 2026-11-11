import { deepEqual } from '@committee/protocol'
import { STATE_TABLES, type ConversationState } from '../state'

/**
 * Incremental projections by dependency tracking.
 *
 * Every view is computed by a memoized function of the state. While it runs,
 * it reads the state through a proxy that records each row and list it
 * touched, by identity. On the next step the view is reused, as the same
 * object, when every recorded row and list is still the same object;
 * otherwise it is computed again. Reducers replace only what changes, so a
 * chunk of streamed text recomputes the one attempt view that shows it.
 *
 * A projector created with `memoize: false` computes every view from
 * scratch. Rebuilding from the log and comparing the two is how the tests
 * prove the incremental projections exact.
 */

type Dep =
  | { readonly kind: 'field'; readonly key: string; readonly ref: unknown }
  | { readonly kind: 'row'; readonly table: string; readonly id: string; readonly ref: unknown }
  | { readonly kind: 'keys'; readonly table: string; readonly ref: unknown }
  | { readonly kind: 'memo'; readonly key: string; readonly ref: unknown }

interface Entry {
  value: unknown
  deps: Dep[]
  generation: number
}

const TABLES = new Set<string>(STATE_TABLES)

export interface Memo {
  /** A memoized sub-computation, keyed by `name` and `id`. */
  get<T>(name: string, id: string, compute: (state: ConversationState, memo: Memo) => T): T
}

export class Projector {
  private readonly entries = new Map<string, Entry>()
  private state: ConversationState | null = null
  private generation = 0
  private readonly memoize: boolean

  constructor(options: { readonly memoize: boolean } = { memoize: true }) {
    this.memoize = options.memoize
  }

  /** Runs a top-level computation against `state`, reusing every view whose inputs are unchanged. */
  run<T>(state: ConversationState, name: string, compute: (state: ConversationState, memo: Memo) => T): T {
    this.state = state
    this.generation += 1
    const value = this.evaluate(name, '', compute, null)
    if (this.generation % 64 === 0) this.prune()
    return value
  }

  private evaluate<T>(name: string, id: string, compute: (state: ConversationState, memo: Memo) => T, parent: Dep[] | null): T {
    const key = `${name}\u0000${id}`
    const state = this.state
    if (!state) throw new Error('Projector used outside run()')
    const existing = this.entries.get(key)
    if (this.memoize && existing && existing.generation === this.generation) {
      parent?.push({ kind: 'memo', key, ref: existing.value })
      return existing.value as T
    }
    if (this.memoize && existing && this.valid(existing, state, compute)) {
      existing.generation = this.generation
      parent?.push({ kind: 'memo', key, ref: existing.value })
      return existing.value as T
    }
    const deps: Dep[] = []
    const memo: Memo = {
      get: (n, i, c) => this.evaluate(n, i, c, deps),
    }
    const computed = compute(track(state, deps), memo)
    // A recomputed view equal to the previous one keeps its identity, so whatever reads it stays valid.
    const value = existing && deepEqual(existing.value, computed) ? (existing.value as T) : computed
    const entry: Entry = { value, deps, generation: this.generation }
    this.entries.set(key, entry)
    // Keep definitions so nested memos can be revalidated by key.
    this.definitions.set(key, { name, id, compute: compute as (state: ConversationState, memo: Memo) => unknown })
    parent?.push({ kind: 'memo', key, ref: value })
    return value
  }

  private readonly definitions = new Map<
    string,
    { readonly name: string; readonly id: string; readonly compute: (state: ConversationState, memo: Memo) => unknown }
  >()

  private valid(entry: Entry, state: ConversationState, _compute: unknown): boolean {
    for (const dep of entry.deps) {
      switch (dep.kind) {
        case 'field':
          if ((state as unknown as Record<string, unknown>)[dep.key] !== dep.ref) return false
          break
        case 'keys':
          if ((state as unknown as Record<string, unknown>)[dep.table] !== dep.ref) return false
          break
        case 'row': {
          const table = (state as unknown as Record<string, Record<string, unknown>>)[dep.table]
          if (!table || table[dep.id] !== dep.ref) return false
          break
        }
        case 'memo': {
          const definition = this.definitions.get(dep.key)
          if (!definition) return false
          const value = this.evaluate(definition.name, definition.id, definition.compute, null)
          if (value !== dep.ref) return false
          break
        }
      }
    }
    return true
  }

  private prune(): void {
    const cutoff = this.generation - 64
    for (const [key, entry] of this.entries) {
      if (entry.generation < cutoff) {
        this.entries.delete(key)
        this.definitions.delete(key)
      }
    }
  }
}

/** A read-only view of the state that records what is read. */
function track(state: ConversationState, deps: Dep[]): ConversationState {
  const tables = new Map<string, unknown>()
  const root = state as unknown as Record<string, unknown>
  return new Proxy(root, {
    get(target, key) {
      if (typeof key !== 'string') return Reflect.get(target, key)
      const value = target[key]
      if (TABLES.has(key) && typeof value === 'object' && value !== null) {
        let proxy = tables.get(key)
        if (!proxy) {
          proxy = trackTable(key, value as Record<string, unknown>, deps)
          tables.set(key, proxy)
        }
        return proxy
      }
      deps.push({ kind: 'field', key, ref: value })
      return value
    },
    set() {
      throw new Error('Projections may not write the state')
    },
  }) as unknown as ConversationState
}

function trackTable(name: string, table: Record<string, unknown>, deps: Dep[]): Record<string, unknown> {
  return new Proxy(table, {
    get(target, id) {
      if (typeof id !== 'string') return Reflect.get(target, id)
      const value = Object.hasOwn(target, id) ? target[id] : undefined
      deps.push({ kind: 'row', table: name, id, ref: value })
      return value
    },
    has(target, id) {
      if (typeof id !== 'string') return Reflect.has(target, id)
      deps.push({ kind: 'row', table: name, id, ref: Object.hasOwn(target, id) ? target[id] : undefined })
      return Object.hasOwn(target, id)
    },
    getOwnPropertyDescriptor(target, id) {
      if (typeof id === 'string') deps.push({ kind: 'row', table: name, id, ref: Object.hasOwn(target, id) ? target[id] : undefined })
      return Reflect.getOwnPropertyDescriptor(target, id)
    },
    ownKeys(target) {
      deps.push({ kind: 'keys', table: name, ref: target })
      return Reflect.ownKeys(target)
    },
    set() {
      throw new Error('Projections may not write the state')
    },
  })
}

/** Returns `previous` when `next` holds the same keys with identical values, so an unchanged record keeps its identity. */
export function shareRecord<T>(previous: { readonly [id: string]: T } | undefined, next: { readonly [id: string]: T }): { readonly [id: string]: T } {
  if (!previous) return next
  const keys = Object.keys(next)
  if (keys.length !== Object.keys(previous).length) return next
  for (const key of keys) if (previous[key] !== next[key]) return next
  return previous
}

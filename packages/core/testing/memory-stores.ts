import type { DomainEvent, LogId, PersistedEvent } from '@pluribus/protocol'
import { EventStoreConflictError, type CachedState, type EventStore, type ProjectionCache, type SecretName, type SecretsStore } from '../src/ports'

/** In-memory event logs. Appends are atomic and checked for gaps, like the real store. Events are stored as copies. */
export class MemoryEventStore implements EventStore {
  private readonly logs = new Map<string, PersistedEvent[]>()

  append(log: LogId, events: readonly DomainEvent[]): Promise<void> {
    const stored = this.logs.get(log) ?? []
    let expected = (stored[stored.length - 1]?.seq ?? 0) + 1
    for (const event of events) {
      if (event.log !== log) return Promise.reject(new Error(`Event ${event.id} belongs to log ${event.log}, not ${log}`))
      if (event.seq !== expected) return Promise.reject(new EventStoreConflictError(log, expected, event.seq))
      expected += 1
    }
    const copies = events.map((e) => structuredCloneJson(e) as PersistedEvent)
    this.logs.set(log, [...stored, ...copies])
    return Promise.resolve()
  }

  read(log: LogId, afterSeq = 0): Promise<readonly PersistedEvent[]> {
    return Promise.resolve((this.logs.get(log) ?? []).filter((e) => e.seq > afterSeq).map((e) => structuredCloneJson(e) as PersistedEvent))
  }

  lastSeq(log: LogId): Promise<number> {
    const stored = this.logs.get(log) ?? []
    return Promise.resolve(stored[stored.length - 1]?.seq ?? 0)
  }

  deleteLog(log: LogId): Promise<void> {
    this.logs.delete(log)
    return Promise.resolve()
  }

  /** Every log's ID, for tests. */
  logIds(): string[] {
    return [...this.logs.keys()]
  }
}

export class MemoryProjectionCache implements ProjectionCache {
  private readonly entries = new Map<string, CachedState>()
  saves = 0

  load(log: LogId): Promise<CachedState | null> {
    const entry = this.entries.get(log)
    return Promise.resolve(entry ? (structuredCloneJson(entry) as CachedState) : null)
  }

  save(log: LogId, cached: CachedState): Promise<void> {
    this.saves += 1
    this.entries.set(log, structuredCloneJson(cached) as CachedState)
    return Promise.resolve()
  }

  delete(log: LogId): Promise<void> {
    this.entries.delete(log)
    return Promise.resolve()
  }
}

export class MemorySecretsStore implements SecretsStore {
  private readonly secrets = new Map<SecretName, string>()

  get(name: SecretName): Promise<string | null> {
    return Promise.resolve(this.secrets.get(name) ?? null)
  }

  set(name: SecretName, value: string): Promise<void> {
    this.secrets.set(name, value)
    return Promise.resolve()
  }

  delete(name: SecretName): Promise<void> {
    this.secrets.delete(name)
    return Promise.resolve()
  }
}

function structuredCloneJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown
}

# @pluribus/storage

The event store, the projection cache and the local secrets store (11 · "Records and storage", Q58, Q63, Q64, Q69, Q70, Q73). Port types come from `@pluribus/core/ports`.

## Layout

| File | Contents |
|---|---|
| `src/adapter.ts` | `StorageAdapter`: the one adapter interface. A transactional key-value store with array keys in IndexedDB order and ordered range reads |
| `src/indexeddb-adapter.ts` | `openIndexedDbAdapter(schema, { indexedDB? })` over raw IndexedDB, with `idb`'s `wrap` for promises |
| `src/memory-adapter.ts` | `openMemoryAdapter(schema, database?)` with the same behavior; a `MemoryDatabase` outlives its adapters, so a test can reload |
| `src/event-store.ts` | `createEventStore(adapter)`: the `EventStore` port plus `listLogs()` and `readAttemptOutput()` |
| `src/projection-cache.ts` | `createProjectionCache(adapter)` |
| `src/secrets-store.ts` | `createSecretsStore(adapter)`: the `SecretsStore` port plus `isConfigured` and `clear`; `secretControls(store)` drops the read |
| `src/storage.ts` | `openIndexedDbStorage(options?)` and `createMemoryStorage(options?)` → `{ eventStore, projectionCache, secretsStore, close }` |
| `src/index.ts` | Public exports for `@pluribus/storage` |
| `testing/conformance.ts` | Shared adapter conformance suites, available as `@pluribus/storage/conformance` |
| `test/storage.test.ts` | Runs the conformance suites against both adapters (`fake-indexeddb` for IndexedDB) |
| `test/core-fakes.test.ts` | Runs the port conformance suites against core's in-memory fakes |

```ts
// In the Worker:
const { eventStore, projectionCache, secretsStore } = await openIndexedDbStorage()
// In tests:
const storage = createMemoryStorage()
```

## Databases

`pluribus-events` (version 1) has four object stores:

| Store | Key | Value |
|---|---|---|
| `events` | `[log, seq]` | The event exactly as appended, `v` included |
| `attempt-output` | `[log, attemptId, index]` | `seq` of that `attempt-output` chunk |
| `logs` | `[log]` | `{ log, createdAt }`: the directory of logs |
| `projections` | `[log]` | `{ throughSeq, stateVersion, state }` |

`pluribus-secrets` (version 1) has one object store, `secrets`: `[name]` → the value.

## Behavior

- **One log per conversation**, plus the app log (`APP_LOG`). Keys are arrays, so `[log, seq]` orders by sequence number as a number, and each log is a contiguous key range.
- **Append-only and atomic.** `append` checks the gap rule and writes the events, their attempt index entries and the log directory entry in one transaction. An append that does not start at `lastSeq + 1`, has a gap, or carries an event of another log rejects with `EventStoreConflictError` and stores nothing. A stored event is never rewritten; `deleteLog` is the one removal.
- **Ordered.** Both adapters run transactions in the order they were requested, and the gap check runs inside the append's transaction, so appends issued without waiting apply in call order and the second of two appends at the same position is rejected.
- **Streamed output grouped under its attempt.** Core writes coalesced `attempt-output` chunks (`CoreOptions.outputChunk`), never one event per token. The `attempt-output` store indexes them by attempt, so `readAttemptOutput(log, attemptId)` returns one attempt's chunks in chunk order without scanning the log.
- **Conversation list.** A log exists from its first append and is listed by `listLogs()` until `deleteLog`. The conversation list the user sees is the app log's projection (`conversation-created`, `conversation-deleted`); `listLogs()` is the storage-side view, for tools and tests.
- **Schema version preserved.** Events are stored as given and read back unchanged, at whatever `v` they were written with. The store never interprets them; core passes what `read` returns through `upcastEvent`.
- **Copies.** Values are structured-cloned in and out (IndexedDB does this natively; the memory adapter calls `structuredClone`).
- **Web Worker safe.** The IndexedDB adapter uses only `indexedDB`, `IDBKeyRange` and structured clone, which a dedicated Worker has. No `window`, `document` or `localStorage`. The connection opens lazily, closes itself when another context upgrades the database (`versionchange`), and reopens on next use after that or after the browser closes it.
- **Projection cache.** One entry per log; `save` replaces it. An entry that is not a well-formed `CachedState` loads as `null`, so core rebuilds from the log. `EventStore.deleteLog` does not touch the cache; deleting a conversation calls both.

## Where the embedded secrets store lives

**Decision: a separate IndexedDB database, `pluribus-secrets`, opened only by the backend in the Web Worker.** (12 lists this as left to the build, Q64; PLAN section 7 records the same choice.)

Why:

- **Apart from the event log (Q64, Q73).** A separate database, not an object store inside `pluribus-events`, means nothing that reads, exports, copies or clears the event database can reach the key, and no transaction ever spans both. `createSecretsStore` refuses an adapter whose database has any store but `secrets`, and `openIndexedDbStorage` refuses to give both databases one name.
- **Reachable from the Worker.** The backend runs in a Web Worker, which has IndexedDB but not `localStorage` or `sessionStorage`. Keeping the key in the Worker also means the client thread never reads it back: the key prompt sends it once in `change-settings` and forgets it.
- **Persists across reloads**, like the rest of the app's local data, so the user pastes the key once per browser profile.
- **Not encrypted at rest.** The browser offers nothing to encrypt it with that the same origin could not also decrypt; a non-extractable `CryptoKey` would protect against a copy of the database files only, at the cost of losing the key whenever that `CryptoKey` is lost. For a key the user pasted into a local app this is the same protection `localStorage` would give, without its exposure to the window.

What the store exposes: `set`, `clear` (the port's `delete`), `isConfigured`, and `get`, the read reserved for the backend (the provider's `getKey`). `secretControls(store)` returns the first three only, for any code that must not see the value. `set` trims surrounding whitespace and refuses an empty value. Every failure is a `SecretsStoreError` that names the operation and never contains the value. The conformance suite checks that, after a key is stored and events and a projection are written, a dump of every store in `pluribus-events` does not contain it.

## Adapter rules

A transaction callback may await only the transaction's own reads. Awaiting anything else lets an IndexedDB transaction commit early, and makes the in-memory adapter (whose transactions run on one queue) wait on itself. Writes (`put`, `delete`, `deleteRange`) are queued synchronously and applied at commit; a callback that throws aborts the transaction and nothing it wrote is kept.

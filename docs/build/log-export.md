# Log export ("Export full logs")

One JSON file per conversation with everything needed to debug a run and replay it: the complete event log, the settings in force, and derived views. The backend builds it; the page only saves it. Nothing is uploaded. The file contains the full text of the conversation and never the OpenRouter key.

## Where it is

- **Button**: the header's debug menu (the scan icon, "Debug views") → "Export full logs". The menu is in the header whether or not a debug view is on. While the backend builds the file the item reads "Preparing export…" and is disabled; then "Saved pluribus-log-….json" is announced (`role="status"`), or "Export failed: …" (`role="alert"`). File name: `pluribus-log-<conversation>-<YYYYMMDD-HHMMSS>.json`, UTC, from the backend's injected clock.
- **Backend request**: the snapshot query `{ kind: 'log-export', conversationId }` on `BackendClient` (`packages/protocol/src/backend.ts`), answered with a `LogExportFile` (`packages/protocol/src/log-export.ts`): the document already serialized, as string `chunks`, with `filename`, `mediaType`, `createdAt`, `length` and `eventCount`. It is a snapshot query rather than a new method so the existing Worker wire (`servePort`, `createPortClient`) carries it unchanged and every `BackendClient` (fixture backend included) stays one interface.
- **Core**: `exportLog` in `packages/core/src/engine/backend.ts` reads the inputs in one queued job (the stored events through the folded state's `throughSeq`, the app log, the projections, the folded state, the settings and the stored key), then builds the file outside the queue so other steps are not held up while a large log serializes. `buildLogExport` (`packages/core/src/engine/log-export.ts`) is pure.
- **Page**: `LogExportSource` (`packages/web/src/backend/log-export.ts`) has one method, `exportLog(conversationId)`, resolving to `{ kind: 'blob'; blob; filename } | { kind: 'url'; url; filename }`. The embedded source (`backendLogExportSource`) sends the query and wraps the chunks in a Blob without parsing them. A server deployment provides its own source with `LogExportSourceProvider` and returns a download URL; the button does not change. `saveLogExport` clicks a hidden `<a download>`; a Blob goes through an object URL that is revoked afterwards.

## The document

Schema `pluribus.log-export`, version 1. Top-level members, in this order, one per line:

| Member | What it is |
|---|---|
| `schema`, `version` | `"pluribus.log-export"`, `1` |
| `exportedAt`, `exportedAtMs` | The backend clock at export, ISO 8601 and milliseconds |
| `conversation` | `{ id, title, createdAt }` |
| `versions` | `{ protocol, eventSchema, state }`: the backend interface, the event schema and core's folded-state version |
| `settings` | The settings in force, as `AppSnapshot.settings` |
| `keyConfigured` | Whether a key was configured. Never the key |
| `appEvents` | The app log's events for this conversation (`conversation-created`, `conversation-titled`) and every `settings-changed` and `key-status-changed`, in order: how the settings came to be what they are |
| `events` | **The source of truth.** Every event of the conversation's log, in sequence order, exactly as stored, one per line. `events[seq - 1]` is the event with that `seq` |
| `derived` | Computed from `events`, for convenience. Replaying `events` gives the same values |

`derived` holds:

- `note`, `throughSeq`: what it reflects.
- `projections`: the four projections (transcript, queue, genealogy, operation graph) as the client reads them.
- `runs`: the run inspection (09 §5) of every directive, latest attempt, in directive creation order. The model input's `messages` are left out, because the `attempt-started` event already records them and the inspection reads them from there; `input.inputMessagesAt` gives that event's `seq`.
- `routingDecisions`: one entry per message, in submission order: `messageId`, `submittedSeq`, the first 120 characters of `text`, `routingInForce` (the latest `routing-decided`), `events` (every event about the message or its work except streamed text, as `{ seq, type }`), `directives` (label and each attempt's model, `startedSeq`, terminal event and number of output chunks) and `elicitationIds`.

Every object is written with a fixed key order (`schema`, `version`, `id`, `log`, `seq`, `v`, `at`, `type`, `kind` first, then the rest sorted), so the same log always gives the same text, and a line per event greps and diffs well.

## Where the routing decisions are

Start at `derived.routingDecisions`, find the message, and follow its `seq`s into `events`:

- `routing-decided` → `decision`: `source` and `model` of the decision model, `composition`, `units` (per unit: relation, targets, placement, prerequisites, with confidence), `thresholds`, `explanation`, and `questions`: every question put to the decision model with its answer. Where routing records them: `strategySelection`, `budgetStop`, `candidateSource`, `runEnds`. The latest `routing-decided` of a message is in force (Undo split routes again).
- `message-decomposed`: fragments with source spans and rewritten text, presentation, barrier, output order, split messages, decomposition model.
- `routing-failed`, `routing-retried`: provider failures and retries of routing.
- `directive-created` and the waits that follow (`directive-waiting`, `-held`, `-paused`, `-ready`, `prerequisites-changed`, `sibling-*`, `join-back-formed`): the plan carried out.
- `attempt-started`: each attempt's model, role, parents and the exact `context` it read (messages, node ids, inputs, corrections, session requirements, counted input tokens). Then `attempt-output` chunks and one of `attempt-completed`, `-failed` (with the retry plan), `-stopped`, `-interrupted`.
- `revision-recorded`, `section-superseded`, `superseded-input-noted`: corrections and recovery.
- `elicitation-raised`, `-edited`, `-answered`, `-defaulted`, `-withdrawn`: questions put to the user and the choices made. An `elicitation-raised` for a target ambiguity carries `decision`: the routing decision behind the question, in the shape of a `routing-decided` decision with no `units`. Its `questions` are every question put to the decision model with its answer (each section by itself, several sections, several lines of work, the line choice), beside the `thresholds` in force. No `routing-decided` exists for the message until the user has chosen, so this is the only record of why it was asked. `derived.routingDecisions[].routingAsks` points at these events.

The export carries events and inspections whole, so fields that later work adds to them (for example more of what the decision model was shown, or readiness results) are exported without a change here.

To replay: `fold(emptyConversationState(id), doc.events)` in core gives the backend's state; `projectSnapshot(new Projector(), state)` gives `derived.projections`; `runInspection(state, directiveId, null)` gives each run (with `input.messages`).

## The key

The key lives in the secrets store and is in no event. The export cannot contain it by construction; as a guard, `buildLogExport` searches the serialized text for the stored key (keys of 8 characters or more) and, if it is there, fails the export with "The export was not produced: it contained the stored OpenRouter key" instead of emitting it. That happens only if the user typed the key into the conversation. The error never repeats the key.

## Size and time

Measured by `packages/core/test/engine/log-export.measure.test.ts` (Node 22, in-memory store, which copies every event on read as IndexedDB does): 2,000 answer sections on lines of ten (each message continues the previous answer of its line, so contexts reach nine earlier exchanges), answers of about 700 characters streamed in 90-character chunks.

| | 2,000 sections |
|---|---|
| Events | 29,400 (7,200 `attempt-output`) |
| Export (read, inspect every run, serialize, guard) | 1,047 ms, in the Worker |
| File | 36.6 MB in 119 chunks of about 256 K characters |
| `JSON.parse` of the file | 191 ms |
| Shares | events 21.2 MB (of which `attempt-started` contexts 11.8 MB), projections 6.9 MB, runs 6.6 MB, index 1.8 MB |

Run it with `LOG_EXPORT_MEASURE=1 pnpm vitest run --project unit packages/core/test/engine/log-export.measure.test.ts --silent=false`; the ordinary suite runs it at 200 sections (3.5 MB, about 100 ms).

The file is built in the Worker and crosses to the page as strings, which the page puts in a Blob as they are: nothing is parsed or stringified on the UI thread. One JSON document was kept rather than JSON Lines because at this size a single document still parses in well under a second, it opens in any JSON viewer, and the one-event-per-line layout already gives line-wise grep and diff. Run inputs are the largest part and grow with context length; that is the log itself, so it is not trimmed. Loading that 2,000-section log into a fresh test backend took 21.5 s, which is the backend's start, not the export.

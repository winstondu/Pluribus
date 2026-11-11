# 11 · Architecture

The accepted technical design for Committee, by area. Question numbers in parentheses trace each statement to its source decision; where a later answer conflicts with an earlier one, only the later one is stated. Terms are defined in the [glossary](glossary.md).

Related specifications:

- Client commands, transcript, and composer: [10-front-end.md](10-front-end.md).
- Inspector and debug-view content: [09-debug-views.md](09-debug-views.md).
- Milestones, test strategy, and build order: [12-build-plan.md](12-build-plan.md).

No production implementation exists.

## Invariants

Every part of the design must preserve these. They come from the accepted scenarios.

1. **Three separate relationships.** Context ancestry (chains, forks, join-backs, join chains), result dependencies (a DAG over attempts and join-backs), and display placement are kept separately. None is derived from another.
2. **Exact consumed context.** Every attempt records the context it actually received. Later join-backs, revisions, or retries never rewrite it (Q29, Q31, Q39).
3. **Append-only history.** Superseded, failed, stopped, and interrupted attempts are retained and marked, never rewritten (Q35, Q38, Q47–Q52).
4. **Dependencies release only on success.** Never on streaming text. A full join-back releases only after its sibling group closes and finishes. No dependent may bypass a full join-back by consuming a subset of it (Q30, Q33, Q48).
5. **Local failure.** There is no aggregate failed or cancelled request state; failure is local to the directive (Q27, Q50).
6. **Placement.** User messages appear in submission order, with split messages in topological order (Q53). A reply's position is fixed at its first visible output; a failure notice counts as output (Q51).
7. **Rewound replacement context.** Replacements and retries never consume an earlier attempt's partial text (Q38, Q47).
8. **No server assumed.** Whatever executes runs can be interrupted; recovery follows the retry setting (Q52, Q54).
9. **The decision model is bounded.** The decision model (a Jev model, reached through OpenRouter Decisions) selects among supplied candidates (targets, relations, affected work). It never generates rewritten fragments (Q20, Q44).
10. **Scope.** Text and read-only work only, initially. No LangChain or LangGraph.

## System structure

### Portable backend

The Committee backend comprises the orchestrator and the coordinator (scheduling, dependency tracking, context assembly). It runs either embedded in the client or on a server. Both deployments are TypeScript and share as much code as possible behind one interface (Q55, Q62; ADR-0005). A client-only design is not the target: the server deployment must remain possible.

- **Embedded:** the backend runs in a Web Worker. Closing the tab is the interrupted case (Q52, Q62).
- **Server:** the client talks to the backend over WebSocket, or SSE plus POST (Q62). The server backend and its store are built after the embedded one (Q63, Q66).

Interrupted execution in either deployment is recovered by the retry setting (Q52, Q54).

### Client stack

A TypeScript web app built with Vite and Tailwind (Q56).

### Shared interface

- The client sends **commands** to the backend (Q62, Q79). The command set is specified in [10-front-end.md](10-front-end.md). Revision is not a command; it is a routing outcome of a submitted message (Q37, Q79).
- The backend sends the client an **ordered stream** of domain events and projection updates (Q62).
- The client can read the backend's **current projection snapshot** on demand, for example on load or reconnect (Q62).
- The same TypeScript types serve both deployments (Q62).

### Core boundary

The core engine maintains chains, the operation queue of directives, and persistence and caching. The decomposer, the decision provider, and the model provider are dependencies injected into core, not part of it (Q71).

### Repository layout

A pnpm workspace (Q66):

| Package | Contents |
|---|---|
| `core` | Domain events, projections, coordinator, validation. No I/O. |
| `providers` | OpenRouter (answers and decomposition), the decision provider over OpenRouter Decisions (Q68), and a fake provider. |
| `storage` | IndexedDB and in-memory adapters. |
| `protocol` | Shared command and event types. |
| `web` | The Vite + Tailwind client. |
| `server` | Later. |

## Records and storage

### Event log and projections

- The source of truth is an append-only log of domain events: submissions, splits, attempt lifecycle, streamed output, join-backs, elicitation answers (Q58; ADR-0006).
- The transcript, genealogy, operation graph, and queue are projections derived from the log. They are cached and updated incrementally, not recomputed in full on each change (Q58).
- The event store and the projection cache each sit behind a storage-agnostic interface with swappable adapters; both use the same adapter interfaces (Q58, Q63).

### Event identity and versioning

- One event log per conversation (Q69, Q70).
- Each event carries a ULID and a per-conversation sequence number (Q69).
- Every entity (message, fragment, attempt, chain, join-back) has a stable ID (Q69).
- Events carry a schema version and are upcast on read, never rewritten (Q69).
- Streamed output is stored in chunks grouped under its attempt, not one event per token (Q69).

### Adapters

- IndexedDB for the embedded backend; in-memory for tests (Q63).
- A server store waits for the server backend (Q63).

### Conversations

- The app holds a list of conversations, each with its own event log (Q70).
- Chains, join-backs, and dependencies never cross conversations (Q70).
- Session-wide requirements (Q17) apply within one conversation (Q70).
- Retry policy, models, and keys are app-wide (Q70).

## Context

### Ownership

The backend builds every run's context itself from its own records. It does not use provider-side conversation state (Q57; ADR-0005). Model calls go through OpenRouter's API (Q57).

### Assembly

Each run's context is assembled mechanically from the genealogy (Q76):

- the handling chain's ancestry, including any join-backs and join chains it depends on;
- requirements explicitly made session-wide (Q17);
- revision corrections, with replacement results standing in for superseded ones (Q39);
- for a join-back member that failed, was stopped, or was interrupted, its request and a marker, without its partial text; a retry after the group closed follows as a descendant of the join-back (Q49, Q92).

There is no per-node relevance scoring (Q76).

### Placement in the genealogy

The decision model's only placement choice for new work is one of (Q76):

- **New chain:** unrelated work starts a fresh chain.
- **Continue an existing chain**, including continuing from a join-back. Work continuing from a full join-back is the same chain continuing, with no new chain identity or color (Q78).
- **New join chain:** merges leaf-node cousins within one tree, or previously separate trees. A join chain has two or more parents, each a leaf of its chain at the moment the join chain is created; a non-leaf node cannot be a parent (Q86, Q88).

Targets and dependencies are selected among supplied candidates (Q59, Q76).

### Context growth

Compaction is out of scope. Until it is designed, the backend counts tokens before each run, warns near the model's limit, and fails the directive as non-retryable rather than silently truncating (Q67, Q82).

## Routing

### Pipeline

Each submitted message passes through four stages (Q59):

1. **Decision gate.** Bounded, typed questions over supplied candidates, sent to the decision model through OpenRouter Decisions (Q68). The questions are:
   - atomic or composite;
   - reply relation: new work, revision (Q37), result-dependent, or addition;
   - target section or sections;
   - target agent chain (handling chain) and the message's dependencies;
   - affected work, for shared-requirement revisions (Q44).
2. **Generative decomposition**, only when the gate judges the message composite: structured fragments with exact source spans, requirement scope, and candidate dependencies.
3. **Deterministic validation:** dependencies are acyclic, no subset bypasses a full join-back, and split messages are ordered topologically (Q53).
4. **Scheduling** (see below).

Both the original text and any generated rewrite are recorded (Q59). Whether trivial messages skip the decision gate is decided after latency is measured (Q59).

### Decision provider

- Bounded routing questions go to OpenRouter's Decisions API (`openRouter.alpha.decisions.create`), which serves TypeSafe's Jev models with the `noul`, `choice`, and `score` question types (Q68).
- One OpenRouter key covers answers, decomposition, and decisions. There is no separate Jev key (Q68).
- There is no fallback implementation. Core keeps a `DecisionProvider` interface so one can be added if the alpha API changes (Q77).

### Decision thresholds

- The decision model is pinned to a versioned model, not a moving alias (Q74).
- Below the target-choice confidence threshold, Committee elicits the target (Q20, Q74).
- Below the "clearly corrective" threshold, a reply is treated as additional work rather than a revision (Q37, Q74).
- Thresholds are tuned on the labelled routing corpus and are a frontend setting sent to the backend (Q74).

## Scheduling and errors

### Scheduling policy

- A per-provider concurrency limit is a user setting, default 4 (Q60).
- Ready work runs in submission order, then by split-message position (Q60).
- Dependents become ready on the prerequisite's success event (Q60).
- Rate limits surface as "Waiting for capacity" (Q47, Q60).
- Fairness tuning and budgets wait for real usage (Q60).

### OpenRouter error mapping

Treatment follows the retry setting (Q47, Q75):

| Response | Treatment |
|---|---|
| 408, 429, 502, 503; empty 200 | Transient: retried automatically, honoring `Retry-After`. 429 shows "Waiting for capacity". |
| 402 (credits or budget) | Non-retryable: "Out of OpenRouter credits". |
| 403 (moderation) | Non-retryable, with the reason. |
| 400, 401 | Non-retryable, with the message. |
| `context_length_exceeded` | Non-retryable (Q67, Q82). |
| Mid-stream error chunk (`finish_reason: "error"` under HTTP 200) | Fails the attempt, then follows the retry setting. |

Stopping aborts the request. Committee does not work around providers that keep billing after an abort (Q75).

## Providers, keys, and models

### Browser access

The embedded Web Worker calls OpenRouter directly, with no CORS proxy (Q72). Jev is not called directly (Q68, Q72).

### Keys

- **Embedded:** the user pastes an OpenRouter key into settings (Q73). It is stored locally in a secrets store separate from the event log, never in the log (Q64, Q73). OAuth PKCE ("Connect OpenRouter") is deferred past the MVP (Q73).
- **Server:** keys come from the server environment and never reach the client (Q64).
- Settings show only whether a key is configured (Q64).

### Models

- Model choice is per role, using OpenRouter model IDs (Q65):
  - answer runs, including work continuing from a join-back (Q90);
  - generative decomposition;
  - synthesis, for join chains only (Q65, Q90);
  - the pinned decision model (Q74).
- **Embedded:** configurable from the frontend. **Server:** set by server environment settings (Q65).
- Each attempt records the model it used (Q65).

## Inspection

The backend must expose enough of its records for the run inspector, genealogy, and operation graph to show exact consumed context, routing decisions, and attempt states (Q31, Q87). What each view shows and which are behind debug toggles is specified in [09-debug-views.md](09-debug-views.md).

## Appendix: integration facts

Facts, not decisions, researched and dated **2026-11-10**. They may go out of date. Committee reaches Jev only through OpenRouter Decisions (Q68), so the direct TypeSafe API details are background, not constraints on the build.

### OpenRouter

- Browser calls work: CORS returns `Access-Control-Allow-Origin: *`. A preflight to `/api/v1/chat/completions` from `http://localhost:5173` returned 204 with POST, Authorization, and Content-Type allowed (Q72).
- Users can obtain their own key through documented OAuth PKCE; localhost callbacks are allowed. Keys should carry credit limits.
- Streaming is SSE, with comment lines to skip.
- Aborting the connection stops processing and billing for supported providers (OpenAI, Anthropic, and others) but not all (for example Google, Bedrock, Groq, Mistral).
- Structured output uses `response_format` with a JSON schema. Support varies by model and provider (`provider.require_parameters: true`), and some providers treat strict schemas as hints.
- Errors: 400, 401, 402 (credits or budget), 403 (moderation), 408, 429, 502, 503, with `Retry-After` on 429 and 503. Mid-stream errors arrive as SSE chunks with `finish_reason: "error"` under HTTP 200. Empty 200 responses can occur. Typed error codes include `context_length_exceeded`.
- Paid models have no platform request cap; upstream providers may still return 429.

### OpenRouter Decisions

- Alpha (`openRouter.alpha.decisions`); the documentation warns that the shape may change.
- Request: `{model, questions, state, assets?}`. Response: one typed answer per question, with probabilities.
- Documented model example: `typesafe/jev-1.13`. Question types `noul`, `choice`, `score` (Q68).
- Error codes 400–529. Streaming, pricing, and rate limits are undocumented.
- A preflight to `/api/alpha/decisions` returned 204 with `*`. The path is inferred; the SDK page does not state it (Q72).

### Jev direct API (TypeSafe AI), background only

- Hosted HTTP API: `POST https://api.typesafe.ai/v1/systemone`, Bearer auth. JS SDK `@typesafe-ai/sdk` (engines Node ≥ 22).
- Request `{model, state, questions}`. Question types: `noul` (yes/no probability), `choice` (1–255 named options; returns the choice, confidence, and probabilities), `score`.
- Questions in one call are independent over the same state and cannot chain. Batching is strongly recommended; one cookbook reports 13 questions in 0.24 s batched against 2.81 s separately.
- `jev-1.14.0` (the current `jev-latest`): $0.042 per million input tokens, output free; 64k context per request, 32k per question. Pin a versioned model when tuning thresholds.
- Errors 400, 401, 413, 422, 429, 529; back off on 429 and 529. No streaming.
- The SDK's `dangerouslyAllowBrowser` defaults off, with a warning about key exposure.
- Observed, not documented: CORS allows only `https://console.typesafe.ai`, so the direct API cannot be called from Committee's browser or Worker.

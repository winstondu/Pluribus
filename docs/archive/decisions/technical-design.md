> **Archived.** Historical record, kept read-only and no longer maintained. The current specification is [docs/spec/](../../spec/README.md); see the [archive README](../README.md) for how to read this file.

# Technical design (batch 7)

Status: Q55–Q77 accepted, with Q78–Q87 review decisions applied (Q79, Q82, and Q87 here; see the [review batch record](review-batch-q78-q88.md)). MVP-only choices (Q73) live in [MVP decisions](mvp-decisions.md). The resulting work is inventoried in [build scope, now part of the specification](../../spec/README.md). No production implementation exists.

Derived from scenarios 1–6, the glossary, and ADRs 0002–0004. Scenario decisions override anything here.

## Invariants the design must satisfy

From accepted scenarios. Each should become an automated test.

1. **Three separate relationships**: context ancestry (chains, forks, join-backs, join chains), result dependencies (a DAG over attempts and join-backs), and display placement (ADR-0003). None is derived from another.
2. **Exact consumed context**: every attempt records the context it actually received; later join-backs, revisions, or retries never rewrite it (Q29, Q31, Q39).
3. **History is append-only**: superseded, failed, stopped, and interrupted attempts are retained and marked, never rewritten (Q35, Q38, Q47–Q52).
4. **Dependencies release only on success**: never on streaming text; full join-back only after its group closes and finishes; no subset bypass (Q30, Q33, Q48).
5. **Local failure**: no aggregate failed or cancelled request state (Q27, Q50).
6. **Placement**: user messages in submission order (split messages in topological order, Q53); replies fixed at first visible output, a failure notice counting as output (Q51).
7. **Rewound replacement context**: replacements and retries never consume earlier partial text (Q38, Q47).
8. **No server assumed**: whatever executes runs can be interrupted; recovery follows the retry setting (Q52, Q54).
9. **Jev is bounded**: it selects among supplied candidates (targets, relations, affected work); it never generates rewritten fragments (Q20, Q44).
10. **Text and read-only work initially; no LangChain or LangGraph.**

## Prior technical notes

The chronological design record (`concurrent-chat-design.md` in the original discussion folder) notes: concurrency comes from independent runs on shared serving, not model copies; one Jev call's questions see the same input and cannot chain; record both the source text and any generated rewrite; avoid a mandatory classification call on every trivial message until latency is measured. A candidate pipeline was: original message → decomposition when needed → candidate target/context selection → bounded relation classification → validated task graph → scheduling.

## Accepted decisions

Grouped by area; question numbers show the order in which they were settled. Q73 is in [MVP decisions](mvp-decisions.md).

## Architecture and deployment

### Q55: Portable backend (ADR-0005)

The Committee backend (coordinator: scheduling, dependency tracking, context assembly) runs either embedded in the client or on a server. Both are TypeScript and share as much code as possible behind one shared interface. Interrupted execution in either place is handled by Q52/Q54.

### Q56: Client stack

TypeScript web app built with Vite and Tailwind.

### Q62: Shared interface

The backend owns the orchestrator and coordinator. The client sends commands (submit, stop, retry, regenerate, continue without, cancel, answer elicitation, undo split, change settings, and create, list, or delete conversation; list corrected by Q79) and receives an ordered stream of domain events and projection updates; it can also read the backend's current state (projection snapshot) on demand, e.g. on load or reconnect. The same TypeScript types serve both deployments: the embedded backend runs in a Web Worker (closing the tab is Q52's interrupted case); a server backend uses WebSocket or SSE + POST.

### Q79: Commands

Revision is not a command: it is what routing concludes from a submitted message (Q37). Regenerate is a command that cancels any ongoing work for its item and redoes it against the new version of what it depends on (Q40). The paused-dependent choices Continue without and Cancel (Q48) and conversation create, list, and delete (Q70) are commands.

### Q66: Repo layout

pnpm workspace: `core` (domain events, projections, coordinator, validation; no I/O), `providers` (OpenRouter, Jev, fake), `storage` (IndexedDB, in-memory), `protocol` (shared command/event types), `web` (Vite + Tailwind), `server` later.

## Records and storage

### Q58: Event log and projections (ADR-0006)

The source of truth is an append-only log of domain events. The transcript, genealogy, operation graph, and queue are derived projections, cached and updated incrementally rather than recomputed in full on each change. The storage layer is agnostic: event store and projection cache sit behind interfaces with swappable adapters.

### Q69: Event identity and versioning

One event log per conversation. Events carry ULIDs and a per-conversation sequence number; every entity (message, fragment, attempt, chain, join-back) has a stable ID. Events carry a schema version and are upcast on read, never rewritten. Streamed output is stored in chunks grouped under its attempt, not one event per token.

### Q63: Storage adapters and build order

Build the embedded backend first. First adapters: IndexedDB (embedded) and in-memory (tests). A server store waits for the server backend. Event store and projection cache use the same adapter interfaces.

### Q70: Multiple conversations

A conversation list, one event log each. Chains, join-backs, and dependencies never cross conversations. Session-wide requirements (Q17) apply within one conversation; retry policy, models, and keys are app-wide.

## Context

### Q57: Context ownership and provider (ADR-0005)

The Committee backend builds every run's context itself from its own records; it does not rely on provider-side conversation state. Model calls go through the OpenRouter API.

### Q76: Context selection

Each run's context is assembled mechanically from the genealogy: the handling chain's ancestry (including join-backs and join chains it depends on), explicitly session-wide requirements (Q17), and revision corrections with replacements standing in for superseded results (Q39). No per-node relevance scoring.

The decision model's only placement choice is one of:

- **New chain**: unrelated work starts a fresh chain.
- **Continue an existing chain**, including continuing from a join-back.
- **New join chain**: merging two leaf-node cousins within one tree, or merging previously separate trees. Its parents are always leaves; non-leaf parents are not allowed (Q86). It may have two or more parents; Q88 supersedes “two” here.

Work continuing from a full join-back, such as scenario 4's J, is the second case: the same chain continuing, with no new chain identity (Q78).

Targets and dependencies are selected among supplied candidates as in Q59.

### Q67: Context growth

Compaction is its own design question, out of scope for now. Interim, confirmed by Q82: count tokens before each run, warn near the limit, and fail the directive as non-retryable rather than silently truncating.

## Routing

### Q59: Routing pipeline

1. **Jev gate** (called through OpenRouter's Decisions API, Q68): bounded typed questions over supplied candidates: atomic or composite; reply relation (new work, revision per Q37, result-dependent, addition); target section(s); target agent chain (handling chain) and dependencies for the message; affected work for shared-requirement revisions (Q44).
2. **Generative decomposition**, only when Jev judges the message composite: structured fragments with exact source spans, requirement scope, and candidate dependencies.
3. **Deterministic validation**: acyclic dependencies, no subset bypass of a full join-back, topological ordering of split messages (Q53).
4. **Scheduling.**

Both the original text and any rewrite are recorded. Whether trivial messages skip the Jev gate is decided after measuring latency.

### Q68: Routing through OpenRouter Decisions

Bounded routing questions go to OpenRouter's Decisions API (`openRouter.alpha.decisions.create`), which serves TypeSafe's Jev models (documented example `typesafe/jev-1.13`) with the same `noul` / `choice` / `score` question types. One OpenRouter key covers answers, decomposition, and decisions; there is no separate Jev key.

### Q74: Decision thresholds

Pin a versioned decision model, not a moving alias. Below the target-choice confidence threshold, elicit the target (Q20); below the “clearly corrective” threshold, treat the reply as additional work (Q37). Thresholds are tuned on the Q61 corpus and are a frontend setting sent to the backend.

### Q77: Decision provider fallback

No fallback implementation. Core keeps a `DecisionProvider` interface so one can be added if the alpha Decisions API changes.

## Scheduling and errors

### Q60: Scheduling policy

Per-provider concurrency limit as a user setting, default 4. Ready work runs in submission order, then split-message position. Dependents become ready on the prerequisite's success event. Rate limits surface as Q47's “Waiting for capacity”. Fairness tuning and budgets wait for real usage.

### Q75: OpenRouter error mapping

| Response | Treatment under Q47 |
|---|---|
| 408, 429, 502, 503; empty 200 | Transient: auto-retry honoring `Retry-After`; 429 shows “Waiting for capacity” |
| 402 credits/budget | Non-retryable: “Out of OpenRouter credits” |
| 403 moderation | Non-retryable, with reason |
| 400, 401 | Non-retryable, with message |
| `context_length_exceeded` | Non-retryable (Q67 interim) |
| Mid-stream error chunk (`finish_reason: "error"`, HTTP 200) | Fails the attempt, then follows the retry setting |

Stopping aborts the request; Committee does not work around providers that keep billing after an abort.

## Provider access, keys, and models

### Q72: Browser access

The embedded Web Worker calls OpenRouter directly; no CORS proxy. The user verified the `/api/v1/chat/completions` preflight from `http://localhost:5173` (204, `Access-Control-Allow-Origin: *`, POST/Authorization/Content-Type allowed). A preflight to `/api/alpha/decisions` (path inferred; the SDK page does not state it) also returned 204 with `*`. Jev's direct API is unnecessary, so its CORS restriction no longer matters.

### Q64: Keys

Embedded: the user supplies an OpenRouter key (Q68 removed the separate Jev key; Jev is reached through OpenRouter), stored locally in a secrets store separate from the event log. Server: keys come from server environment and never reach the client. Settings show only whether a key is configured.

### Q65: Model settings

Per-role model choice (answer runs, generative decomposition, synthesis for join chains (work continuing from a join-back is an answer run, Q78), and the pinned decision model) using OpenRouter model IDs. Embedded: configurable from the frontend. Server: from server environment settings. Each attempt records the model it used.

## Inspectors

### Q87: Run inspector and visibility

Selecting a run reveals:

1. The original user message and source fragment.
2. The resolved instructions and applicable requirements, with provenance.
3. The exact model input for that attempt, including selected history and result inputs.
4. The unfinished results it is waiting for, shown separately from context ancestry.
5. The routing decision and its explanation, with decision confidence where available, without implying correctness.
6. The attempt version and whether its result is current, superseded, failed, stopped, or interrupted.
7. The visible answer section the result belongs to.

Margin rails with Focus and the “split from one message” link (Q53) are always available. The chain mini-map, operation graph, and run inspector sit behind debug toggles.

## Testing and build order

### Q61: Test strategy

Every acceptance condition in scenarios 1–6 becomes a deterministic coordinator test using a scripted fake provider that controls streaming timing, failures, and interruptions. A labelled routing corpus (targets, chains, revision vs addition, splits, dependencies) evaluates Jev and the decomposer offline. Live model calls run only in a small smoke suite.

### Q71: Milestone order and core boundary

Order: (1) `core` + fake provider with scenario 1/3/4 tests; (2) OpenRouter streaming + IndexedDB; (3) web transcript (Sections, responding bubbles, composer queue); (4) routing (decisions, decomposition, validation); (5) revisions and recovery, then inspectors. Implementation starts only on the user's go-ahead.

The core engine maintains chains, the operation queue of tasks, and persistence/caching. The decomposer, relevance/decision provider, and model provider are input dependencies injected into core, not part of it.

## Integration facts (researched 2026-11-10)

Facts, not decisions. Raw doc pages were saved in the session scratchpad.

Since Q68, Committee reaches Jev only through OpenRouter Decisions. The direct TypeSafe API details below (endpoint, SDK, CORS restriction, pricing) are background, not constraints on the build.

**Jev (TypeSafe AI)**: hosted HTTP API, `POST https://api.typesafe.ai/v1/systemone`, Bearer auth; JS SDK `@typesafe-ai/sdk` (Node ≥22 engines). Request `{model, state, questions}`; question types `noul` (yes/no probability), `choice` (1–255 named options; returns choice, confidence, probabilities), `score`. Questions in one call are independent over the same state; batching is strongly recommended (one cookbook: 13 questions in 0.24 s batched vs 2.81 s separately). `jev-1.14.0` (current `jev-latest`): $0.042 per million input tokens, output free, 64k context per request / 32k per question. Pin a versioned model when tuning thresholds. Errors 400/401/413/422/429/529; back off on 429/529. No streaming. SDK `dangerouslyAllowBrowser` defaults off with a warning about key exposure. **Observed, not documented:** CORS allows only `https://console.typesafe.ai`; localhost and other origins are rejected, so Jev cannot currently be called from Committee's browser or Worker.

**OpenRouter Decisions**: alpha (`openRouter.alpha.decisions`, “the shape may change”); request `{model, questions, state, assets?}`; one typed answer per question with probabilities; error codes 400–529; streaming, pricing, and rate limits undocumented.

**OpenRouter**: browser calls work (observed CORS `*`). Users can obtain their own key through documented OAuth PKCE (localhost callbacks allowed), and keys should carry credit limits. SSE streaming with comment lines to skip; aborting the connection stops processing and billing for supported providers (OpenAI, Anthropic, and others) but not all (e.g. Google, Bedrock, Groq, Mistral). Structured output via `response_format` json_schema; support varies by model and provider (`provider.require_parameters: true`), and some providers treat strict schemas as hints. Errors: 400, 401, 402 (credits/budget), 403 (moderation), 408, 429, 502, 503, with `Retry-After` on 429/503. Mid-stream errors arrive as SSE chunks with `finish_reason: "error"` under HTTP 200; empty 200 responses can occur. Typed error codes include `context_length_exceeded`. Paid models have no platform request cap; upstream providers may still 429.

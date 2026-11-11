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
   - target section or sections, found by [dependency attachment](#dependency-attachment);
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

## Dependency attachment

The part of routing that decides which earlier work a message or fragment attaches to: its **referents**, and from them its reply targets, its place in the genealogy, and the results it waits for. It answers the decision gate's questions about target sections and dependencies ([Pipeline](#pipeline)).

This section was settled after Q98, by the user's instructions of 2026-11-11. They are quoted, with the measurements behind each choice, in the build records: [dependency decisioning](../build/dependency-decisioning.md) and [context summaries](../build/context-summaries.md). They have no question numbers yet.

**Scope.** The architecture is part of the first version: the interfaces, the settings, the guard, and what is recorded. Optimizing it is not. [Scope in the first version](#scope-in-the-first-version) says which is which.

### Contract of the stage

- **Input.** One unit (the message, or one fragment of a composite) and the genealogy as supplied candidates: the current answer sections, the work behind them, the chains, and the sibling groups with their join-backs. Nothing else is read (invariant 9).
- **Output.** The unit's referents: the answer sections it may refer to, each with a confidence, and the probability that it refers to several at once. A section that is not returned is not a referent.
- **A strategy scores; it places nothing.** Everything after it is the same whichever strategy was used, and is binding:
  - A referent at or above the target-choice threshold is a reply target. Below it, Committee elicits the target; it never guesses ([05](05-reply-targets-and-routing.md), [07](07-elicitation.md); Q20, Q74).
  - Two or more members of one sibling group are the whole group: the unit depends on the full join-back, never on a subset (invariant 4; Q30; C9, C19).
  - Placement is a new chain, a continuation, or a new join chain whose parents are leaves ([Placement in the genealogy](#placement-in-the-genealogy); Q76, Q86; C20).
  - Dependencies are acyclic, and a plan that breaks a rule is repaired where it has one correct reading and refused otherwise ([Pipeline](#pipeline), stage 3).
- **Given targets are used as given.** An explicit reply target, or one the user chose in a target-ambiguity elicitation, is not scored and no strategy is consulted (Q10, Q20).

### Referent strategies

How referents are found is a **referent strategy** behind one interface. The pipeline is handed a strategy and never asks which one it has, so a strategy can be replaced without touching the rules above. Two exist.

| | One pass | Tree walk |
|---|---|---|
| Asks about | Every answer section the routing request lists (the most recent ones), and each sibling group among them as a whole | The genealogy level by level from every root, only along lines that are relevant |
| Requests | The routing request that is sent anyway. No further request | That request, and one more for each branching level it descends and each step of a search, within the [decision budget](#decision-budget) |
| Reach | The listed sections. An older section is never asked about | Any section, however old |

Terms the tree walk uses. A **branch point** is a place where a line of work splits: a node with two or more continuations, a sibling group's join-back among them. An **unbranched run** is the answers of one line between two branch points, each continuing the one before; it is not a model run. The **trunk** of a root is its first unbranched run, down to the first branch point, or to its tip when the line never splits; the last answer of a trunk is its **base**.

**One pass**

- One yes-or-no question per listed section, one per sibling group as a whole, and whether the unit refers to several sections, all in the routing request.

**Tree walk**

- The trunks are asked about first, in the routing request as far as it lists them. Each further level is one further request that shows only that level's sections.
- It descends below an unbranched run only when one of its sections, or the question "does the unit refer to anything built on this?", is at least plausible. Nothing below an irrelevant line is asked about.
- **Search of long unbranched runs.** An unbranched run too long to ask about section by section is searched: its sections are put in chunks, each chunk is one question that names its sections by the requests they answered, and only the sections of a relevant chunk are then asked about one by one. The requests it needs grow with the logarithm of its length. Old single answers that nothing was built on count as one unbranched run.
- **Start at the trunk base** (optional, off by default). Of each trunk only the base is asked about by itself; the answers before it are searched, however few.
- **Hop between branch points** (optional, off by default). Below a branch point, of each unbranched run only its last answer is asked about by itself; the answers skipped are searched.

**Both strategies**

- A sibling group is asked about as a whole, as the join-back it is or will be, beside its members. A group judged relevant resolves to every member (Q30).
- An ancestor of a relevant node is dropped: the descendant's context already holds it. The exception is a correction, which may name work its descendants only consumed ([06](06-revisions.md#revising-a-shared-requirement)); for a unit with clearly corrective wording the ancestor is kept.
- **Nothing is placed silently on a section that was not asked about by itself.** A question about several sections (a chunk, or "anything built on this") only decides where to look next. When a search cannot be finished, the sections of the relevant chunk are returned below the target-choice threshold, so the user is asked which one is meant.

What a strategy cannot reach it does not guess at: the unit is routed as if it referred to nothing there.

### Decision budget

A guard on what routing one message may cost in decision-model work. It applies to every decision request of the routing: the pipeline's own, the strategy selector's, and the referent strategy's.

| Limit | What it is | Initial value |
|---|---|---|
| Token budget | Decision input tokens per routing. Either **absolute**, a fixed number, or **relative**: a share of the tokens recorded in the conversation's log, with a floor so that a new conversation is not starved and a ceiling so that a huge one is not unbounded | Relative: 2% of the log, at least 16,000 and at most 40,000 tokens |
| Bound against the answer | The decision requests of a routing cost at most a multiple of the answer they route, priced on the cheapest answer model offered | Twice the answer |
| Backstops | Further requests and questions per routing, whatever the tokens and prices | 4 requests, 96 questions |

- **The smaller limit applies.** A routing may use the lesser of the token budget and what the bound against the answer allows.
- **The conversation's log**, for a relative budget, is the text of every user message and of every attempt. Superseded, failed, stopped, and interrupted attempts count, with the partial text they recorded: they are part of the append-only history (invariant 3), and counting them means a revision never shrinks the budget. It is computed from the backend's records alone.
- **The answer's cost** is estimated before it is written: its least input, the message itself, and its expected length, taken from the conversation's completed answers, or a set figure while there are too few.
- **Decided before sending.** Every request is sized by an estimate and compared with what is left. A request that would pass a limit is not sent. The guard therefore never depends on a provider's reply, and routing stays deterministic.
- **The routing request draws from the budget first.** When it would not fit with every section it normally lists, it lists fewer, the most recent, down to a small minimum. One request is always sent, because a message has to be routed.
- **Two requests are counted but never refused**, because no plan can be made without them: the confirmation that a requirement was made session-wide (Q17), and the question which consumers a shared-requirement revision affects (Q44).
- **When a limit is reached** the strategy falls back deterministically: it asks about the listed sections it has not yet asked about in one request if that still fits, and otherwise keeps what it has scored. It never completes a search by guessing: unfinished candidates are put to the user, as above. The routing decision records which limit was reached and what was done instead.

The bound against the answer holds for conversations of up to a million tokens across the shapes the build tests (one chain, an early split, many small sibling groups, nested forks, many unrelated answers), down to answers of about 100 tokens. Below that the smallest request that routes a message costs more than twice the answer, and routing costs at most what twice a 100-token answer buys.

### Context summaries for decisions

Deep lines of work can be shown to the decision model in compact form. This is optional and concerns **decisions only**.

- **A run's context is never a summary.** "Context is assembled mechanically from the genealogy. There is no per-node relevance scoring" ([04](04-chains-dependencies-context.md#context-for-a-run); Q76), and every attempt records the context it actually received (invariant 2). A summary appears in no run's input and in no record of one. Compacting what a run reads stays out of scope ([Context growth](#context-growth); Q67).
- **Linking.** A summary stands for the context of one node, its **anchor**: everything a run continuing from the anchor would read. For the anchor the decision model is shown the summary. For a descendant it is shown the same summary followed by the content specific to the descendant: the exchanges after the anchor, its own last. One summary therefore serves the whole line below its anchor. Deeper in a line, a second anchor's summary is written from the first summary and the exchanges between the two.
- **Join-backs and join chains.** A summary anchored at a join-back covers every member; a summary anchored at one member never stands for the group (invariant 4). A node on a join chain is shown one summary per parent line.
- **Two ports.**
  - A **summary provider** answers, for a node, what the decision model is shown: the node's context chain as the backend assembles it, or a summary and the node's own content. It is asked synchronously and performs no I/O.
  - A **summarizer** is offered finished work in the background and may write a summary. Nothing waits for it.
- **Two settings**, both off by default: whether a referent strategy uses a summary where one is available, and whether the background summarizer runs. The first is passed to whichever strategy is in use.
- **The first version ships a pass-through.** Its provider returns the node's real context chain unchanged, which leaves every decision request as it is, and its summarizer produces nothing. Turning either setting on changes no routing.
- **Open design: what to summarize, which nodes, and when.** This is a problem of its own and is not settled. The recommended first policy: summarize in the background, after a run completes or a join-back forms, while the conversation is idle; anchor a node when its context has grown by a set amount since the nearest anchor above it, or it is a join-back whose members' answers are large, or it has become a branch point; write each summary from the nearest anchor's summary and the exchanges since. Routing never waits for a summary.
- **Staleness and invalidation** (design only). A summary is recorded as an event with what it read, as an attempt records its inputs, so replay never calls a model. It is stale when what it read is no longer what a run would read: a covered directive was revised or superseded, a covered member was retried after its group closed, a covered section was dropped by Undo split, or a session-wide requirement it read was replaced or withdrawn. Invalidation is recorded by the step that records the cause. A stale summary is not shown, and summaries written from it are stale with it.

### Strategy selection

An optional layer in front of the referent strategy chooses, for each routing, which strategy is used and how the tree walk treats unbranched runs. The user's working name for it is "decision-inception": a decision about how to decide.

- **Input: the shape of the genealogy only.** Counts and structure: answer sections and how many are older than the routing request lists; roots; branch points; depth; sibling groups, open and closed; the number and the longest of the trunks and of the unbranched runs below a branch point, with their sizes; total tokens. And what the routing may spend. No request, answer, or title.
- **Output: a typed choice.** One pass; or the tree walk with each of its switches on or off and long unbranched runs searched or not. Never free text.
- **Modes**, a user setting, off by default:

| Mode | How it chooses | Cost |
|---|---|---|
| Off | The configured strategy and switches, as they are | None |
| Rules | Deterministic rules over the shape: one pass while every section is listed or the budget has no room for a further request; the tree walk otherwise; each switch by the length of the trunk or unbranched run it would skip | None |
| Decision model | One small request about the shape: a `choice` question for the strategy and a `noul` question for each switch ([Decision provider](#decision-provider)) | One request, inside the [decision budget](#decision-budget) |

- **Fallback.** The decision-model mode uses the rules when its request fails, when its confidence is below the target-choice threshold, and when the decision budget does not allow the request. Routing does not fail because selection did.
- **Reuse.** A choice made from the shape alone holds for every routing of the same shape. The shape is reduced to a signature that changes only when the shape changes materially; the choice recorded with the most recent routing decision of the conversation is reused while the signature is the same, and nothing is asked. The record is the cache: nothing is kept outside the event log.
- **The pipeline and the strategies are unaware of it.** They are handed a strategy and its settings, as they would be from the settings alone.

### What is recorded

With the routing decision of each message ([Inspection](#inspection)), in addition to the questions and answers:

- the limit of the decision budget that was reached, if one was, and what the strategy did instead;
- that the routing request listed fewer sections than usual, and why;
- whether the decision model was shown summaries, and for how many sections;
- how the strategy was chosen, when strategy selection is on: whose choice was used, the choice, the shape's signature, the reason, the decision model's confidences, why the rules stood in, and whether the choice was reused.

### Scope in the first version

| Part | In the first version |
|---|---|
| Referent strategy interface; one pass; tree walk with search of long unbranched runs, trunk base, and hops | Implemented. Tree walk with long unbranched runs searched is the default; the two switches are off |
| Rules after the strategy: thresholds, elicitation, no subset bypass, acyclicity, leaf repair | Implemented, unchanged |
| Decision budget: token budget (absolute or relative), bound against the answer, backstops, the routing request drawing from it | Implemented |
| Summary provider | Interface, with a pass-through that returns the real context chain |
| Background summarizer | Interface, with an implementation that produces nothing |
| Summary policy, recording, staleness, and invalidation | Design only |
| Strategy selection: the interface, the rules, the decision-model mode, reuse, recording | Implemented, off by default |
| Optimization: tuning the thresholds and the budget's figures, the size of unbranched run that is searched, the selector's rules, summary policies, and the quality of a learned or model-based selector | Beyond the first version |

What the build measured, and where it falls short of this, is in [the build status](../build/STATUS.md).

### Proposed additions, not adopted

These are proposals. They are **not** among the ten invariants or the 61 acceptance conditions, nothing is renumbered, and no test is required by them until the user accepts them.

Proposed invariants:

- **Routing cost is bounded.** Apart from the requests a plan cannot be made without, no decision request is sent that would take a routing past its decision budget, and whether a request fits is decided before it is sent.
- **Summaries are not context.** No run's input, and no record of one, contains a context summary.

Proposed acceptance conditions:

- **DA1.** With either referent strategy, and with strategy selection off, by rules, or by the decision model, a continuation requiring multiple siblings depends on their full join-back (C9) and J continues on the chain A and B forked from (C19).
- **DA2.** A routing whose strategy was chosen by a selector is the routing that strategy gives when it is configured directly.
- **DA3.** A reply to a section inside a long unbranched run is placed on that section or put to the user; it is never placed on a neighboring section because a question about several sections was answered yes.
- **DA4.** With the decision budget in force, a referent strategy and a strategy selector send no decision request beyond it, and reaching it produces the same routing every time.
- **DA5.** With context summaries in use, a run started meanwhile receives the recorded exchanges and no summary.

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

# 12 · Build plan

What has to exist to meet this specification, in what order, and how it is verified. This is the scope and sequence, not a task breakdown. Implementation started on the user's go-ahead (Q71), and the first version now exists in `packages/`. This document remains the statement of scope, order, and verification.

## Packages

A pnpm workspace (Q66). `core` has no I/O; the decomposer, decision provider, and model provider are injected into it (Q71). Details are in [architecture](11-architecture.md).

| Package | Must provide | Specified in |
|---|---|---|
| `core` | Domain events and stable IDs; projections for transcript, queue, genealogy, and operation graph; chain, fork, sibling-group, join-back, and join-chain bookkeeping; dependency graph and validation; the routing pipeline, including dependency attachment; context assembly; scheduling; typed readiness before visible answer text; attempt lifecycle (supersession, retry, stop, pause with its reason, interruption recovery); elicitation state and default timers whose deadlines persist; the log export | [01](01-mental-model.md)–[08](08-failure-and-recovery.md), [11](11-architecture.md) |
| `protocol` | Command and event types shared by embedded and server backends; projection snapshot on demand; the tested model compatibility list; the log export document | [10](10-front-end.md#part-2-client-and-backend) |
| `providers` | OpenRouter streaming answers with error mapping and the streamed clarification signal; the preparation step that establishes readiness; the decision provider over OpenRouter Decisions; the generative decomposer; a scripted fake provider for tests | [11](11-architecture.md) |
| `storage` | Event store and projection cache behind adapter interfaces; IndexedDB and in-memory adapters; a local secrets store separate from the event log | [11](11-architecture.md) |
| `web` | Vite + Tailwind client; embedded backend in a Web Worker; everything in [front-end interface](10-front-end.md) part 1; the [debug views](09-debug-views.md) | [09](09-debug-views.md), [10](10-front-end.md) |
| `server` | Later: the same interface over a network transport, with keys from the server environment | [11](11-architecture.md) |

## Milestones

The order and the contents of the "Brings in" column for milestones 1–3 and 5 are accepted (Q71), which also names scenario 1, 3, and 4 tests for milestone 1 and "decisions, decomposition, validation" for milestone 4. The finer assignment of capabilities and acceptance conditions below is this document's proposal, not a recorded decision.

| # | Milestone | Brings in | First demonstrates |
|---|---|---|---|
| 1 | `core` with the fake provider | Event log, projections, chains, forks, join-back, dependencies, context assembly, scheduling | C1–C20 and the ordering rules of P1–P3 as core tests, with routing outcomes supplied by the test |
| 2 | OpenRouter streaming and IndexedDB | Real answers, persistence, error mapping, interruption on reload | Live smoke suite; detection of interrupted attempts |
| 3 | Web transcript | Sections, responding bubbles, placement, scroll following, composer queue | P1–P8 in the browser |
| 4 | Routing | Decision calls, decomposition, validation, split messages, reply-target inference, target and clarification elicitation, typed readiness and the pause for user input, join chains | D1–D5, T1–T4, E1–E2, E5, P9, DA1–DA5; routing corpus evaluation |
| 5 | Revisions and recovery, then debug views | Supersession, propagation, Regenerate, choice with default, retry policies, paused dependents, mixed-result display; mini-map, association, Compare, operation graph, run inspector, log export | R1–R8, E3–E4, F1–F9, P10–P13 |

Until milestone 4 exists, tests and the transcript supply routing outcomes directly (which chain, which dependencies), because there is no decision provider yet.

## Verification

- **Coordinator tests.** One deterministic test for each of the 69 acceptance conditions (D1–D5, P1–P13, C1–C20, T1–T4, R1–R8, E1–E5, F1–F9, DA1–DA5) and for each [architecture invariant](11-architecture.md#invariants). They run against the fake provider, which scripts streaming timing, failures, and interruptions (Q61).
- **Routing corpus.** Labelled examples for targets, chain placement, revision versus addition, splits, and dependencies. It evaluates the decision model and decomposer offline and is used to tune the thresholds (Q61, Q74). It carries a second set of expected placements for hop between branch points. Its decision requests are also measured with no network, through a mock of the Decisions API that counts tokens with a tokenizer calibrated against the provider's reported counts; the bound of the [decision budget](11-architecture.md#decision-budget) against the answer is asserted under those counts.
- **Live smoke suite.** A small number of real model calls (Q61), including the calls that qualify a model for the compatibility list (Q107) and the calibration of the token estimate.

## Left to the build

No user-visible promise depends on these, so they are not specification questions. Each should be decided when its milestone is reached and noted in the architecture document.

| Choice | Milestone |
|---|---|
| Which sections, chains, and nodes are supplied to the decision model as candidates | 4 |
| Whether trivial messages skip the decision call, after measuring latency (Q59) | 4 |
| Whether decision and decomposition calls count against the concurrency limit, and what "per provider" means while every call goes through OpenRouter (Q60) | 1–2 |
| Backoff timings for Standard, and how much longer Persistent waits (Q47) | 2 |
| The pinned decision model version, and the tuned thresholds (Q74) | 4 |
| How close to the context limit the warning appears (Q67) | 2 |
| Chunk size for stored streamed output (Q69) | 1 |
| Where the embedded secrets store lives (Q64) | 2 |
| Status wording for work held by the concurrency limit, as opposed to a provider rate limit | 3 |
| Which pipeline stage assigns each fragment of a composite its chain and target; Q59's gate chooses these before decomposition | 4 |
| The default referent strategy and tree-walk switches, the size of unbranched run that is searched, the figures of the decision budget, the strategy selector's rules, the lexical index's stop words and minimum score, and how much of an answer a question about one section shows ([dependency attachment](11-architecture.md#dependency-attachment)) | 4 |
| The default for ordered-message decomposition (Q104), and when the preparation step is skipped because routing's findings already establish readiness (Q103) | 4 |
| The shape of the log export document | 5 |
| How a superseded input is detected for the superseded-input note, and whether a finer check estimates if the replacement would change the result before showing it (Q40) | 5 |

## Out of scope for the first version

- Context compaction (Q67).
- Generating context summaries for decisions. The first version has the interface, a pass-through, and the design ([architecture](11-architecture.md#context-summaries-for-decisions)).
- Optimizing dependency attachment: tuning the referent strategies and the decision budget, summary policies, and the quality of a rule-based, learned, or model-based strategy selector. The interfaces, settings, guard, and recording are in scope ([architecture](11-architecture.md#scope-in-the-first-version)).
- A server backend and server storage (Q63).
- OAuth sign-in for OpenRouter; the user pastes a key (Q73).
- A fallback decision provider; only the interface is kept (Q77).
- Tools, edits, sends, and any other non-read-only work (Q1).
- Scheduling fairness tuning and budgets (Q60).

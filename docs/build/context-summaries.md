# Context summaries for decisioning

Specified in [11 · Architecture, "Context summaries for decisions"](../spec/11-architecture.md#context-summaries-for-decisions) (the spec writes "summarizer"; the code's port is `ContextSummariser`). This document is the build record behind it. Where the two disagree the spec wins.

Build-time record, 2026-11-11. Status: **the interface, the wiring and two settings exist; nothing produces a summary.** The only provider returns a node's real context chain unchanged, and the only summariser produces nothing.

The request, in the user's words:

> let's also think of compaction strategies in terms of linking — what I mean is that for very deep branch nodes, we may want to run decision model on the compacted summary. And running for decision model children of those runs on the (summary + content specific to child). This can also be boolean setting (use_summary_if_available) passed to whatever strategy we use. We can should also propose how we strategize the independent problem of what to summarize, which nodes, and when. This might be a background process, and user setting can turn on or off. Put this in a doc, have the interface well connected to our backend, but for now just have a dummy that obtains the actual context chain and returns it.

## What does not change: a run's context

Summaries are for routing decisions only. The spec fixes what a run reads and how it is recorded:

> Context is assembled mechanically from the genealogy. There is no per-node relevance scoring (Q76). (04 · "Context for a run")
>
> **Exact consumed context.** Every attempt records the context it actually received. Later join-backs, revisions, or retries never rewrite it (Q29, Q31, Q39). (11 · invariant 2)

A summary in a run's input would be neither mechanical nor the genealogy, and the spec has no place for one. So nothing here touches `assembleContext`, `attempt-started` or `ConsumedContext`; a test asserts that a run started while a summary provider is active still reads the recorded exchanges and not the summary. Compacting what the answer model reads would need a spec change (04, invariant 2, the run inspector's "exact input") and is **not proposed here**. It is flagged, not decided.

One thing the build already does differs from the user's premise, and matters for what a summary is worth: the decision model is not shown a node's context today. It is shown one line per section (title, request, the opening of the answer; about 85 tokens), because the full context costs 1,750 tokens per ancestor and scored worse (`dependency-decisioning.md` · "Where this differs"). A summary therefore does not replace something expensive in the current requests; it adds what the line lacks, which is what the section was built on.

## The linking model

- A **summary** stands for the context of one node, its **anchor**: everything a run that continues from the anchor would read, up to and including the anchor's own exchange.
- For the anchor itself the decision model is shown the summary.
- For a **descendant** of the anchor it is shown the same summary and then the **content specific to the descendant**: the messages of its context chain after the anchor (the exchanges between the anchor and the descendant, the descendant's own last). This is the link: one summary serves the whole line of work below its anchor, and a child costs only its own content.
- Summaries **chain**: deeper in a branch a second anchor's summary is written from the first summary plus the exchanges between the two anchors, not from the root. A node is shown the summary of its nearest anchor at or above it.
- Across a **join-back**: the join-back is an artificial node whose context is the group's starting context and every member's exchange ("a child of all participating siblings", 04). A summary anchored at a join-back is written from the starting context's summary and each member's exchange, and it covers every member. Work that continues from the join-back is shown that summary and its own content. A summary anchored at one member never stands for the group: a subset of a sibling group is not a context anything runs on (04 · "No subset bypass").
- Across a **join chain**: its context is each parent's ancestry in order. A node on a join chain is shown one summary per parent line (each parent's nearest anchor) and its own content.

In the request the decision model sees, a section with a summary reads:

```
S7. "Plan day 2 hour by hour": the work before it, summarised: "Five days in Kyoto in November, moderate budget; staying in Gion; itinerary agreed with a rain plan for day 3."; after that: request "Plan day 2 hour by hour"; answer "An early start at Kiyomizu-dera…"
```

and a section without one keeps its usual line, in the same request. At most 600 characters of a summary and the last six messages of own content are shown per line.

## What exists

| Piece | Where | What it is |
|---|---|---|
| `ContextSummaryProvider` | `packages/core/src/ports/context-summary.ts`, injected as `CoreDependencies.contextSummaryProvider` | `contextFor({ nodeId, chain })` returns a `DecisionContext` or null. Synchronous, no I/O |
| `DecisionContext` | the same file | `{ kind: 'full-chain', nodeId, chain }` or `{ kind: 'summary', nodeId, summary: { anchorNodeId, text, tokens, provenance }, own }`. The kind says which the decision model saw; `provenance` carries the summary's ID, the model that wrote it, the nodes it covers and the sequence number of the event that recorded it |
| `contextChainOf(state, nodeId)` | `packages/core/src/engine/context.ts` | The node's context chain from the **same function** that assembles a run's context (`assemble`, steps 1 to 3), for a run that does not exist yet. A test asserts it equals what a run that continued from the node consumed, minus that run's own request |
| `fullChainContextProvider` | `packages/core/src/engine/summaries.ts` | The dummy, and the default: returns the chain unchanged, marked `full-chain`. No model call, no storage |
| `settings.routing.useSummaryIfAvailable` | `packages/protocol/src/settings.ts`, off by default; Settings → Routing | On: the backend puts a reader on the `RoutingInput` (`decisionContext`), and the `ReferentRequest` carries the setting and the reader to whichever strategy runs |
| Both strategies honour it | `routing/supply.ts` (`decisionContextOf`, `sectionLine`), `routing/referents/tree-walk.ts` | One place writes a section's line. The pipeline's state text (which one pass relies on) and the tree walk's own state texts both pass the section's context to it. A `summary` changes the line; a `full-chain` or null leaves it as it is |
| The run inspector | the routing decision's explanation | "Decision context: a stored summary was shown for 3 of the 24 listed sections." The questions and answers are recorded as always |
| The cost guard | unchanged | It estimates every request from the text actually sent, so a longer line is counted |
| `ContextSummariser` | the port file, injected as `CoreDependencies.contextSummariser` | `consider({ conversationId, nodeId, directiveId, reason, chain })` returns `summarised` with a draft, or `skipped`. May be slow; nothing waits for it |
| `noContextSummariser` | `engine/summaries.ts` | The default: always `skipped`, "Summaries are not generated yet." |
| `settings.routing.backgroundSummaries` | off by default; Settings → Routing | On: the backend offers every completed run's node to the summariser (`reason: 'run-completed'`). The outcome is not recorded yet |

With the dummy, turning `useSummaryIfAvailable` on changes no request and no plan: asserted for both strategies on the scripted provider and on a real backend (C19 holds either way).

## The independent problem: what to summarise, which nodes, when

Three questions, and candidate answers with what each costs.

**Which nodes become anchors.**

| Policy | For | Against |
|---|---|---|
| By size: a node whose context chain has grown by more than T tokens since the nearest anchor above it (T ≈ 8,000, about five exchanges) | Bounded and predictable: one summary per T tokens of conversation, on any shape. Chains naturally: each summary reads the one above and at most T new tokens | Anchors land wherever the count trips, not where the tree walk stops |
| At the tree walk's stops: branch points, trunk bases and the ends of hops | Exactly the nodes the walk asks about by themselves. With a summary there, "start at the trunk base" and "hop between branch points" would ask about the run's content at its end, which is what the user first described ("start at the context for the node at the base of the trunk"), and the chunk search of a skipped run becomes a fallback | A node only becomes a branch point when it is branched from, which is after the fact; a long trunk that never splits has one stop |
| On every join-back | The join-back is where several lines meet and the context jumps in size; J is asked about against the group as a whole | Small groups of short answers do not need it |
| Every node | Simple | One summariser call per exchange: the cost of reading the conversation twice |

**When.**

| Policy | For | Against |
|---|---|---|
| Eagerly, in the background, after a run completes or a join-back forms | Routing never waits; the summary is there when the next message arrives | Summarises work nobody refers to again |
| On idle (no run in flight for the conversation) | Does not compete with answers for the concurrency limit or the rate limit | A fast follow-up is routed without it |
| Lazily, on the first routing that would use it | Pays only for what is used | Routing would wait for an answer-model call (seconds, against 0.15 s for a decision request); or the first routing goes without and only later ones benefit |

**Recommended first policy.** Background, after a run completes or a join-back forms, when the conversation is idle; anchor a node when (a) its chain has grown by more than 8,000 tokens since the nearest anchor, or (b) it is a join-back whose members' answers total more than 2,000 tokens, or (c) it has become a branch point and (a) holds for half the threshold. Write each summary from the nearest anchor's summary plus the exchanges since. Lazy summarisation is not recommended: routing must not wait on an answer model.

This is why the seam is `ContextSummariser.consider`: the backend offers a node with a reason and its chain, and **the summariser owns the policy** (which nodes, what size) as well as the writing. The backend owns when it is offered and recording the result.

## Cost

Prices: Haiku $0.10 in and $0.50 out per million; decisions $0.042 per million input.

- **Producing.** Written incrementally, every exchange is read by the summariser once: 1,750 tokens × $0.10 = $0.000175 per exchange, plus about 300 output tokens per anchor ($0.00015) every five exchanges. About **$0.0002 per exchange, 0.21 of a Haiku answer** ($0.00096 for the cheapest measured answer), or 1% of that answer on the default answer model. Written from the root each time it would be quadratic: 20 exchanges are 35,000 tokens, $0.0035, 3.6 Haiku answers for one summary.
- **Using.** A summary adds to a line; it does not shorten it. At 600 characters it is about 150 tokens per section shown: 24 listed sections with summaries add 3,600 decision tokens ($0.00015) to the pipeline's request, about doubling it. Naming a summary once per request and referring to it from each line ("continues from C1") would cut that to one summary per anchor; this is not built.
- **Against the guard.** The price guard bounds the *decision requests* of one routing at twice the answer on Haiku. Summaries shown are inside it: the guard counts what is sent, and in a conversation of short answers the longer lines will use the allowance up sooner (`dependency-decisioning.md` · "The price guard"). The summariser's own calls are answer-model calls, not decision requests, and are **outside** that guard as built. At 0.21 of a Haiku answer per exchange they would fit under it with room, but whether "two times haiku" is meant to include them is the user's to say. On the million-token grid: 3,300 exchanges of 300 tokens cost about $0.12 to summarise once, in all (a million tokens read, 124 summaries written), and 500 of 2,000 tokens the same.
- **What it could save.** In the walk: with anchors at its stops, a hop over s sections is one summary line (150 tokens) in place of a chunk question (47 + 17·s) and, when a skipped section is referred to, a listing request (305 + 125·(s + 1)). For a run of 20 that is 150 against 387 and 2,930. Whether the summary line then finds the section as reliably as the chunk question does is not measured.

None of the figures in "Using" and "What it could save" are measured live: there is no summary to measure.

## Recording, replay, staleness

Not built; specified so that a summariser can be added without changing the seam.

- **Event.** `context-summary-recorded { summaryId, anchorNodeId, text, tokens, model, coveredNodeIds, basedOnSummaryId | null, inputs }`, appended by the backend when `consider` resolves `summarised`. `inputs` is the same shape a run records (`ConsumedInput[]`: for every directive read, the attempt whose answer was read, or the marker), plus the corrections and session-wide requirements read. A second event, `context-summary-invalidated { summaryId, cause }`. Both are additive: an older client ignores them; they need a schema-version bump of the event union and a projection-cache version bump (`STATE_VERSION`), and no upcast of existing events ("Events carry a schema version and are upcast on read, never rewritten", 11).
- **Replay.** The summary's text is in the event, so replay and projections never call a model. The reducer keeps a table `summaries` by anchor node.
- **Staleness.** A summary is stale when what it read is no longer what a run would read. That is the test the engine already has for a completed attempt with a superseded input (Q40): compare the summary's `inputs` with the conversation's current state. It goes stale when a covered directive is revised or superseded (06), when a covered member is retried after its group closed (the late retry's exchange joins the chain, Q49), when a covered section is dropped by Undo split, and when a session-wide requirement it read is replaced or withdrawn. A join-back formed after the summary does not make a summary above it stale; a summary anchored at the join-back is stale when the group re-forms.
- **Invalidation** is recorded by the same step that records the cause, so it is deterministic. A stale summary is not shown: the provider returns null for nodes at or below its anchor until a new one is recorded, and those sections fall back to their usual lines. Summaries below a stale one that were based on it (`basedOnSummaryId`) are stale with it.
- **The provider** that replaces the dummy reads the `summaries` table: for a node, the nearest non-stale anchor at or above it, and `own` = the node's chain after the anchor.

## In the run inspector

- Per routing decision: the note above, and (to add with real summaries) for each section whether it was shown as its line or as summary `sum_…` anchored at which node.
- Per summary: its text, the model, the nodes it covers, what it read (`inputs`), and whether it is stale and why.
- A run's "exact input" is unchanged and never lists a summary.

## Tests

- `routing/acceptance/summaries.test.ts`: the dummy returns exactly the chain the engine assembles (equal to a run's consumed context minus its own request); the setting on and off give the same outcome, consumed contexts and decision requests on a backend; an injected provider is asked for the listed sections' nodes with their real chains only while the setting is on, the decision model is shown summary and own content, and the run still reads the full context; `backgroundSummaries` offers each completed run with its node and chain only while on, and nothing is recorded.
- `routing/referents/referents.test.ts`, for one pass and the tree walk: full chains change no request and no plan; a scripted summary provider (test only) gives summary and own content for the sections that have one and the usual line for the others, with the same questions and plan, and the decision's explanation says so; the budget holds with the longer lines.
- `protocol/src/contracts.test.ts`, `web/src/app/app.test.tsx`: the two settings merge, are defaulted for stored settings, and are switches in Settings → Routing whose wording says summaries are not generated yet.

## Open

- Whether the summariser's cost belongs inside the "two times haiku" bound.
- Whether a summary line finds a referent as well as the line it replaces, and as well as a chunk question for a skipped run. Needs summaries to measure.
- One summary per request rather than per line.
- Summaries in the chunk questions of a search: today a chunk still names its sections by their requests.
- The summariser is offered work on `run-completed` only; `join-back-formed` and `idle` are named in the port and not yet raised.
- Compacting the answer model's context: out of scope, and against the spec as it stands.

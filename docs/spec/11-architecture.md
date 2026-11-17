# 11 · Architecture

The accepted technical design for Pluribus, by area. Question numbers in parentheses trace each statement to its source decision; where a later answer conflicts with an earlier one, only the later one is stated. Terms are defined in the [glossary](glossary.md).

Related specifications:

- Client commands, transcript, and composer: [10-front-end.md](10-front-end.md).
- Inspector and debug-view content: [09-debug-views.md](09-debug-views.md).
- Milestones, test strategy, and build order: [12-build-plan.md](12-build-plan.md).

No production implementation exists.

## Invariants

Every part of the design must preserve these. Invariants 1 to 10 come from the accepted scenarios; 11 and 12 come from the decisions on [dependency attachment](#dependency-attachment).

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
11. **Routing cost is bounded.** The decision budget is a hard stop. Apart from the routing request, which is always sent, and the two requests a plan cannot be made without, no decision request is sent that would take a routing past its decision budget, and whether a request fits is decided before it is sent. When the budget is reached, routing uses the best node found so far and does not ask the user ([Decision budget](#decision-budget)).
12. **Summaries are not context.** No run's input, and no record of one, contains a context summary. Summaries are used only for search and decisions ([Context summaries for decisions](#context-summaries-for-decisions)).

## System structure

### Portable backend

The Pluribus backend comprises the orchestrator and the coordinator (scheduling, dependency tracking, context assembly). It runs either embedded in the client or on a server. Both deployments are TypeScript and share as much code as possible behind one interface (Q55, Q62; ADR-0005). A client-only design is not the target: the server deployment must remain possible.

- **Embedded:** the backend runs in a Web Worker. Closing the tab is the interrupted case (Q52, Q62). Only one active Pluribus tab executes work per browser profile/origin; a second tab shows an already-open state until ownership is released (Q99). Switching conversations in the owning tab leaves background work running under the app-wide concurrency limit (Q100).
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
4. **Scheduling** (see below). Before visible answer generation, a typed readiness result establishes ready versus clarification needed; reuse routing/decomposition findings when sufficient, otherwise use a preparation step (Q103).

Messages with a combined total output limit remain atomic and skip decomposition (Q102).

Both the original text and any generated rewrite are recorded (Q59). Whether trivial messages skip the decision gate is decided after latency is measured (Q59).

### Decision provider

- Bounded routing questions go to OpenRouter's Decisions API (`openRouter.alpha.decisions.create`), which serves TypeSafe's Jev models with the `noul`, `choice`, and `score` question types (Q68).
- One OpenRouter key covers answers, decomposition, and decisions. There is no separate Jev key (Q68).
- There is no fallback implementation. Core keeps a `DecisionProvider` interface so one can be added if the alpha API changes (Q77).

### Decision thresholds

- The decision model is pinned to a versioned model, not a moving alias (Q74).
- Below the target-choice confidence threshold, Pluribus elicits the target (Q20, Q74). Two exceptions: a routing whose [decision budget](#decision-budget) was reached, and a reply that is joined instead.
- At or above the join threshold, a reply whose target would be elicited, and whose candidate sections are on two or more lines of work, joins those lines instead ([05](05-reply-targets-and-routing.md#joining-instead-of-asking)). The threshold is compared with the decision model's answer to one question, asked with the routing's first request whenever two or more lines are listed: does the reply bring together the subjects of more than one line of work? At 1 the question is not asked.
- Below the "clearly corrective" threshold, a reply is treated as additional work rather than a revision (Q37, Q74).
- Thresholds are tuned on the labelled routing corpus and are a frontend setting sent to the backend (Q74).

## Dependency attachment

The part of routing that decides which earlier work a message or fragment attaches to: its **referents**, and from them its reply targets, its place in the genealogy, and the results it waits for. It answers the decision gate's questions about target sections and dependencies ([Pipeline](#pipeline)).

This section was settled after Q98, by the user's instructions of 2026-11-11 and 2026-11-12. They are quoted, with the measurements behind each choice, in the build records: [dependency decisioning](../build/dependency-decisioning.md) and [context summaries](../build/context-summaries.md). They have no question numbers yet.

**Scope.** The architecture is part of the first version: the interfaces, the settings, the guard, and what is recorded. Optimizing it is not. [Scope in the first version](#scope-in-the-first-version) says which is which.

### Contract of the stage

- **Input.** One unit (the message, or one fragment of a composite) and the genealogy as supplied candidates: the current answer sections, the work behind them, the chains, and the sibling groups with their join-backs. Nothing else is read (invariant 9).
- **Output.** The unit's referents: the answer sections it may refer to, each with a confidence, and the probability that it refers to several at once. A section that is not returned is not a referent.
- **A strategy scores; it places nothing.** Everything after it is the same whichever strategy was used, and is binding:
  - A referent at or above the target-choice threshold is a reply target. Below it, Pluribus elicits the target; it never guesses which one is meant ([05](05-reply-targets-and-routing.md), [07](07-elicitation.md); Q20, Q74). Two exceptions. A routing whose decision budget was reached uses the best node found so far and does not ask ([Decision budget](#decision-budget)). A unit that brings several lines of work together, at the join threshold, takes every referent it would have offered the user and is placed on a join chain ([Decision thresholds](#decision-thresholds)).
  - Two or more members of one sibling group are the whole group: the unit depends on the full join-back, never on a subset (invariant 4; Q30; C9, C19).
  - Placement is a new chain, a continuation, or a new join chain whose parents are leaves ([Placement in the genealogy](#placement-in-the-genealogy); Q76, Q86; C20).
  - Dependencies are acyclic, and a plan that breaks a rule is repaired where it has one correct reading and refused otherwise ([Pipeline](#pipeline), stage 3).
- **Given targets are used as given.** An explicit reply target, or one the user chose in a target-ambiguity elicitation, is not scored and no strategy is consulted (Q10, Q20).

### The search problem

Finding referents is a search over the genealogy, stated here once so that every strategy is a way of carrying it out.

- **The graph.** The answer sections, and each sibling group's join-back as a node of its own, joined by continuation. The context of a node is the node and its ancestors.
- **What is hidden.** For a unit there is a set of **relevant nodes**: the sections it actually refers to. No strategy sees this set; it can only ask.
- **What is sought.** The **deepest relevant nodes**: every relevant node that has no relevant descendant. This one definition gives the rules of the stage:
  - an ancestor of a relevant node is dropped, because the descendant's context already holds it;
  - inside an unbranched run the answer is the last relevant node, not the end of the run and not every relevant node in it: continuing from there carries everything relevant and nothing after it. The tree walk's optional [hop between branch points](#referent-strategies) trades this for fewer questions: it takes the end of the run, whose context holds the last relevant node, and the answer then reads the rest of the run as well;
  - two or more deepest relevant nodes in one sibling group are the whole group (invariant 4).
  - A correction is the exception: it seeks the relevant nodes themselves, ancestors included ([06](06-revisions.md#revising-a-shared-requirement)).
- **Two modes of one search.**

| | Exact | Best effort |
|---|---|---|
| Finds | Every deepest relevant node | The best answer obtainable within the [decision budget](#decision-budget) |
| Stops when | Nothing unexamined could be relevant | The budget is reached |
| Returns | The whole set | The best node found so far |

  Best effort is the exact search made interruptible: the same steps, the most promising first. Routing always runs in best effort; exact is the search with no budget, and is what the build's tests check a strategy against.

- **What exact means for a search that only follows relevant lines.** A search that does not look below an unbranched run that is not relevant finds every deepest relevant node only when each one is reached through relevant lines, is a starting node, or is a first-pass section. A relevant section under a line that is not itself relevant is found through a starting node, not by the walk. Whatever it returns is sound: every referent was confirmed by a Point or a Group, or, with hop between branch points on, is the last section of an unbranched run that a Point or a Segment says the unit refers to.

### Operations

A strategy reaches the genealogy and the decision model only through a fixed set of operations behind one interface. A strategy is then policy alone: which operations to use next, where to split, and when to stop. How each operation is carried out is injected, so a strategy is tested with no decision model at all, and the means of an operation can change without touching a strategy.

Each operation that asks has a **subject**, what the question is about, and a **shown context**, what the decision model is given to judge it by. Only the subject counts for what the answer may be used for.

| Operation | Subject | Shown context | What its answer may do | Costs budget |
|---|---|---|---|---|
| **Point** | One section, by itself | The section with as much of its answer as the decision budget allows (the whole answer; else its opening and the passages that best match the unit; else its opening), and some of its ancestry | Confirm the section as a referent | Yes |
| **Group** | One sibling group as a whole, as the join-back it is or will be | Its members | Confirm the group, which resolves to every member (Q30) | Yes |
| **Segment** | A contiguous part of one unbranched run | Some of the sections at the top of the run | Say where to look next. It confirms none of the sections it names. With hop between branch points on, it also says whether the unit refers to the unbranched run | Yes |
| **Several** | The unit: does it refer to more than one section at once | The sections asked about | Admit a merely plausible further referent beside a clear one, where that changes nothing about where the work runs; tell a search to look on other lines after its first find | Yes |
| **Estimate** | A section or a part of an unbranched run | None: it is computed, not asked | Order and prune what is asked. It confirms nothing | No |
| **Structure** | The genealogy: roots, continuations, the unbranched run of a node, ancestors, recency | | Read from the backend's records | No |
| **Describe** | How a section is shown in a question: its title, the request it answered, its context chain, or a [context summary](#context-summaries-for-decisions); a section asked about by itself is shown as much of its answer as the decision budget allows | | | No |
| **Cost** | The size of a question before it is sent, and what is left of the budget | | Questions of one step are sent as one request | No |

- **Only Point and Group confirm.** This is the rule that a unit is placed on a section only if that section was asked about by itself (DA3). The one exception is the last section of an unbranched run under the tree walk's [hop between branch points](#referent-strategies): it is a referent because the unit refers to the run, not because it was asked about.
- **There is no question about everything built on a node.** A no to such a question would hide a whole part of the conversation on the strength of a few titles. Lines are followed one unbranched run at a time instead.
- **Estimate has no implementation in the first version.** It is the place for a lexical or embedding index over the sections; with none, nothing is ordered or pruned by it.

### Referent strategies

How referents are found is a **referent strategy** behind one interface. The pipeline is handed a strategy and never asks which one it has, so a strategy can be replaced without touching the rules above. Two exist. Both are written against the [operations](#operations) alone, and both start from the same first pass.

**First pass**

- Every routing, with either strategy and however the strategy was chosen, first asks about the **first-pass sections**, each by itself, in the routing request. They are found by walking back from the most recent answer section and taking each section that is not an ancestor of one already taken, until there are five.
- An ancestor is skipped because the context of the section taken already holds it. In a conversation that only ever continued one chain, the first pass is therefore the latest answer alone; after a split it is the ends of the most recent lines.
- A sibling group that one of them belongs to is also asked about as a whole, as below.
- The first-pass sections are always listed in the routing request, however few sections it lists.
- So every routing has scored a bounded set of sections by themselves before a strategy asks anything further, and a routing whose [decision budget](#decision-budget) is reached has candidates for the best node found so far. The strategy continues from there as described next; a question the first pass has already asked is not asked again.

| | One pass | Tree walk |
|---|---|---|
| Asks about, after the first pass | Every answer section the routing request lists (the most recent ones), and each sibling group among them as a whole | The genealogy from its starting nodes downward, one unbranched run at a time, only along lines that are relevant |
| Requests | The routing request that is sent anyway. No further request | That request, and one more for each level it descends and each step of a search, within the [decision budget](#decision-budget) |
| Reach | The listed sections. An older section is never asked about | Any section, however old, that lies on a relevant line or under a starting node |

Terms the tree walk uses. A **branch point** is a place where a line of work splits: a node with two or more continuations, a sibling group's join-back among them. An **unbranched run** is the answers of one line between two branch points, each continuing the one before; it is not a model run. The **trunk** of a root is its first unbranched run, down to the first branch point, or to its tip when the line never splits; the last answer of a trunk is its **base**.

**One pass**

- A Point for each listed section, a Group for each sibling group among them, and Several, all in the routing request. Nothing is searched and nothing older is reached.

**Tree walk**

- **Starting nodes.** The walk starts from every root, and from any **candidate sections** it is handed besides. Candidates come from a candidate source, an injected port; its intended use is retrieval, the sections an index over the conversation finds closest to the unit. The first version has one source, a lexical index over the answer sections: it hands over the sections whose title, request, and answer share the most words with the unit, when any are close enough. It is on by default and can be turned off; the walk then starts from the roots. A candidate is a hint for the search and nothing more: it is asked about by itself like any other section, and the source's score is never read. A source that fails counts as none, and none is asked when the reply target was given.
- **No starting node is an ancestor of another.** Before the walk, the roots and the candidates are reduced to the set in which no node is an ancestor of another: an ancestor is dropped in favor of its descendant, whose context holds it. A root with a candidate below it therefore gives way to the candidate.
- **A dropped ancestor is not lost.** It is taken up again as a starting node when the node that displaced it turns out not to be relevant, and when Several says the unit refers to more than one section, so that a second referent on another line under the same root is still found (C9, C19).
- **At a starting node** the walk examines the part of the node's unbranched run from the top of the run down to the node: by a Point for each section when the part is short, by a search when it is long.
- **Search of a long unbranched run.** The search looks for the last relevant section. "Does the unit refer to anything after this position?" is a Segment, and along one unbranched run its answer changes from yes to no only once, so the position is found by halving, or by asking about several parts in one request; the requests it needs grow with the logarithm of the run's length. The latest part that is at least plausible is then opened: its sections are asked about by Points, and only a section confirmed by a Point can be a referent. When none of them is confirmed, the next plausible part before it is opened, while the budget allows; a part that was not plausible is never opened. Sections above a confirmed section are not asked about, because they are its ancestors. A correction opens every plausible part, since it seeks the relevant sections themselves. Old single answers that nothing was built on count as one unbranched run, searched for every relevant one: they are not a line of work, so none holds another in its context.
- **Descent.** Below an unbranched run in which anything is at least plausible, each continuing unbranched run is examined in the same way, and a sibling group's join-back by a Group. Nothing is examined below an unbranched run that is not relevant, apart from the first-pass sections and the starting nodes. This is the cost of having no question about everything built on a node: a reply to an old section on a side line, under a line the unit does not otherwise touch, is reached only through a candidate section.
- **Start at the trunk base** (optional, off by default). Of each trunk only the base is asked about by itself; the answers before it are searched, however few.
- **Hop between branch points** (optional, off by default). The walk does not look for the last relevant section inside an unbranched run. It asks only whether the unit refers to the run. A unit that refers to an unbranched run, and to nothing built on it, is placed on the run's last section, whose context holds the whole run.
  - **What is asked.** Points on sections of the run that were asked anyway count as they are: the first-pass sections, and the sections the routing request lists at a starting node. The sections not yet asked about are asked about in one step of Segments; a single section, and a candidate section the walk starts at, by a Point. Nothing is asked when a Point has already confirmed a section of the run. No part is opened and nothing is halved.
  - **What is placed.** An unbranched run in which any of these answers is at least plausible is descended below as always. Its last section becomes a referent with the highest of those scores, although it was not asked about by itself. At or above the target-choice threshold it is a reply target and the user is not asked. Below it, it is a weak referent like any other: the target is elicited, or, when the decision budget was reached, it is among the nodes the best node found so far is chosen from. A relevant descendant stands for it as for any ancestor, so it is the referent only of the run that ends the line of relevance. No other section of the run, and no section of a neighboring run, becomes a referent this way.
  - **What it costs and saves.** The answer continues from the end of the run, so it reads everything after the relevant part of the run. Saved are the questions about the sections one by one: on a short run one Segment replaces a Point for every section, and on a long run every step of the search after the first is dropped.
  - **Context limit.** When a run that continues from the last section would not fit what a run may read, the deepest section of the unbranched run that does fit is taken, and the sections below it are searched as with the switch off. The first version gives routing no such limit, because what a run may read is counted when the run starts ([Context growth](#context-growth)); the last section is always taken.
  - **Where it does not apply.** A correction needs the exact section it revises ([06](06-revisions.md)): for a unit with clearly corrective wording the switch changes nothing. A member of a sibling group is asked about by itself beside its group, as always, and does not count for the run that continues it. A run whose sections were all asked about by themselves already has its last relevant section, which stands. Old single answers that nothing was built on are not an unbranched run and are searched as before. A run that was not asked about before the decision budget was reached has nothing placed on it.
  - **It is the user's setting.** A [strategy selector](#strategy-selection) does not choose it.

**Both strategies**

- A sibling group is asked about as a whole, by a Group, beside its members. A group judged relevant resolves to every member (Q30).
- The result is the deepest relevant nodes, so an ancestor of a relevant node is dropped. The exception is a correction, which may name work its descendants only consumed ([06](06-revisions.md#revising-a-shared-requirement)); for a unit with clearly corrective wording the ancestor is kept.
- **A unit is placed on a section only if that section was asked about by itself.** A yes to a question about several sections (a Segment) only says where to look next. It makes none of those sections a referent, and a unit is never placed on a neighboring section because of it. When a search cannot be finished, the sections it did not get to ask about by themselves are not referents. The one exception is the tree walk's hop between branch points, above: the last section of an unbranched run the unit refers to, and no other section.

What a strategy cannot reach it does not guess at: the unit is routed as if it referred to nothing there.

### Decision budget

A guard on what routing one message may cost in decision-model work. It applies to every decision request of the routing: the pipeline's own, the strategy selector's, and the referent strategy's.

| Limit | What it is | Initial value |
|---|---|---|
| Token budget | Decision input tokens per routing. Either **absolute**, a fixed number, or **relative**: a share of the tokens recorded in the conversation's log, with a floor so that a new conversation is not starved and a ceiling so that a huge one is not unbounded | Relative: 3% of the log, at least 16,000 and at most 40,000 tokens |
| Bound against the answer | The decision requests of a routing cost at most a multiple of the answer they route, priced on the cheapest answer model offered | Twice the answer |
| Backstops | Further requests and questions per routing, whatever the tokens and prices | 4 requests, 96 questions |

- **The smaller limit applies.** A routing may use the lesser of the token budget and what the bound against the answer allows.
- **The conversation's log**, for a relative budget, is the text of every user message and of every attempt. Superseded, failed, stopped, and interrupted attempts count, with the partial text they recorded: they are part of the append-only history (invariant 3), and counting them means a revision never shrinks the budget. It is computed from the backend's records alone.
- **The answer's cost** is estimated before it is written: its least input, the message itself, and its expected length, taken from the conversation's completed answers, or a set figure while there are too few.
- **Decided before sending.** Every request is sized by an estimate and compared with what is left. A request that would pass a limit is not sent. The guard therefore never depends on a provider's reply, and routing stays deterministic.
- **The routing request draws from the budget first.** When it would not fit with every section it normally lists, it lists fewer, the most recent, down to the first-pass sections alone. One request is always sent, because a message has to be routed: when even the smallest does not fit, it is sent and nothing follows it. Once its sections are chosen, the sections it asks about by themselves are shown more of their answers with what is left, up to a share kept for the strategy's further requests.
- **Two requests are counted but never refused**, because no plan can be made without them: the confirmation that a requirement was made session-wide (Q17), and the question which consumers a shared-requirement revision affects (Q44).
- **The budget is a hard stop.** When a limit is reached, the strategy sends nothing that does not fit. It asks about the listed sections it has not yet asked about in one request if that still fits, and otherwise keeps what it has scored. With hop between branch points on, the sections of an unbranched run that was asked about in their place are not asked about in that request: the answer about the run stands. Nothing further is asked, of the decision model or of the user.
- **Best node found so far.** A routing whose budget was reached does not elicit the target. Referents at or above the target-choice threshold are reply targets as always. Where the rules of the stage would otherwise ask the user which section is meant, the unit is placed on the best node found so far, although its score is below the target-choice threshold. It is chosen from the sections confirmed by a Point and the sibling groups confirmed by a Group, as far as they are at least plausible (the threshold the tree walk descends on); with hop between branch points on, also from the last sections of the unbranched runs the unit plausibly refers to. Among them:
  1. a node with a plausible descendant is passed over for the descendant, whose context already holds it. A correction is the exception, as for [both strategies](#referent-strategies);
  2. of the rest, the highest score is taken;
  3. on equal scores, the most recent.

  A sibling group resolves to every member (Q30). A section that was only named in a question about several sections is never a candidate, except as the last section of its unbranched run under hop between branch points.
- **The floor.** The first pass guarantees that there are candidates once the conversation has answers. It does not guarantee that one is plausible. When nothing that was asked about by itself is plausible, and no unbranched run taken by a hop is, the unit is routed as referring to nothing there, as for sections a strategy cannot reach.
- **Why the user is not asked.** A question to the user is for an ambiguity that is real. In the user's words: "asks are only made when clear-eyed, rather than because we couldn't calculate the referents." A routing that finished within its budget and still finds the target ambiguous elicits it, as before (Q20, Q74).
- **Deterministic.** The same conversation and message give the same requests and the same routing every time.

The bound against the answer holds for conversations of up to a million tokens across the shapes the build tests (one chain, an early split, many small sibling groups, nested forks, many unrelated answers), down to answers of about 100 tokens. Below that the smallest request that routes a message costs more than twice the answer, and routing costs at most what twice a 100-token answer buys.

### Context summaries for decisions

Deep lines of work can be shown to the decision model in compact form. This is optional and concerns **decisions only**.

- **A run's context is never a summary** (invariant 12). A run receives the recorded exchanges; summaries are used only for search and decisions. "Context is assembled mechanically from the genealogy. There is no per-node relevance scoring" ([04](04-chains-dependencies-context.md#context-for-a-run); Q76), and every attempt records the context it actually received (invariant 2). A summary appears in no run's input and in no record of one. Compacting what a run reads stays out of scope ([Context growth](#context-growth); Q67).
- **Linking.** A summary stands for the context of one node, its **anchor**: everything a run continuing from the anchor would read. For the anchor the decision model is shown the summary. For a descendant it is shown the same summary followed by the content specific to the descendant: the exchanges after the anchor, its own last. One summary therefore serves the whole line below its anchor. Deeper in a line, a second anchor's summary is written from the first summary and the exchanges between the two.
- **Join-backs and join chains.** A summary anchored at a join-back covers every member; a summary anchored at one member never stands for the group (invariant 4). A node on a join chain is shown one summary per parent line.
- **Two ports.**
  - A **summary provider** answers, for a node, what the decision model is shown: the node's context chain as the backend assembles it, or a summary and the node's own content. It is asked synchronously and performs no I/O.
  - A **summarizer** is offered finished work in the background and may write a summary. Nothing waits for it.
- **The summarizer's cost is outside the decision budget.** Its calls are answer-model calls made in the background, not decision requests of a routing, so neither the token budget nor the bound against the answer counts them. A summary that is shown to the decision model is counted like any other text of a decision request.
- **Two settings**, both off by default: whether a referent strategy uses a summary where one is available, and whether the background summarizer runs. The first is passed to whichever strategy is in use.
- **The first version ships a pass-through.** Its provider returns the node's real context chain unchanged, which leaves every decision request as it is, and its summarizer produces nothing. Turning either setting on changes no routing.
- **Open design: what to summarize, which nodes, and when.** This is a problem of its own and is not settled. The recommended first policy: summarize in the background, after a run completes or a join-back forms, while the conversation is idle; anchor a node when its context has grown by a set amount since the nearest anchor above it, or it is a join-back whose members' answers are large, or it has become a branch point; write each summary from the nearest anchor's summary and the exchanges since. Routing never waits for a summary.
- **Staleness and invalidation** (design only). A summary is recorded as an event with what it read, as an attempt records its inputs, so replay never calls a model. It is stale when what it read is no longer what a run would read: a covered directive was revised or superseded, a covered member was retried after its group closed, a covered section was dropped by Undo split, or a session-wide requirement it read was replaced or withdrawn. Invalidation is recorded by the step that records the cause. A stale summary is not shown, and summaries written from it are stale with it.

### Strategy selection

An optional layer in front of the referent strategy chooses, for each routing, which strategy is used and how the tree walk treats unbranched runs. The user's working name for it is "decision-inception": a decision about how to decide.

- **Input: the shape of the genealogy only.** Counts and structure: answer sections and how many are older than the routing request lists; roots; branch points; depth; sibling groups, open and closed; the number and the longest of the trunks and of the unbranched runs below a branch point, with their sizes; total tokens. And what the routing may spend. No request, answer, or title.
- **Output: a typed choice.** One pass; or the tree walk with start at the trunk base on or off and long unbranched runs searched or not. Never free text.
- **Hop between branch points is not chosen.** It changes where a message is placed and what its answer reads, which the shape of the genealogy says nothing about. It stays as the user set it, whoever chose the strategy, and applies whenever the tree walk runs.
- **Modes**, a user setting. Rules is the default:

| Mode | How it chooses | Cost |
|---|---|---|
| Off | The configured strategy and switches, as they are | None |
| Rules (default) | Deterministic rules over the shape: one pass while every section is listed or the budget has no room for a further request; the tree walk otherwise; start at the trunk base by the length of the trunk it would skip | None |
| Decision model | One small request about the shape: a `choice` question for the strategy, and a `noul` question each for start at the trunk base and for searching long unbranched runs ([Decision provider](#decision-provider)) | One request, inside the [decision budget](#decision-budget) |

- **A selector only chooses.** A routing whose strategy and switches were chosen by a selector is identical, request for request and in its plan, to the routing obtained when the same strategy and switches are configured directly. The selector's own request, in the decision-model mode, is the only difference.
- **Fallback.** The decision-model mode uses the rules when its request fails, when its confidence is below the target-choice threshold, and when the decision budget does not allow the request. Routing does not fail because selection did.
- **Reuse.** A choice made from the shape alone holds for every routing of the same shape. The shape is reduced to a signature that changes only when the shape changes materially; the choice recorded with the most recent routing decision of the conversation is reused while the signature is the same, and nothing is asked. The record is the cache: nothing is kept outside the event log.
- **The pipeline and the strategies are unaware of it.** They are handed a strategy and its settings, as they would be from the settings alone.

### What is recorded

With the routing decision of each message ([Inspection](#inspection)), in addition to the questions and answers:

- for each question about a section, the section's text as the decision model was shown it and in what form (whole answer, opening and matching passages, opening only, or summary), so the inspector shows what was sent and not a reconstruction. A summary is recorded by reference, never as text (invariant 12);
- the limit of the decision budget that was reached, if one was, and what the strategy did instead;
- that the best node found so far was used in place of a question to the user, for which unit, which node, and its score;
- that hop between branch points placed a unit on the last section of an unbranched run without a search inside the run: for which unit, which run, which section, its score, and the question the score comes from;
- that the routing request listed fewer sections than usual, and why;
- whether the decision model was shown summaries, and for how many sections;
- how the strategy was chosen, when strategy selection is on: whose choice was used, the choice, the shape's signature, the reason, the decision model's confidences, why the rules stood in, and whether the choice was reused.

### Scope in the first version

| Part | In the first version |
|---|---|
| Referent strategy interface; the operations behind one interface; the first pass; one pass; tree walk with the search for the last relevant section of a long unbranched run, trunk base, and hop between branch points | Implemented. The configured strategy, used when strategy selection is off, is the tree walk with long unbranched runs searched; the two switches are off. Routing is given no limit on what a run may read, so a hop always takes the last section of the unbranched run |
| Candidate source for the tree walk's starting nodes | Implemented as a lexical index over the conversation's answer sections, on by default, with a setting to turn it off. Retrieval by meaning (an embedding index) is beyond the first version |
| Estimate | Operation defined, with no implementation: nothing is ordered or pruned by it |
| Rules after the strategy: thresholds, elicitation, no subset bypass, acyclicity, leaf repair | Implemented. Unchanged, except that a routing whose decision budget was reached does not elicit the target |
| Decision budget: token budget (absolute or relative), bound against the answer, backstops, the routing request drawing from it, the hard stop and the best node found so far | Implemented |
| Summary provider | Interface, with a pass-through that returns the real context chain |
| Background summarizer | Interface, with an implementation that produces nothing |
| Summary policy, recording, staleness, and invalidation | Design only |
| Strategy selection: the interface, the rules, the decision-model mode, reuse, recording | Implemented. Rules is the default; off and the decision model are available |
| Optimization: tuning the thresholds and the budget's figures, the size of unbranched run that is searched, how much context a Point and a Segment show, the selector's rules, summary policies, the lexical index's stop words and minimum score, an embedding index behind the candidate source, an index behind Estimate, and the quality of a learned or model-based selector | Beyond the first version |

What the build measured, and where it falls short of this, is in [the build status](../build/STATUS.md).

### Acceptance conditions

- **DA1.** With either referent strategy, and with strategy selection off, by rules, or by the decision model, a continuation requiring multiple siblings depends on their full join-back (C9) and J continues on the chain A and B forked from (C19).
- **DA2.** A strategy selector only chooses. A routing whose strategy and switches were chosen by a selector is identical, request for request and in its plan, to the routing obtained when the same strategy and switches are configured directly.
- **DA3.** A yes to a question about several sections only says where to look next. A message is placed on a section only if that section was asked about by itself, with one exception. With hop between branch points on, a unit that refers to an unbranched run, and to nothing built on it, is placed on the run's last section, or on the deepest one a run's context allows, because that section's context holds the whole run. It is never placed on any other section of the run, or on a section of a neighboring run, without that section being asked about by itself. A correction is never placed this way.
- **DA4.** The decision budget is a hard stop. Apart from the routing request, which is always sent, and the two requests a plan cannot be made without, no decision request is sent beyond it. When it is reached, routing uses the best node found so far and does not ask the user, and the same conversation and message give the same routing every time.
- **DA5.** With context summaries in use, a run receives the recorded exchanges and never a summary; summaries are used only for search and decisions.

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

Stopping aborts the request. Pluribus does not work around providers that keep billing after an abort (Q75).

### Claude API error mapping

A role that runs on the Claude API (see [Models](#models)) maps its errors to the same treatments:

| Response | Treatment |
|---|---|
| 408, 429, 500, 502, 503, 504, 529 (overloaded); `timeout_error`; empty 200 | Transient: retried automatically, honoring `Retry-After`. 429 shows "Waiting for capacity". |
| 402 (`billing_error`); 429 with `enforced_spend_limit_reached` (the monthly spend cap) | Non-retryable: "Out of Anthropic credits". |
| 401, 403 | Non-retryable, with the message. A 401 that says the organization may not call the API from a browser is shown as it is. |
| 400, 404 | Non-retryable, with the message. |
| 400 whose message says the input is over the context window; 413 | Non-retryable, as `context_length_exceeded` (Q67, Q82). |
| `stop_reason: "refusal"` | Non-retryable. No fallback model is requested: an attempt records the one model that ran it. |
| `error` event in the stream (under HTTP 200) | Fails the attempt, then follows the retry setting. |

## Providers, keys, and models

### Browser access

The embedded Web Worker calls OpenRouter directly, with no CORS proxy (Q72). Jev is not called directly (Q68, Q72).

With an Anthropic key, the embedded Web Worker also calls the Claude API directly. The Claude API accepts a request from a browser only with the header `anthropic-dangerous-direct-browser-access: true`, which the backend sends on every such request. The key is the user's own, is used from the user's browser, and is sent only to Anthropic. An organization with zero data retention or the Compliance API cannot call the Claude API from a browser at all.

### Keys

- **Embedded:** the user pastes an OpenRouter key into settings (Q73). It is stored locally in a secrets store separate from the event log, never in the log (Q64, Q73). OAuth PKCE ("Connect OpenRouter") is deferred past the MVP (Q73).
- **Embedded, optional:** the user may also paste an Anthropic key. It is held under the same rules, as a second secret. The OpenRouter key stays required: decisions run on OpenRouter only.
- **Server:** keys come from the server environment and never reach the client (Q64).
- Settings show only whether each key is configured (Q64).
- Providing a key is the one part that differs by deployment, so the client reaches it through one interface, the key provision: check a key, store or replace it, remove it. Embedded, the Web Worker checks and stores the key; a key goes from the client to the Worker once and is never sent back. A key is never part of a command, an event, a setting, an export or a log. With keys from the server environment the client offers no way to enter one.
- A key is checked before it is stored. OpenRouter reports what is left on a key. The Claude API has no balance a standard key can read, so the check is whether the key is recognized and whether one request of a single output token on the cheapest model is paid for. It reports valid, invalid, or valid but out of credit, and says so when the credit cannot be determined.

### Models

- Model choice is per role (Q65). Each role has a provider and a model, named by that provider's model IDs: OpenRouter, or the Claude API when an Anthropic key is configured. Without an Anthropic key every role is on OpenRouter. While one is configured, the Claude API is the default for answers, synthesis and decomposition: a role whose provider the user has never chosen, that is on OpenRouter on a model the Claude API also offers, moves to the Claude API on that model, when the key is added or found at start. Choosing a role's provider in settings, either one, makes it the user's; the backend never moves it again. The backend's own moves are not choices. A deployment whose server sets the models moves nothing. The roles:
  - answer runs, including work continuing from a join-back (Q90);
  - generative decomposition;
  - synthesis, for join chains only (Q65, Q90). A join chain exists only where lines of work have truly diverged over further turns, or were separate chains from the start. Work that needs several members of one sibling group continues from that group's join-back, which is bookkeeping: it is an ordinary answer and involves no synthesis (invariant 4; C5);
  - the pinned decision model (Q74), on OpenRouter only: the Claude API has no Decisions endpoint.
- **Embedded:** configurable from the frontend. MVP answer, decomposition, and synthesis choices are restricted to a small tested compatibility list, covering structured preparation and streamed clarification signals for the relevant roles (Q107). Synthesis is on the list because a synthesis run is an answer the user reads and must be able to stop and ask. The list is per provider. **Server:** set by server environment settings (Q65).
- The backend owns this configuration in both deployments. It reports, for each role, the providers it can run on, which of them are usable now, the models each offers, and whether the client may change them; the client renders that and sends a settings change, which the backend validates. Choosing a provider without a model gives the role that provider's default model.
- When the Anthropic key is removed, every role on the Claude API returns to OpenRouter and its default model there, in the same step.
- Each attempt records the model and the provider it used (Q65).

## Inspection

The backend must expose enough of its records for the run inspector, genealogy, and operation graph to show exact consumed context, routing decisions, and attempt states (Q31, Q87). What each view shows and which are behind debug toggles is specified in [09-debug-views.md](09-debug-views.md).

The backend can also export a conversation's full log: every stored event in order, which is the source of truth for every routing and run decision; the settings in force with their change events; and, marked as derived, the four projections, the run inspection of every directive, and a per-message index of its decision events. The export is built by the backend from the stored log and is the same for the same log at the same clock. It never contains a key: the export fails rather than emit text equal to a stored key. A server deployment may serve the same document as a download.

## Appendix: integration facts

Facts, not decisions, researched and dated **2026-11-10**. They may go out of date. Pluribus reaches Jev only through OpenRouter Decisions (Q68), so the direct TypeSafe API details are background, not constraints on the build.

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
- Observed, not documented: CORS allows only `https://console.typesafe.ai`, so the direct API cannot be called from Pluribus's browser or Worker.

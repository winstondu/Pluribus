# Dependency decisioning: which earlier work a message refers to

Specified in [11 · Architecture, "Dependency attachment"](../spec/11-architecture.md#dependency-attachment): the stage's contract, the two referent strategies, the decision budget and strategy selection. This document is the build record behind it: the measurements, the departures and what is open. Where the two disagree the spec wins. The spec calls a run of only children an "unbranched run", because in the spec a run is one model call; this document and the code say "run".

**Changed a third time on 2026-11-12**: a candidate source exists and is on by default. A word index over the answer sections hands the tree walk candidate sections as seed hints; see ["The candidate source: a lexical index"](#the-candidate-source-a-lexical-index). Statements below that say no source or no retrieval is built predate it and are marked.

**Changed again on 2026-11-12** by the user's decisions recorded under ["The model, the operations, and the search"](#the-model-the-operations-and-the-search): the question "does it refer to anything built on this?" is removed; the operations a search uses sit behind one interface, and the two strategies are policies over it; a long unbranched run is searched for its last relevant node; a tree walk can start at candidate nodes besides the roots. The sections "Strategy 2: tree walk", "Long runs" and the cost tables before that section describe the walk as it was until then and are marked where they no longer hold.

**Changed on 2026-11-12** by the user's decisions recorded under ["The hard stop, the best node found so far, the first pass, and rules by default"](#the-hard-stop-the-best-node-found-so-far-the-first-pass-and-rules-by-default): the budget is a hard stop and never a reason to ask the user; every routing starts with a first pass; strategy selection defaults to the rules. Statements below that predate it are marked where they no longer hold. The cost and score tables before that section were measured before the change.

Build-time record for the routing change of 2026-11-11. It closes the round-3 blocker "the spec's own J request is silently placed on one sibling" and the related "follow-up naming two sections raises the target-ambiguity prompt".

Sources: `docs/spec/01-mental-model.md`, `04-chains-dependencies-context.md`, `05-reply-targets-and-routing.md` and `11-architecture.md`. The slides on the join-back "under the hood" (`docs/presentation/`) are gitignored and were not in the checkout; the join-back is taken from the spec text quoted below.

A **referent** here is an answer section a message refers to. The referents that pass the thresholds are the message's reply targets (glossary: "Reply target … selected explicitly or inferred from its meaning"); 05 uses the word the same way ("several possible referents").

## What was wrong

J, in the spec's running example, is "Use those recommendations to make a five-day itinerary." (04). The spec says where it goes:

> `J` needs both A and B, so it continues from the join-back. (01)
>
> Work that needs several siblings of the same group never uses a join chain. It waits for that group's join-back and continues from it. (01)
>
> **No subset bypass.** Work needing more than one sibling depends on the full join-back. If A, B, and D are siblings, work needing A and B waits for D too (Q30). (04)
>
> [The join-back] is a child of every member. (04)
>
> **C9.** A continuation requiring multiple siblings depends on their full join-back, never a subset. **C19.** J, continuing from the A/B join-back, is on the chain A and B forked from and creates no new chain. (04)

The engine did this correctly once routing named both siblings. Routing did not name both. It asked the decision model one yes/no per answer section ("does the message refer to S2?") and whether the message refers to several sections. Measured on `typesafe/jev-1.13` with titles as a live run records them (three calls each, answers stable to ±0.03):

| Message | brief | neighborhoods | activities | "refers to several" | Result before |
|---|---|---|---|---|---|
| "Use those recommendations to make a five-day itinerary." (group closed) | 0.36 | 0.77 | 0.52 | 0.47 | J placed on the neighborhoods alone |
| The same, both siblings still running | 0.37 | 0.75 | 0.29 | 0.37 | targets the neighborhoods alone |
| "Make an itinerary from the neighborhoods and the activities" (closed) | 0.38 | 0.90 | 0.85 | 0.78 | both, plus the brief when it scores ≥ 0.7 |

The second of two siblings is scored low when each is asked about alone, and "those recommendations" is not read as "several sections". No threshold fixes that: the question was the wrong one. Asked about the group as a whole, the model is clear (0.86 and 0.92 for the two J wordings; 0.03 to 0.47 for eight messages that concern one sibling, the brief or nothing in the trip).

## Design

Deciding the referents is a strategy behind one interface, `ReferentStrategy` (`packages/core/src/ports/referent-strategy.ts`):

```ts
interface ReferentStrategy {
  readonly name: string
  /** Yes/no questions that ride in the request the pipeline sends anyway. */
  questions(request: ReferentRequest): ReferentQuestions
  /** The referents of every unit; any further request goes through `ask`, which enforces the budget. */
  resolve(request: ReferentRequest, gate: ReferentGate, ask: ReferentAsk): Promise<ReferentResult>
}
```

- The pipeline (`routing/pipeline.ts`) takes the strategy from `settings.routing.referentStrategy`, or from `CoreDependencies.referentStrategy` when one is injected. It never asks which one it has.
- A strategy returns, per unit (the message, or each part of a composite), a score for every section it kept, and the probability that the unit refers to several sections. It has no I/O: it states questions and reads probabilities.
- Everything after it is unchanged and the same for every strategy: `resolveUnitTargets` (target-choice threshold, ambiguity floor, the question to the user), `derivePlacement` (two or more members of a group become the group; an open group is waited for), `validatePlan` (acyclic, no subset of a sibling group, leaves for join chains). Only supplied sections are accepted from a strategy (invariant 9).
- Both strategies share the wording, the question IDs and the last step, `referentsFromScores` (`routing/referents/shared.ts`).
- Since 2026-11-12 each strategy is a **policy** over `ReferentOperations` (`packages/core/src/ports/referent-operations.ts`) and holds no wording, question ID or budget arithmetic of its own: see ["The model, the operations, and the search"](#the-model-the-operations-and-the-search).

Files: `routing/referents/`: `tree.ts` (structure), `shared.ts` (wording, IDs, scores to referents), `operations.ts` (the operations over the decision provider and the guard), `search.ts` (the policy interface and the adapter to `ReferentStrategy`), `one-pass.ts` and `tree-walk.ts` (the two policies), `oracle.ts` (the operations over a labelled set, for tests), `first-pass.ts`, `ask.ts` (the guard), `index.ts`.

### The context tree

`buildTree` builds it from the supplied candidates only:

- one node per answer section, under the nearest earlier exchange it builds on;
- one **group node** per sibling group with two or more answered or running members: the join-back as an artificial node. It hangs under the group's starting context beside the members, every member counts as its ancestor ("a child of every member"), and work that continues from the join-back hangs under it. `CandidateGroup.joinBackNodeId` was added so that this last link is visible to routing.

### From scores to referents (both strategies)

1. The relevant set is every node scored at or above the target-choice threshold.
2. Any node that is an ancestor of a relevant node is dropped: a relevant child is better than its parent, whose content the child's context already holds.
3. A relevant group node that survives gives its score to every member, so the result is the group's full join-back, never a subset.
4. Sections below the threshold that were not dropped keep their own score, and the pipeline's existing rules decide whether to ask the user.

Step 2 is skipped for a unit with clearly corrective wording. "Actually, the trip is four days, not five" scores the brief 0.89 and the neighborhoods 0.73; dropping the brief would turn a shared-requirement revision into a correction of one answer (06).

### Strategy 1: one pass

Every listed answer section (the pipeline lists the 24 most recent, `MAX_SECTIONS`) gets one yes/no in the pipeline's own request, each sibling group gets one ("does it build on S2 and S3 together, the answers that were requested in parallel, rather than on one of them alone or on none of them?"), plus "refers to several". No further request.

This is the previous behaviour plus the group question and the ancestor rule.

### Strategy 2: tree walk

**Until 2026-11-12.** The walk as it is now is under ["The search"](#the-search). What changed: step 2's question about "the answers built on" a branch point is gone, so step 4 descends on the nodes of the segment alone; the roots are one start set among others.

Breadth-first from every root, pruned where a line of work is not relevant:

1. A **level** is a set of segments. A segment is a node and the run of only children below it, down to the next branch point (a node with two or more children, a group node among them).
2. Every node of a level is asked about in one request; where a node has parallel children, the group node is asked about with them; and each branch point gets one more question: "does the message refer to, or need, any of the answers built on S1: S2 ("…"), S3 ("…")?".
3. The roots' level rides in the pipeline's own request. Each further level is one further request, whose state text lists only that level's sections and the message.
4. A segment is descended into when any of its nodes, or the "built on it" question, scores at or above the floor (0.25). Nothing below an irrelevant segment is ever asked about.
5. The scores go through the four steps above.

It also reaches sections older than the pipeline's window: they are numbered after the listed ones and shown in the walk's own state texts.

### Long runs: search, the trunk base, hops

Added 2026-11-11 on three requests from the user:

> add a setting to our treewalk algorithm: For very long flat conversations, we should just start at the context for the node at the base of the 'trunk' (first place it splits), and for each branch do fast forward 'hops' to the next branching point instead of walking one child down and down at a time. This can be two singular settings.
>
> For long parts of a trunk (some threshold of amount of node context), we can even implement something like binary search too.
>
> the guard is that for up to a 1 million tokens conversation, for various reasonable assumptions of turns and shape structure, we should not cost more than two times haiku.

**Changed 2026-11-12**: a searched run is searched for its **last** relevant section, not for every relevant chunk; see ["The search"](#the-search). The chunk question, its wording, the size of a chunk, the fan-out, the most recent answer beside it and the rule that a chunk's score never becomes a section's score are unchanged, and so is the evidence table below.

A **run** is a segment's only children: the answers of one line of work between two places where it splits. The **trunk** of a root is its first run, from the root to the first branch point, or to the tip when the line never splits; its **base** is that last node. The sections of a run are now either **listed** (asked about one by one, as before) or **searched**.

**Search.** The sections are put into chunks, each as many as can be listed within `searchRunsOverTokens` (1,500 estimated input tokens, about 12 full-length sections). A chunk is one question that names its sections by the request each answered (at most 80 characters): "Does the new message refer to one of these earlier answer sections, each named by the request it answered: S25 ("…"), S26 ("…"), …: reply to it, build on it, compare or combine it with another answer, or correct it?". Then:

- *(until 2026-11-12; now only for a correction and for old one-answer roots)* every chunk at or above the floor (0.25) is followed: its sections are listed in the next request, with their full lines, and scored one by one. Two relevant chunks are both followed in that one request; no relevant chunk ends the search and nothing in the run is a referent;
- a run with more than 24 chunks (`SEARCH_FANOUT`) is first asked about in 24 groups of chunks, and a relevant group is split again. Requests grow with log₂₄ of the run's length: one round of chunks up to about 290 sections, two up to about 7,000;
- a request with chunk questions also shows the most recent answer and asks about it (`m_recent`, not read). Without that alternative the model has nothing to prefer;
- a relevant chunk counts for its segment like a relevant node: the walk descends below the run's end (still so);
- a section is **never taken as a referent from a chunk's score**. It is asked about by itself first. When the budget ends a search between the chunk and its sections, the sections of the relevant chunk are not candidates at all: they were never asked about by themselves (DA3). Until 2026-11-12 they were reported at just under the target-choice threshold, so that the user was asked which one is meant; the budget is now a hard stop and never a reason to ask.

Which sections are searched:

| Setting (`settings.routing.treeWalk`) | Default | What it does |
|---|---|---|
| `searchRunsOverTokens` | 1,500 | A run is searched when listing the sections of it that the pipeline's request does not already list would cost more than this. Roots older than the window that nothing was built on (a long conversation of unrelated answers) count as one run. Also the size of a chunk that is listed. Always in force |
| `startAtTrunkBase` | off | Of every trunk only the base is asked about by itself; the sections above it are searched, however few (two or more). Those the pipeline lists ride in its request as chunk questions; older ones are a further request |
| `hopBetweenBranchPoints` | off | Below a branch point, of every branch's run only its end (the next branch point, or the leaf) is asked about by itself; the sections skipped (two or more) are searched and their lines are not sent |

The two switches are independent. Neither changes what happens below the end of a run, at sibling groups (a group node is always asked about by itself, so C9 and C19 are untouched), or after the strategy (thresholds, no subset bypass, acyclicity, leaf repair, ancestor removal).

**Evidence for the design** (live, `typesafe/jev-1.13`, 2026-11-11; 200 sections, one of them the referent):

| Question | Measured | Decision |
|---|---|---|
| What names a section in a chunk? | Title only: the itinerary's chunk scored 0.31 (its live title is cut before the word "itinerary"). The request: 0.72. Request and answer opening: 0.87, at twice the tokens. Unrelated chunks ≤ 0.07 with each | The request, ≤ 80 characters: 17 tokens a section against 125 for a line and a question |
| Does a chunk question find one section among 200? | Yes at every chunk size: 0.89–0.97 at 12 and 25 sections, 0.85–0.97 at 50, 0.77–0.96 at 100, 0.65–0.93 with all 200 in one question; unrelated messages ≤ 0.04 | One section among many does not dilute the question |
| Bisection or many chunks? | The tokens of a round are the sections it names, whatever the fan-out: 3,819 tokens for 17 chunks of 12, 3,051 for one of 200. Halving shows every section log₂ times, and costs a request each time | k-ary, as many chunks as one request needs (≤ 24), so a run up to 290 sections is two further requests: chunks, then one chunk's sections. Chunks of 12 rather than 25: with the latest answer beside them a correction of the brief scored 0.80 in a chunk of 12 and 0.46 in one of 25 |
| What when the message is about the latest answer? | Chunks alone: "Make that shorter" scored 0.37–0.49 on **all 17** chunks, "Which of those is the most important?" 0.52. With the most recent answer shown and asked about in the same request: ≤ 0.09 on every chunk, 0.93 on the answer | The most recent answer rides in every request that has chunk questions |
| Is the end of a hop judged well without the run above it? | No. "Which of those hostels has private rooms with a bathroom?" (about the second of four sections) scored the run's end at or above the threshold when only the end's line was shown; the end is built on the section meant, so ancestor removal placed the reply on the end | When a chunk's sections are listed, the run's end is asked about again beside them and that score replaces the first (`Chunk.beside`). The corpus example `deep-run-other-branch` went from the hop's end to the right section |

**What each gives up.**

- *Search* (always on, by size): nothing inside the window. Beyond it, a referent is found only if its chunk reaches the floor on the request alone; a reply that can only be recognised from the answer text ("the one that mentioned sake") is missed, and the message is then placed as if nothing old were referred to. It costs one request more than listing would when listing fits the budget (two further requests instead of one, from about 13 to 90 older sections).
- *Start at the trunk base*: inside the window it replaces up to 23 questions by two chunk questions (709 fewer tokens on a 200-section chain), and a reply to any trunk section but the base then needs a further request (about 1,900 tokens, 0.15 s) that the listed walk does not. A correction of the brief is found through its chunk and kept as before. On the corpus it changed no result.
- *Hop between branch points*: saves the lines and questions of the skipped sections (639 tokens, 18%, when nothing in the run is referred to) and costs a further request when a skipped section is (277 tokens more than without hops, and 0.15 s). The end of a run is first judged without its neighbours, which is what the re-ask corrects.

**Mis-placement is prevented in three ways**: a chunk's score never becomes a section's score; the end of a hop is asked about again beside the sections it was built on; and the sections of an unfinished search are not candidates (until 2026-11-12: an unfinished search elicited). The remaining silent failures are the one named under *Search*, a chunk below the floor, and a search the budget ended: the message is then placed on the best node found so far, or on nothing there.

**Departures from the request as worded.**

| Asked | Built | Why |
|---|---|---|
| "start at the context for the node at the base of the trunk" | The base's own line, and one question per chunk for the sections above it, by their requests | The context of the base is every exchange of the trunk in full: 1,750 tokens each (see "Formulae"). The chunk question stands for it at 17 tokens a section |
| A setting for long flat conversations | A long run is searched with both switches off; the switches extend that to short runs | The size threshold needs no accuracy trade inside the window, so it is always on and fixes the known gap by default. The switches cost a request whenever a skipped section is meant and are the user's to turn on |
| Trunk base: skip the trunk | With the switch off, sections the pipeline lists are still asked about one by one | Their lines are in the pipeline's request anyway. A question each is 40 tokens; searching them saves 23 tokens a section and costs a 1,900-token request whenever one is referred to |
| "binary search" | k-ary, up to 24 chunks a request | See the table: the same tokens, fewer round trips |
| The trunk of each root | Old one-answer roots are pooled into one run | 200 unrelated answers are 200 trunks of one node. Without pooling, the first known gap ("the walk's request for the older roots exceeds the budget") would remain |

### Where this differs from the algorithm as proposed, and why

| Proposed | Built | Reason (measured) |
|---|---|---|
| Check a node's **full context** against the message | One line per node: title, request (≤ 240 characters), opening of the answer (≤ 280) | Full context costs tokens proportional to cumulative context; see the calculation below. It is also worse: asked about six nodes one request each, "Make that shorter" scored 0.79 to 0.93 on all six; in one request with the alternatives side by side it scored 0.68 on the latest answer and ≤ 0.34 on the others |
| Descend when the node is relevant | *Until 2026-11-12:* descend when the node **or anything built on it** is relevant. *Now:* as proposed | The question was removed on the user's decision: "It feels too lossy on a wrong 'no'." What it was added for still holds and is what the removal costs: "Compare the itinerary with the sky explanation" scores the brief 0.07, so a walk that prunes on the brief alone never finds the itinerary below it, unless it is a first-pass section or a start candidate. The extra question scored 0.90 there and 0.03 for unrelated messages |
| One step per node ("bfs check its children") | One step per branch point; runs of only children are one segment | A conversation that only ever continues one chain is a path. Walking it node by node is one request per turn; as a segment it is one request, the pipeline's own |
| Remove every ancestor of a relevant node | The same, except for a correction | See above: a correction may name the brief its descendants only consumed |
| Several surviving siblings resolve to the full join-back | The same. It is work continuing from the join-back on the base chain, not a join chain | 01: "Work that needs several siblings of the same group never uses a join chain" |
| The result is the set of referents | The result is a score per kept section; the pipeline's thresholds still decide | 05: "It never guesses silently"; a referent below the target-choice threshold is asked about, not taken, unless the budget was reached (2026-11-12) |

## Cost

### Measured rates (2026-11-11)

| What | Figure | How measured |
|---|---|---|
| Decisions, `typesafe/jev-1.13` | **$0.042 per million input tokens; output tokens are not charged** | `usage.cost` of every live call equals input tokens × 4.2e-8 (279 → $0.000011718; 848 → $0.000035616; 4,508 → $0.000189336). The verified sample in `CLAUDE.md` agrees: 358 → $0.000015 |
| Input tokens of a decision request | 262 fixed + 0.193 per character of state + 7 per question + 0.233 per character of its ID and instructions | Nine live requests from 303 to 4,508 input tokens; the fit is within 3% of each and never under. `estimateDecisionTokens` used 265, 0.2, 7 and 0.24. **Refitted 2026-11-12** to 300 + 0.35 per character of state + 7 per question + 0.32 per character of question text: on 70 live requests the earlier figures counted as little as 0.63 of the reported tokens (see "Measuring tokens") |
| Latency of a decision request | about 0.15 s | 67 sequential requests in 10.5 s; 84 in 12.2 s |
| Answer, `anthropic/claude-sonnet-5.5` | $2 per million input, $10 per million output (`/api/v1/models`) | |
| One answer run | $0.0192 (35 in, 1,917 out), $0.0198 (1,354 in, 1,713 out), $0.0227 (1,351 in, 2,000 out, cut at the limit), $0.0372 (J: 3,607 in, 3,000 out, cut at the limit) | Four live runs of the trip example |

One exchange (request and answer) is about 1,750 tokens. The cheapest measured answer, **$0.0192**, is the denominator below; J's own answer cost $0.0372. Ten percent of an answer is $0.00192, which buys **45,700 decision input tokens**.

### Formulae

Symbols: N answer sections; R roots; W = 24, the pipeline's window; D, the depth of the tree in segments (branching levels); b, children per branch point; ρ, the fraction of a level's segments that are relevant; F = 262, the fixed tokens of a request; ℓ ≈ 85, a section's line (a live-style section: title, request, 280 characters of answer); q ≈ 40, one yes/no about it; u ≈ 30 to 120, a "built on it" question (it names up to 12 answers); g ≈ 30, a group question; σ ≈ 40, the message repeated in a further request; c ≈ 1,750, one exchange in full.

Since 2026-11-12 the "built on it" question is removed: the u·B terms below are gone, a level is asked only below a segment that is itself plausible, and a searched run is charged one opened chunk when a section is confirmed (the "r chunks relevant" row holds for a correction only).

The pipeline's own request costs F + P + ℓ·min(N, W) whichever strategy runs, with P ≈ 700 for its other questions (composite, relation, handling chain, dependencies, clarification). The strategy adds:

| | Further requests | Questions | Input tokens added |
|---|---|---|---|
| **One pass** (best = typical = worst) | 0 | min(N, W) + groups + 1 | q·min(N, W) + g·groups + 35 |
| **Tree walk**, best: no root relevant, or nothing branches | 0 | n₀ + B₀ + 1 (n₀ nodes in the root segments, B₀ branch points among them) | q·n₀ + u·B₀ + 35: less than one pass when the tree branches |
| **Tree walk**, typical: one relevant branch point | 1 | + n₁ + groups there | + F + σ + (ℓ + q)·n₁ + g, with n₁ ≈ b nodes |
| **Tree walk**, worst: every segment relevant | D − 1 (one more when roots lie beyond the window) | N + branch points + groups + 1 | Σₖ [F + σ + (ℓ + q)·nₖ + u·Bₖ + g·Gₖ], every node once; nₖ = n₀·(ρ·b)ᵏ in a regular tree |
| *As proposed*: full context, one request per visited node | V, the nodes visited | V | Σᵥ [F + q + c·depth(v)] |

With long runs (added symbols: L, the sections of a run that are not already listed in the pipeline's request; s, the sections a hop skips; t, the trunk sections above the base that the pipeline lists; m ≈ 12, the sections of one chunk, `searchRunsOverTokens` ÷ (ℓ + q); K = 24, the most chunks per request; d ≈ 17, a section named in a chunk question by a request of average length, 8 to 27 from a short request to one cut at 80 characters; c ≈ 47, a chunk question's fixed part; a ≈ 130, the most recent answer shown beside chunk questions):

| | Further requests | Questions | Input tokens added |
|---|---|---|---|
| **Run listed** (before; still the rule up to `searchRunsOverTokens`) | 1 | L | F + σ + (ℓ + q)·L ≈ 305 + 125·L |
| **Run searched**, nothing in it relevant | h = ⌈log_K(L ÷ m)⌉, 1 up to L = 288 | ⌈L ÷ m⌉ + 1 (K + 1 per round beyond one) | F + σ + a + d·L + c·⌈L ÷ m⌉ ≈ 435 + 21·L |
| **Run searched**, one section referred to (typical) | h + 1 | + m, + 1 when the run's end is asked again | + F + σ + (ℓ + q)·(m + 1) ≈ + 1,930; in all ≈ 2,365 + 21·L. Each round beyond the first adds F + σ + a + d·L ÷ K |
| **Run searched**, r chunks relevant | h + 1 | + r·m | ≈ 435 + 21·L + 305 + 125·r·m |
| **Run searched**, worst: every chunk plausible | h + 1 | ⌈L ÷ m⌉ + L | ≈ 740 + 146·L: a search never costs less than listing when everything is relevant |
| **Trunk base**, t listed sections above the base | 0, or 1 when one of them is referred to | −t + ⌈t ÷ m⌉ in the pipeline's request | −(q − d)·t + c·⌈t ÷ m⌉ ≈ −23·t + 47·⌈t ÷ m⌉; + 1,930 when one is referred to |
| **Hop** over s sections of a branch | 0 more, or 1 when one of them is referred to and nothing below the run is asked anyway | −s + 1 | −(ℓ + q)·s + c + d·s ≈ −108·s + 47; + 305 + 125·(s + 1) when one is referred to |

Searching beats listing from L = 3 when nothing in the run is relevant and from L = 20 when one section is; the threshold of 1,500 tokens (12 sections) sits between, because listing 12 is one request and searching them is two. Bisection in place of K-ary chunks would name every section once per round, 2·d·L in all instead of d·L·(1 + 1/K + …), over ⌈log₂(L ÷ m)⌉ requests instead of h: 5 rounds instead of 1 for 200 sections.

The last row of the first table is why full context is not sent. Its token count is the sum of the depths of the visited nodes times a whole exchange. For a conversation that continued one chain for n turns that is 1,750·n(n + 1)/2 + 302·n: 51,100 tokens at n = 7, which is already more than a tenth of an answer, for every message routed. The spec's own trip tree (brief, A, B, the join-back, J: depths 1, 2, 2, 3, 4) costs 22,500 tokens, 4.9% of an answer. One line per node costs 125 tokens however deep the node is.

### Money, measured per routing

| Case (live, final code) | One pass | Tree walk |
|---|---|---|
| Corpus mean, 55 examples | 1.22 requests, 1,295 tokens, $0.000054, **0.28%** of an answer | 1.53 requests, 1,450 tokens, $0.000061, **0.32%** |
| J, group closed (3 sections) | 1 request, 1,358 tokens, $0.000057, 0.30% | 2 requests, 1,274 + 625 = 1,899 tokens, $0.000080, 0.42% |
| J, siblings running | 1,441 tokens, $0.000061, 0.32% | 1,357 + 505 = 1,862 tokens, $0.000078, 0.41% |
| Unrelated message, 5 sections, branched tree | 1,663 tokens, $0.000070, 0.36% | 1 request, 1,579 tokens, $0.000066, 0.35% |
| Two cousins, 7 sections | 1,403 tokens, $0.000059, 0.31% | 1,249 + 635 = 1,884 tokens, $0.000079, 0.41% |
| 30 sections, referent older than the window | 3,813 tokens, $0.00016, 0.83%; **does not find it** | 3 requests, 3,813 + 674 + 764 = 5,251 tokens, $0.00022, 1.15% |
| 30 sections, unrelated message | 3,810 tokens, 0.83% | 2 requests, 4,481 tokens, $0.00019, 0.98% |

On the corpus the tree walk costs 25% more requests and 12% more tokens than one pass. Both cost about a third of one percent of the cheapest answer they route.

With long runs (62 examples: the 55 above, four in 200-section conversations and three in a tree whose branches are runs; live, 2026-11-11, one run each; tokens are the provider's `usage`). The last column prices the same cheapest answer run (35 in, 1,917 out) on `anthropic/claude-haiku-5.5` at $0.10 in and $0.50 out per million: **$0.00096**, a twentieth of its price on the default answer model.

| Corpus mean per routing, 62 examples | Score | Requests | Tokens | $ | Of the cheapest answer | Of that answer on Haiku |
|---|---|---|---|---|---|---|
| One pass | 58/62 | 1.19 | 1,493 | $0.000063 | 0.33% | 6.5% |
| Tree walk, runs always listed (as before this change) | 59/62 | 1.52 | 1,687 | $0.000071 | 0.37% | 7.4% |
| **Tree walk, long runs searched (the default)** | **61/62** | 1.61 | 1,939 | $0.000081 | 0.42% | 8.5% |
| + start at the trunk base | 61/62 | 1.61 | 1,907 | $0.000080 | 0.42% | 8.3% |
| + hop between branch points | 61/62 | 1.65 | 1,936 | $0.000081 | 0.42% | 8.5% |
| + both | 61/62 | 1.65 | 1,903 | $0.000080 | 0.42% | 8.3% |

| Case (requests, tokens; ✗ = not routed as labelled) | One pass | Runs listed | Default | + trunk base | + hops | + both |
|---|---|---|---|---|---|---|
| 200 sections on one chain, reply to the 3rd (`long-chain-old-section`) | ✗ 1, 3,256: continues the tip | ✗ 1, 3,256: budget, falls back | 3, 8,043 | 3, 7,431 | 3, 8,043 | 3, 7,431 |
| The same chain, reply to the latest section | 1, 3,259 | 1, 3,259 | 2, 6,086 | 2, 5,377 | 2, 6,086 | 2, 5,377 |
| The same chain, unrelated message | 1, 3,256 | 1, 3,256 | 2, 6,080 | 2, 5,371 | 2, 6,080 | 2, 5,371 |
| 199 unrelated answers, reply to the 17th (`long-roots-old-section`) | ✗ 1, 4,474: new chain | ✗ 1, 4,474: budget, falls back | 3, 9,699 | 3, 9,699 | 3, 9,699 | 3, 9,699 |
| 30 sections, referent older than the window | ✗ 1, 3,813 | 3, 5,251 | 3, 5,251 | 3, 5,251 | 3, 5,251 | 3, 5,251 |
| Branch runs of 4 and 6, reply to the middle of a run | 1, 2,369 | 2, 3,534 | 2, 3,534 | 2, 3,534 | 3, 3,811 | 3, 3,811 |
| The same, reply to the end of a run | 1, 2,371 | 2, 3,538 | 2, 3,538 | 2, 3,538 | 2, 2,899 | 2, 2,899 |
| The same, reply to the 2nd section of the other run | 1, 2,372 | 2, 3,540 | 2, 3,540 | 2, 3,540 | 3, 3,675 | 3, 3,675 |

- The search finds what listing could not afford: both 200-section referents, at 8,043 and 9,699 tokens ($0.00034 and $0.00041; 1.8% and 2.1% of the cheapest answer, 35% and 42% of it on Haiku). It also costs every message in such a conversation one request of chunks (about 2,800 tokens here), whether or not it refers to anything old.
- The trunk switch saves 709 tokens (12%) per message on the 200-section chain and nothing elsewhere on the corpus: no other example has a trunk of three or more.
- Hops save 639 tokens (18%) when the reply is to the end of a run and cost one more request and 135 to 277 tokens when it is to a section inside one.
- The J request on both siblings, five runs of five cases, and the follow-up naming two sections, five runs of two: **25/25 and 10/10 with every one of the six configurations.** Through the whole backend (`j-request.smoke.test.ts`): 4/4.
- The one miss of every tree-walk configuration is `split-correction-and-new-work`, as before.

### Where each would reach 10% of an answer

- **One pass** cannot: it is bounded by the window. At 24 full-length sections its request is about 5,000 tokens, 1.1% of an answer. Without the window it would reach 10% at about 360 sections.
- **Tree walk**, unguarded, in the worst case (every line of work relevant, every node asked once): about 965 + 155·N tokens, so 10% at about 290 sections. With the guard it cannot: see below.
- **Full context per node**, as first proposed: 10% at a 7-turn conversation.

The same figures against an answer priced on Haiku. The cheapest measured answer is $0.00096 there, which buys 22,900 decision tokens; twice that is 45,700 tokens, the same number as 10% of that answer on the default model, because the default answer model costs twenty times Haiku. So "10% of an answer" above reads "twice a Haiku answer", and decision cost **exceeds one Haiku answer at half of each figure**:

| | Exceeds one Haiku answer (22,900 tokens) | Exceeds two (45,700) = 10% of the answer on the default model |
|---|---|---|
| One pass | never: ≤ 5,400 tokens, 0.24 of a Haiku answer | never |
| Tree walk, runs listed, worst case, unguarded | about 140 sections | about 290 |
| Run searched, one section referred to (≈ 3,300 for the pipeline + 2,365 + 21·L), unguarded | L ≈ 820 older sections | L ≈ 1,900 |
| Run searched, worst case (≈ 3,300 + 740 + 146·L), unguarded | L ≈ 130 | L ≈ 285 |
| Trunk base or hops | no earlier than the row they modify: both only remove questions unless a skipped section is referred to, and then add 1,930 tokens once | |
| Any of them with the guard | never, for an answer of 100 tokens or more: see the grid below | never |

## The guard

Three limits bound the decision work of one routing. All are estimated from a request's size before it is sent, so the guard is deterministic.

| Limit | Setting | Default | Covers |
|---|---|---|---|
| Token budget | `settings.routing.tokenBudget` | **relative: 3% of the conversation's log, at least 16,000 and at most 40,000 tokens** (2% until 2026-11-12) | Every decision request of the routing: the pipeline's own, the strategy selector's, the referent strategy's |
| Price guard | `settings.routing.costGuard` | **twice the answer, priced on the cheapest answer model** | The same requests. A routing may use the **smaller** of the two (`routingTokenBudget` in `routing/referents/ask.ts`) |
| Backstops | `settings.routing.referentBudget` | **4 requests, 96 questions** | The strategy's further requests, whatever the tokens and prices are |

- The pipeline's own request comes first. When it would not fit with its full window of 24 answer sections it lists fewer, the most recent, down to the first-pass sections alone (`fitWindow` in `routing/pipeline.ts`; see "The pipeline's request draws from the budget").
- Every further request goes through `createReferentAsk` (`routing/referents/ask.ts`). It counts requests, questions and estimated tokens, and **refuses** a request that would pass a limit: nothing is sent. This holds for any strategy, an injected one included; the pipeline, not the strategy, owns the counter. Its token limit is what the routing's budget has left after the pipeline's requests.
- The tree walk checks before each level that the level **and its fallback** both fit. When a level does not fit, it stops walking and asks the one-pass questions it has not asked yet in one request over the pipeline's state text (bounded by the window). When the fallback is what does not fit and the level does, the walk goes on without the reserve (this arises under the price guard below, where what is left is less than one request over the pipeline's state text). When neither fits, the referents are what it has asked about by itself: the first pass and the nodes it reached. Either way the budget is a hard stop: the user is not asked, and where the pipeline's rules would ask, the best node found so far is the target (below). The routing decision records which happened, which limit was reached, and the node that was used.
- One pass adds no request, and at most one question per listed section and per group.

Ceiling with the defaults: 16,000 tokens ($0.00067, **3.5% of the cheapest measured answer**, 70% of it on Haiku) up to a conversation of 800,000 tokens, rising to 20,000 at a million and never above 40,000 ($0.00168, 8.8%). The budget that would allow 10% is 45,700 tokens. Before this change the ceiling was the pipeline's request (≤ 5,400) plus a fixed 12,000: 17,400.

### The token budget: absolute, or relative to the conversation

The user's request (2026-11-11):

> The guard decision routing token budget should be a configurable setting, with either an absolute or a setting such as some reasonable default (some fraction or multiple of the total tokens of the full session log).

**Built.** One typed setting, a discriminated union (`DecisionTokenBudget` in `packages/protocol/src/settings.ts`):

```ts
type DecisionTokenBudget =
  | { mode: 'absolute'; inputTokens: number }
  | { mode: 'relative'; fraction: number; floor: number; ceiling: number }
```

- `absolute`: that many decision input tokens per routing.
- `relative`: `fraction` × the tokens of the conversation's log, never below `floor` and never above `ceiling`. A fraction above 1 is a multiple.
- **The log** (`RoutingInput.sessionLogTokens`, computed by `sessionLogTokens` in `engine/candidates.ts` from state alone): the text of every user message as typed, and the text of every attempt. **Superseded, failed, stopped and interrupted attempts count**, with whatever partial text they recorded: they are in the log (invariant 3, "Append-only history"), and counting them keeps the figure from falling when work is revised or retried, so a correction never shrinks the budget of the next message. Not counted: routing decision records, the fields of events, and context sent again to a run (an answer that continues a chain re-reads the chain; the log holds it once). Each text is sized at **one token per four characters**, rounded up, the estimate core already uses for an answer's expected length (`textTokens` in protocol); the provider's script-aware estimate lives in `providers` and core cannot import it.
- The budget covers the **whole routing**. `referentBudget.inputTokens`, which it replaces, covered only the strategy's further requests.
- Settings → Routing → Decision budget: the mode (two cards) and its value (a slider: 0.5% to 10%, or 2,000 to 40,000 tokens). The floor and ceiling are settable through the settings command and shown, not edited, in the dialog.
- Stored settings normalise (`normalizeSettings`): a stored `referentBudget.inputTokens` other than 12,000 becomes `{ mode: 'absolute', inputTokens }`. Settings are stored whole, so 12,000 was the earlier default and never a choice; it becomes the relative default. A stored budget with a broken field is repaired field by field.

**Raised to 3% (2026-11-12).** The share is now 3% of the log; the floor and the ceiling are unchanged. The measurements below were taken at 2% and still hold as a lower bound on the reach: every row that was found is found, since the budget is never smaller, and the rows at the ceiling are the same, since the ceiling did not move. What changes: the share passes the floor at about 533,000 tokens of log instead of 800,000 and reaches the ceiling at about 1,333,000 instead of 2,000,000; at a million tokens the worst message may cost 30,000 tokens ($0.00126) where it could cost 20,000; 3% of a chain's tokens in decision tokens is 1.26% of the input cost of an answer that reads that chain, where 2% was 0.84%; and the share now keeps up with exchanges of about 900 tokens and more, where 2% needed about 1,400. The reason for the change is margin: the found rows needed 1.55% to 1.83% of the log, and the gate has since gained questions (the combined limit, several lines of work) that every routing pays for.

**Why relative is the default, and why 2% / 16,000 / 40,000** (as measured before the share was raised). What a search of a long run costs grows with the run: about 21 tokens per older section (12 to 27 with the length of the requests), on top of the pipeline's request and the listing of the relevant chunk (about 5,700). A fixed budget therefore has a fixed reach, and the document's own open item was that raising it "also triples what the worst message may cost" for every conversation, short ones included. A share of the log raises it only where there is more to search. Measured with decisions as labelled (a reply to the 41st section of one chain of 1,720-token exchanges; total estimated tokens of the routing):

| Sections (log tokens) | Requests ≤ 40 characters: absolute 12,000 / absolute 16,000 / relative default | Requests of 80 characters: the same three |
|---|---|---|
| 200 (0.35M) | found 6,914 / found / found | found 8,870 / found / found |
| 300 (0.53M) | found 8,334 / found / found | found 11,331 / found / found |
| 500 (0.88M) | found 11,174 / found / found | **falls back** / asks the user 14,469 / **found 16,197** |
| 700 (1.2M) | **falls back** 2,262 / found 13,794 / found | falls back / **falls back** / **found 20,624** |
| 900 (1.6M) | falls back / asks the user 15,492 / **found 17,233** | falls back / falls back / found 26,374 |
| 1,200 (2.1M) | falls back / **falls back** / found 20,947 | falls back / falls back / found 33,004 |
| 1,600 (2.8M) | falls back / falls back / found 25,943 | falls back / falls back / asks the user 38,708 |
| 2,000 (3.5M) | falls back / falls back / found 31,281 | falls back / falls back / falls back (the ceiling) |

- **Fraction 2%.** The found rows need 1.55% to 1.83% of the log (16,197 of 885,009; 20,624 of 1,239,009; 33,004 of 2,124,009). 2% is the smallest round share above the need. It is also small against what it routes: an answer that continues a chain of T tokens reads T tokens, which on the cheapest answer model costs T × $0.10 per million; 2% of T in decision tokens costs T × $0.00084 per million, **0.84% of that answer's input alone**.
- **Floor 16,000.** Below 800,000 tokens of log the share is under 16,000, and a small conversation must not be starved: the largest routing of the corpus is 9,699 tokens. 16,000 is the old ceiling (12,000 for the strategy plus the pipeline's 3,300 to 5,400) rounded down, so no conversation gets materially less than it had, and it meets the share without a gap: at 800,000 tokens (about 455 exchanges of this size) a search with long requests needs about 15,100.
- **Ceiling 40,000.** Twice a 1,700-token answer on the cheapest answer model buys 40,542 decision tokens, so for answers of ordinary length the price guard binds there anyway; the ceiling keeps the budget bounded when the price guard is off or the answers are long (a conversation of 10,000-token answers has an allowance of 238,000). It is reached at 2,000,000 tokens of log, and the reach ends at about 1,200 to 2,000 older sections.
- **What it costs.** Up to 800,000 tokens nothing changes against a fixed 16,000. At a million tokens the worst message may cost 20,000 tokens ($0.00084) where it cost 17,400.
- **Where 2% is not enough.** With exchanges under about 1,400 tokens a section's 21 to 27 tokens are more than 2% of its exchange, so the share never catches up and the floor is the reach (about 380 to 490 older sections). By 1,000-token exchanges the price guard (20,200 tokens for an 850-token answer) is the smaller limit in any case.

**How it composes with the price guard: the minimum.** The user's bound ("we should not cost more than two times haiku") is about price, the budget is about size, and neither implies the other: a relative budget in a long conversation of short answers is far above twice an answer, and the price allowance in a conversation of long answers is far above any sensible budget. So a routing may use `min(token budget, price allowance)`, and the decision's explanation names the one that cut a request. The cost grid asserts both on every cell.

### The pipeline's request draws from the budget

Before this change the pipeline's own request was outside the guard: with a full window it costs 3,300 to 5,400 tokens, more than twice an answer of fewer than about 250 tokens, whatever the strategy. Now (`fitWindow`):

- The request is built with the full window (24 answer sections, 24 lines of work). If its estimate fits what the routing's budget has left, it is sent as before: **with answers of ordinary length nothing changes**.
- Otherwise the widest window that fits is found by halving between 4 and 23 (a request only grows with its window; at most five more builds) and the request lists that many sections and lines of work, **the most recent**. The sections it leaves out are still candidates, numbered after the listed ones: the tree walk reaches them in a further request when the budget allows, one pass does not, exactly as for sections older than the window before.
- An open clarification question stays listed however old it is, so its answer is still recognised; explicit reply targets are always listed.
- **The smallest request lists the first-pass sections alone** (`MIN_SECTIONS` = `FIRST_PASS_SECTIONS` = 5; until 2026-11-12 the 4 most recent sections): the most recent answer sections that no later one of them builds on, at most five, and as many lines of work. On one chain that is the latest answer; in a conversation of unrelated answers, the five most recent. A message has to be routed, so a request is always sent: when even that does not fit, it is sent, the strategy gets nothing further, and the explanation says by how much the limit was missed.
- A composite's second request (the questions per part) is cut the same way, against the budget of as many answers as it has parts.
- Two rare requests of the pipeline are counted when they come before the strategy runs but are never cut or refused, because the plan cannot be made without them: the confirmation of a conversation-wide requirement, and the question which consumers a shared-requirement revision affects.
- The decision's explanation records it: "The routing request listed the 9 most recent answer sections and lines of work, not 24, to stay within the price guard on decision cost."

With the window price-aware, **the bound holds down to answers of 100 tokens** (`SHORTEST_ANSWER_TOKENS`, 250 before): the request with its smallest window is 2,250 to 2,430 tokens in the grid's shapes, and twice a 100-token answer buys about 2,440. Below 100 tokens the median is taken as 100, so routing costs at most what twice a 100-token answer buys, **$0.0001 a message** (3.81 times the answer in a probe with 60-token exchanges, which is not in the grid). The floor is not removed altogether because the allowance would then fall under the smallest request and every conversation of one-line answers would lose the walk as well: the first attempt at this change did remove it, and the C20 acceptance test (five answers of a few words each) lost its join chain.

### The price guard: at most twice a Haiku answer

The fixed budget bounds decision cost against one measured answer. The user's rule is about any answer: "for up to a 1 million tokens conversation, for various reasonable assumptions of turns and shape structure, we should not cost more than two times haiku."

**Reading.** For a conversation whose recorded context is up to 1,000,000 tokens, the decision requests of routing one message cost at most twice the answer run that message gets, priced on `anthropic/claude-haiku-5.5` ($0.10 in, $0.50 out per million; decisions $0.042 per million input, output free). The other reading, twice what Haiku would charge to read the tokens the decision model reads, holds for every request there can be: the decision model costs 0.42 of Haiku's input price. The first reading binds, and it is the one built.

**Built** (`settings.routing.costGuard`, `decisionAllowance` in `routing/referents/ask.ts`, applied in `routing/pipeline.ts`):

- The allowance of one routing, in decision input tokens, is `maxAnswerCostRatio` (2) × the price of the answer × the pieces of work routed, ÷ the decision price. The answer is priced at its **least input**, the message itself (a message that starts a new chain reads nothing else; one that continues a chain reads more and costs more, so the bound only gets looser), and its **expected output**.
- Expected output is the median length of the conversation's completed answers once there are five (`CandidateSection.answerLength` was added for this), never taken below 100 tokens; with fewer than five, `expectedOutputTokens` (1,700, the shortest of the answer runs measured). An answer is not known before it is written, so this is an estimate, and it is deterministic: it is read from the candidates, not from a clock or a provider.
- The pipeline's own requests are estimated (`estimateRequestTokens`: 300 + 0.35 per character of state + 7 per question + 0.32 per character of question text since 2026-11-12, never below the count the decision model reported on 70 live requests; see "Measuring tokens"), cut to fit (above) and counted first. What is left of the smaller of the allowance and the token budget is the strategy's token budget for this routing. The request and question caps stay as backstops that hold whatever the prices.
- The prices are settings and default to Haiku's, the cheapest answer model among the role defaults. On a dearer answer model the bound is looser by that model's price; to hold "twice the answer" on another model, set its prices. Stored settings without the group get the defaults (`normalizeSettings`).

With 1,700 expected output tokens the allowance is 40,500 tokens and the token budget binds first. With answers of 250 tokens it is about 6,100, the pipeline's request takes 3,300 to 5,100 of it, and the strategy gets what is left. With answers of 100 tokens it is about 2,450, and the pipeline's request is cut to fit it.

**The grid** (`routing/referents/cost-grid.ts`; `cost-grid.test.ts` asserts the price bound and the token budget on all 360 cells: five shapes, six fixed strategies and the two strategy selectors; `pnpm smoke` prints them). Conversations of 50, 500, 3,300 and 8,000 sections with exchanges of 120, 300, 2,000 and 10,000 tokens, every cell at most a million tokens, in five shapes: flat (one chain), an early split with two long branches, bushy (two parallel answers joined back, one answer on the join-back, repeated), nested forks (every answer continued twice, one continuation going on), and many roots. Each cell routes the message that costs most: every yes/no is answered 0.5, so every line is walked into and every chunk followed. Tokens are the guard's estimate over every decision request of the routing. The Haiku answer is the conversation's own answer length (85% of the exchange) on a new chain.

**Since the estimate was refitted (2026-11-12)** the guard holds the bound with the requests counted as the decision model counts them, not only by its own estimate. `providers/test/decision-tokens.test.ts` asserts it on all 360 guarded cells with the tokenizer-calibrated count on both sides (see "Measuring tokens"), and `cost-grid.test.ts` still asserts it by the estimate. Worst guarded cell per size:

| Sections × tokens per exchange | By the estimate | By the tokenizer, calibrated |
|---|---|---|
| 50 × 120 | 1.98× | 1.73× |
| 500 × 120 | 1.99× | 1.72× |
| 8,000 × 120 | 2.00× (1.996) | **1.80×** (bushy, tree walk with runs listed: 2,486 estimated, 2,170 calibrated) |
| 50 × 300 | **2.00×** (1.997: nested forks, tree walk with runs listed, 6,123 estimated, 5,184 calibrated) | 1.74× |
| 500 × 300 | 1.96× | 1.70× |
| 3,300 × 300 | 1.96× | 1.79× |
| 50 × 2,000 | 0.79× | 0.68× |
| 500 × 2,000 | 0.90× | 0.77× |
| 50 × 10,000 | 0.16× | 0.14× |

The table below is from before the refit: the same cells by the earlier estimate, which ran low (by the tokenizer its guarded worst was 2.79×, and 208 of the 360 cells were over 2×). Worst shape per size, the switches shown where they differ:

| Sections × tokens per exchange | Strategy | Worst shape | Unguarded: requests / questions / tokens | $ | ÷ Haiku answer | Guarded: requests / questions / tokens | $ | ÷ Haiku answer |
|---|---|---|---|---|---|---|---|---|
| 50 × 120 | one pass | bushy | 1 / 41 / 4,523 | $0.00019 | 3.63× | 1 / 23 / 2,468 | $0.00010 | 1.98× |
| 50 × 120 | tree walk, any setting | nested forks | 26 / 82 / 20,113 | $0.00084 | 16.2× | 1 / 9 / 2,400 | $0.00010 | 1.93× |
| 500 × 120 | one pass | bushy | 1 / 41 / 4,543 | $0.00019 | 3.65× | 1 / 23 / 2,473 | $0.00010 | **1.99×** |
| 8,000 × 120 | one pass | bushy | 1 / 41 / 4,558 | $0.00019 | 3.66× | 1 / 23 / 2,481 | $0.00010 | **1.99×** |
| 8,000 × 120 | default | flat | 5 / 8,912 / 1,502,180 | $0.06309 | 1,206× | 1 / 21 / 2,375 | $0.00010 | 1.91× |
| 8,000 × 120 | tree walk, any setting | nested forks | 4,001 / 12,007 / 2,867,295 | $0.12043 | 2,303× | 1 / 9 / 2,419 | $0.00010 | 1.94× |
| 50 × 300 | one pass | bushy | 1 / 41 / 5,041 | $0.00021 | 1.64× | the same | | 1.64× |
| 50 × 300 | tree walk, any setting | nested forks | 26 / 82 / 21,684 | $0.00091 | 7.07× | 4 / 17 / 5,682 | $0.00024 | 1.85× |
| 50 × 300 | tree walk, any setting | bushy | 18 / 90 / 19,120 | $0.00080 | 6.23× | 4 / 21 / 6,032 | $0.00025 | 1.97× |
| 50 × 2,000 | one pass | bushy | 1 / 41 / 5,334 | $0.00022 | 0.26× | the same | | 0.26× |
| 50 × 2,000 | tree walk, any setting | nested forks | 26 / 82 / 22,585 | $0.00095 | 1.11× | 5 / 41 / 10,421 | $0.00044 | 0.51× |
| 50 × 2,000 | + trunk base | early split | 4 / 70 / 14,782 | $0.00062 | 0.73× | 4 / 48 / 11,394 | $0.00048 | 0.56× |
| 50 × 2,000 | default (flat) | flat | 3 / 63 / 10,548 | $0.00044 | 0.52× | the same | | 0.52× |
| 50 × 2,000 | + trunk base (flat) | flat | 3 / 67 / 14,049 | $0.00059 | 0.69× | 3 / 40 / 9,711 | $0.00041 | 0.48× |
| 50 × 10,000 | tree walk, any setting | nested forks | 26 / 82 / 22,585 | $0.00095 | 0.22× | 5 / 41 / 10,421 | $0.00044 | 0.10× |
| 500 × 300 | one pass | bushy | 1 / 41 / 5,066 | $0.00021 | 1.65× | the same | | 1.65× |
| 500 × 300 | tree walk, any setting | nested forks | 251 / 757 / 191,417 | $0.00804 | 62.4× | 4 / 17 / 5,698 | $0.00024 | 1.86× |
| 500 × 2,000 | runs listed | flat | 2 / 509 / 83,854 | $0.00352 | 4.14× | 1 / 33 / 4,766 | $0.00020 | 0.24× |
| 500 × 2,000 | default | flat | 4 / 588 / 110,025 | $0.00462 | 5.43× | 2 / 58 / 17,052 | $0.00072 | 0.84× |
| 500 × 2,000 | default | many roots | 4 / 588 / 110,314 | $0.00463 | 5.44× | 2 / 58 / 17,341 | $0.00073 | 0.86× |
| 500 × 2,000 | + trunk base | flat | 4 / 592 / 113,529 | $0.00477 | 5.60× | 2 / 36 / 8,526 | $0.00036 | 0.42× |
| 500 × 2,000 | tree walk, any setting | bushy | 168 / 840 / 170,486 | $0.00716 | 8.41× | 5 / 53 / 11,146 | $0.00047 | 0.55× |
| 500 × 2,000 | tree walk, any setting | nested forks | 251 / 757 / 197,741 | $0.00831 | 9.76× | 5 / 41 / 10,447 | $0.00044 | 0.52× |
| 3,300 × 300 | one pass | bushy | 1 / 41 / 5,077 | $0.00021 | 1.66× | the same | | 1.66× |
| 3,300 × 300 | default | flat | 4 / 3,699 / 678,341 | $0.02849 | 221× | 1 / 33 / 4,473 | $0.00019 | 1.46× |
| 3,300 × 300 | tree walk, any setting | bushy | 1,101 / 5,505 / 1,072,469 | $0.04504 | 350× | 4 / 21 / 6,066 | $0.00025 | **1.98×** |
| 3,300 × 300 | tree walk, any setting | nested forks | 1,651 / 4,957 / 1,254,249 | $0.05268 | 409× | 4 / 17 / 5,712 | $0.00024 | 1.86× |

Guarded, the worst cell of the whole grid is **1.99×** (one pass in a bushy conversation of 500 or 8,000 sections and 120-token exchanges: the pipeline's request, cut to the 4 most recent sections and their group), and the worst with 300-token exchanges is 1.98× (the tree walk in a bushy conversation of 3,300 sections: the pipeline's request and three small levels, which use the allowance up). The largest guarded routing in tokens is 18,106 (500 unrelated answers of 2,000 tokens: the decision-model selector's request, the pipeline's request and one round of chunks; 17,341 without the selector; the budget there is 20,000). Unguarded, the worst message in a million-token conversation costs up to 2,303 Haiku answers.

**Where the guard cuts the walk short, and what that costs.**

- *Short answers.* In a conversation whose answers are about 100 tokens the allowance (about 2,450 tokens) is used up by the pipeline's request, which lists only its most recent sections (9 to 23 questions in the grid's cells, 33 to 41 with the full window); nothing further is sent, with either strategy. In a conversation whose answers are about 250 tokens the allowance (about 6,100 tokens) is mostly used by the pipeline's request. What is left (1,000 to 2,800 tokens) is less than the walk's fallback request costs, so the walk does not keep room for it: it goes on level by level for as long as each fits (three levels of a branching tree in the grid's worst case; a level with one relevant branch point is about 600 tokens) and then keeps what it has scored. A search of a long run does not fit: its first request alone is 2,800 tokens for 176 sections. Old referents beyond the window are then out of reach, as with one pass: the message is placed as if it referred to nothing old. This is the price of the bound and it is not a guess about a section: nothing is placed on a section that was not asked about.
- *Below 100 tokens an answer* the bound cannot hold: the smallest request that routes a message costs about 2,400 tokens (estimated, refitted; about 2,100 to 2,200 as the decision model counts it). Routing then costs at most twice a 100-token answer. See "The pipeline's request draws from the budget".
- *Long runs.* With answers of normal length the token budget binds before the price does. A search's first request names every section of the run: about 21 tokens a section (12 to 27 with the length of the requests). With the default budget a referent is found up to about 1,200 to 2,000 older sections (the table under "The token budget"); just beyond, the chunks are asked but the relevant chunk can no longer be listed, so its sections are not candidates and the message goes to the best node found so far, or to nothing there (the rows that read "asks the user" in that table are from before 2026-11-12); beyond that the chunk request itself does not fit and the walk falls back to the one-pass questions, so the old section is not reached. With a fixed budget of 16,000 a referent is found up to about 300 to 700 older sections.
- *Bushy and nested trees.* The request cap (4) ends a walk at the fourth branching level below the roots, and the walk then asks the one-pass questions, which cover the window. A referent deeper than that and older than the window is not reached.
- *What it never does:* exceed a cap, send a request it has not counted, take a section as a referent without having asked about it by itself, or ask the user because the budget ran out.

The pipeline's later request (the question which dependents a revision affects) is not reserved for; a revision also re-runs its dependents, whose answers are not in the allowance either.

## Strategy selection

The user's request (2026-11-11), whose working name for this is **"decision-inception"**:

> we can maybe do a decision-inception here where we can send the shape of the conversation genealogy to a decision model for which strategy (and if tree walk settings, whether tree walk settings) are used. Make this decision-inception a clean layer too, and optional setting.

In code and in the spec it is **strategy selection**, done by a **strategy selector** (11 · "Strategy selection").

### What was built

An optional layer in front of the referent strategy, behind its own port, `StrategySelector` (`packages/core/src/ports/strategy-selector.ts`):

```ts
interface StrategySelector {
  readonly name: string
  /** Whether a choice may stand for a later routing of the same shape. */
  readonly reusable: boolean
  select(request: StrategySelectionRequest, ask: SelectorAsk): Promise<StrategySelection>
}
```

- **Setting.** `settings.routing.strategySelection`: `off` (the configured strategy and switches, exactly as before) | `rules` (the default since 2026-11-12) | `decision-model`. Settings → Routing → "Choosing the strategy". `CoreDependencies.strategySelector` injects another.
- **Input: the shape only** (`GenealogyShape`, `routing/selection/shape.ts`), read from the same context tree the strategies build, so trunk, run and branch point mean the same thing: answer sections and how many are older than the window; roots and old single-answer roots; branch points; depth in branching levels; sibling groups open and closed; total tokens; the number of trunks and of branch runs, and for the longest of each its sections, the listed ones before its end, the unlisted ones, its tokens and whether it ends in a split. And one number that is not shape: the decision tokens this routing may use (the token budget or the price allowance, whichever is smaller), because with no room for a further request a walk cannot descend. No request, answer or title is in it; a test asserts that.
- **Output: a typed choice** (`StrategyChoice` in protocol): `{ strategy: 'one-pass' }`, or `{ strategy: 'tree-walk', startAtTrunkBase, hopBetweenBranchPoints, searchLongRuns }`. `searchLongRuns: false` hands the walk a run size nothing reaches, which is the walk as it was before long runs were searched; the size that is searched stays the configured `searchRunsOverTokens`.
- **The pipeline and the strategies do not know how the choice was made.** `chooseStrategy` in `routing/pipeline.ts` returns a strategy and tree-walk settings, as the settings alone would; the strategies read `ReferentRequest.treeWalk` as before. Explicit and chosen reply targets, an empty conversation and an injected referent strategy select nothing.
- **Recorded with the routing decision** (`RoutingDecision.strategySelection`, a `StrategySelectionRecord`): whose choice was used, the choice, the shape signature, a one-sentence reason, the decision model's scores, why the rules stood in (`failed`, `low-confidence`, `no-budget`) and whether the choice was reused. The decision's explanation carries it as a sentence, the run inspector shows a "Strategy" row, and the selector's four questions and answers are in the decision's question list beside the others.

### The rules (`routing/selection/rules.ts`)

From what was measured above, when each setting pays:

| Rule | Evidence |
|---|---|
| **One pass** when every answer is listed in the pipeline's request | Inside the window the two strategies routed every corpus example the same (58/62 and 61/62 differ only by the three examples beyond the window); one pass needs no further request. Since 2026-11-12 one pass is the better of the two inside the window: it asks about every listed section, and the walk no longer asks below a root that is not plausible (two corpus examples) |
| **One pass** when the routing may use fewer than 6,000 decision tokens | The pipeline's request takes up to 5,400 with its full window and a level of the walk about 600. With less, the walk asks about the roots in the pipeline's request and cannot descend, so answers below a root go unasked **even when they are listed**, except the first-pass sections; one pass asks about every listed answer in that same request. Until 2026-11-12 the test was: with 3,000 tokens the configured tree walk places J on nothing, the rules' one pass on both siblings. With the first pass the siblings, being the most recent answers, are asked about either way and both place J on them; the rule still matters for listed answers that are neither roots nor in the first pass |
| **Tree walk** otherwise, **long runs searched** | Only the walk reaches answers older than the window; the search is the only setting that found a referent the walk could not (59/62 → 61/62) and changes nothing inside the window |
| **Start at the trunk base** when the longest trunk has 12 or more listed answers before its last and ends in a split | −23 tokens per skipped answer, +1,900 and a request when one of them is referred to. A trunk that has split is history more often than subject; a trunk that never splits is the conversation itself and replies to its earlier answers are the normal case, so there it stays off |
| **Hop between branch points** when a run below a split has 6 or more answers | −108 tokens per skipped answer, +280 and a request when a reply is inside the run |

The two switch rules are derived from the formulae and from one corpus example each; the corpus has no example where they change the result.

(Later on 2026-11-12: the hop rule, `HOP_SKIP` and the `sel_hops` question below are removed, and a choice no longer has `hopBetweenBranchPoints`. See ["Hop between branch points, redefined"](#hop-between-branch-points-redefined).)

### The decision-model selector (`routing/selection/decision.ts`)

One request to the injected `DecisionProvider`, through the pipeline's `SelectorAsk`. Its state text is the shape in words (`describeShape`: a heading line, seven lines of counts and the budget, under 1,400 characters); its questions are typed, never free text:

| ID | Type | Asks |
|---|---|---|
| `sel_strategy` | `choice`, options `one-pass` and `tree-walk` with a description each | Which way of finding the earlier answers fits a conversation of this shape |
| `sel_trunk` | `noul` | Whether the longest trunk ends in a split with 12 or more listed answers before its last |
| `sel_hops` | `noul` | Whether the longest run below a split has 6 or more answers |
| `sel_search` | `noul` | Whether more than a dozen answers of one run, or old single answers, are older than the listed ones |

- **Size.** 806 to 849 input tokens as the provider reported them (the difference between the same corpus example with and without the selector); 754 to 785 by the guard's estimate. About 0.15 s.
- **Reading the answers.** The strategy stands at or above the target-choice threshold (0.70). A switch is turned on only on a confident yes (≥ 0.70); the search is turned off only on a confident no (≤ 0.30), because off, a run too long to list is out of reach.
- **Fallback to the rules**, with the reason recorded: the request fails (`failed`; routing goes on, it does not fail with it); the strategy's confidence is below the threshold (`low-confidence`, with the confidence); the request does not fit (`no-budget`: it may take at most 15% of the routing's token budget, `SELECTOR_BUDGET_SHARE`, and nothing is sent).
- **Its cost is inside the guard.** The request is counted against the routing's token budget like the pipeline's own, before the pipeline's request is fitted to what is left. The cost grid runs both selectors on every cell: worst 1.99× (the same cell as without), and with 120-token answers the request is refused and the rules choose.
- **Reuse by shape signature.** `shapeSignature` reduces the shape to buckets: every count by its power of two (1, 2–3, 4–7, …), tokens by the thousand, whether the longest trunk and run end in a split, and whether the budget has room for a further request. A choice made from the shape alone is the same for every routing with the same signature, so it is made once: the backend hands the router the most recent selection in the conversation's recorded routing decisions (`RoutingInput.strategySelectionOnRecord`, from `state.messages[…].decision`), and when its signature is the current one and it was the decision model's own choice, it is used and **nothing is asked**. The cache is the event log: nothing is held outside state, it survives a restart, and core stays deterministic. A fallback on record is not reused. A growing conversation changes signature a number of times logarithmic in its size.
- **The message is not shown.** `createDecisionSelector({ includeMessage: true })` adds it and words the options for it; it is not a setting. Measured below: no gain, more fallbacks, and a choice that depends on the message cannot be reused.

### Measured (live, `typesafe/jev-1.13`, 2026-11-11, reference decompositions, 62 examples)

Three runs of the corpus for the default and the selectors, two for the other rows (the third run of each is the whole `pnpm smoke`). Requests and tokens were the same in every run. The decision-model rows are **without reuse**: the corpus routes one message per conversation, so the selector is asked every time.

| Configuration | Score per run | Requests | Tokens reported | Per routing |
|---|---|---|---|---|
| One pass | 58/62, 58/62 | 74 | 92,592 | 1.19 requests, 1,493 tokens |
| Tree walk, runs listed | 59/62, 59/62 | 94 | 104,582 | 1.52, 1,687 |
| Tree walk, long runs searched (the default) | 60/62, 61/62, 61/62 | 100 | 120,245 | 1.61, 1,939 |
| + trunk base | 61/62, 61/62 | 100 | 118,215 | 1.61, 1,907 |
| + hops | 61/62, 61/62 | 102 | 120,018 | 1.65, 1,936 |
| + both | 61/62, 61/62 | 102 | 117,988 | 1.65, 1,903 |
| **Selected by rules** | **61/62, 61/62, 61/62** | **83** | **110,364** | **1.34, 1,780** |
| Selected by the decision model | 61/62, 60/62, 61/62 | 126 | 145,539 | 2.03, 2,347 |
| Selected by the decision model, shown the message | 61/62, 61/62, 61/62 | 126 | 147,233 | 2.03, 2,375 |

- The differences between runs are one borderline example each, neither of them about the strategy: `revision-session-requirement` (the default, run 1), `target-ambiguous-use-that-one` (the decision model, run 2). `split-correction-and-new-work` is missed by every configuration, as before.
- **The rules** score what the default tree walk scores, with 17% fewer requests and 8% fewer tokens: 34 or 35 of the 40 or 41 routings that select anything are inside the window and get one pass, the six beyond it the tree walk.
- **The decision model does not beat the rules.** Its choices: one pass 35 times, the tree walk 3 times, the tree walk with runs listed twice (conversations with fewer than a dozen older answers, where listing fits), and once not confident. The score is the same within the noise; it costs 26% more requests and 21% more tokens than the default, and 52% and 32% more than the rules. With reuse a real conversation pays the request once per shape, which removes most of that cost and none of the reason: the questions it answers are the rules, stated in words.
- **Shown the message**: the same score, five or six fallbacks for low confidence instead of one, about 41 more tokens a request.
- The J request on both siblings, five runs of five cases, and the follow-up naming two sections, five runs of two: **25/25 and 10/10 with each of the three selectors.**

**Default: `rules`** (2026-11-12; `off` before). On this evidence the rules are the better default than a fixed strategy: the same results for fewer requests, and the walk exactly where it is needed. The user: "Keep rules the default for strategy selection". `off` and `decision-model` stay available; `decision-model` has nothing the rules do not.

## Evidence and the default

Live, `typesafe/jev-1.13`, reference decompositions, 2026-11-11. The corpus grew from 44 to 55 examples: nine with live-style titles (the J request in four settings and among unrelated answers, two follow-ups naming two sections, one sibling alone, an unrelated message), and two in a 30-section conversation.

| | 44 examples (before this change) | 55 examples |
|---|---|---|
| Round-3 questions (as shipped before) | 41/44 | 47/55 (reproduced as an injected strategy) |
| One pass | | **53/55** |
| Tree walk | | **54/55** |
| Tree walk with the live decomposer | | 53/55 (39/44 before) |

- The J request on both siblings, five runs of five cases: **25/25** with each strategy. With the round-3 questions the spec's wording was placed on the neighborhoods alone in both closed scenes, every run.
- The J request through the whole embedded backend (real engine, live decision model, live answers on a cheap model; `providers/test/smoke/j-request.smoke.test.ts`): **4/4**. Two runs sent J while A and B were running (J was queued on the sibling group, started after both had finished, read both); two sent it after the join-back had formed (J continued from it on the base chain, read both).
- A follow-up naming two sections, five runs of two cases: **10/10** with each strategy. "Compare the itinerary with the sky explanation" (the corpus's older example of this) went from the target-ambiguity prompt to a join chain after the section question was reworded to "…reply to it, build on it, compare or combine it with another answer, or correct it?": the sky section rose from 0.50–0.61 to above the threshold.
- Misses. `split-correction-and-new-work` under both: the new part ("also suggest some day trips") gets a handling chain below the threshold; it also missed before, and it is not a referent question. `live-referent-beyond-window` under one pass: the itinerary is older than the 24 listed sections, so it is never asked about and the message silently starts a new chain.

**Defaults of the long-run settings** (2026-11-11):

- `searchRunsOverTokens`: **1,500**, always in force. It is the only one of the three that finds something the walk could not find before (the two 200-section referents: 59/62 → 61/62), and it changes nothing inside the window. A chunk of 12 was more accurate than one of 25 for a correction, and 12 sections are what one request lists for 1,500 tokens.
- `startAtTrunkBase`: **off**. On the corpus it changes no result and saves 1.7% of the tokens, all of it on the 200-section chain (12% there). Inside the window it trades 23 tokens a trunk section for a further request whenever a trunk section other than the base is referred to, and a conversation that continues one chain is exactly where replies to earlier sections of the trunk are the normal case.
- `hopBetweenBranchPoints`: **off**. Same score, 0.2% fewer tokens, 2% more requests on the corpus. It pays when replies go to the ends of runs (−18% on that example) and costs a request when they go inside one (+4% to +8%). It also needs the end of a hop asked twice to be right. Turn it on for trees with long branch runs where follow-ups address the latest state of each branch.
- No size trigger was added to the switches: the size trigger is the third setting, which the user asked for in its own right ("some threshold of amount of node context").

**Configured strategy: tree walk** (what runs when strategy selection is `off`; with the default, `rules`, the rules choose one pass inside the window and the tree walk beyond it). Within the window the two are equal on every example (until 2026-11-12; since then the walk misses two examples inside the window that one pass routes, see "What removing the question costs", so the configured strategy matters only with strategy selection off, and one pass is then the safer choice for conversations inside the window). The difference is the conversation longer than the window, where one pass loses the referent without asking, which is the kind of silent wrong placement this change exists to remove. The price is 12% more decision tokens on the corpus (0.32% of an answer instead of 0.28%) and one more request of about 0.15 s when a message refers into a branched line of work; an unrelated message, or one in a conversation that does not branch, costs the same or less. The guard bounds the worst case at 3.7%. One pass stays selectable (Settings → Routing → Referents) for anyone who prefers a single request.

## The hard stop, the best node found so far, the first pass, and rules by default

Added 2026-11-12 on the user's decisions:

> Keep rules the default for strategy selection

> For routing cost, just default with the best leaf if its too expensive to keep checking.

> DA4 -- budget is a hard stop. No asking the user. Just best node found so far.

> DA3 -- agreed -- A yes to that question only says where to look next.

> On best node found so far -- we can just as a first pass always check the last 5 non-ancestor nodes in the conversation, so we keep a bound of candidates.

> asks are only made when clear-eyed, rather than because we couldn't calculate the referents.

> Stored settings keep strategy selection value. Only default is rules.

> Yes, agreed with proposed invariants. Update spec.

> Run receives recorded exchanges, not summary. The summary is more used for search and decision.

Specified in 11 · "Referent strategies" (first pass), "Decision budget" (hard stop, best node found so far), invariants 11 and 12, and DA1–DA5.

### Rules by default

`DEFAULT_SETTINGS.routing.strategySelection` is `'rules'`. `normalizeSettings` keeps any stored mode, `off` included; settings stored before the mode existed, or with a value that is not a mode, get the default. Settings are stored whole, so a conversation list that was opened between 2026-11-11 and this change has `off` stored and keeps it: only the default changed. Settings → Routing shows "By rules" selected and says so.

### The first pass

Every routing, with either strategy and any selector mode, asks in the routing request about the **first-pass sections**, each by itself (`routing/referents/first-pass.ts`; the pipeline adds the questions for every strategy in `addReferentQuestions`):

- Walk back from the most recent answer section; take a section unless it is an ancestor of one already taken; stop at five (`FIRST_PASS_SECTIONS`). "Ancestor" is the context tree's: a group's members are ancestors of what continues from its join-back.
- A sibling group one of them belongs to gets its whole-group question too, when the request lists every member.
- They are listed in the routing request whatever its window, and the smallest window lists them alone (`MIN_SECTIONS` = `FIRST_PASS_SECTIONS`).
- The questions carry the IDs both strategies use (`m_s<n>`, `m_j<i>`). One pass asks them anyway. The tree walk reads the answers like any other score: it does not ask again when it reaches the node, and a first-pass section on a line the walk pruned is still a referent when it scored at the threshold.

| Conversation | First-pass sections |
|---|---|
| One chain of any length | The latest answer |
| Unrelated answers | The five most recent |
| The trip: brief → A, B → join-back → J; B → B2; S | J, B2, S |
| Brief → A, B, nothing built on them | A, B, and the group as a whole |
| A trunk of ten that split into X and Y | X, Y |

What it changes for the tree walk, measured in the tests: in a tree three branch points deep a reply to a leaf takes two further requests where it took three (the leaves' level is already asked about); with no further request allowed, a reply to a leaf is found where the root was taken before. It costs the walk at most five questions (about 200 tokens) in the routing request.

### The hard stop and the best node found so far

When any limit stops a referent strategy (the token budget, the bound against the answer, the request or question backstops), nothing more is asked of the decision model, and **the user is not asked which section is meant**.

- The strategy still takes its cheaper fallback when it fits: the listed sections it has not asked about, in one request.
- It reports, per unit, the **best node found so far** (`bestNodeFound` in `routing/referents/shared.ts`). Candidates: every node that was asked about by itself (a section through its own question, a sibling group through the question about the group as a whole) and scored at or above the plausibility floor.
- **Order (the tie-break).** (1) A node with a plausible descendant is passed over for the descendant, whose context already holds it; not for a correction. (2) Of the rest, the highest score. (3) On equal scores, the most recent in conversation order; a group counts as just after its last member.
- **The floor is 0.25** (`AMBIGUITY_FLOOR`): the threshold the walk descends on, and the same one below which the pipeline never asked the user about a section. Nothing plausible means no best node: the unit is routed as referring to nothing there.
- A group resolves to every member, so the unit continues from the full join-back, never a subset.
- The pipeline (`resolveUnitTargets` in `routing/derive.ts`) uses it **only where its rules would have asked the user**. Referents at or above the target-choice threshold are targets as always. A unit judged to be new work, or one placed with confidence without a target, is not a reply and gets no target, as before.
- The guard itself also reports a stop: a strategy whose request `createReferentAsk` refused is treated as stopped even when it does not say so, and one that names no best node has its highest-scoring plausible section taken (the most recent on equal scores).
- **Recorded**: `RoutingDecision.budgetStop` (`limit`: `token-budget`, `price-guard`, `requests` or `questions`; `fallback`: `one-pass` or `partial`; `bestFound`: unit, sections and score for each unit placed that way). The explanation carries it as a sentence, and the run inspector shows a "Decision budget" row.
- **Deterministic**: every input is a recorded score or the candidates; the tests route twice and compare requests and outcome.

**How the first pass and the floor interact.** The first pass makes the candidate set non-empty and bounded once the conversation has answers; it does not make a candidate plausible. So three outcomes remain when the budget is reached and no referent is clear: a plausible node asked about by itself exists and is taken; none is plausible and the unit refers to nothing there; or the unit is not a reply at all and the question never arose. The floor was kept because without it a reply would be placed on a section the decision model scored at 0.05. It does not conflict with existing behaviour: below 0.25 the pipeline never raised a question either.

**What is given up.** A reply to an old section whose search the budget ended is placed on the best of what was asked about, usually a recent leaf, or starts where its handling chain says, without the user being asked. Before, the user was shown the sections of the relevant chunk. The descendant-first rule can take a node scored 0.30 over its ancestor scored 0.65; the ancestor is in the descendant's context, so the work still reads it.

**Interpretations made** (reported to the user):

- "Best node found so far" replaces the question to the user; it does not make every message a reply. With clear targets they stand; with none and no question due, there is no target.
- A sibling group asked about as a whole competes as a node also below the target-choice threshold, and wins over its members when plausible (it is their descendant).
- The routing request is always sent, also when it alone exceeds the budget, as before; DA4 and invariant 11 name it beside the two requests a plan cannot be made without.

### Measured (live, `typesafe/jev-1.13`, 2026-11-12, reference decompositions, 62 examples)

One run of the whole `pnpm smoke` after the change. "Before" is the 2026-11-11 table under "Strategy selection · Measured".

| Configuration | Score | Requests | Tokens reported | Per routing | Before: score, requests, tokens |
|---|---|---|---|---|---|
| One pass | 58/62 | 74 | 92,592 | 1.19 requests, 1,493 tokens | 58/62, 74, 92,592 |
| Tree walk, runs listed | 59/62 | 83 | 99,798 | 1.34, 1,610 | 59/62, 94, 104,582 |
| Tree walk, long runs searched (the configured strategy) | 61/62 | 89 | 115,461 | 1.44, 1,862 | 60–61/62, 100, 120,245 |
| + trunk base | 61/62 | 89 | 113,431 | 1.44, 1,830 | 61/62, 100, 118,215 |
| + hops | 61/62 | 92 | 116,419 | 1.48, 1,878 | 61/62, 102, 120,018 |
| + both | 61/62 | 92 | 114,389 | 1.48, 1,845 | 61/62, 102, 117,988 |
| **Selected by rules (the default)** | **61/62** | **83** | **110,364** | **1.34, 1,780** | 61/62, 83, 110,364 |
| Selected by the decision model | 61/62 | 126 | 145,539 | 2.03, 2,347 | 60–61/62, 126, 145,539 |
| Selected by the decision model, shown the message | 61/62 | 126 | 147,233 | 2.03, 2,375 | 61/62, 126, 147,233 |

- **No score changed.** With the default budget no routing of the corpus reaches a limit in any configuration but one, so no question to the user became a placement. The exception is the tree walk with runs always listed, whose question backstop is reached on the four 200-section examples; none of them needed the best node (the target was clear, or nothing asked about by itself was plausible), and the two it misses are the two it missed before.
- The user is still asked which section is meant in two or three examples per configuration: the two labelled as ambiguous (`target-ambiguous-shorter`, `target-ambiguous-use-that-one`), and under one pass `split-correction-and-new-work`, which every configuration misses. These are ambiguities with budget to spare.
- **The first pass saves the tree walk requests**: 11 fewer on the corpus (100 → 89 for the configured walk, 94 → 83 with runs listed) and 4% fewer tokens, because the level of the most recent leaves is already asked about in the routing request. One pass and the rules' choice (one pass inside the window) are unchanged to the token.
- The J request on both siblings, five runs of five cases, and the follow-up naming two sections, five runs of two: **25/25 and 10/10 with each of the nine configurations.** Through the whole backend with the default settings (`j-request.smoke.test.ts`): 4/4.
- **Cost grid** (`pnpm smoke`, 360 cells): the worst guarded cell is still **1.99×** (one pass, bushy, 120-token exchanges). The tree walk in nested forks with 120-token exchanges is now 1.97× to 1.98× (1.93× to 1.94× before): its smallest request lists five leaves and asks 14 questions where it listed four sections and asked 9. With 300-token exchanges the tree walk's worst is 1.93× in nested forks. The rows of the grid table above are from before the change.
- Not measured live: a routing where the best node found so far is actually used. The corpus has no example that reaches the budget with a plausible candidate below the threshold; the behaviour is covered by the deterministic tests only.

## The model, the operations, and the search

Added 2026-11-12 on the user's decisions:

> Let's not have "below" as an operation. It feels too lossy on a wrong "no".

> Extract the operations behind one interface. This keeps our search algorithm much purer and better abstracted.

> Change the stretch search to find the last relevant node.

> If the stretch is relevant, we may want to check if the relevant part is all just in the first half of the stretch or not, hence the binary search.

> In our "tree walk" algorithm, we can take in a different set of candidate nodes, which will be on top of the starting with root nodes. In practice, we will be providing the rag hits as nodes. Note that we still need a pass to reduce the provided candidates + all true roots to the "non-ancestor" set before starting the actual walk, or in other words the set where no node is an ancestor of another node.

> while the point operation asks a node by itself, under the hood the decision model is provided some of the ancestry context to help the decisioning.

> It must obviously include some of the nodes at the root of the stretch as context for the decision, but the decision should be asked only about the stretch.

> For each node's full context, check relevancy. If it is relevant, bfs check its children (as well as the join group, if there are multiple children, as that is an artificial node).

The user's word for an unbranched run is "stretch". This document says unbranched run, or run, as the glossary does.

### The model

- The genealogy is a graph of answer sections and join-backs. A join-back is an artificial node for a sibling group: a child of every member.
- The **context** of a node is the node and its ancestors.
- For a unit there is a hidden set of **relevant** nodes. Dependency selection returns the **deepest relevant nodes**: every relevant node that has no relevant descendant.
- Consequences, all of which were rules before and are now one statement:
  - an ancestor of a relevant node is dropped (a correction keeps it, 06);
  - inside an unbranched run the answer is the **last relevant node**: not the end of the run, and not every relevant node of it;
  - two or more members of one sibling group become the whole group (Q30).
- **Exact and best effort are one search.** With no budget it runs to its end. With the decision budget, which is a hard stop, a round that does not fit is not sent and what a Point or a Group confirmed so far stands, with the best node found so far (`bestNodeFound`, unchanged).
- **What "exact" needs.** A walk descends only below a run that is plausible. So it returns exactly the deepest relevant nodes when relevance is inherited upward along a line of work (a relevant node's context is relevant, which is what the model says), or, without that, when every deepest relevant node is a start candidate or a first-pass section. A relevant node below a run the decision model finds unrelated, with neither, is not reached. See "What removing the question costs".

### The operations

One interface, `ReferentOperations` (`packages/core/src/ports/referent-operations.ts`). A search calls nothing else.

```ts
type Probe =
  | { kind: 'point'; unit: ReferentUnit; node: SectionNode }       // this one node, asked about by itself
  | { kind: 'group'; unit: ReferentUnit; node: GroupNode }         // a sibling group as a whole: its join-back
  | { kind: 'segment'; unit: ReferentUnit; nodes: readonly SectionNode[] } // anything in this part of an unbranched run
  | { kind: 'several'; unit: ReferentUnit }                        // more than one section at once

interface ReferentOperations {
  known(probe: Probe): number | null                 // the latest answer, as a probability of yes; null when not asked
  ask(round: readonly Probe[]): Promise<ProbeRoundResult> // one round is one decision request: answered | refused (limit) | failed
  rides(probe: Probe): boolean                       // whether the routing request, sent anyway, can carry it
  estimate(unit: ReferentUnit, nodes: readonly ReferentNode[]): number | null // a free prior; never confirms
  describe(node: ReferentNode): string               // what a question shows for the node
  size(probe: Probe): number                         // what the probe adds to a round, in estimated input tokens
  fits(round: readonly Probe[], reserve?: readonly Probe[]): keyof DecisionBudget | null // the first limit the round, and a reserve round after it, would pass
  remaining(): DecisionBudget                        // what the budget still allows
}

interface CandidateSource {                          // settings.routing.candidateSource, or CoreDependencies.candidateSource
  name: string                                       // recorded with the routing decision
  candidates(query: {
    conversationId: ConversationId; unit: ReferentUnit; text: string
    sections: readonly CandidateSection[]            // every answer section, oldest first
    answerText(section: CandidateSection): string    // the whole answer so far
    firstPass: readonly SectionId[]                  // asked about by themselves anyway
  }): Promise<readonly { sectionId: SectionId; score: number | null }[]>  // best first; the score is recorded, never read
}
```

| Operation | Costs | What it is | Default implementation (`routing/referents/operations.ts`) |
|---|---|---|---|
| **Point** | decision | Does the unit refer to this one node, asked about by itself. The only way a section becomes a referent | `m_s<n>`, the section's line with as much of its answer as the budget allows (see "What a Point shows"), and in a further request the nearest answers it was built on as context |
| **Group** | decision | Does it build on a sibling group as a whole. The only way a group becomes a referent | `m_j<i>`, unchanged |
| **Segment** | decision | Does it refer to anything in this contiguous part of an unbranched run. Directs the search; confirms nothing (DA3) | `m_c<first>_<last>`: the chunk question, each section named by its request; the first answers of the run as context |
| **Several** | decision | Does it refer to more than one section. Read by `derive.ts`, and by the walk for reinstating (below) | `m_several`, unchanged |
| **Estimate** | free | A relevance prior for a node or a part. Never confirms | Returns no estimate. No policy consults it yet: a lexical or embedding prior goes here |
| **Structure** | free | Roots, children, the unbranched run of a node, ancestors, the non-ancestor set, recency | Pure functions over the tree: `routing/referents/tree.ts` (`stretchOf`, `segmentFrom`, `ancestorsOf`, `reduceToNonAncestors`, `joinBacksOf`, `rank`). Where a run is split is the policy's choice, from `size` |
| **Describe** | free | How a node is shown in a question | The section's line (title, request, opening of the answer), or the stored summary and the section's own content where the summary provider has one. A Point's line shows the whole answer, or its opening and the best-matching passages, as the budget allows (`routing/shown.ts`, "What a Point shows") |
| **Cost** | free | The size of a probe before sending, whether a round fits, what is left | The guard's estimate (`ask.ts`), through `ReferentAsk`. The probes of one round are batched into one decision request |

- **A strategy is a policy** (`ReferentPolicy` in `routing/referents/search.ts`): `opening(input, ops)` names the probes it wants in the routing request, `search(input, ops)` runs the rounds. `strategyFromPolicy(policy, operations?)` makes it the `ReferentStrategy` the pipeline is handed, with the decision-backed operations unless another factory is given. `one-pass.ts` and `tree-walk.ts` import only the port, `search.ts` and `tree.ts`; a test reads their imports and fails on a question ID, a wording, a token estimate or a decision-provider type in them.
- **The test double** (`createOracleOperations` in `routing/referents/oracle.ts`): the operations over a labelled set of relevant nodes, with a budget counted in rounds and probes. `search.test.ts` runs both policies with it and no decision provider at all.
- **Not injectable through `CoreDependencies`.** The operations are a port by shape and are swapped by building a strategy (`strategyFromPolicy`) and injecting that as `referentStrategy`. The first pass, which the pipeline adds to its request for every strategy, uses the default wording and IDs; a second injection point would have to keep the two in step.

### What a probe shows

- **In the routing request** nothing is added: its state text lists the window's sections and lines of work already. A section asked about by itself there is shown more of its answer since 2026-11-12: see "What a Point shows".
- **Point, in a further request.** After the lines of the sections asked about: "Where they come from, for context only (no question is about the answers named here unless it names them itself):", then one line per parent, `S7 and S8 build on S5 ("request…"), which builds on S3 ("request…").` The nearest **two** ancestors (`POINT_ANCESTRY`), each by its request cut at 80 characters, or by its number alone when its own line is in the request. Sections that follow one another in a run get one line for the first and `S36 to S47 are consecutive answers of one line of work.` A section whose line is a stored summary gets none: the summary stands for the work before it.
- **Segment.** The question names only the part's sections. Context: `S41 to S198 are consecutive answers of one line of work that starts with S1 ("…"), S2 ("…") and builds on S9 ("…").` The first **two** answers of the run (`SEGMENT_LEAD`) when the part does not start there, and the **one** node the run was built on. The parts of one run in one request share the line. A part that starts at the top of a root's run has no line.
- **Cost.** About 12 to 30 tokens per context line; one to three lines in a typical further request. Measured on the corpus below.

### The removed question

`underQuestion`, the `m_u<n>` and `m_uj<i>` IDs and the descent on them are gone from the code, the tests and the oracles. A routing recorded earlier keeps the questions it asked: `RoutingDecision.questions` is a list of records by ID and no stored shape changed, so `STATE_VERSION` is unchanged.

### The search

`treeWalkPolicy` (`routing/referents/tree-walk.ts`). One pass is unchanged in what it asks: its request is the same, token for token.

1. **Start set** (`startSet`): the roots and the start candidates of the unit, reduced to their **non-ancestor set** by `reduceToNonAncestors` (`tree.ts`): a node that is an ancestor of another is dropped in favour of its descendant, the same direction as the first pass. With no candidates it is the roots.
2. **Starting at a node** examines the part of its unbranched run from the run's top down to the node. A root's run is examined whole.
3. **Examining a part of a run.**
   - A sibling group is asked about as a whole (Group): the group node at the top of a run, and the group any section of the part is a member of.
   - At a start, the sections the routing request lists are asked about by themselves in that request.
   - **A confirmed section stands for everything above it in the run**: sections above the last one a Point confirmed (at the target-choice threshold) are not asked about. Its context holds them, and `referentsFromScores` would drop them.
   - The other sections that were not asked about: by themselves in one round when that costs at most `searchRunsOverTokens`; otherwise the part is **searched for its last relevant node**.
4. **The search of a run** (find the last relevant node). "Is anything relevant in this part?" is asked for up to 24 parts in one round (Segment; a part is as many sections as can be listed within `searchRunsOverTokens`, and more than 24 parts are grouped into 24 and split again). The **latest** plausible part is opened: when it can be listed, its sections are asked about by themselves, and only that makes one a referent. So a run of any length costs rounds logarithmic in its length, and one part's Points.
   - **When the Point does not confirm.** A Segment's yes confirms nothing. When no section of the opened part scores at the target-choice threshold, the search goes on in the **next plausible part before it**, one part a round, as long as the budget allows. A part that was not plausible is never opened. Sections of an opened part that scored between the floor and the threshold are reported with their own score, as always.
   - **Corrections.** A corrective unit needs the relevant nodes themselves, not only the deepest: it may name work its descendants only consumed (06). For it every plausible part is opened, side by side in one round, and nothing above a confirmed section is skipped; `referentsFromScores` keeps the ancestors. This is the search as it was before.
   - **Old single answers** that nothing was built on are not a line of work: every relevant one is a deepest relevant node. They are pooled into one run and searched for all of them, as before.
5. **Descent.** As soon as anything in a run is plausible (0.25), the rest of the run and every child run are examined: the runs below its end, and the join-back of a sibling group one of its sections is a member of. Nothing is examined below a run that is not plausible. The first round of a part settles this, so the runs below are taken up while a search of the run goes on.
6. **Reinstating**, two safeguards for what dropping an ancestor from the start set can hide:
   - (a) a start that displaced an ancestor and is **not plausible** hands over to the nearest nodes it displaced (the roots and candidates above it, reduced to their non-ancestor set), which become starts;
   - (b) when Several is at the target-choice threshold, the displaced ancestors of **every** start are started as well, so that a second referent in another branch is found.
   Both go tier by tier up to the roots, each tier after the one before has finished. What was asked is not asked again: a run records how far down it was examined, so a reinstated root that reaches the run of an earlier start examines only the rest of it.
7. **Rounds.** Everything every unit wants next is one round, one decision request. The first round rides in the routing request as far as that request lists what it names.
8. **Budget.** Before a round the walk checks that the round and its fallback both fit (`fits`). The fallback is the one-pass probes for listed nodes it has not asked. It is now a round like any other, showing only the sections it asks about, not the routing request's whole state text. Otherwise as before: `one-pass` or `partial`, and the best node found so far.

The walk is written as steps that say what they want answered next; steps under way are a flat list, so a tree thousands of branch points deep is walked without nesting.

### Start candidates

- **Port.** `CandidateSource` (`CoreDependencies.candidateSource`, threaded like the other routing ports; `createTestBackend` takes it too). Asked once per unit before the routing request is put together: the message, or each part of a composite, with its text and the conversation's answer sections. Not asked for an explicit or chosen reply target.
- **Default: none.** No retrieval is built. The tests use scripted sources. (Until later on 2026-11-12: the lexical source is built and is the default, see ["The candidate source: a lexical index"](#the-candidate-source-a-lexical-index). An injected source still replaces it.)
- **Rules.** Only answer sections of this conversation are accepted (invariant 9); at most 12 per unit (`MAX_START_CANDIDATES`); a source that rejects is a source with nothing to say. A candidate is a place to look and never a referent: it is asked about like any other node. One pass ignores candidates.
- **In the request.** `ReferentRequest.startCandidates`, by unit key.
- **What a candidate changes.** Its run from the top down to it rides in the routing request when listed, and the root above it is not asked about. An unlisted candidate is examined in the first further request with its ancestry as context.

### The two switches

Both still work and are tested in each combination (`referents.test.ts`, `search.test.ts`, the corpus, the cost grid).

- **What they mean now.** With a switch on, of a part only its **last** section is asked about by itself at once, and the sections skipped (two or more) are one Segment per part, however few; the last is asked about again beside the sections a search opens. `startAtTrunkBase` applies to a root's run, `hopBetweenBranchPoints` to every other run.
- **Neither is redundant, both matter less.** Without a switch a run over `searchRunsOverTokens` is searched anyway, and now a confirmed section already spares everything above it. What a switch still changes is a **short** run: one Segment instead of a Point per section.
- **Evidence** (live, below): `startAtTrunkBase` saves 2,002 tokens on the corpus (1.8%), all of it on the three 200-section-chain examples, where two Segment questions replace 23 Points in the routing request (5,377 against 6,086 tokens for a reply to the latest answer); the score is the same. `hopBetweenBranchPoints` changes **nothing** on the corpus now: the same 84 requests and 108,935 tokens to the token. Its one corpus scene with runs below a split (`deep-run-*`) is no longer descended into, and where it would have paid before, a reply to the end of a run, the end is a first-pass section and, confirmed, already spares the run above it with the switch off. What is left for it is a short run that is plausible while its end is not confirmed.
- The rules of the strategy selector for the two switches (`TRUNK_SKIP`, `HOP_SKIP`) are unchanged.
- (Later on 2026-11-12: `hopBetweenBranchPoints` has a new meaning, and no rule turns it on. See ["Hop between branch points, redefined"](#hop-between-branch-points-redefined).)

### What removing the question costs

- **Where.** A referent that is neither a first-pass section nor a start candidate, below a run the decision model does not find plausible. The corpus has three such examples (`CorpusExample.below`): `live-referent-beyond-window` (the itinerary, below the brief and the sibling group, older than the window), `deep-run-middle-section` (day 2 of five day plans below the itinerary) and `deep-run-other-branch` (the second of four answers in the other branch).
- **With decisions strictly as labelled** (the oracle answers "no" for the brief) the tree walk misses all three, and the default, by rules, misses the first: inside the window the rules choose one pass, which asks about every listed section. `corpus.test.ts` expects exactly that.
- **Live** the brief is plausible for "Swap days 2 and 3 of the Kyoto itinerary", so `live-referent-beyond-window` is found, in three requests as before. It is not plausible for "Make the day 2 plan less packed" or "Which of those hostels has private rooms with a bathroom?": the walk asks nothing below the brief, the ends of the two runs (first pass) are not confirmed, and the reply continues the end of its line (D5, H4) through its handling chain. It reads the section meant, which is in the end's context, and does not branch from it. Configured tree walk: **61/62 → 59/62**. The default (rules): **61/62, unchanged**.
- **Why.** The question existed because relevance, as the decision model answers a Point, is not inherited upward: the brief scored 0.07 for a message about the itinerary below it. The model above says a relevant node's context is relevant; the decision model's answer about a root by itself does not.
- **What recovers it**, in the order the user intends: a **candidate source** (a retrieval hit on D2 or H2 is a start: both examples are routed as labelled in `corpus.test.ts` with a scripted source that names the referent, and so is the third; since built as a lexical index, which names all three by itself: "The candidate source: a lexical index"); a real **Estimate** (a lexical or embedding prior to rank the runs below a root); or wording the Point of a root so that "the line of work it starts" counts, which is the removed question under another name and was not done.

### Departures

| From | Built | Why |
|---|---|---|
| "exact: finds all deepest relevant nodes" | Exact when relevance is inherited upward along a line, or the deepest relevant nodes are start candidates or first-pass sections | The brief also says nothing is examined below a run that is not relevant. Both hold together only under that condition; the tests state it |
| "On a relevant stretch, search for the last relevant node" by bisection | 24-ary, batched: up to 24 parts a round | The tokens of a round are the sections it names, whatever the fan-out; halving costs a request each time (measured 2026-11-11, "Long runs") |
| Short runs "may still be asked point by point" | They are, in one round | As before |
| The found node "is then confirmed with a Point" | Every section of the opened part is asked about by itself in one round, not only the last | One request either way; the part is at most what `searchRunsOverTokens` lists, and the neighbours give the decision model something to compare with |
| Candidates "on top of the starting with root nodes" | A root that a candidate displaced is not asked about unless reinstated | That is the reduction the user asked for; safeguards (a) and (b) bring it back |
| Estimate | On the interface, returns nothing, and no policy calls it | No estimator was to be built |
| Operations "a port" | A port by interface; injected by building a strategy, not through `CoreDependencies` | See "The operations" |
| Fallback request | Shows only the sections it asks about | It is a round like the others; it is smaller, so it fits more often |
| 11 · "Tree walk": "It descends below an unbranched run only when one of its sections, or the question 'does the unit refer to anything built on this?', is at least plausible" | Only the sections, the group and the parts of the run | The question is removed. The spec text is the main session's to change |
| 11 · "Search of long unbranched runs": "only the sections of a relevant chunk are then asked about one by one" | Only the latest relevant part, then the one before it when no Point confirms; every relevant part for a correction and for old single answers | The last relevant node |
| 11 · "Start at the trunk base" and "Hop between branch points" | The same, and the skipped sections are searched for the last relevant one | |

### Measured

Live, `typesafe/jev-1.13`, 2026-11-12, reference decompositions, 62 examples, one run of the whole `pnpm smoke` (run twice: the first run's output was not captured, so the figures are the second's). "Before" is the table under "The hard stop … · Measured".

| Configuration | Score | Requests | Tokens reported | Per routing | Before: score, requests, tokens |
|---|---|---|---|---|---|
| One pass | 58/62 | 74 | 92,592 | 1.19 requests, 1,493 tokens | 58/62, 74, 92,592 |
| Tree walk, runs listed | 57/62 | 78 | 93,343 | 1.26, 1,506 | 59/62, 83, 99,798 |
| Tree walk, long runs searched (the configured strategy) | 59/62 | 84 | 108,935 | 1.35, 1,757 | 61/62, 89, 115,461 |
| + trunk base | 59/62 | 84 | 106,933 | 1.35, 1,725 | 61/62, 89, 113,431 |
| + hops | 59/62 | 84 | 108,935 | 1.35, 1,757 | 61/62, 92, 116,419 |
| + both | 59/62 | 84 | 106,933 | 1.35, 1,725 | 61/62, 92, 114,389 |
| **Selected by rules (the default)** | **61/62** | **83** | **110,263** | **1.34, 1,778** | 61/62, 83, 110,364 |
| Selected by the decision model | 61/62 | 126 | 145,438 | 2.03, 2,346 | 61/62, 126, 145,539 |
| Selected by the decision model, shown the message | 61/62 | 126 | 147,132 | 2.03, 2,373 | 61/62, 126, 147,233 |

| Case (requests, tokens; ✗ = not routed as labelled) | Tree walk | Before |
|---|---|---|
| `live-referent-beyond-window` | 3, 5,282 | 3, 5,251 |
| `long-chain-old-section` (reply to the 3rd of 200) | 3, 7,972 | 3, 8,043 |
| `long-chain-latest-section`, `long-chain-unrelated` | 2, 6,086; 2, 6,080 | the same |
| `long-roots-old-section` | 3, 9,699 | 3, 9,699 |
| `deep-run-middle-section` | ✗ 1, 1,874: continues D5 | 2, 3,534 |
| `deep-run-end-section` | 1, 1,876 | 2, 3,538 |
| `deep-run-other-branch` | ✗ 1, 1,877: continues H4 | 2, 3,540 |

- **One pass is unchanged to the token**: the same request.
- **The tree walk loses two examples and 5.7% of its tokens** (84 requests against 89). The loss is the removed question, as above. The saving is the same thing: no question about what is built on a branch point, and no request below a root that is not plausible.
- **The default, by rules, keeps its score**, with the same 83 requests and 101 fewer tokens: 34 routings are one pass, six the tree walk.
- **The J request on both siblings, five runs of five cases, and the follow-up naming two sections, five runs of two: 25/25 and 10/10 with each of the nine configurations.** Through the whole backend with the default settings (`j-request.smoke.test.ts`): 4/4.
- The misses that are not the walk's: `split-correction-and-new-work` under every configuration, as before; under "runs listed", the two 200-section referents, as before. `routing-corpus.smoke.test.ts` (default settings): 60/62 with reference decompositions, the second miss being `split-output-order-barrier` (the barrier question, one borderline answer), and 59/62 with the live decomposer.
- **What the context costs.** With decisions as labelled and the guard's estimate, the tree walk's requests over the corpus are 102,993 tokens with the context lines and 102,667 without: **326 tokens, 0.3%**. Five of its 18 further requests carry a context block, of about 65 tokens each. The routing request carries none.
- **Cost grid** (`pnpm smoke`, 360 cells): the worst guarded cell is still **1.99×** (the tree walk in an early split, 50 or 500 sections of 120-token exchanges: the routing request alone, cut to its smallest, 11 questions and 2,478 tokens; one pass in a bushy conversation is 1.99× as before). With 300-token exchanges the worst is 1.93× (the tree walk over many roots). The largest guarded routing is 19,082 tokens (500 answers of 2,000 tokens on one chain, with the decision-model selector's request; the budget there is 20,000; 18,106 before). Unguarded, a search whose Points never confirm goes back one part a round: a 500-section chain is 79 requests where it was 4, and 8,000 sections 902. The request backstop (4) is what bounds that, as it bounds a deep tree. The grid table above is from before this change.
- Not measured live: start candidates (no source exists; since measured, see "The candidate source: a lexical index"), safeguards (a) and (b), a search whose Point does not confirm, and a routing that falls back. They are covered by the deterministic tests only.

## The candidate source: a lexical index

Added 2026-11-12 on the user's decision:

> yes, build a real candidate source with a subagent. Start with lexical index. Recall this is merely to help the search as a seed hints.

**What it is, and what it is not.** A word index over the conversation's answer sections that, for each unit, names the sections whose words are closest to the unit's text. They are handed to the tree walk as start candidates: further places to start, beside the roots. That is all.

- A candidate confirms nothing. It is asked about by itself like any other section, and only that Point (or a Group) makes it a referent (DA3).
- No score of the source is read by routing. The scores are recorded for the run inspector and nothing else.
- It replaces no Point and no Group, and it is **not the Estimate operation**: `estimate` still returns nothing and no policy calls it. Nothing is ordered or pruned by the index.
- One pass does not walk and ignores candidates: with the source on, its request is the same, token for token (live: 74 requests, 92,592 tokens, both ways).

### Built

`packages/core/src/routing/candidates/lexical.ts`, pure and deterministic: no clock, no randomness, no I/O, and no new dependency.

- **What is indexed.** One document per answer section: its title, the request it answered, and its whole answer text so far. A word of the request counts twice: the request names the subject in the user's own words, and the answer is long and names much besides. The candidates the pipeline is handed carry only the opening of an answer (280 characters), so the backend passes the whole text through `RoutingInput.answerText`; where a caller leaves it out (the corpus, which holds whole answers as openings) the opening stands for the answer.
- **Words** (`lexicalTerms`). Folded to compatibility form (NFKC) and lowercased; a word is a run of letters, digits and combining marks in any script, so a number is a word ("day 2"). English plurals are folded onto the singular ("hostels" = "hostel", "entries" = "entry"); nothing else is stemmed. A stop list of about 210 English words leaves out function words, the pieces of contractions, and the words of an instruction that name the change and not its subject (make, shorter, longer, combine, both, add, rewrite, again, answer, section, …).
- **Other languages.** Text written with spaces is split into its words in any script; accents are kept ("café" and "cafe" are two words). Chinese, Japanese, Thai, Lao, Khmer and Burmese, written without spaces, are indexed as overlapping pairs of characters. The stop list and the plural folding are English only: in another language every word counts, and a word common to the whole conversation weighs little only because it is common. A contentless message in another language therefore has words to look up, and gets candidates only if they clear the minimum below.
- **Score.** BM25 with the usual constants (k1 = 1.2, b = 0.75) over the distinct words of the unit's text; a word's weight is ln(1 + (N − n + 0.5) ÷ (n + 0.5)) for N sections of which n contain it, so it is positive for every word and largest for a word no section contains.
- **Query.** The unit's text: the message, or the instruction of one part of a composite.
- **Incremental.** One index per conversation, kept by the router between routings (the eight most recently routed conversations). At each routing it is brought up to date: a section whose title, request and answer are the strings it was indexed from is left alone, so only what was written or revised since is read again, and a section that is no longer current is removed. An index brought up to date gives exactly the hits of one built at once (tested); a score is summed in the order of the text's words, so it does not depend on how the index came about. The index is not persisted: after a restart it is rebuilt at the first routing of a conversation.

### The decisions the brief left to the build

| Question | Decided | Why |
|---|---|---|
| Are sections that are asked about anyway left out? | **The first-pass sections are left out; other sections the routing request lists are kept** | Every routing asks about each first-pass section by itself in the routing request, with either strategy, so naming one adds nothing and would take one of the twelve places. They are the ends of the most recent lines, so nothing lies below them that a start there would reach. A listed section that is not in the first pass is different: the tree walk asks about a listed section only when it lies on a line it follows, which is exactly the case to recover (`deep-run-middle-section` and `deep-run-other-branch` are inside the window) |
| Minimum score | **A share of at least 0.3** (`LEXICAL_MIN_SHARE`): the section's score ÷ the summed weight of all the text's words, those no section contains included. **And at least half the best section's score** (`LEXICAL_MIN_OF_BEST`), the best being taken before the first-pass sections are left out | An absolute BM25 score means different things in a conversation of 13 sections and of 200. The share says how much of what the message says is found in the section: a section that shares one or two common words with a message stays below it (on the corpus the sections left out score 0.10 to 0.27), the section a message names clears it (0.67 to 0.80 for the three examples below unrelated work, 1.07 and 1.80 for the single entries of the two long conversations). Half of the best keeps the sections that only share the named section's vocabulary out (the other days of the same plan: 0.31 to 0.32 against 0.67), and keeps two sections that are about equally close |
| Contentless messages | **No candidates.** "Make that shorter", "combine both", "Use that one", "Try again" have no word left after the stop list, so nothing is looked up | The stop list holds the words of an instruction that name the change. A message with one content word that no section contains has a share of 0 everywhere |
| Cap | **12 per unit**, the pipeline's existing `MAX_START_CANDIDATES`, applied by the source and again by the pipeline | Unchanged. On the corpus the source never returns more than two |
| Ties | **By recency: of equal scores the later section first.** Then the cap | Deterministic, and the later of two equally close sections is the likelier referent |
| Small conversations | Nothing special. In a conversation of one to five sections a word every section contains weighs almost nothing and a word none contains weighs most, so few sections clear the share | There the first pass asks about the ends of every line anyway |

### Wiring, the setting and the record

- **Setting.** `settings.routing.candidateSource: 'none' | 'lexical'` (`CandidateSourceName`, `CANDIDATE_SOURCE_NAMES` in `protocol/src/settings.ts`), validated in `validateSettingsPatch`, defaulted by `normalizeSettings` for settings stored before it existed. Settings → Routing → "Candidate sections": "None" or "Word index", worded as seed hints that cost no decision tokens themselves, each of which may add questions within the decision budget.
- **Which source runs** (`candidateSourceFor` in `routing/pipeline.ts`): an injected `CoreDependencies.candidateSource` wins; otherwise the lexical source when the setting says so; otherwise none. `createRouter` makes one lexical source for its lifetime, which is what keeps the index between routings.
- **The port** gained what a real source needs: `CandidateQuery.conversationId`, `answerText` and `firstPass`; a source has a `name` and returns `{ sectionId, score }`. The scripted sources of the tests were updated.
- **Recorded.** `RoutingDecision.candidateSource` (`CandidateSourceRecord`): the name of the source that was asked and, for each unit, the sections it returned with its scores, after the pipeline's own filter (answer sections of this conversation, no duplicates, at most twelve). Present whenever a source was asked, with empty lists when it named nothing or failed; absent with the setting on `none` and for an explicit or chosen reply target. For a composite the parts stand in place of the message.
- **Run inspector.** A "Candidate sections" row beside "Strategy" and "Decision budget": how many, from which source, each with its title and score, and that they are seed hints, none a target for being listed.
- **Strategy selection is unchanged** (DA2 holds). The rules choose from the shape of the genealogy and what may be spent; candidates are not part of the shape. One pass is still chosen while every answer section is listed: it asks about each of them by itself, so a candidate could add nothing there. Candidates matter exactly where the rules choose the tree walk. A routing whose strategy a selector chose is still request for request the routing with that strategy configured: the source is asked the same way in both.

### Measured

Live, `typesafe/jev-1.13`, 2026-11-12, reference decompositions, 62 examples, one run of `providers/test/smoke/referents.smoke.test.ts` with the source set explicitly in every configuration (`pnpm smoke` was run once in full first; its output was not captured, as before, so that file was run a second time with the console shown and the figures are the second run's).

| Configuration | Source off: score, requests, tokens reported | Source on (lexical) | Change |
|---|---|---|---|
| One pass | 58/62, 74, 92,592 | 58/62, 74, 92,592 | None: the same requests |
| Tree walk, long runs searched (the configured strategy) | 59/62, 84, 108,935 | **61/62**, 85, 108,412 | **+2 examples**, +1 request, −523 tokens (−0.5%) |
| **Selected by rules (the default)** | 61/62, 83, 110,263 | **61/62**, 82, 107,841 | The same score, −1 request, −2,422 tokens (−2.2%) |

The source-off figures are the ones recorded before, to the token.

| Case (requests, tokens; ✗ = not routed as labelled) | Tree walk, off | Tree walk, on | What the source handed over (BM25 score) |
|---|---|---|---|
| `deep-run-middle-section` | ✗ 1, 1,874: continues D5 | 2, 2,554 | D2 3.9, J 2.7 |
| `deep-run-other-branch` | ✗ 1, 1,877: continues H4 | 2, 3,011 | H2 6.8 |
| `live-referent-beyond-window` | 3, 5,282 | 2, 4,728 | J 11.0, B 7.4 |
| `long-chain-old-section` (reply to the 3rd of 200) | 3, 7,972 | 3, 6,104 | E2 8.8 |
| `long-roots-old-section` | 3, 9,699 | 3, 9,699 | R16 16.8 (a root: it is a start already, and old single answers are searched together) |
| `deep-run-end-section` | 1, 1,876 | 1, 1,961 | D1 3.5 (the target, D5, is a first-pass section and is left out) |
| `long-chain-latest-section`, `long-chain-unrelated`, `live-unrelated-in-long-conversation` | 2, 6,086; 2, 6,080; 2, 4,420 | the same | none |

- **The two examples the removed question cost are routed as labelled again**, with nothing scripted: the walk starts at the section the message names, asks about it by itself, and the reply branches from it. With the rules (the default) both were already routed by one pass; there the gain is `live-referent-beyond-window` in two requests where it took three, and the old section of the 200-section chain for 1,868 fewer tokens, because the walk starts at the candidate and examines the four sections down to it where it searched the 176 older ones.
- **Candidates were handed to 12 of the 62 routings**, at most two each. Besides the ones above: the trip brief, for six messages or parts about the trip (1.8 to 3.6). An unrelated message got none.
- **The J request on both siblings, five runs of five cases, and the follow-up naming two sections, five runs of two: 25/25 and 10/10** with each of the twelve configurations, the three with the source on included.
- **One example changed its failure.** `split-correction-and-new-work` is missed under every configuration, as before. With the configured tree walk and the source on, its second part ("Suggest some day trips from Kyoto") was handed the trip brief, and the routing ended in a question to the user (target ambiguity) where it was a plan on a new chain. Under the default (rules) it is a plan both ways. The same example also ended in that question once with the source off (trunk base and hops), so it is borderline by itself; one run does not say how much is the candidate.
- **With decisions as labelled** (`candidates/lexical.test.ts`, the oracle): the tree walk with the lexical source routes **62 of 62**, and so does the strategy the rules select (59 and 61 with no source).
- **Cost grid** (guarded cells, the guard's estimate; `cost-grid.test.ts` asserts the 2× bound and the token budget on each):

| Grid | Worst guarded cell | Guarded requests and tokens, all 360 cells |
|---|---|---|
| The grid's message, source off | 1.99× (8,000 × 120, early split, tree walk with runs listed: 1 request, 11 questions, 2,481 tokens) | 867, 2,162,323 |
| The grid's message, lexical source | The same, to the token: the message names nothing, so there are no candidates | 867, 2,162,323 |
| A message that names three answers (`COST_GRID_SEEDED_MESSAGE`), source off | 2.00× (50 × 120, early split, one pass: 1 request, 22 questions, 2,528 tokens; the message is longer, and so is the allowance) | 867, 2,176,223 |
| The same message, lexical source (up to three candidates) | 2.00×, the same cell: one pass ignores candidates | 814, 2,084,287 |
| A source that hands over twelve sections spread over the conversation (`worstCaseCandidateSource`), the grid's message | 1.99× (50 × 300, flat, tree walk: 3 requests, 37 questions, 6,116 tokens) | 670, 1,921,295 |

  The bound holds with the source on, and with the worst a source can do. Candidates lower the worst message's cost: a root with a candidate below it is not asked about, and a long run is examined down to the candidate where it would be searched whole. The largest guarded routing is 19,634 tokens (500 answers of 2,000 tokens on one chain, twelve candidates; the budget there is 20,000). The tokenizer-count caveat of "Measuring tokens" applies unchanged: the guard holds what it estimates.
- **Time** (one core, Node, a made-up vocabulary of 20,000 words with a skewed frequency): a conversation of **10,000 sections, 35 MB of text** (about 430 words each) is indexed in **1.9 s**, once per conversation per backend start. After that a routing costs **3 to 4 ms** to bring the index up to date (one new section, or none) and **1.7 ms** for a query of twelve words; a query made only of the twelve most common words, 9 ms.

### Default: `lexical`

The condition set for it was no loss of score and the 2× bound holding on the cost grid. Both hold: no configuration lost an example (the configured tree walk gained two, the default kept its 61), the J and two-section cases are unchanged, the default spends 2.2% fewer decision tokens on the corpus, and the grid's worst guarded cell is unchanged. `none` stays selectable.

### Limits, and what is not verified

- **Words only.** A reply that names its referent in other words ("the lodging one" for the hostels) gets no candidate. That is what an embedding index behind the same port would add; none is built.
- **A plausible wrong candidate can hide a referent on another line under the same root.** A root with a candidate below it gives way to the candidate and is reinstated only when the candidate is not plausible or the unit refers to several sections (safeguards (a) and (b)). This is the walk's rule for any candidate, not the index's; the more candidates, the more often it can bite. Half-of-the-best keeps the candidates few. Not observed on the corpus.
- **The minimum share (0.3) and the stop list were set on this corpus**, 62 examples, of which 12 get candidates. Not tuned further, and not measured on conversations in other languages or on long single-subject conversations, where many sections share the message's words and the cap (the twelve best) is what bounds the candidates.
- **The stop list is English.** A contentless message in another language is looked up word for word.
- **The index is rebuilt after a restart**, 1.9 s at the first routing of a 10,000-section conversation, on the backend's thread. Not persisted.
- **One word left the stop list after the live run**: "brief", which in this application names a piece of work ("the trip brief"). With decisions as labelled the candidates of every corpus routing are the same sections as before and the requests are the same to the token; two scores of the trip brief moved by 0.1. The live run was not repeated.
- **Not looked at live in the app.** The corpus is routed through the pipeline; the Settings control and the inspector row were looked at in the fixture gallery in a browser, and the backend wiring (whole answers, the record) is covered by `routing/acceptance/referents.test.ts`. The e2e flows were not rerun.

## Measuring tokens

Added 2026-11-12. Before this, token figures came from live runs (the provider's `usage.input_tokens`, which needs a key) or from the guard's estimate (`estimateRequestTokens`: 265 + 0.2 per character of state + 7 per question + 0.24 per character of question text; the answer side and the log at characters ÷ 4, `textTokens`). Now they are also measured deterministically, with no network, in `pnpm test`.

**How.** `providers/testing/openrouter/decisions-api-mock.ts` is a mock of `POST /api/alpha/decisions` at the HTTP boundary: the real decision provider is driven with an injected `fetch`, the mock parses the exact body (`model`, `state`, the `questions` record), refuses one in the wrong shape as the live API does, answers from a scripted `DecisionProvider` (the corpus oracle, the cost grid's worst case), and returns the documented shape with `usage: { input_tokens, output_tokens, cost }` at $0.042 per million input tokens. It counts the text the decision model reads (the state, and each question's ID, instructions, choice options with their descriptions and score criteria) with `gpt-tokenizer` (`o200k_base`, pure JavaScript, a devDependency of `packages/providers` only; it is not in the app bundle). **This is a proxy:** the decision model's tokenizer and its prompt template are not public. A calibration (`FITTED_CALIBRATION`) maps the tokenizer's count to what the live model reports: **reported ≈ 282 + 6.1 × questions + 1.104 × tokenizer tokens**, a least-squares fit to eight live requests (`decision-tokens.smoke.test.ts`). Core gains no I/O and no tokenizer: the cost grid takes an optional channel (`costGridRows(…, { through })`) that the measurement routes through the mock.

**The corpus** (`decision-tokens.test.ts`, decisions as labelled; live figures from "Measured" above, live answers):

| Configuration | Requests (mock / live) | Tokenizer, text only | Calibrated | Live reported | Guard's estimate |
|---|---|---|---|---|---|
| One pass | 74 / 74 | 60,559 | 93,352 (+0.8%) | 92,592 | 85,896 (−7.2%) |
| Tree walk, long runs searched | 86 / 85 | 72,306 | 109,913 (+1.4%) | 108,412 | 100,067 (−7.7%) |
| Selected by rules (the default) | 82 / 82 | 72,259 | 108,866 (+1.0%) | 107,841 | 99,304 (−7.9%) |

Over the three configurations' 242 requests the tokenizer counts **0.79 to 1.04 × characters ÷ 4, mean 0.90** (0.93 over all their text), and the calibrated count is **0.99 to 1.22 × the guard's estimate, mean 1.067**.

These two rows and the line under them were recorded again when the lexical candidate source became the default (see "The candidate source: a lexical index"): the tree walk and the strategy the rules select now start at candidate sections as well, and with decisions as labelled both route all 62 examples. With no source the rows were: tree walk 83 / 84, 72,243, 109,090 (+0.1%), 108,935, 99,468 (−8.7%); rules 82 / 83, 73,662, 110,610 (+0.3%), 110,263, 100,907 (−8.5%); 239 requests, 0.79 to 1.03, mean 0.90, and 0.99 to 1.21, mean 1.065. One pass is unchanged.

**Live calibration** (`pnpm smoke`, 2026-11-12, 14 requests, about $0.002):

| Bodies | Reported ÷ calibrated tokenizer | Reported ÷ guard's estimate | Tokenizer ÷ (characters ÷ 4) |
|---|---|---|---|
| The CLAUDE.md sample and seven corpus requests (1 to 33 questions, 136 to 14,814 characters) | 0.92 to 1.05; within 1% from 1,000 tokens up | **0.96 to 1.19** | 0.80 to 1.03 |
| Six cost-grid requests (synthetic text: numbered sections, repeated labels) | 0.91 to 1.07 | **1.07 to 1.38**; the worst cell's request 1.30 | |

A one-off fit over 24 live requests of both kinds (run once, not kept as a test) on characters gives about 0.34 tokens per character of state and 0.33 per character of question text, against the estimate's 0.2 and 0.24: about 3 characters per token, not 4 or 5.

**The cost grid with tokenizer counts.** Every guarded cell (360) recomputed: decision requests by the calibrated tokenizer, the answer by the same tokenizer (the message in; an answer of 85% of the exchange out, at the 4.12 characters per token the tokenizer finds in the corpus's answer prose), Haiku at $0.10 in and $0.50 out per million.

| Estimate in the guard | Worst guarded cell by the estimate | Worst guarded cell by the tokenizer, calibrated | Cells over 2× by the tokenizer |
|---|---|---|---|
| Before: 265 + 0.2 / character of state + 7 / question + 0.24 / character of question text | 1.99× (8,000 × 120, early split, tree walk with runs listed: 2,481 tokens) | 2.79× (8,000 × 120, bushy, tree walk with runs listed: 3,362 tokens) | 208 of 360: every 120-token cell, 88 of 120 with 300-token exchanges |
| **Since 2026-11-12: 300 + 0.35 + 7 + 0.32** | 2.00× (1.997: 50 × 300, nested forks, tree walk with runs listed: 6,123 estimated, 5,184 calibrated) | **1.80×** (8,000 × 120, bushy, tree walk with runs listed: 2,486 estimated, 2,170 calibrated) | **0** |

Before the refit the bound did not hold as the decision model counts tokens: the worst cell's routing request was reported live at 3,223 tokens, 1.30 × its estimate, 2.6× the answer. The estimate ran low by 7 to 9% on the corpus and by 20 to 40% on text with many short numbered lines.

### The estimate, refitted (2026-11-12)

`estimateRequestTokens` and `estimateDecisionTokens` (`core/src/routing/referents/ask.ts`) now count **300 per request + 0.35 per character of state + 7 per question + 0.32 per character of question text** (its ID, instructions, choice options and descriptions, score criteria), before **265 + 0.2 + 7 + 0.24**.

- **Fitted to** 70 live requests, 333 to 16,139 reported tokens: the CLAUDE.md sample, 14 corpus requests across sizes, and the smallest, middle and largest guarded request of every cost-grid size. The sample is built deterministically (`estimateSample()` in `providers/testing/openrouter/estimate-fixture.ts`); `decision-estimate.smoke.test.ts` sends it, asserts that the estimate is not below any reported count and prints the rows; the rows are recorded in `estimate-fixture.data.ts`, and `decision-estimate.test.ts` asserts the same over them with no network. Three runs are recorded: one with the earlier estimate and two while refitting, because the guard cuts the grid's requests by the estimate and so each estimate sends some different requests. The constants are the no-undercount fit closest to the reported counts with the per-request and per-question parts held near the earlier fit's.
- **How it counts now:** 1.01 to 1.30 times the reported tokens (about 1.23 on corpus requests, which are prose; less on the grid's numbered lines, which run up to 0.46 reported tokens per character of state, questions included). The earlier figures counted 0.63 to 1.04 times the reported tokens on the same 70. Against the tokenizer-calibrated count of the corpus's 242 requests: 1.13 to 1.28 times.
- **Not changed:** `SHORTEST_ANSWER_TOKENS` (100), the token budget, the allowance's arithmetic, the answer side (`textTokens`, characters ÷ 4, about right for prose by the tokenizer's 4.1).

**Effect on the corpus** (decisions as labelled, `decision-tokens.test.ts`): no score and no request count changed. Four examples are routed with smaller search parts, the same sections found (`long-chain-old-section`, `long-chain-latest-section`, `long-chain-unrelated`, `long-roots-old-section`: the parts are sized by the estimate against `searchRunsOverTokens`), 21 more questions in all. Live (`referents.smoke.test.ts`, the lexical source on, one run): one pass **58/62**, tree walk **61/62**, rules **61/62**, as before; 74, 85 and 82 requests; 92,592, 109,128 and 108,557 tokens reported (92,592, 108,412 and 107,841 before).

| Configuration | Requests (mock / live) | Tokenizer, text only | Calibrated | Live reported | Guard's estimate |
|---|---|---|---|---|---|
| One pass | 74 / 74 | 60,559 | 93,352 (+0.8%) | 92,592 | 115,370 (+24.6%) |
| Tree walk, long runs searched | 86 / 85 | 72,991 | 110,797 (+1.5%) | 109,128 | 135,719 (+24.4%) |
| Selected by rules (the default) | 82 / 82 | 72,944 | 109,750 (+1.1%) | 108,557 | 134,559 (+24.0%) |

**Effect on the default budgets.** A routing now counts 1.14 to 1.62 times what it did against the token budget (2% of the log, at least 16,000 and at most 40,000): about 1.35 times on the corpus, the most on numbered lines. The budget's figures are unchanged, so it admits fewer real tokens than before: by the corpus, its estimate is now about 25% above the decision model's count where it was about 8% below. No corpus routing reaches its budget (with decisions as labelled none came within 80% of it). One deterministic test was resized: `budget · relative to the log, a search reaches an old section…` (`referents.test.ts`) used a chain of 700 answers of 1,700 tokens, whose relative budget (24,080) held the search round over 700 sections only under the earlier estimate; with answers of 2,500 tokens (35,280) it holds now. The decision-model selector's request is now estimated at about 1,070 tokens (806 to 849 reported live); `selection.test.ts` bounds it at 1,100 where it bounded it at 900.

**The floor of the bound** (`SHORTEST_ANSWER_TOKENS`, 100, not changed: raising it is the user's decision). At 100 every cell of the grid is covered (its shortest answers are 102 tokens) and none is over 2×. A floor of 135 or 155 would price the 120 cells of 120-token exchanges as if their answers were that long, so the guard would allow more and those cells would no longer be held to the bound. Emulated in `decision-tokens.test.ts` (recorded, not asserted): at 135 all 120 would cost more than twice their own answer by the tokenizer, worst 2.39× (8,000 × 120, nested forks, tree walk with runs listed; 2.63× by the estimate); at 155, worst 2.72× (8,000 × 120, nested forks, one pass; 2.98× by the estimate). Against an answer of the floor's length they stay within it (about 1.8×). Every cell with longer answers is unaffected.

## Hop between branch points, redefined

2026-11-12, on the user's instruction:

> The hop idea is to just not bother looking for the best midpoint node, and just instead take the node at the bottom of the stretch (or as far down towards the bottom as context allows), if no further descendant has relevancy, in order to save tokens

> Keep it as a switch, off by default.

Until then the switch asked about a run's last answer by itself and, when that was not confirmed, searched the answers skipped anyway ("Long runs", "The two switches"). That meaning is dropped. The setting keeps its name and place: `settings.routing.treeWalk.hopBetweenBranchPoints`, default `false`, a stored value kept by `normalizeSettings`. The spec is changed with it (11 · "Referent strategies", DA3, and the lines listed in the commit).

### The rule as built (`routing/referents/tree-walk.ts`, `search.ts`)

- **Applies to** every unbranched run with two or more sections that can be stood for, a root's run (a trunk) included, for a unit that is not clearly corrective.
- **Evidence that the unit refers to the run.** Points on its sections that are known anyway (first-pass sections; the listed sections of a start part, which ride in the routing request), and one round about the sections that are not: Segments over them, split as a search's first round is; a Point when it is one section; a Point for the candidate section the walk starts at, beside the Segments over the rest of its part. Nothing is asked once a Point of the run is confirmed. No part is opened.
- **Descent** is unchanged: a run with anything at least plausible (0.25) is descended below, child runs and join-backs.
- **Placement.** The run's last section is scored with the **highest** answer among that evidence, when it is at least plausible (`RunEnd`, read in `unitReferents`). From there the existing rules apply and nothing else was added: `referentsFromScores` drops it for a clear descendant, so it is a referent only of the run that ends the line of relevance; `bestNodeFound` passes it over for a plausible descendant; `resolveUnitTargets` makes it a target at the target-choice threshold and puts it to the user below it.
- **The confidence it carries**, then, is the confidence that the unit refers to the run: a run with a clear yes (a Segment or a Point at 0.70 or more) places without asking the user; a run that is only plausible (0.25 to 0.70) is a weak referent exactly as a weakly scored section is with the switch off (elicited; or the best node found so far when the budget was reached). When the last section was also asked about by itself, the higher of the two scores stands.
- **Context limit.** `ReferentRequest.runContextFits(section)` (as `SearchInput.continuable` for a policy): whether a run continuing from the section fits what a run may read. The deepest section of the run that fits is taken, it stands only for the sections at or above it, and the sections below it are searched as with the switch off; when no section fits, the run is searched as with the switch off. **The pipeline does not supply it: the limit is unbounded in the first version.** What a run may read is the answer model's context limit, which the model provider reports when the run starts (`countTokens`, `engine/backend.ts`; 11 · "Context growth", Q67); routing does not know it. The code path is tested with an explicit limit (`search.test.ts` · "hop · context limit").
- **Not the hop's.** A correction (the search runs, request for request as with the switch off). A member of a sibling group (asked about by itself beside its group, and no evidence for the run that continues it: a Segment that named it could not be told from a yes about the group). A part whose sections were all asked about by themselves (nothing to save: the last relevant section stands). The pooled old single answers (`loneAnswers`: not a line of work). A run whose question the budget refused (nothing stands for it: `Hop.taken` is set only after the round was answered; its listed sections are then asked about by themselves in the fallback, as with the switch off).
- **With start at the trunk base on as well**, the base's Point and the Segments above it, which that switch asks in the routing request, are the evidence for the trunk, and no part is opened.
- **Recorded.** `RoutingDecision.runEnds` (`RunEndRecord`): the unit, the section taken, its confidence, the run (first and last section, length), the question the score comes from (the sections it was about), and whether the context limit moved it up. Only for targets, and only when the section's own question did not score at least as high. The decision's explanation carries a sentence, and the run inspector a row "Hop between branch points" beside the budget and candidate rows.

### Strategy selection: the hop is no longer chosen

The rule that turned hops on (`HOP_SKIP`: a run of six or more answers below a split) was derived for the earlier meaning, in which the placement was the same either way and only the cost differed. The new hop changes where a message is placed and what its answer reads; the shape of the genealogy is no evidence for that. So:

- `HOP_SKIP` and the rule are removed; `StrategyChoice` has no `hopBetweenBranchPoints`; the decision-model selector's `sel_hops` question is removed (its request is three questions).
- `applyChoice` keeps the configured `hopBetweenBranchPoints` whatever was chosen, so the user's switch applies whenever a tree walk runs: with selection off, by rules (the default) and by the decision model. A choice on record from before, which has the field, is read without it.
- DA2 holds as before: the selector chooses the strategy, start at the trunk base and whether long runs are searched, and the routing equals the one with those configured directly; `selection.test.ts` · DA2 has a case with the hop set on both sides.
- Settings → Routing shows the hop switch whenever the tree walk can run (the tree walk is configured, or a selector is on).

### Measured

Oracle double (`search.test.ts`, every probe costs one, a part is 12 sections), one relevant section in the middle of one run:

| Run | Off: rounds, probes | On: rounds, probes |
|---|---|---|
| 20 sections | 2, 14 | 1, 2 |
| 200 sections | 2, 29 | 1, 17 |
| 2,000 sections | 3, 43 | 1, 24 |

Corpus, 62 examples, configured tree walk, lexical candidate source (the default source):

| | Off | On |
|---|---|---|
| Decisions as labelled (`hop-tokens.test.ts`): routed as expected (off: default expectations; on: hop-on expectations) | 62/62 | 62/62 (59/62 against the default) |
| requests, questions | 86, 977 | 84, 949 |
| tokens: guard's estimate, tokenizer, calibrated | 135,719, 72,991, 110,797 | 130,227, 69,339, 106,031 |
| Live (`typesafe/jev-1.13`, 2026-11-12, `referents.smoke.test.ts`): routed as expected | 61/62 | 61/62 (58/62 against the default) |
| requests, questions, tokens reported | 85, 976, 109,128 | 83, 948, 104,535 |

- **What it saves here: 4.0% of the estimated tokens, 4.2% of the live ones, two requests.** The corpus is mostly short conversations inside the window, where every section rides in the routing request by itself and the switch changes nothing. All of the saving is on three examples: `long-chain-old-section` (live 6,440 → 2,847 tokens, 3 → 2 requests), `deep-run-middle-section` (2,554 → 2,005, 2 → 1) and `deep-run-other-branch` (3,011 → 2,560). (These figures are with the guard's estimate as refitted the same day, which sizes the parts of a run. Live before the refit: off 85 requests and 108,412 tokens, on 83 and 104,155.)
- **The same three are where the placement moves**: E2 → E198 (the last of a 200-section chain), D2 → D5, H2 → H4. The corpus's default expectations label a reply to a section inside a run with that section (the note of `deep-run-middle-section` says "not the end of the run"), which is the behaviour the switch gives up; they were not changed.
- **Two sets of expectations** (2026-11-12, on the user's decision). An example may carry a hop-on expectation (`CorpusExample.hop`: a note and the parts that replace the default ones); an example without one expects the same with the switch on and off. The evaluator scores a routing against the hop-on set when the switch is on and the tree walk ran, configured or chosen by a selector (read from the settings and the selection record, never from the placement), and against the default set otherwise; `CorpusResult.expectations` and the report's first line say which. The decisions the oracle gives are always those of the default expectation: what a message refers to does not change, only where the hop places it.
- **How the hop-on set was derived**: by hand, from the rule (11 · "Referent strategies", DA3, and "Not the hop's" above), for every example before comparing with the implementation. The hop needs an unbranched run of two or more sections that can be stood for, a unit that is not corrective, a referent in the run with nothing built on the run relevant, and sections of the run not asked about by themselves. Every other scene fails one of these: single answers and pooled old roots (`sky`, `twoAnswers`, `longRoots`, …); runs whose only further section follows a group member, which does not count (`tripDone`'s J, `tripBranch`'s B2, `longConversation`'s J); the trunk `brief`–`A` of `tripOneRunning`, whose two sections ride in the routing request at its start; corrections; and `deep-run-end-section`, `long-chain-latest-section` and the unrelated messages, which are placed on the run's end or on no run either way. So exactly the three above have a hop-on expectation: `long-chain-old-section` E198, `deep-run-middle-section` D5, `deep-run-other-branch` H4 (the run below A, a member of a sibling group, is H1 to H4). **The implementation agrees on every example**, in both hop configurations of `corpus.test.ts` and with a candidate source naming the referent. Without a candidate source the two `deep-run` examples are not reached with the switch on or off (`below`), so only `long-chain-old-section` moves there.
- **Scores under the expectation sets** (decisions as labelled): with no candidate source, off 59/62 and on 59/62 (the three `below` examples, both with and without the trunk base); with the lexical source, 62/62 each; strategy selected by rules with the hop on, 61/62 (none) and 62/62 (lexical), the rules choosing the tree walk, and so the hop-on set, for 6 examples. Live with the lexical source: off 61/62, 85 requests, 109,128 tokens; on 61/62, 83 requests, 104,535 tokens, the one miss in both being `split-correction-and-new-work`; the three moved examples were placed on E198, D5 and H4 live.
- **Live, a Segment over a short part can miss what a Point finds.** In a first live run, before the candidate section was asked about by itself, the Segment over the four sections above and including the candidate E2 was not plausible for "Make the entry on tides shorter", although E2 by itself is confirmed with the switch off; the message was then placed with no target (it still continued the chain's end, through its handling chain). That is why a candidate section is asked about by a Point. Not measured further.
- **Switch off: identical.** Every decision request, the plan and the explanation of all 62 examples with decisions as labelled were dumped on the commit before this change and after it, for eight configurations (tree walk without and with the lexical source, with the trunk base without and with it, runs listed, one pass, and the tree walk under a request budget of one and under a 7,000-token budget, where 14 routings reach the budget; 650 requests): byte for byte the same. The recorded figures of `decision-tokens.test.ts` are unchanged.
- **The cost grid bound holds** for all 360 cells with the new hop, by the guard's estimate (`cost-grid.test.ts`) and by tokenizer counts (`decision-tokens.test.ts`), and a guarded routing still never costs more than the unguarded one. The last needed a change to the fallback: with the hop on, a round about runs is cheaper than asking their listed sections one by one, so room is kept only for the fallback as it would be **after** the round at hand (the sections that round stands for left out), and the fallback does not ask about sections whose run was asked about. With the switch off both are what they were.

### Departures from the brief, and what is not verified

- **A trunk is hopped too.** The brief's rule is about unbranched runs; the switch's name is about branch points. A conversation that never split is one run, so with the switch on a reply to an old answer continues from the latest answer.
- **A candidate section is asked about by a Point** (the brief: "no confirming Points for interior sections"). It does not place the unit on the candidate: it is evidence for the run, and the run's last section is taken.
- **"Nothing to save" keeps the last relevant section.** When every section of a part was asked about by itself anyway, the hop does not move the placement to the end.
- **A clear Point inside the run ends the questions about the run** and the end is taken, although two or three further Points would have settled the last relevant section (`deep-run-middle-section`).
- **The context limit** is implemented and tested, and unused: see above.
- Not verified: how often, live, a Segment over a short run scores a run plausible or clear when a Point on the section meant would; the hop with the decision-model selector live; the J cases live with the hop on (they pass in `referents.test.ts` with scripted answers in all four combinations).

## What a Point shows

Added 2026-11-12, on the user's report:

> For the "questions put the decision model" in run logs, is that the full question? I noticed for one chat I have, for a new message on "modern kyoto" [the questions about S1 ("kyoto city") and S3 ("kyoto history") were answered 0.79 and 0.59] Even though in the actual S3 content response has a section on modern kyoto.

**What was wrong.** The run inspector showed each question's `instructions`, which is the whole question. But the decision model also reads the request's state text, and there every section was described by its title, its request and the first **280 characters** of its answer (`CandidateSection.excerpt`). S3's section on modern Kyoto was further down, so no request ever showed it. The whole answer was already available to routing (`RoutingInput.answerText`, added for the lexical candidate source) and was used only by that source.

**Built** (`core/src/routing/shown.ts`; Describe in `referents/operations.ts`, the routing request in `pipeline.ts`):

- **Which sections.** A section asked about by itself: a Point (`m_s<n>`), in the routing request (the first-pass sections; with one pass, every listed section) and in further requests. Every other line (sections listed but not asked about, Group members, Segment digests, the most recent answer shown beside Segments for comparison) is as before: Group and Segment questions keep their compact form, because a group's members and a run's parts are judged as a whole and their digests are what keeps a long run's search affordable.
- **What it shows, in order** (`ShownAnswerForm`, one function: `chooseShown`):
  1. `full`: the whole answer so far, when it fits;
  2. `passages`: the opening (the same 280 characters) and the passages of the answer that share the most words with the message, separated by ` … `;
  3. `opening`: the opening alone, as before.
  A stored context summary, where the summary provider has one, still takes the place of the answer (`summary`) and is never expanded.
- **Passages** (`passagesOf`, `rankPassages`). The answer is cut into blocks at blank lines; a heading line (Markdown `#`, or a line that is all bold) starts a block and heads the paragraph after it; a block over 600 characters (`PASSAGE_CHARACTERS`) is cut at spaces. Each passage after the opening is scored by the message's words it holds, its heading's included (the lexical source's tokeniser, `lexicalTerms`: stop words out, plurals folded), each word weighing `ln(1 + passages ÷ passages holding it)`, so a word every passage has ("Kyoto") counts little and a rarer one ("modern") much. Best first, earlier first on equal scores, at most six (`PASSAGES_SHOWN`), shown in answer order. A passage that shares no word with the message is never shown; with none, the line is the opening alone.
- **How much room.** The window is chosen exactly as before, every answer by its opening (`fitWindow`, so the reach of the routing request is unchanged and no listed section, first-pass or not, is dropped to make room). Then the Points are shown at more length with what is left of the routing's budget, up to a share of it: **all of it** for a strategy that sends no further request (one pass, `ReferentStrategy.furtherRequests: false`), **half** otherwise (`ROUTING_REQUEST_SHOWN_SHARE`), the other half kept for the tree walk's levels. In a further request, the round is decided on its size with every answer by its opening (`size`, `fits`, unchanged), and when it is sent its Points share what the budget has spare after the round and the reserve it was checked with, divided by the requests still allowed. So showing more never changes which rounds a search sends, only how much of the room they use.
- **Sharing the room** (`chooseShown`). The Points whose whole answers cost least are shown whole while each fits an even share of what is left, so short answers are always whole; each of the rest gets an even share of what remains for its opening and best passages. Deterministic: the same conversation, message and budget give the same lines. If rounding ever made the request larger than its room, it is sent with every answer by its opening.
- **The hard stop holds.** The request never grows past the room it was given, and with no room the request is byte for byte what it was before (tested).

**Recorded** (`DecisionQuestionRecord.shown`, `RoutingDecision.shownRecorded`; `STATE_VERSION` 4):

- Each question about a section by itself, and each Group question (its members), records the section's line exactly as the state text showed it, with its form. The line is kept in pieces (`ShownPiece`): literal text (title, request, wording), and the answer as **spans of the attempt's recorded text** (`attemptId`, start, end), never a copy. The log already holds every answer once; a copy per question would have added up to the routing's whole budget (16,000 to 40,000 tokens, 50 to 120 kB) to every routing decision. A span costs about 80 bytes of JSON, a line with its title and request about 400.
- Attempt text only grows (a streaming answer is appended to), so a span recorded while an answer was still streaming reads the same text on replay. The run inspector's projection renders the pieces against the recorded attempt text (`renderShownLine`, one helper shared with routing); replaying the log from scratch gives the same text (tested).
- A stored summary is recorded by its ID and length only: no record may hold a summary's text (invariant 12, DA5), so the inspector says where a summary stood, not what it said.
- Decisions recorded earlier have no `shownRecorded`; the inspector shows their questions alone with a note that the shown text was not recorded.

**The run inspector.** Each card under "Questions put to the decision model" keeps its question as before. A card whose question recorded what it showed has a "Show what was sent" button, which opens a dialog (the side panel is narrow): the question, its ID and answer, the form ("Whole answer", "Opening and matching passages", "Opening only", "Summary") with a sentence on what it means, and the section's line exactly as sent, in a scrolling monospaced block. Screenshots: `docs/build/screenshots/review/shown-card-{light,dark}.png`, `shown-dialog-{light,dark}.png`, `shown-dialog-light-narrow.png`.

**Cost, measured.**

- *Corpus* (`decision-tokens.test.ts`, decisions as labelled). Only `target-later-in-answer`, added for this, writes its answers out in full; the other 62 examples carry only their openings, so their requests are unchanged and **the corpus does not measure the rise on them**. The new example: one request of 1,540 estimated tokens with openings only, 1,870 with the whole answers (+21%; measured before the gate's combined-limit question was added), all three configurations route it right; with it the corpus is 64 examples (one pass 61, tree walk 64, rules 64 as labelled).
- *Cost grid* (whole answers written out in every cell since this change). The bound holds on all 360 guarded cells by the estimate and by the tokenizer. The worst cells are unchanged by it (measured before and after on the same code: 1.997× by the estimate, 50 × 300; 1.80× by the tokenizer, 8,000 × 120; after the rebase onto the gate's combined-limit question both are 3,300 × 300, nested forks, one pass, 1.994× and 1.819×, the same tokens as before this change): where the bound is tight, the routing request already uses the whole allowance and nothing is left to show more with. Only the 500 × 2,000 cells changed: worst 0.898× → **0.960×** by the estimate, 0.766× → **0.811×** by the tokenizer (0.965× and 0.814× after the rebase). The grid's worst-case message shares no word with the answers, so its Points are shown whole or by their opening, never by passages.
- *Live* (`referents.smoke.test.ts`): one pass **59/63**, tree walk **62/63**, rules **62/63** (the lexical source on, default expectations); 75, 86 and 83 requests; 94,042, 110,578 and 110,007 tokens reported. Before (62 examples): 58/62, 61/62, 61/62; 74, 85, 82; 92,592, 109,128, 108,557. The difference in each is the new example, routed right by all three (one request, about 1,450 tokens); the same four examples fail as before (`split-correction-and-new-work`, and with one pass the three long-conversation examples it cannot reach). The live run was made twice, before the rebase onto the gate's combined-limit question: the first passed but its report was not captured.
- *What it costs in general.* A Point's whole answer costs about 0.35 estimated tokens a character: a 1,700-token answer (6,800 characters) about 2,400 tokens. With the default budget (16,000 tokens at least) one pass shows about five such answers whole and the rest by passages; the tree walk keeps half for itself.

**Not verified.** The estimate's 0.35 tokens per character was fitted on English prose and the grid's numbered lines. Text in scripts written without spaces (Chinese, Japanese) counts nearer one token per character, so a whole answer in those languages is undercounted by the estimate, by up to about three times. This was true of openings and requests before; whole answers make more of the request such text. The tokenizer-counted bound (`decision-tokens.test.ts`) covers English only.

## Tests

- `routing/candidates/lexical.test.ts` (2026-11-12), the lexical candidate source. The words of a text (stop words, the words of an instruction, plurals, numbers, other scripts). The index: ranking; the minimum share and half-of-the-best; contentless messages; the cap and ties by recency; exclusion; determinism, and an index brought up to date against one built at once (growing, a streaming answer, a revised and a dropped section, 2,000 sections). The source: whole answers, the first-pass sections left out, one index per conversation. Through the pipeline: the three corpus examples whose referent lies below unrelated work miss with no source and are routed as labelled with the lexical one and nothing scripted; the whole corpus with the tree walk and with the strategy the rules select (62 of 62 each); candidates reduced with the roots by `reduceToNonAncestors`; `DA3` (a candidate is asked about by itself and is never a target for being named, nor on the strength of a question about several sections; every target of a routing was confirmed by its own question or its group's); an injected source wins and `none` asks nothing; one pass sends the same requests; an explicit target asks no source; a contentless message.
- `routing/acceptance/referents.test.ts` (2026-11-12): on a backend with the setting on `lexical`, a word found only beyond the opening of an answer makes that section the candidate, the decision records it with its score, and the reply continues from it; with the setting on `none` nothing is recorded.
- `routing/referents/cost-grid.test.ts` (2026-11-12): the 2× bound and the token budget on every cell again with the lexical source on a message that names answers, and with a source that hands over twelve sections.
- `protocol/test/contracts.test.ts`, `web/src/app/app.test.tsx`, `web/src/features/debug/debug.test.tsx` (2026-11-12): the candidate source as a setting, its control in Settings → Routing, and the run inspector's "Candidate sections" row.
- `routing/referents/search.test.ts` (2026-11-12), the policies over the oracle and no decision provider: the non-ancestor set (`reduce`) by example and as a property on five shapes; the start set; `exact` (no budget: exactly the deepest relevant nodes on one chain, an early split, nested forks, sibling groups with join-backs and many roots, for relevance inherited upward and for the least a walk descends on; for any relevant set when its deepest nodes are start candidates; and, with neither, only relevant, confirmed nodes none of which is an ancestor of another); `budget` (no round or probe beyond it, only Point- or Group-confirmed nodes, the exact answer when the budget was not reached, the same search twice); `last` (probes logarithmic in the run's length from 100 to 10,000 sections; only the part that holds the last relevant section is opened; a Point that does not confirm sends the search to the plausible part before it and never into one that was not; short runs point by point; nothing above a confirmed section; a correction opens every plausible part; old single answers found all at once); `walk` (child runs and the join-back, pruning, starting at a candidate, safeguards (a) and (b), a tree 3,000 branch points deep, no candidates = the roots); `switches` (exact with each combination; what is asked first); `policy` (the two policy files import only the port, `search.ts` and `tree.ts`, and hold no wording, ID, estimate or decision-provider type).
- `routing/referents/referents.test.ts` (2026-11-12): `candidates` (a scripted source through the pipeline: a candidate rides in the routing request and its root is not asked about; never a referent by itself; safeguard (a) in a further request that asks nothing twice; safeguard (b); a candidate older than the window; unknown sections, more than twelve, a failing source, one pass and explicit targets; no source = an empty source; `C19` with one sibling as the candidate); `operations` (one question per probe; two parts with the same ends are two questions; what a Point and a Segment show as context; a summary in place of ancestry).
- `routing/acceptance/referents.test.ts` (2026-11-12): `candidates` on a backend: the source of `CoreDependencies` is asked per routed message and the J request lands on both siblings from one sibling as the candidate.
- `routing/corpus/corpus.test.ts` (2026-11-12): the three examples whose referent lies below work the message does not refer to are expected to miss with the tree walk when decisions are strictly as labelled, and to be routed as labelled when the line above is plausible and when a candidate source names the referent.
- `routing/referents/referents.test.ts`: the tree; for both strategies C19, C9, C20, ancestor removal and its exception; one pass asks everything once; the walk's levels, state text, pruning (until 2026-11-12: descent below an irrelevant branch point), linear runs; the guard (request, question and token budgets, the partial fallback, a strategy that keeps asking, one pass bounded); the strategy swap and a strategy that names an unsupplied section.
- `routing/acceptance/referents.test.ts`: the J request end to end on a backend with each strategy: C19 (continues from the join-back on the base chain and reads both), C9 twice (two of three running siblings wait for the third; a weak second sibling with a relevant group), C20 (join chain over leaves).
- `routing/referents/referents.test.ts`, long runs: a section of a 200-section chain and of 200 unrelated roots found within the budget where listing falls back; a referent at the start, middle and end of a run; two referents in different chunks; no relevant chunk; the most recent answer beside chunk questions; a run split in two rounds; the budget ending a search (`DA3`: the chunk's sections are not candidates, nothing is placed on a neighbour, the user is not asked) and the guard under five budgets; the trunk base (what is asked, a mid-trunk reply resolved exactly, not placed and not elicited with no budget, a correction keeping its ancestor, a trunk that never splits); hops (what is asked, a mid-run reply resolved exactly, the end of a hop asked again, the fallback, descent through a relevant chunk); and for each of the four combinations of the two switches C19, C9, C19 after a long trunk and among long branches, a mid-run reply in trunk and branch, a correction keeping its ancestor, and the guard with a deterministic fallback.
- `routing/referents/referents.test.ts`, first pass and hard stop: the first-pass sections of six conversations; with each strategy they are asked about in the routing request, a sibling group among them as a whole, and they are what the smallest request lists; `bestNodeFound` (descendant before ancestor, score, recency, the floor, a group as a node, a correction); `DA4` (each limit: one request, a plan and no elicitation, the best node, the record, the explanation, the same routing twice; the fallback request inside the budget; nothing plausible; and the same scores with budget to spare elicit); a strategy that reports a limit without a best node, and one the guard refused.
- `routing/acceptance/invariants.test.ts`: `I11` (a 6,000-token budget on the 200-answer chain with each strategy and each selector mode: the requests stay within it, a plan and no elicitation, the same routing twice) and `I12` (a scripted summary provider in use: no attempt's input and no event holds the summary).
- `routing/acceptance/summaries.test.ts`: `DA5` (a scripted summary provider: the decision model is shown the summary, every run receives the recorded exchanges, the event log holds no summary).
- `routing/referents/cost-grid.test.ts`: the price guard and the token budget on 360 cells of conversations up to a million tokens, answers down to 102 tokens, with each fixed strategy and with each strategy selector in front.
- `routing/referents/referents.test.ts`, token budget: the smaller of budget and allowance in either mode; every request of a routing counted; a relative budget reaching a section of a 700-exchange chain that a fixed 16,000 does not, and the two the same routing in a short conversation; for each strategy, the pipeline's request cut to its most recent sections under short answers and under a fixed budget, uncut with answers of ordinary length, and sent with its smallest window when nothing fits; a composite cut to the budget of its parts.
- `routing/acceptance/budget.test.ts`: on a backend, the log is every user message and every attempt's text, a failed attempt's partial text included, and only grows; a request that cannot be made smaller is sent and the decision says so.
- `protocol/test/contracts.test.ts`: the three tree-walk settings and the price guard merge key by key, validate, and are defaulted for stored settings that lack them; the token budget resolves by mode, is replaced as a whole, validates by mode, and normalises from what earlier versions stored.
- `web/src/app/app.test.tsx`: the two switches in Settings → Routing, independent, shown only for the tree walk; the decision budget's mode and value.
- `routing/corpus/corpus.test.ts`: every example with decisions as labelled, once per strategy and once per combination of the two switches.
- `routing/selection/selection.test.ts`: the shape of the trip tree, a long chain, old single roots, a trunk that splits and long branch runs; the description is counts only; the signature by powers of two; each rule; each mode through the pipeline (off: nothing asked or recorded; rules: no request, the record; decision model: one request about the shape alone with typed questions, then the chosen strategy's routing); the fallback on failure, on low confidence and on no budget; the search turned off only on a confident no; reuse of a recorded choice for the same signature and a new request when the shape changed; explicit targets select nothing; an injected selector; `DA2` (the routing with a selector, by rules and by the decision model, is request for request and in its plan the routing of the chosen strategy configured directly; four shapes); `DA1` (C19 and C9 with each strategy, configured, chosen by the rules and chosen by the decision model); the token budget with a selector on.
- `routing/acceptance/selection.test.ts`: on a backend with each selector, C19 (J continues from the join-back and reads both) and C9 (J waits for the whole group); the selection is in the `routing-decided` event and in state; the decision model is asked once per shape and the next message reuses the choice from the log.
- `routing/corpus/corpus.test.ts`: every example with decisions as labelled, with the strategy the rules select, which is the default (configured the other way round). The per-strategy runs set strategy selection `off`.
- `protocol/test/contracts.test.ts`, `web/src/app/app.test.tsx`, `web/src/features/debug/debug.test.tsx`: the mode as a setting, its control in Settings → Routing, and the run inspector's "Strategy" row.
- `providers/test/smoke/referents.smoke.test.ts` (`pnpm smoke`): the corpus for twelve configurations (one pass, runs always listed, the default, each switch, both, and the three selectors, all with no candidate source; then one pass, the tree walk and the rules with the lexical one, with the candidate sections each routing was handed) with its decision cost, the cost of every long example and a tally of the selections; the J and two-section cases five times per configuration; and the cost grid, printed.
- `providers/test/decision-tokens.test.ts` (2026-11-12): the Decisions mock's body parsing and usage; the corpus per configuration and the ratio to characters ÷ 4 against recorded figures; the price bound on all 360 guarded cells under tokenizer-calibrated counts; what a floor of 135 or 155 would do (recorded). `providers/test/decision-estimate.test.ts`: the guard's estimate is never below the reported count on 70 recorded live requests. `providers/test/smoke/decision-tokens.smoke.test.ts` and `decision-estimate.smoke.test.ts` (`pnpm smoke`): the live calibration and the live sample the estimate is fitted to (see "Measuring tokens").
- Hop between branch points (2026-11-12): `routing/referents/search.test.ts` · "hop between branch points" (probe counts for runs of 20, 200 and 2,000; the weak run; a relevant descendant; the property over the five shapes; a correction, round for round as off; the context limit; sibling groups; candidates and the two safeguards; first-pass sections; the budget stop; with the trunk base; old single answers), `referents.test.ts` · DA3 and "long runs · hop between branch points" through the pipeline with the record and the explanation, `corpus.test.ts` (the hop-on expectations: which examples have one and where they go, every example scored against them in both hop configurations, the two `deep-run` examples with a candidate source, and the evaluator's choice of set) and `providers/test/hop-tokens.test.ts` (the corpus off against on, each against its set), `selection.test.ts` (no rule and no question for the hop; DA2 with it set), `web` (`debug.test.tsx`: the inspector row).
- `providers/test/smoke/j-request.smoke.test.ts` (`pnpm smoke`): the brief, A, B and J through a real backend with the live providers, J sent during and after the siblings' runs.

## Left open

- **The floor of the price guard** (`SHORTEST_ANSWER_TOKENS`, 100): with the refitted estimate the 2× bound holds by tokenizer counts on every grid cell down to 102-token answers. Whether to raise the floor to about 135 or 155 is open (the user's decision); what that would do is under "Measuring tokens". The estimate itself rests on one decision model on one day, and a cheaper or different decision model needs the sample re-sent (`decision-estimate.smoke.test.ts`).
- **A referent below work the decision model finds unrelated** (2026-11-12): reached only as a first-pass section or through a start candidate. The lexical candidate source now names it when the message shares words with it (all three corpus examples); a reply that names it in other words is still not reached. No embedding index and no estimator are built. See "The candidate source: a lexical index".
- **The fallback's wording** is no longer the routing request's: its sections are judged beside each other only, not beside the whole window. Not measured live (no corpus routing falls back with the default budget).
- A referent in a searched run that only its answer text identifies: the chunk question names sections by their requests. Not measured how often this happens.
- Conversations whose answers are shorter than 100 tokens: the smallest request that routes a message exceeds twice the answer (250 before the pipeline's window became price-aware). Holding the bound lower means fewer than 4 listed sections, or a cheaper request (its fixed part, about 1,000 tokens, is the pipeline's other questions).
- Beyond about 1,200 to 2,000 older sections (by request length) the first chunk request exceeds the budget's ceiling and old referents are again out of reach. Asking the newest chunks that fit would extend it.
- The fraction (2%) fits exchanges of about 1,400 tokens and more; for shorter ones the floor is the reach. A per-section term (so many tokens per recorded exchange) would fit both and is not built: the user asked for a share of the log's tokens.
- The reach table is measured with decisions as labelled (the oracle) and the guard's token estimates, not live.
- Strategy selection: the two switch rules rest on formulae, not on a corpus that exercises them; the rule "one pass under 6,000 tokens" is a fixed figure where the pipeline's own request could be estimated; the selector is not shown which sibling groups are open beyond their count; and whether a decision model given more than counts (for example which lines are active) would choose better than the rules is not explored.
- The two rare pipeline requests that follow the strategy's are not reserved for: see "The pipeline's request draws from the budget".
- Context summaries for decisioning are designed in `docs/build/context-summaries.md`.

- `split-correction-and-new-work`: see above.
- A join chain appears in the tree under its first parent only (`CandidateWork.startNodeId` is one node), so a walk reaches it through that parent's line.
- The 10% figures rest on four answer runs of one example; an answer on a cheaper model changes the ratio in proportion (on `anthropic/claude-haiku-5.5`, at a twentieth of the price, the guarded ceiling would be about 74% of a short answer, and the budget should be lowered with the model).
- The live runs measure one decision model on one day. Jev's answers were stable across runs (the same scores to two decimals in most repeats), but the corpus is small.

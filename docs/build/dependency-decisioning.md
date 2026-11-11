# Dependency decisioning: which earlier work a message refers to

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

Files: `routing/referents/` (`tree.ts`, `shared.ts`, `one-pass.ts`, `tree-walk.ts`, `ask.ts`, `index.ts`).

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

A **run** is a segment's only children: the answers of one line of work between two places where it splits. The **trunk** of a root is its first run, from the root to the first branch point, or to the tip when the line never splits; its **base** is that last node. The sections of a run are now either **listed** (asked about one by one, as before) or **searched**.

**Search.** The sections are put into chunks, each as many as can be listed within `searchRunsOverTokens` (1,500 estimated input tokens, about 12 full-length sections). A chunk is one question that names its sections by the request each answered (at most 80 characters): "Does the new message refer to one of these earlier answer sections, each named by the request it answered: S25 ("…"), S26 ("…"), …: reply to it, build on it, compare or combine it with another answer, or correct it?". Then:

- every chunk at or above the floor (0.25) is followed: its sections are listed in the next request, with their full lines, and scored one by one. Two relevant chunks are both followed in that one request; no relevant chunk ends the search and nothing in the run is a referent;
- a run with more than 24 chunks (`SEARCH_FANOUT`) is first asked about in 24 groups of chunks, and a relevant group is split again. Requests grow with log₂₄ of the run's length: one round of chunks up to about 290 sections, two up to about 7,000;
- a request with chunk questions also shows the most recent answer and asks about it (`m_recent`, not read). Without that alternative the model has nothing to prefer;
- a relevant chunk counts for its segment like a relevant node: the walk descends below the run's end;
- a section is **never taken as a referent from a chunk's score**. It is asked about by itself first. When the budget ends a search between the chunk and its sections, every section of the relevant chunk is reported at just under the target-choice threshold, so the pipeline's own rule asks the user which one is meant (05: "It never guesses silently"; 11: "Below the target-choice confidence threshold, Committee elicits the target").

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

**Mis-placement is prevented in three ways**: a chunk's score never becomes a section's score; the end of a hop is asked about again beside the sections it was built on; and an unfinished search elicits. The remaining silent failure is the one named under *Search*: a chunk below the floor.

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
| Descend when the node is relevant | Descend when the node **or anything built on it** is relevant | Relevance is not inherited downward. "Compare the itinerary with the sky explanation" scores the brief 0.07, so a walk that prunes on the brief alone never finds the itinerary below it. The extra question scored 0.90 there and 0.03 for unrelated messages |
| One step per node ("bfs check its children") | One step per branch point; runs of only children are one segment | A conversation that only ever continues one chain is a path. Walking it node by node is one request per turn; as a segment it is one request, the pipeline's own |
| Remove every ancestor of a relevant node | The same, except for a correction | See above: a correction may name the brief its descendants only consumed |
| Several surviving siblings resolve to the full join-back | The same. It is work continuing from the join-back on the base chain, not a join chain | 01: "Work that needs several siblings of the same group never uses a join chain" |
| The result is the set of referents | The result is a score per kept section; the pipeline's thresholds still decide | 05: "It never guesses silently"; a referent below the target-choice threshold is asked about, not taken |

## Cost

### Measured rates (2026-11-11)

| What | Figure | How measured |
|---|---|---|
| Decisions, `typesafe/jev-1.13` | **$0.042 per million input tokens; output tokens are not charged** | `usage.cost` of every live call equals input tokens × 4.2e-8 (279 → $0.000011718; 848 → $0.000035616; 4,508 → $0.000189336). The verified sample in `CLAUDE.md` agrees: 358 → $0.000015 |
| Input tokens of a decision request | 262 fixed + 0.193 per character of state + 7 per question + 0.233 per character of its ID and instructions | Nine live requests from 303 to 4,508 input tokens; the fit is within 3% of each and never under. `estimateDecisionTokens` uses 265, 0.2, 7 and 0.24 |
| Latency of a decision request | about 0.15 s | 67 sequential requests in 10.5 s; 84 in 12.2 s |
| Answer, `anthropic/claude-sonnet-5.5` | $2 per million input, $10 per million output (`/api/v1/models`) | |
| One answer run | $0.0192 (35 in, 1,917 out), $0.0198 (1,354 in, 1,713 out), $0.0227 (1,351 in, 2,000 out, cut at the limit), $0.0372 (J: 3,607 in, 3,000 out, cut at the limit) | Four live runs of the trip example |

One exchange (request and answer) is about 1,750 tokens. The cheapest measured answer, **$0.0192**, is the denominator below; J's own answer cost $0.0372. Ten percent of an answer is $0.00192, which buys **45,700 decision input tokens**.

### Formulae

Symbols: N answer sections; R roots; W = 24, the pipeline's window; D, the depth of the tree in segments (branching levels); b, children per branch point; ρ, the fraction of a level's segments that are relevant; F = 262, the fixed tokens of a request; ℓ ≈ 85, a section's line (a live-style section: title, request, 280 characters of answer); q ≈ 40, one yes/no about it; u ≈ 30 to 120, a "built on it" question (it names up to 12 answers); g ≈ 30, a group question; σ ≈ 40, the message repeated in a further request; c ≈ 1,750, one exchange in full.

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
| Token budget | `settings.routing.tokenBudget` | **relative: 2% of the conversation's log, at least 16,000 and at most 40,000 tokens** | Every decision request of the routing: the pipeline's own, the strategy selector's, the referent strategy's |
| Price guard | `settings.routing.costGuard` | **twice the answer, priced on the cheapest answer model** | The same requests. A routing may use the **smaller** of the two (`routingTokenBudget` in `routing/referents/ask.ts`) |
| Backstops | `settings.routing.referentBudget` | **4 requests, 96 questions** | The strategy's further requests, whatever the tokens and prices are |

- The pipeline's own request comes first. When it would not fit with its full window of 24 answer sections it lists fewer, the most recent, down to 4 (`fitWindow` in `routing/pipeline.ts`; see "The pipeline's request draws from the budget").
- Every further request goes through `createReferentAsk` (`routing/referents/ask.ts`). It counts requests, questions and estimated tokens, and **refuses** a request that would pass a limit: nothing is sent. This holds for any strategy, an injected one included; the pipeline, not the strategy, owns the counter. Its token limit is what the routing's budget has left after the pipeline's requests.
- The tree walk checks before each level that the level **and its fallback** both fit. When a level does not fit, it stops walking and asks the one-pass questions it has not asked yet in one request over the pipeline's state text (bounded by the window). When the fallback is what does not fit and the level does, the walk goes on without the reserve (this arises under the price guard below, where what is left is less than one request over the pipeline's state text). When neither fits, the referents are the relevant nodes it has reached, and the sections of a relevant chunk whose search was cut short are reported below the target-choice threshold, so the user is asked about them. The routing decision's explanation says which happened and which limit was reached.
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

**Why relative is the default, and why 2% / 16,000 / 40,000.** What a search of a long run costs grows with the run: about 21 tokens per older section (12 to 27 with the length of the requests), on top of the pipeline's request and the listing of the relevant chunk (about 5,700). A fixed budget therefore has a fixed reach, and the document's own open item was that raising it "also triples what the worst message may cost" for every conversation, short ones included. A share of the log raises it only where there is more to search. Measured with decisions as labelled (a reply to the 41st section of one chain of 1,720-token exchanges; total estimated tokens of the routing):

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
- **The floor is 4** (`MIN_SECTIONS`): the latest answer, and room for a small sibling group and what it was requested from. A message has to be routed, so a request is always sent: when even 4 do not fit, the request with 4 is sent, the strategy gets nothing further, and the explanation says by how much the limit was missed.
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
- The pipeline's own requests are estimated (`estimateRequestTokens`), cut to fit (above) and counted first. What is left of the smaller of the allowance and the token budget is the strategy's token budget for this routing. The request and question caps stay as backstops that hold whatever the prices.
- The prices are settings and default to Haiku's, the cheapest answer model among the role defaults. On a dearer answer model the bound is looser by that model's price; to hold "twice the answer" on another model, set its prices. Stored settings without the group get the defaults (`normalizeSettings`).

With 1,700 expected output tokens the allowance is 40,500 tokens and the token budget binds first. With answers of 250 tokens it is about 6,100, the pipeline's request takes 3,300 to 5,100 of it, and the strategy gets what is left. With answers of 100 tokens it is about 2,450, and the pipeline's request is cut to fit it.

**The grid** (`routing/referents/cost-grid.ts`; `cost-grid.test.ts` asserts the price bound and the token budget on all 360 cells: five shapes, six fixed strategies and the two strategy selectors; `pnpm smoke` prints them). Conversations of 50, 500, 3,300 and 8,000 sections with exchanges of 120, 300, 2,000 and 10,000 tokens, every cell at most a million tokens, in five shapes: flat (one chain), an early split with two long branches, bushy (two parallel answers joined back, one answer on the join-back, repeated), nested forks (every answer continued twice, one continuation going on), and many roots. Each cell routes the message that costs most: every yes/no is answered 0.5, so every line is walked into and every chunk followed. Tokens are the guard's estimate over every decision request of the routing. The Haiku answer is the conversation's own answer length (85% of the exchange) on a new chain. Worst shape per size, the switches shown where they differ:

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
- *Below 100 tokens an answer* the bound cannot hold: the smallest request that routes a message costs about 2,400 tokens. Routing then costs at most twice a 100-token answer. See "The pipeline's request draws from the budget".
- *Long runs.* With answers of normal length the token budget binds before the price does. A search's first request names every section of the run: about 21 tokens a section (12 to 27 with the length of the requests). With the default budget a referent is found up to about 1,200 to 2,000 older sections (the table under "The token budget"); just beyond, the chunks are asked but the relevant chunk can no longer be listed, so **its sections are put to the user**; beyond that the chunk request itself does not fit and the walk falls back to the one-pass questions, so the old section is not reached. With a fixed budget of 16,000 a referent is found up to about 300 to 700 older sections and put to the user up to about 500 to 900.
- *Bushy and nested trees.* The request cap (4) ends a walk at the fourth branching level below the roots, and the walk then asks the one-pass questions, which cover the window. A referent deeper than that and older than the window is not reached.
- *What it never does:* exceed a cap, send a request it has not counted, or take a section as a referent without having asked about it.

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

- **Setting.** `settings.routing.strategySelection`: `off` (the default: the configured strategy and switches, exactly as before) | `rules` | `decision-model`. Settings → Routing → "Choosing the strategy". `CoreDependencies.strategySelector` injects another.
- **Input: the shape only** (`GenealogyShape`, `routing/selection/shape.ts`), read from the same context tree the strategies build, so trunk, run and branch point mean the same thing: answer sections and how many are older than the window; roots and old single-answer roots; branch points; depth in branching levels; sibling groups open and closed; total tokens; the number of trunks and of branch runs, and for the longest of each its sections, the listed ones before its end, the unlisted ones, its tokens and whether it ends in a split. And one number that is not shape: the decision tokens this routing may use (the token budget or the price allowance, whichever is smaller), because with no room for a further request a walk cannot descend. No request, answer or title is in it; a test asserts that.
- **Output: a typed choice** (`StrategyChoice` in protocol): `{ strategy: 'one-pass' }`, or `{ strategy: 'tree-walk', startAtTrunkBase, hopBetweenBranchPoints, searchLongRuns }`. `searchLongRuns: false` hands the walk a run size nothing reaches, which is the walk as it was before long runs were searched; the size that is searched stays the configured `searchRunsOverTokens`.
- **The pipeline and the strategies do not know how the choice was made.** `chooseStrategy` in `routing/pipeline.ts` returns a strategy and tree-walk settings, as the settings alone would; the strategies read `ReferentRequest.treeWalk` as before. Explicit and chosen reply targets, an empty conversation and an injected referent strategy select nothing.
- **Recorded with the routing decision** (`RoutingDecision.strategySelection`, a `StrategySelectionRecord`): whose choice was used, the choice, the shape signature, a one-sentence reason, the decision model's scores, why the rules stood in (`failed`, `low-confidence`, `no-budget`) and whether the choice was reused. The decision's explanation carries it as a sentence, the run inspector shows a "Strategy" row, and the selector's four questions and answers are in the decision's question list beside the others.

### The rules (`routing/selection/rules.ts`)

From what was measured above, when each setting pays:

| Rule | Evidence |
|---|---|
| **One pass** when every answer is listed in the pipeline's request | Inside the window the two strategies routed every corpus example the same (58/62 and 61/62 differ only by the three examples beyond the window); one pass needs no further request |
| **One pass** when the routing may use fewer than 6,000 decision tokens | The pipeline's request takes up to 5,400 with its full window and a level of the walk about 600. With less, the walk asks about the roots in the pipeline's request and cannot descend, so answers below a root go unasked **even when they are listed**; one pass asks about every listed answer in that same request. Test: with 3,000 tokens the configured tree walk places J on nothing, the rules' one pass on both siblings |
| **Tree walk** otherwise, **long runs searched** | Only the walk reaches answers older than the window; the search is the only setting that found a referent the walk could not (59/62 → 61/62) and changes nothing inside the window |
| **Start at the trunk base** when the longest trunk has 12 or more listed answers before its last and ends in a split | −23 tokens per skipped answer, +1,900 and a request when one of them is referred to. A trunk that has split is history more often than subject; a trunk that never splits is the conversation itself and replies to its earlier answers are the normal case, so there it stays off |
| **Hop between branch points** when a run below a split has 6 or more answers | −108 tokens per skipped answer, +280 and a request when a reply is inside the run |

The two switch rules are derived from the formulae and from one corpus example each; the corpus has no example where they change the result.

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

Two runs of the corpus for the default and the selectors, one for the other rows. The decision-model rows are **without reuse**: the corpus routes one message per conversation, so the selector is asked every time.

| Configuration | Score, run 1 | Score, run 2 | Requests | Tokens reported | Per routing |
|---|---|---|---|---|---|
| One pass | 58/62 | | 74 | 92,592 | 1.19 requests, 1,493 tokens |
| Tree walk, runs listed | 59/62 | | 94 | 104,582 | 1.52, 1,687 |
| Tree walk, long runs searched (the default) | 60/62 | 61/62 | 100 | 120,245 | 1.61, 1,939 |
| + trunk base | 61/62 | | 100 | 118,215 | 1.61, 1,907 |
| + hops | 61/62 | | 102 | 120,018 | 1.65, 1,936 |
| + both | 61/62 | | 102 | 117,988 | 1.65, 1,903 |
| **Selected by rules** | **61/62** | **61/62** | **83** | **110,364** | **1.34, 1,780** |
| Selected by the decision model | 61/62 | 60/62 | 126 | 145,539 | 2.03, 2,347 |
| Selected by the decision model, shown the message | 61/62 | 61/62 | 126 | 147,233 | 2.03, 2,375 |

- The differences between runs are one borderline example each, none of them about referents: `revision-session-requirement` (the default, run 1), `target-ambiguous-use-that-one` (the decision model, run 2). `split-correction-and-new-work` is missed by every configuration, as before.
- **The rules** score what the default tree walk scores, with 17% fewer requests and 8% fewer tokens: 34 or 35 of the 40 or 41 routings that select anything are inside the window and get one pass, the six beyond it the tree walk.
- **The decision model does not beat the rules.** Its choices: one pass 35 times, the tree walk 3 times, the tree walk with runs listed twice (conversations with fewer than a dozen older answers, where listing fits), and once not confident. The score is the same within the noise; it costs 26% more requests and 21% more tokens than the default, and 52% and 32% more than the rules. With reuse a real conversation pays the request once per shape, which removes most of that cost and none of the reason: the questions it answers are the rules, stated in words.
- **Shown the message**: the same score, five or six fallbacks for low confidence instead of one, about 41 more tokens a request.
- The J request on both siblings, five runs of five cases, and the follow-up naming two sections, five runs of two: **25/25 and 10/10 with each of the three selectors.**

**Default: `off`.** The layer is optional and the user asked for it as a setting. On this evidence `rules` would be the better default than a fixed strategy (the same results for fewer requests, and the walk exactly where it is needed), and `decision-model` should stay off until it has something the rules do not. Changing the default is the user's call; see "Left open".

## Evidence and the default

Live, `typesafe/jev-1.13`, reference decompositions, 2026-11-11. The corpus grew from 44 to 55 examples: nine with live-style titles (the J request in four settings and among unrelated answers, two follow-ups naming two sections, one sibling alone, an unrelated message), and two in a 30-section conversation.

| | 44 examples (before this change) | 55 examples |
|---|---|---|
| Round-3 questions (as shipped before) | 41/44 | 47/55 (reproduced as an injected strategy) |
| One pass | | **53/55** |
| Tree walk | | **54/55** |
| Tree walk with the live decomposer | | 53/55 (39/44 before) |

- The J request on both siblings, five runs of five cases: **25/25** with each strategy. With the round-3 questions the spec's wording was placed on the neighborhoods alone in both closed scenes, every run.
- The J request through the whole embedded backend (real engine, live decision model, live answers on a cheap model; `providers/src/j-request.smoke.test.ts`): **4/4**. Two runs sent J while A and B were running (J was queued on the sibling group, started after both had finished, read both); two sent it after the join-back had formed (J continued from it on the base chain, read both).
- A follow-up naming two sections, five runs of two cases: **10/10** with each strategy. "Compare the itinerary with the sky explanation" (the corpus's older example of this) went from the target-ambiguity prompt to a join chain after the section question was reworded to "…reply to it, build on it, compare or combine it with another answer, or correct it?": the sky section rose from 0.50–0.61 to above the threshold.
- Misses. `split-correction-and-new-work` under both: the new part ("also suggest some day trips") gets a handling chain below the threshold; it also missed before, and it is not a referent question. `live-referent-beyond-window` under one pass: the itinerary is older than the 24 listed sections, so it is never asked about and the message silently starts a new chain.

**Defaults of the long-run settings** (2026-11-11):

- `searchRunsOverTokens`: **1,500**, always in force. It is the only one of the three that finds something the walk could not find before (the two 200-section referents: 59/62 → 61/62), and it changes nothing inside the window. A chunk of 12 was more accurate than one of 25 for a correction, and 12 sections are what one request lists for 1,500 tokens.
- `startAtTrunkBase`: **off**. On the corpus it changes no result and saves 1.7% of the tokens, all of it on the 200-section chain (12% there). Inside the window it trades 23 tokens a trunk section for a further request whenever a trunk section other than the base is referred to, and a conversation that continues one chain is exactly where replies to earlier sections of the trunk are the normal case.
- `hopBetweenBranchPoints`: **off**. Same score, 0.2% fewer tokens, 2% more requests on the corpus. It pays when replies go to the ends of runs (−18% on that example) and costs a request when they go inside one (+4% to +8%). It also needs the end of a hop asked twice to be right. Turn it on for trees with long branch runs where follow-ups address the latest state of each branch.
- No size trigger was added to the switches: the size trigger is the third setting, which the user asked for in its own right ("some threshold of amount of node context").

**Default: tree walk.** Within the window the two are equal on every example. The difference is the conversation longer than the window, where one pass loses the referent without asking, which is the kind of silent wrong placement this change exists to remove. The price is 12% more decision tokens on the corpus (0.32% of an answer instead of 0.28%) and one more request of about 0.15 s when a message refers into a branched line of work; an unrelated message, or one in a conversation that does not branch, costs the same or less. The guard bounds the worst case at 3.7%. One pass stays selectable (Settings → Routing → Referents) for anyone who prefers a single request.

## Tests

- `routing/referents/referents.test.ts`: the tree; for both strategies C19, C9, C20, ancestor removal and its exception; one pass asks everything once; the walk's levels, state text, pruning, descent below an irrelevant branch point, linear runs; the guard (request, question and token budgets, the partial fallback, a strategy that keeps asking, one pass bounded); the strategy swap and a strategy that names an unsupplied section.
- `routing/acceptance/referents.test.ts`: the J request end to end on a backend with each strategy: C19 (continues from the join-back on the base chain and reads both), C9 twice (two of three running siblings wait for the third; a weak second sibling with a relevant group), C20 (join chain over leaves).
- `routing/referents/referents.test.ts`, long runs: a section of a 200-section chain and of 200 unrelated roots found within the budget where listing falls back; a referent at the start, middle and end of a run; two referents in different chunks; no relevant chunk; the most recent answer beside chunk questions; a run split in two rounds; the budget ending a search (the chunk's sections are put to the user) and the guard under five budgets; the trunk base (what is asked, a mid-trunk reply resolved exactly, elicited with no budget, a correction keeping its ancestor, a trunk that never splits); hops (what is asked, a mid-run reply resolved exactly, the end of a hop asked again, the fallback, descent through a relevant chunk); and for each of the four combinations of the two switches C19, C9, C19 after a long trunk and among long branches, a mid-run reply in trunk and branch, a correction keeping its ancestor, and the guard with a deterministic fallback.
- `routing/referents/cost-grid.test.ts`: the price guard and the token budget on 360 cells of conversations up to a million tokens, answers down to 102 tokens, with each fixed strategy and with each strategy selector in front.
- `routing/referents/referents.test.ts`, token budget: the smaller of budget and allowance in either mode; every request of a routing counted; a relative budget reaching a section of a 700-exchange chain that a fixed 16,000 does not, and the two the same routing in a short conversation; for each strategy, the pipeline's request cut to its most recent sections under short answers and under a fixed budget, uncut with answers of ordinary length, and sent with its smallest window when nothing fits; a composite cut to the budget of its parts.
- `routing/acceptance/budget.test.ts`: on a backend, the log is every user message and every attempt's text, a failed attempt's partial text included, and only grows; a request that cannot be made smaller is sent and the decision says so.
- `protocol/src/contracts.test.ts`: the three tree-walk settings and the price guard merge key by key, validate, and are defaulted for stored settings that lack them; the token budget resolves by mode, is replaced as a whole, validates by mode, and normalises from what earlier versions stored.
- `web/src/app/app.test.tsx`: the two switches in Settings → Routing, independent, shown only for the tree walk; the decision budget's mode and value.
- `routing/corpus/corpus.test.ts`: every example with decisions as labelled, once per strategy and once per combination of the two switches.
- `routing/selection/selection.test.ts`: the shape of the trip tree, a long chain, old single roots, a trunk that splits and long branch runs; the description is counts only; the signature by powers of two; each rule; each mode through the pipeline (off: nothing asked or recorded; rules: no request, the record; decision model: one request about the shape alone with typed questions, then the chosen strategy's routing); the fallback on failure, on low confidence and on no budget; the search turned off only on a confident no; reuse of a recorded choice for the same signature and a new request when the shape changed; explicit targets select nothing; an injected selector; **the routing with a selector is, request for request, the routing of the chosen strategy configured directly** (four shapes); C19 and C9 with each selector and each strategy chosen; the token budget with a selector on.
- `routing/acceptance/selection.test.ts`: on a backend with each selector, C19 (J continues from the join-back and reads both) and C9 (J waits for the whole group); the selection is in the `routing-decided` event and in state; the decision model is asked once per shape and the next message reuses the choice from the log.
- `routing/corpus/corpus.test.ts`: every example with decisions as labelled, with the strategy the rules select (configured the other way round).
- `protocol/src/contracts.test.ts`, `web/src/app/app.test.tsx`, `web/src/features/debug/debug.test.tsx`: the mode as a setting, its control in Settings → Routing, and the run inspector's "Strategy" row.
- `providers/src/referents.smoke.test.ts` (`pnpm smoke`): the corpus for nine configurations (one pass, runs always listed, the default, each switch, both, and the three selectors) with its decision cost, the cost of every long example and a tally of the selections; the J and two-section cases five times per configuration; and the cost grid, printed.
- `providers/src/j-request.smoke.test.ts` (`pnpm smoke`): the brief, A, B and J through a real backend with the live providers, J sent during and after the siblings' runs.

## Left open

- A referent in a searched run that only its answer text identifies: the chunk question names sections by their requests. Not measured how often this happens.
- Conversations whose answers are shorter than 100 tokens: the smallest request that routes a message exceeds twice the answer (250 before the pipeline's window became price-aware). Holding the bound lower means fewer than 4 listed sections, or a cheaper request (its fixed part, about 1,000 tokens, is the pipeline's other questions).
- Beyond about 1,200 to 2,000 older sections (by request length) the first chunk request exceeds the budget's ceiling and old referents are again out of reach. Asking the newest chunks that fit would extend it.
- The fraction (2%) fits exchanges of about 1,400 tokens and more; for shorter ones the floor is the reach. A per-section term (so many tokens per recorded exchange) would fit both and is not built: the user asked for a share of the log's tokens.
- The reach table is measured with decisions as labelled (the oracle) and the guard's token estimates, not live.
- Strategy selection: whether `rules` should be the default; the two switch rules rest on formulae, not on a corpus that exercises them; the rule "one pass under 6,000 tokens" is a fixed figure where the pipeline's own request could be estimated; the selector is not shown which sibling groups are open beyond their count; and whether a decision model given more than counts (for example which lines are active) would choose better than the rules is not explored.
- The two rare pipeline requests that follow the strategy's are not reserved for: see "The pipeline's request draws from the budget".
- Context summaries for decisioning are designed in `docs/build/context-summaries.md`.

- `split-correction-and-new-work`: see above.
- A join chain appears in the tree under its first parent only (`CandidateWork.startNodeId` is one node), so a walk reaches it through that parent's line.
- The 10% figures rest on four answer runs of one example; an answer on a cheaper model changes the ratio in proportion (on `anthropic/claude-haiku-5.5`, at a twentieth of the price, the guarded ceiling would be about 74% of a short answer, and the budget should be lowered with the model).
- The live runs measure one decision model on one day. Jev's answers were stable across runs (the same scores to two decimals in most repeats), but the corpus is small.

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

The last row is why full context is not sent. Its token count is the sum of the depths of the visited nodes times a whole exchange. For a conversation that continued one chain for n turns that is 1,750·n(n + 1)/2 + 302·n: 51,100 tokens at n = 7, which is already more than a tenth of an answer, for every message routed. The spec's own trip tree (brief, A, B, the join-back, J: depths 1, 2, 2, 3, 4) costs 22,500 tokens, 4.9% of an answer. One line per node costs 125 tokens however deep the node is.

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

### Where each would reach 10% of an answer

- **One pass** cannot: it is bounded by the window. At 24 full-length sections its request is about 5,000 tokens, 1.1% of an answer. Without the window it would reach 10% at about 360 sections.
- **Tree walk**, unguarded, in the worst case (every line of work relevant, every node asked once): about 965 + 155·N tokens, so 10% at about 290 sections. With the guard it cannot: see below.
- **Full context per node**, as first proposed: 10% at a 7-turn conversation.

## The guard

`settings.routing.referentBudget` is the most decision work a strategy may add to one routing beyond the pipeline's own requests. Default: **4 requests, 96 questions, 12,000 estimated input tokens**.

- Every further request goes through `createReferentAsk` (`routing/referents/ask.ts`). It counts requests, questions and estimated tokens, and **refuses** a request that would pass a limit: nothing is sent. This holds for any strategy, an injected one included; the pipeline, not the strategy, owns the counter. Tokens are estimated from the request's size, so the decision is deterministic and made before sending.
- The tree walk checks before each level that the level **and its fallback** both fit. When a level does not fit, it stops walking and asks the one-pass questions it has not asked yet in one request over the pipeline's state text (bounded by the window). When not even that fits, the referents are the relevant nodes it has reached. The routing decision's explanation says which happened and which limit was reached.
- One pass adds no request, and at most one question per listed section and per group.

Ceiling with the defaults: the pipeline's request (≤ 5,000 tokens) plus 12,000 is 17,000 tokens, $0.00071, **3.7% of the cheapest measured answer**, at any tree size. The budget that would allow 10% is 45,700 tokens; the default is a quarter of that.

In a flat conversation far larger than the window the walk's first further request (the older roots) does not fit, and it falls back at no cost: the one-pass questions were all asked in the pipeline's request already.

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

**Default: tree walk.** Within the window the two are equal on every example. The difference is the conversation longer than the window, where one pass loses the referent without asking, which is the kind of silent wrong placement this change exists to remove. The price is 12% more decision tokens on the corpus (0.32% of an answer instead of 0.28%) and one more request of about 0.15 s when a message refers into a branched line of work; an unrelated message, or one in a conversation that does not branch, costs the same or less. The guard bounds the worst case at 3.7%. One pass stays selectable (Settings → Routing → Referents) for anyone who prefers a single request.

## Tests

- `routing/referents/referents.test.ts`: the tree; for both strategies C19, C9, C20, ancestor removal and its exception; one pass asks everything once; the walk's levels, state text, pruning, descent below an irrelevant branch point, linear runs; the guard (request, question and token budgets, the partial fallback, a strategy that keeps asking, one pass bounded); the strategy swap and a strategy that names an unsupplied section.
- `routing/acceptance/referents.test.ts`: the J request end to end on a backend with each strategy: C19 (continues from the join-back on the base chain and reads both), C9 twice (two of three running siblings wait for the third; a weak second sibling with a relevant group), C20 (join chain over leaves).
- `routing/corpus/corpus.test.ts`: every example with decisions as labelled, once per strategy.
- `providers/src/referents.smoke.test.ts` (`pnpm smoke`): the corpus per strategy with its decision cost, and the J and two-section cases five times per strategy.
- `providers/src/j-request.smoke.test.ts` (`pnpm smoke`): the brief, A, B and J through a real backend with the live providers, J sent during and after the siblings' runs.

## Left open

- `split-correction-and-new-work`: see above.
- A join chain appears in the tree under its first parent only (`CandidateWork.startNodeId` is one node), so a walk reaches it through that parent's line.
- The 10% figures rest on four answer runs of one example; an answer on a cheaper model changes the ratio in proportion (on `anthropic/claude-haiku-5.5`, at a twentieth of the price, the guarded ceiling would be about 74% of a short answer, and the budget should be lowered with the model).
- The live runs measure one decision model on one day. Jev's answers were stable across runs (the same scores to two decimals in most repeats), but the corpus is small.

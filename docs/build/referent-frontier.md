# The referent frontier: accuracy against spend of the existing settings

Measured 2026-11-26 on `typesafe/jev-1.13`, decision model alone (reference decompositions), on the code of 9c6e522. This is a search over the configuration space that already exists: the referent strategy, strategy selection, the candidate source, the tree walk's switches and run size, the decision budget, `useSummaryIfAvailable`, the six decision thresholds and `AMBIGUITY_FLOOR`. No algorithm was changed and `DEFAULT_SETTINGS` was not touched. Background: [dependency-decisioning.md](dependency-decisioning.md) (what each setting does, how cost is counted) and [PLAN §7](PLAN.md#7-decisions-for-left-to-the-build) ("Threshold tuning", the 44-example sweep this one repeats).

**Result in one paragraph.** The defaults are on the frontier, and the data cannot separate any other setting from them on accuracy. Every arm that spends less loses cases, all of them in the six long conversations (one pass, tighter token budgets, one request or 24 questions for the strategy), or changes where a message is placed (hop between branch points, which is scored against its own expectations). Every arm that spends more (the decision-model selector, +35% per routing) gains nothing. Every threshold sits on a plateau. The best combination found on the tune cases (`dependency` 0.55, floor 0.2) gains one case on average (0 to +2 per replica), which is the noise, and gains nothing on held-out. **Recommendation: keep the defaults.** What would separate the plateaus is under "What corpus would separate them".

## Method

### The cases

- **Tune**: the routing corpus (`ROUTING_CORPUS`, 65 examples) and the `tune` partition of the conversation corpus (59 of 85, `partitionOf`): 124 routings. A routing is **long** when its conversation has more answer sections than the routing request lists (24, `MAX_SECTIONS`). Six are: two 30-section conversations and four of about 200 sections, all in the routing corpus. The conversation corpus has at most five sections per scene, so everything it says about spend is about short conversations.
- **Held-out**: the other 26 cases of the conversation corpus, routed once at the end under the default and under the arms fixed before that run.

### Record and replay

`packages/providers/testing/frontier/replay.ts`. A decision provider in front of the live one, keyed by a SHA-256 of the exact wire body (model, state text, the questions record). The cache holds **replicas**: replica *k* holds one live answer per distinct request, recorded the first time any arm sends that request in replica *k* and replayed to every later arm. So:

- within a replica, every arm that sends a request sees the same answer for it (as PLAN §7 did: the comparison between arms is paired, on common answers);
- the three replicas are three independent live runs, and their spread is the noise;
- a threshold or floor arm sends nothing live unless the threshold changes which requests are sent. The "Sent live" column counts those requests. It is 0 for every threshold arm but three: `targetChoice` 0.4 (9 requests: the walk's clear threshold is `targetChoice`), floor 0.05 (15: the floor is the walk's descent threshold) and `joinChoice` 1 (211: at 1 the `<unit>_lines` question is not asked, so every routing request is a new request).

Failed answers are not cached; no routing failed. The cache lives in the scratch area given by `FRONTIER_CACHE_DIR` and holds no key or header.

### The ambiguity floor

`AMBIGUITY_FLOOR` is a constant in `core/src/routing/derive.ts`. The sweep's vitest config (`packages/providers/testing/frontier/vitest.config.ts`) applies a load-time transform, in memory, that turns `export const AMBIGUITY_FLOOR = 0.25` into a binding with a setter (`floor.ts`); the file is unchanged, and the transform throws if the line it looks for ever changes. The floor is read by `derive.ts` and passed to the referent strategy as its plausibility floor, so the sweep moves both. Under `pnpm smoke` the floor rows are skipped.

### Spend

Per routing: decision requests, questions, and input tokens as the decision model reported them (`usage.input_tokens`, replayed with the answer), for short and long routings separately: mean, p95 and worst. Dollars at the price guard's `decisionInputPrice`, $0.042 per million input tokens, output free (the project's own accounting, "Measured rates"). Short conversations and long ones are reported apart because the mean over 124 routings is 95% short.

The corpus has six long routings, so it cannot say how an arm scales. **Scaling** (`scaling.ts`) routes the cost grid's five shapes at 5, 24, 50, 200 and 1,000 sections, with exchanges of 300 and 2,000 tokens, every yes/no answered 0.5 (every line walked into, every part of a search opened), through the real decision provider over the tokenizer-counting Decisions mock (`FITTED_CALIBRATION`, comparable with reported tokens). It reports the costliest shape and message per size: an upper bound on one routing under the arm's guard, not a typical one.

### Order of work

1. Strategy and budget arms: three replicas each, recorded live.
2. Thresholds and the floor, one at a time from the defaults, on the cached answers.
3. Joint arms: the best values of step 2 together, with and without the cheapest settings of step 1 that kept the score.
4. The recommendation fixed in `arms.ts` (`RECOMMENDED_ARM`, and `TUNE_BEST_ARM` for the record).
5. Held-out, once.

Live cost of the whole study: **1,022 decision requests, 1,421,815 input tokens, $0.060**, about seven corpus-sized runs.

## Noise

The default arm passed 118, 120 and 120 of 124 on the three replicas. Its misses per replica:

| Replica | Missed |
|---|---|
| 0 | `target-ambiguous-use-that-one`, `placement-continue-chain`, `dependency-expand-running`, `split-correction-and-new-work`, `fork-wordy`, `join-chain-separate-trees` |
| 1 | `split-correction-and-new-work`, `fork-wordy`, `join-chain-separate-trees`, `join-lines-non-english` |
| 2 | `dependency-expand-running`, `split-correction-and-new-work`, `join-chain-separate-trees`, `join-lines-non-english` |

Two misses are stable (`split-correction-and-new-work`, known since PLAN §7; `join-chain-separate-trees`, in the brief's baseline), six move between replicas. So **a difference of one or two cases between arms is noise**, even paired on common answers: a threshold moved by 0.05 flips exactly these borderline cases one way or the other, and which way depends on the replica. A difference is read here as real only when it holds in every replica and is three cases or more, or when it is a whole class of case (the long conversations) that an arm structurally cannot route.

## Strategy and budget arms

Cases passed: mean over three replicas, (min–max) where they differ. "Δ vs default": per-replica paired difference in cases passed. Spend columns: requests / questions / tokens mean / p95 / worst per routing. F: on the frontier by all tune cases against mean tokens per routing; L: on the frontier by long-routing tokens. †: scored against the hop-on expectations (`CorpusExample.hop`), because hop between branch points places a reply on the run's last answer by design.

| Arm | Routing corpus | Conv. tune | Long | All tune | Δ vs default | Short: req / q / tokens mean / p95 / max | Long: req / q / tokens mean / p95 / max | $ per 1,000 routings | Sent live | Frontier |
|---|---|---|---|---|---|---|---|---|---|---|
| **default (rules, lexical)** | 62.7 (61–64)/65 | 56.7 (56–57)/59 | 6/6 | **119.3 (118–120)/124** | – | 1.17 / 13.7 / 1,357 / 2,564 / 3,505 | 2.33 / 47.3 / 6,591 / 9,949 / 9,949 | $0.0677 | 456 | |
| rules, no candidate source | 62.7 | 56.7 | 6/6 | 119.3 | 0 | the same | 2.50 / 52.3 / 6,900 / 9,949 / 9,949 | $0.0683 | 15 | |
| rules, lexical, hops † | 62.7 | 56.7 | 6/6 | 119.3 | 0 | the same | 2.17 / 43.7 / 5,992 / 9,949 / 9,949 | $0.0664 | 3 | FL |
| rules, search runs over 750 | 62.7 | 56.7 | 6/6 | 119.3 | 0 | the same | 2.50 / 50.3 / 6,755 / 10,164 / 10,164 | $0.0680 | 18 | |
| rules, search runs over 3,000 | 62.7 | 56.7 | 6/6 | 119.3 | 0 | the same | 2.33 / 42.7 / 6,472 / 10,580 / 10,580 | $0.0674 | 15 | |
| rules, summaries if available | 62.7 | 56.7 | 6/6 | 119.3 | 0 | the same | the same | $0.0677 | **0** | |
| decision-model selection | 62.7 | 56.7 | 6/6 | 119.3 | 0 | 1.87 / 15.8 / 1,902 / 3,366 / 4,265 | 3.33 / 50.3 / 7,377 / 10,731 / 10,731 | $0.0910 | 99 | |
| one pass | 59.7 (58–61) | 56.7 | **3/6** | 116.3 (115–117) | **−3** | the same | 1.00 / 34.5 / 3,930 / 4,920 / 4,920 | $0.0622 | 0 | FL |
| tree walk, lexical | 62.7 | 56.3 | 6/6 | 119.0 | −1 to 0 | 1.20 / 13.5 / 1,363 / 2,747 / 3,505 | 2.33 / 47.3 / 6,591 / 9,949 / 9,949 | $0.0679 | 54 | |
| tree walk, no source | 61.0 (59–62) | 56.3 | 6/6 | 117.3 (116–118) | −2 | 1.19 / 13.4 / 1,359 / 3,015 / 3,593 | 2.50 / 52.3 / 6,900 / 9,949 / 9,949 | $0.0684 | 13 | |
| tree walk, trunk base | 62.7 | 56.3 | 6/6 | 119.0 | −1 to 0 | 1.21 / 13.5 / 1,369 / 2,747 / 3,505 | 2.33 / 40.7 / 6,356 / 9,949 / 9,949 | $0.0676 | 15 | |
| tree walk, hops † | 62.7 | 56.3 | 6/6 | 119.0 | −1 to 0 | 1.19 / 13.4 / 1,355 / 2,520 / 3,505 | 2.17 / 43.7 / 5,992 / 9,949 / 9,949 | $0.0663 | 3 | F |
| tree walk, trunk base + hops † | 62.7 | 56.3 | 6/6 | 119.0 | −1 to 0 | 1.20 / 13.4 / 1,360 / 2,651 / 3,505 | 2.33 / 40.7 / 6,356 / 9,949 / 9,949 | $0.0673 | 0 | |
| tree walk, runs listed | 61.7 (60–63) | 56.3 | 5/6 | 118.0 | −2 to −1 | 1.20 / 13.5 / 1,363 / 2,747 / 3,505 | 1.67 / 36.3 / 4,589 / 5,845 / 5,845 | $0.0638 | 3 | FL |
| referent requests 1 | 60.7 (59–62) | 56.7 | 4/6 | 117.3 | −2 | the same | 2.00 / 45.5 / 6,121 / 8,646 / 8,646 | $0.0667 | 0 | |
| referent requests 2 | 62.7 | 56.7 | 6/6 | 119.3 | 0 | the same | 2.33 / 47.7 / 6,465 / 9,949 / 9,949 | $0.0674 | 0 | FL |
| referent requests 8 | 62.7 | 56.7 | 6/6 | 119.3 | 0 | the same | the same | $0.0677 | 0 | |
| referent questions 24 | 60.7 (59–62) | 56.7 | 4/6 | 117.3 | −2 | the same | 2.00 / 45.5 / 6,121 / 8,646 / 8,646 | $0.0667 | 0 | |
| referent questions 48 | 62.7 | 56.7 | 6/6 | 119.3 | 0 | the same | the same | $0.0677 | 0 | |
| token budget absolute 6,000 | 60.7 (59–62) | 56.7 | 4/6 | 117.3 | −2 | the same | 1.33 / 31.7 / 3,957 / 4,808 / 4,808 | $0.0623 | 3 | FL |
| token budget absolute 10,000 | 61.7 (60–63) | 56.7 | 5/6 | 118.3 | −1 | the same | 2.00 / 42.7 / 5,627 / 6,538 / 6,538 | $0.0657 | 0 | |
| token budget absolute 16,000 | 62.7 | 56.7 | 6/6 | 119.3 | 0 | the same | the same | $0.0677 | 0 | |
| token budget absolute 40,000 | 62.7 | 56.7 | 6/6 | 119.3 | 0 | the same | the same | $0.0677 | 0 | |
| token budget relative 2%, floor 8,000 | 61.7 (60–63) | 56.7 | 5/6 | 118.3 | −1 | the same | 1.67 / 36.3 / 4,589 / 5,845 / 5,845 | $0.0636 | 0 | FL |
| price guard 1×, 4×, off; expected answer 400 tokens | 62.7 | 56.7 | 6/6 | 119.3 | 0 | the same | the same | $0.0677 | 0 | |

"The same" is the default's figure to the token. Cases that changed sides against the default (any replica; + passed only under the arm):

- one pass: −`live-referent-beyond-window`, −`long-chain-old-section`, −`long-roots-old-section` (referents older than the window: one pass never asks about them).
- tree walk configured (any switch): −`revise-shared-brief`. Inside the window the rules choose one pass, which asks about every listed section; the configured walk does not ask below a root it finds implausible, so the brief's consumers are not reached. Without a candidate source also −`deep-run-middle-section`, −`deep-run-other-branch` (as recorded in dependency-decisioning.md, "What removing the question costs").
- runs listed: −`long-roots-old-section` (the question backstop ends the listing).
- referent requests 1, referent questions 24: −`long-chain-old-section`, −`long-roots-old-section`.
- token budget 6,000: −`live-referent-beyond-window`, −`long-roots-old-section`; 10,000 and relative 2% with an 8,000 floor: −`long-roots-old-section`.

Reading it:

- **Inside the window every arm under the rules sends the same requests**, because the rules choose one pass there, with no further request. 118 of the 124 tune routings are short, so the short-routing spend column is the same for every rules arm, and strategy settings are decided entirely by the six long routings.
- **The frontier on all tune cases** is the default-equivalent arms at 119.3, and below them arms that trade the long referents for spend: one pass (−3 cases, −8% of all tokens, −40% on long routings), a 6,000-token budget (−2, −8%), runs listed and a relative 2% budget with an 8,000 floor (−1 to −2, −6%). These are real losses, not noise: each is a referent older than the window that the arm cannot reach, in every replica.
- **Hop between branch points** is the only arm on both frontiers at the default's score: −9% of long-routing tokens, nothing elsewhere. It is not a free saving: it places a reply to an answer inside a run on the run's last answer, and is scored against the hop-on expectations that say so. Whether an answer may read the rest of the run is the user's decision (dependency-decisioning.md, "Hop between branch points, redefined"); the corpus cannot decide it.
- **`referentBudget.requests` 2** keeps the score at 2% fewer long tokens: indistinguishable from 4 on six routings, and the scaling table shows it bites only on 50-section trees with long answers. Not worth a change.
- **The decision-model selector is dominated**: the same score for 40% more short-routing tokens and 0.7 more requests per routing, as measured before.
- **`useSummaryIfAvailable`** sent no request that the default did not: no summary provider produces anything yet, as its comment says. It cannot be measured until one does.
- **The candidate source** matters only to the configured tree walk (−2 cases without it) and to long-routing spend (lexical is 4.5% cheaper there); under the rules it cannot be separated on accuracy.
- **The price guard** never binds on the corpus: every corpus answer is long enough that the token budget binds first. Its effect is in the scaling table.

## Thresholds and the floor, one at a time

All 124 tune routings, mean (min–max) over replicas, every other setting at its default. Bold: the default.

| Threshold | 0.05 | 0.1 | 0.15 | 0.2 | 0.25 | 0.3 | 0.35 | 0.4 | 0.5 | 0.55 | 0.6 | 0.65 | 0.7 | 0.75 | 0.8 | 0.85 | 0.9 | 0.95 | 1 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `targetChoice` | | | | | | | | 110 (109–111) | 115 (114–116) | 116.3 | 119.3 (119–120) | 119.3 (119–120) | **119.3 (118–120)** | 119 (118–120) | 117.7 | 114.7 | 111 (109–113) | 83.3 | |
| `clearlyCorrective` | | | | | | | | 116.3 | 117.7 | 118.3 | 118.3 | 118.7 | 119.3 | 119.3 | **119.3** | 118.3 | 117.3 | 112.3 | |
| `composite` | | | | | | 118.3 | | 118.7 | 119.3 | 119.3 | 119.3 | **119.3** | 118.3 | 117.7 | 117.3 | 117.3 | 115.7 | 114 | |
| `dependency` | | | | | | 119 | | 119.7 (119–120) | 120 (119–121) | 120 (119–121) | **119.3** | 118.7 | 118.3 | 118 | 117.3 | 116 | 114 | 113 | |
| `clarification` | | | | | | 119.3 | | 119.3 | 119.3 | 119.3 | 119.3 | 119.3 | 119.3 | **119.3** | 119 | 118.3 | 115 | 113.3 | |
| `joinChoice` | | | | | | | | | 117.3 | | 118 | 118.3 | 118.3 | 118.3 | **119.3** | 119.3 | 119 | 118 | 117.3 (115–120)* |
| `AMBIGUITY_FLOOR` | 114.7 | 118 | 119.7 (119–120) | 119.7 (119–120) | **119.3** | 118.7 | 117.7 | 116.7 | 113.7 | | | | | | | | | | |

\* `joinChoice` 1 drops the join question, so its 211 requests were recorded live: its spread is a live run's, not the cached answers'. It is also the only threshold that changes spend materially: −2.8% of short-routing tokens (one question fewer per routing) for −2 cases.

No other threshold changes spend by more than 2%, and those that do change it lose cases: `composite` at 0.9 or 0.95 decomposes less (−1% to −5% of tokens, −4 to −6 cases), `targetChoice` 0.95 and `clearlyCorrective` 0.95 are far off their plateaus.

**Plateaus** (within one case of the best value, in every replica):

| Threshold | Plateau | Default | Where it sits | First loss each side |
|---|---|---|---|---|
| `targetChoice` | 0.6 – 0.75 | 0.7 | inside | 0.55: ambiguities become placements (`ask-*`, `target-join-lines-instead-of-asking`, `join-back-subset`); 0.8: weak referents become questions (`wait-group-subset`, `answer-terse`, the J request while running) |
| `clearlyCorrective` | 0.7 – 0.8 | 0.8 | upper edge | 0.65: `clarify-incompatible-follow-up` is read as a revision; 0.85: `revision-session-requirement` stops being one |
| `composite` | 0.5 – 0.65 | 0.65 | upper edge | 0.4: `revision-session-requirement`; 0.7: `sequential-on-existing-work` (one of the flaky cases) |
| `dependency` | 0.5 – 0.6 | 0.6 | upper edge | 0.4: `revise-shared-brief`; 0.65: `split-output-order-barrier`. 0.5 and 0.55 gain `dependency-expand-running` in two replicas |
| `clarification` | 0.3 – 0.75 | 0.75 | upper edge | 0.8: `clarification-missing`. Nothing in the tune cases sits between 0.3 and 0.75 |
| `joinChoice` | 0.8 – 0.9 | 0.8 | lower edge | 0.75: `ask-noisy` is joined instead of asked; 0.95: `target-join-lines-instead-of-asking`, `join-lines-non-english` |
| `AMBIGUITY_FLOOR` | 0.15 – 0.3 | 0.25 | inside | 0.1: `fork-shares-subject-with-running`, `ask-which-course`; 0.35: `target-ambiguous-shorter`. 0.15 and 0.2 gain `target-ambiguous-use-that-one` in one replica |

Against PLAN §7's sweep on 44 examples: every default is still on its plateau, and the plateaus are narrower now that the conversation corpus adds cases near their edges (`clearlyCorrective` was flat from 0.4 to 0.8 and now loses `clarify-incompatible-follow-up` below 0.7; `dependency` was flat from 0.4 to 0.65 and now loses `revise-shared-brief` at 0.4 and `split-output-order-barrier` at 0.65; `targetChoice` now holds at 0.6 and 0.65, where it lost a label before). Three of them sit at an edge whose next value loses one borderline case (`clearlyCorrective` 0.85, `composite` 0.7, `dependency` 0.65). Each of those edges is the conservative side the spec asks for (revise only on clearly corrective wording, Q37; split conservatively, Q4; topic overlap must stay below the dependency threshold, Q2), and the one case lost is a case that moves between replicas of the default, so the edge is no more than a case wide.

## Joint check

The two sweeps that gained a case, together, and with the cheapest settings of the first table that kept the score:

| Arm | Routing corpus | Conv. tune | All tune | Δ vs default, per replica | Long tokens mean | Cases that changed sides |
|---|---|---|---|---|---|---|
| default | 62.7 (61–64) | 56.7 (56–57) | 119.3 (118–120) | – | 6,591 | |
| `dependency` 0.55, floor 0.2 | 63.7 (63–64) | 56.7 | 120.3 (120–121) | 0 to +2 | 6,591 | +`target-ambiguous-use-that-one`, +`dependency-expand-running` |
| `dependency` 0.5, floor 0.2 | 63.7 | 56.7 | 120.3 | 0 to +2 | 6,591 | the same |
| + `targetChoice` 0.65 | 64/65 | 56.3 | 120.3 | 0 to +3 | 6,591 | also +`placement-continue-chain`, +`fork-wordy`, −`ask-noisy` |
| + `joinChoice` 0.85 | 63.7 | 56.7 | 120.3 | 0 to +2 | 6,591 | as the first |
| + referent requests 2 | 63.7 | 56.7 | 120.3 | 0 to +2 | 6,465 | as the first |
| + hops † | 63.7 | 56.7 | 120.3 | 0 to +2 | 5,992 | as the first |

No interaction hides: the joint gain is the sum of the two one-at-a-time gains, and adding a third threshold trades cases rather than adding them. Short-routing spend is the default's to the token in every row. The gain is +1 on average, 0 in one replica, made of two cases that already move between replicas of the default: **the data cannot separate this arm from the default**.

## Scaling: the costliest message by size

Every yes/no answered 0.5, calibrated tokens over every decision request of the routing, and the ratio to the message's own answer on the cheapest answer model (the price guard's bound is 2×). Requests / tokens (ratio). Rows that differ from the default; the default's figures are shared by every threshold and joint arm, by the rules arms other than those shown, by referent requests 8 and questions 48, by the 16,000 absolute budget up to 200 sections, and by "expected answer 400 tokens".

| Arm | 5 × 300 | 24 × 300 | 200 × 300 | 1,000 × 300 | 5 × 2,000 | 50 × 2,000 | 200 × 2,000 | 1,000 × 2,000 |
|---|---|---|---|---|---|---|---|---|
| **default** | 1 / 3,173 (1.03×) | 1 / 5,342 (1.73×) | 1 / 5,151 (1.67×) | 1 / 5,163 (1.67×) | 1 / 11,221 (0.55×) | 5 / 12,999 (0.64×) | 2 / 13,860 (0.68×) | 2 / 35,942 (1.77×) |
| decision-model selection | 2 / 3,542 (1.15×) | 1 / 5,342 | 1 / 5,151 | 1 / 5,163 | 2 / 12,051 (0.59×) | 4 / 13,329 | 3 / 13,675 | 3 / 35,793 |
| one pass | the same | | 1 / 5,185 | 1 / 5,197 | the same | 1 / 13,082 | 1 / 12,863 (0.63×) | 1 / 29,120 (1.44×) |
| tree walk, lexical | 2 / 3,393 (1.11×) | 1 / 5,319 | 1 / 5,151 | 1 / 5,163 | 2 / 7,344 (0.36×) | 5 / 12,999 | 2 / 13,860 | 2 / 35,942 |
| tree walk, runs listed | 2 / 3,393 | 1 / 5,319 | 1 / 5,151 | 1 / 5,163 | 2 / 7,344 | 2 / 13,156 | 5 / 12,925 | 5 / 31,790 (1.57×) |
| referent questions 24 | the same | | | | | 5 / 12,999 | 5 / 12,925 | 5 / 29,507 (1.46×) |
| token budget absolute 6,000 | 1 / 3,173 | 1 / 5,096 (1.65×) | 1 / 5,008 | 1 / 5,022 | 1 / 4,878 (0.24×) | 1 / 5,088 | 1 / 5,046 (0.25×) | 1 / 5,046 (0.25×) |
| token budget absolute 10,000 | 1 / 3,173 | 1 / 5,342 | 1 / 5,151 | 1 / 5,163 | 1 / 6,976 (0.34×) | 4 / 8,307 | 4 / 8,254 | 4 / 8,254 (0.41×) |
| token budget absolute 16,000 | the same up to 200 sections | | | | | | | 5 / 12,925 (0.64×) |
| token budget absolute 40,000 | the same | | | | 1 / 11,221 | 5 / 32,018 (1.58×) | 5 / 32,534 (1.60×) | 2 / 35,942 |
| token budget relative 2%, floor 8,000 | the same | | | | 1 / 6,468 (0.32×) | 2 / 6,748 | 2 / 6,695 (0.33×) | 2 / 35,942 |
| price guard 1× | 1 / 2,718 (0.88×) | 1 / 2,582 (0.84×) | 1 / 2,560 (0.83×) | 1 / 2,560 | the same | | | 5 / 16,590 (0.82×) |
| price guard 4× | 1 / 3,173 | 1 / 10,202 (3.31×) | 5 / 10,276 (3.33×) | 5 / 10,288 | the same | | | |
| price guard off | 1 / 3,173 | 1 / 11,635 (3.77×) | 2 / 13,548 (4.39×) | 5 / 13,288 (4.33×) | the same | | | |

- **No arm is cheap at 5 sections and ruinous at 200 or 1,000.** The guard holds every guarded arm under twice its answer up to 200 sections, and the default's worst cell is 1.77× (1,000 sections of 2,000-token exchanges, two million tokens of log, beyond the guard's million-token design: the relative budget is at its 40,000 ceiling there).
- **With short answers (300-token exchanges) the price guard binds** from 24 sections on, for every strategy: the worst message costs the same 5,100 to 5,350 tokens at 24 and at 1,000 sections. With 2,000-token exchanges the token budget binds instead, and grows with the log as designed (3% of it, 16,000 to 40,000).
- **What turns cheap into ruinous is the guard, not a strategy**: off, or at 4×, the same message costs 3.3 to 4.4 times its answer from 24 sections on. Keep it at 2×.
- **One pass and runs listed are cheaper at 1,000 × 2,000 only because they cannot search** the old sections; that is the same −3 and −1 cases as on the corpus.
- **The 16,000 absolute budget** is the relative default up to about 530,000 tokens of log; beyond, it costs a third as much in the worst case and loses the old referents of long conversations (dependency-decisioning.md, "The token budget"). Every corpus conversation is below that, at the 16,000 floor (the 16,000 absolute arm routes the corpus request for request like the default), so the corpus cannot tell the two apart.

## Held-out (once, after the recommendation was fixed)

`FRONTIER_PHASE=held-out`, 26 cases, three replicas. The recommendation was fixed in `arms.ts` before this run; the tune-best arm was routed beside it for the record and could not change it.

| Arm | Held-out passed | Short: req / q / tokens mean / p95 / max | $ per 1,000 routings |
|---|---|---|---|
| default (= the recommendation) | **22/26 in every replica** | 1.15 / 13.6 / 1,318 / 1,589 / 3,337 | $0.0554 |
| tune-best, not adopted (`dependency` 0.55, floor 0.2) | 22/26 in every replica, Δ 0 | the same | $0.0554 |

Missed in every replica by both: `fork-beside-running`, `revise-session-requirement`, `clarify-missing`, `clarify-one-part`, the stable misses of the brief's baseline (22/26 on three runs). No held-out case changed sides between the two arms. The `clarification` sweep shows why no threshold recovers the two clarify cases from the tune side: nothing in the tune cases moves between 0.3 and 0.75, so the threshold is not what separates them (a defect of the question or of the label, for the agents changing those).

## Recommendation

**Keep `DEFAULT_SETTINGS` as they are**, thresholds and `AMBIGUITY_FLOOR` included.

| Setting | Recommended | Confidence | Why |
|---|---|---|---|
| `strategySelection` | `rules` (unchanged) | High | Same score as every alternative at the lowest spend among them; the decision model costs 35% more for nothing; a configured walk loses `revise-shared-brief` inside the window |
| `referentStrategy` (read with selection off) | `tree-walk` (unchanged) | High for long conversations | One pass loses all three referents older than the window, in every replica |
| `candidateSource` | `lexical` (unchanged) | Medium | Cannot be separated under the rules on accuracy; 4.5% cheaper on long routings; the configured walk needs it (−2 cases without) |
| `treeWalk.startAtTrunkBase` | off (unchanged) | Low | No effect under the rules; the rules turn it on themselves where their condition holds |
| `treeWalk.hopBetweenBranchPoints` | off (unchanged) | Not an accuracy question | −9% of long-routing tokens, and moves replies inside a run to the run's end. The user's decision |
| `treeWalk.searchRunsOverTokens` | 1,500 (unchanged) | Low | 750 and 3,000 differ from it by ±3% on six long routings |
| `referentBudget` | 4 requests, 96 questions (unchanged) | Medium | 1 request or 24 questions lose two long referents; 2 requests and 8 cannot be separated from 4 |
| `tokenBudget` | relative 3%, 16,000–40,000 (unchanged) | Medium | Every tighter budget tried loses a long referent; looser ones change nothing on the corpus |
| `costGuard` | 2× (unchanged) | High at scale | Never binds on the corpus; off or at 4× the worst message costs 3.3 to 4.4 times its answer |
| `useSummaryIfAvailable` | off (unchanged) | None | Changes no request: nothing produces a summary yet |
| `targetChoice` | 0.7 (unchanged) | Medium | Inside its plateau (0.6–0.75) |
| `clearlyCorrective` | 0.8 (unchanged) | Medium | Plateau 0.7–0.8; the edge is the spec's conservative side |
| `composite` | 0.65 (unchanged) | Medium | Plateau 0.5–0.65; the same |
| `dependency` | 0.6 (unchanged) | Low | Plateau 0.5–0.6; 0.5 and 0.55 gain one flaky case, which is noise |
| `clarification` | 0.75 (unchanged) | Low | Flat from 0.3 to 0.75: the tune cases do not constrain it below 0.75 |
| `joinChoice` | 0.8 (unchanged) | Medium | Plateau 0.8–0.9 |
| `AMBIGUITY_FLOOR` | 0.25 (unchanged) | Medium | Plateau 0.15–0.3; 0.15 and 0.2 gain one flaky case, which is noise |

**Cannot separate**: `dependency` 0.5–0.6; `AMBIGUITY_FLOOR` 0.15–0.3; `targetChoice` 0.6–0.75; `clarification` 0.3–0.75; `referentBudget.requests` 2–8; `searchRunsOverTokens` 750–3,000; the candidate source under the rules; the price guard's ratio and expected answer length on corpus-sized answers; the token budget's mode and floor up to about 100,000 tokens of log.

## What corpus would separate them

- **Long conversations.** Spend is decided on six routings, four of them in two scenes of about 200 sections. A long-conversation corpus of 30 or more routings across the cost grid's shapes (a long flat chain, an early split with long branches, many roots, nested forks), at 50, 200 and 1,000 sections, with referents at the top, middle and end of runs, inside and beyond the window, and unrelated messages, would separate the run size, the request backstop, the token budget's floor and mode, and the trunk switch, which the corpus touches only on the 200-section chain.
- **Cases at the plateau edges.** Each edge is held by one or two cases: `dependency` by `dependency-expand-running` (0.5–0.55) and `split-output-order-barrier` (0.65); the floor by `target-ambiguous-use-that-one` (0.15–0.2) and `target-ambiguous-shorter` (0.35); `composite` by `sequential-on-existing-work`; `clearlyCorrective` by `revision-session-requirement`. Five to ten contrast cases per edge whose answer scores sit between the two values (for the floor: a second plausible section scored 0.15 to 0.3; for `dependency`: work in flight the message needs, scored 0.45 to 0.65, against work it only shares a subject with) would turn a one-case edge into a measured one. As a rule of thumb, with three replicas and this noise (two to three of 124 cases move between replicas), a difference of five cases or more that holds in every replica is needed to call one value better than another, so an edge needs at least that many cases on it.
- **Clarification below 0.75.** No tune case has a clarification question scored between 0.3 and 0.75; cases where the model is unsure whether information is missing are what would set it.
- **Summaries.** `useSummaryIfAvailable` needs a summary provider before it can be measured.

## Rerunning the sweep

```sh
FRONTIER_CACHE_DIR=<a directory outside the repository> \
  pnpm vitest run --config packages/providers/testing/frontier/vitest.config.ts --reporter=verbose --silent=false
```

`FRONTIER_GROUPS` (`strategy,budget,threshold,floor,joint,scaling`) runs a part, `FRONTIER_REPLICAS` sets the replicas (3), `FRONTIER_PHASE=held-out` routes the held-out partition under `HELD_OUT_ARMS` (run it once, after fixing `RECOMMENDED_ARM`). A rerun over a full cache sends nothing live; new corpus cases and new arms are recorded on first use. The summaries per arm and per case are written to the cache directory (`frontier-tune.json`, `frontier-held-out.json`, `frontier-scaling.json`). Under `pnpm smoke` the suite is skipped unless `FRONTIER_CACHE_DIR` is set, and the floor is not swept. `packages/providers/test/frontier.test.ts` checks the harness without the network.

Files: `packages/providers/testing/frontier/` (`replay.ts`, `arms.ts`, `frontier.ts`, `scaling.ts`, `floor.ts`, `prices.ts`, `vitest.config.ts`), `packages/providers/test/smoke/referent-frontier.smoke.test.ts`.

## Not verified

- The live answers are one decision model on one day; three replicas recorded within minutes of each other may vary less than runs on different days.
- With the hop on, scores are against the hop-on expectations, so its row is not the same measurement as the others'.
- The scaling table is a worst case (every yes/no 0.5), not a typical message; typical long-conversation spend is the six live long routings only.
- The live decomposer was not used: every figure is the decision model alone, with reference decompositions. `composite` in particular acts on whether the decomposer is called, and its plateau may differ with the real one.
- The floor transform relies on vite's SSR transform keeping exports live; `setAmbiguityFloor` checks that the binding moved, and the floor sweep's spread of outcomes confirms it acted.

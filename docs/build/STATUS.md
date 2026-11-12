# Committee MVP status

What runs, what was checked, what each review found and what was done about it, and what is still open. Final gate: 2026-11-11, branch `claude/charming-rubin-ty8nfp`.

## What works end to end

The app at `/` is the real product. The page holds the client store over a `PortClient`. A Web Worker holds core (engine, routing, recovery), the three OpenRouter providers (answers, Decisions, decomposition) and IndexedDB storage. All of the following were seen working in Chromium against live OpenRouter by `packages/web/e2e/run.mjs`:

- First-run key prompt, with "Use the key from this environment" on the dev server. Models per role are set in Settings.
- Parallel answers with overtaking. A quick answer is placed above a slow request's pending bubble and never moves.
- A two-intent message becomes one reply group with two sections.
- "Reply to this" on a story still being written queues the follow-up ("Waiting for …"). The follow-up runs after the story and reads it.
- Stopping a prerequisite pauses its dependent with the recovery choice (Retry, Continue without, Cancel). Retry reruns the prerequisite, then the dependent.
- A corrective follow-up ("Sorry, I meant …") supersedes the list and answers in a revision.
- Stop while streaming keeps the partial text. Retry streams a second attempt in the same section.
- Reload mid-answer: the attempt is recorded as interrupted. Standard retries it at once; Manual waits for Retry.
- After a reload, conversations, key status and models are kept. The run inspector shows the recorded input. The key is absent from every store of `committee-events`.
- Conversations can be created and deleted, and the deletion survives a reload.
- Markdown answers render: code blocks, tables, light and dark.
- An invalid key fails routing visibly with Retry. Replacing the key and pressing Retry answers.
- A second tab stands by ("Committee is open in another tab") and takes over when the first tab closes, with nothing recorded as interrupted.

The key reaches the Worker in a `change-settings` command and is written to the `committee-secrets` store; the providers read it on each call. It is in no event, projection, log line, screenshot, committed file or built bundle (checked below).

These are covered only by core and component tests, never end to end: clarification questions, target-ambiguity and choice-with-default panels, Undo split and join chains.

## Verification (final gate, run from the repository root)

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | Lockfile up to date |
| `pnpm typecheck` | 5 packages, no errors |
| `pnpm test` | 50 files, 631 tests passed, 0 failed (unit 543, of which core 288; web 88) |
| `pnpm --filter @committee/web lint` | Exit 0, warnings only. It exited 1 before this gate; see "Final gate" below |
| `pnpm build` | Succeeds. Worker bundle 298 kB; main chunk 1.9 MB (Streamdown's code, math and Mermaid plugins), with Vite's chunk-size warning |
| `pnpm smoke` | 2 files, 6 tests passed: four provider smoke tests and the live routing corpus |
| `COMMITTEE_URL=http://localhost:5199/ pnpm e2e` (dev server with `OPENROUTER_KEY`, cheap model for every generative role) | 13 of 13 flows passed; `overtaking` observed the overtaken case. Screenshots in `docs/build/screenshots/e2e/` |
| Secret scan | The key's value was searched for, without printing it, in the working tree, every commit's tree and patch, and `packages/web/dist`: 0 matches. The only `sk-or-v1-` strings in the repository are placeholder keys in `e2e/run.mjs` and `app.test.tsx` |

### End-to-end flows (`packages/web/e2e/run.mjs`)

| Flow | What it shows | Screenshots |
|---|---|---|
| setup | Key prompt on first run, "Use the key from this environment", every generative role set to the cheap model | `00-*` |
| overtaking | A long essay, then a one-word question: the quick answer is placed above the essay's pending bubble and never moves | `01-*` |
| replyGroup | A two-intent message gives one reply group with two completed sections | `02-*` |
| dependentFollowUp | "Reply to this" on a story still being written: queue item "Waiting for …", then the title runs after the story | `03-*` |
| pausedDependent | Stop a story a follow-up waits for: the follow-up is paused with the recovery choice; Retry runs the story again, then the follow-up | `12-*` |
| corrective | "Sorry, I meant yellow" on a finished list: the list is superseded and a revision answers | `04-*` |
| stopAndRetry | Stop while streaming ("Stopped · partial"), Retry: a second attempt completes in the same section | `05-*` |
| reloadMidAnswer | Reload while streaming: interrupted, and Standard retries it to completion | `06-*` |
| reloadUnderManual | The same under Manual: interrupted, no automatic retry; Retry completes it | `06b-*` |
| persistence | After a reload: conversations, key status and models kept; run inspector shows the recorded input; key absent from `committee-events` | `09-*` |
| conversations | Create and delete through the sidebar; the deletion survives a reload | `10-*` |
| markdown | A fenced code block with Streamdown's chrome, and a table when the model writes one, light and dark | `11-*` |
| invalidKey | An invalid key is rejected by the prompt. A key saved unverified that OpenRouter rejects fails routing visibly ("Could not route this message: User not found", Retry). Replacing the key and Retry answers | `07-*` |
| secondTab | A second tab stands by while the first streams; it takes over when the first closes | `08-*` |

## Acceptance conditions

Every condition has its canonical test, titled with its ID. All 66 pass in the final run (61 from the behavior documents, and DA1–DA5 from 11 · "Dependency attachment", adopted 2026-11-12). Where reviews added more tests under the same ID, they are listed too. Paths are relative to `packages/`.

| ID | Canonical test file | Further tests under the ID | Result |
|---|---|---|---|
| D1–D5 | `core/src/routing/acceptance/decomposition.test.ts` | `D3 (atomic)`, `D5 (decomposer)` in the same file; `D3 (review)`, `D4 (review)` in `core/src/routing/acceptance/review-2.test.ts`; corpus examples `combined-limit-atomic`, `combined-limit-atomic-new`, `split-per-part-limit-no-barrier` | pass |
| P1–P4, P8 | `core/src/engine/acceptance/placement.test.ts` | `(web)` renderings in `web/src/features/transcript/transcript.test.tsx` | pass |
| P5, P7 | `web/src/features/transcript/acceptance.test.tsx` | — | pass |
| P6 | `core/src/engine/acceptance/placement.test.ts` | `core/src/recovery/acceptance/review-3.test.ts` | pass |
| P9 | `core/src/routing/acceptance/placement.test.ts` | — | pass |
| P10–P13 | `core/src/recovery/acceptance/placement.test.ts` | — | pass |
| C1–C20 | `core/src/engine/acceptance/chains.test.ts` | C2 in `core/src/routing/acceptance/review-3.test.ts`; C10 in `core/src/recovery/acceptance/review-4.test.ts`; C19 in `core/src/routing/acceptance/review-4.test.ts`; `C3/C9/C11/C20 (engine)` in `core/src/engine/acceptance/named.test.ts` | pass |
| T1 | `core/src/routing/acceptance/targets.test.ts` | `core/src/routing/acceptance/review-2.test.ts`, `review-3.test.ts` | pass |
| T2, T3 | `core/src/recovery/acceptance/targets.test.ts` | T3 in `core/src/recovery/acceptance/review-4.test.ts` and `core/src/routing/acceptance/review-3.test.ts` | pass |
| R1–R8 | `core/src/recovery/acceptance/revisions.test.ts` | R3, R8 in `core/src/recovery/acceptance/review-3.test.ts` | pass |
| E1, E2 | `core/src/routing/acceptance/elicitation.test.ts` | `E1 (review)` in `core/src/routing/acceptance/review-2.test.ts` | pass |
| E3, E4 | `core/src/recovery/acceptance/elicitation.test.ts` | `E3 (Q101) · …` (the default-choice deadline across a restart) in the same file; `E3/E4 (…)` in `core/src/recovery/acceptance/review-2.test.ts` | pass |
| DA1, DA2 | `core/src/routing/selection/selection.test.ts` | On a backend with each selector: `C19 · …`, `C9 · …` in `core/src/routing/acceptance/selection.test.ts`; with each strategy in `core/src/routing/acceptance/referents.test.ts` | pass |
| DA3, DA4 | `core/src/routing/referents/referents.test.ts` | `I11` in `core/src/routing/acceptance/invariants.test.ts`; the cost grid in `core/src/routing/referents/cost-grid.test.ts`; with no decision provider, `budget · …` in `core/src/routing/referents/search.test.ts` | pass |
| DA5 | `core/src/routing/acceptance/summaries.test.ts` | `I12` in `core/src/routing/acceptance/invariants.test.ts` | pass |
| F1–F9 | `core/src/recovery/acceptance/failure.test.ts` | `F2 (engine)` in `named.test.ts`; `F3 (routing)` in `core/src/routing/acceptance/review-2.test.ts`; `F3 (web)` in `web/src/features/transcript/transcript.test.tsx` | pass |

The architecture invariants I1–I12 also pass (I11 and I12 were adopted 2026-11-12 and are in the routing file). They are in `core/src/{engine,routing,recovery}/acceptance/invariants.test.ts`.

## Decisions for "Left to the build" (12 · Build plan)

PLAN §7 has the full reasoning for each.

| Choice | Decision |
|---|---|
| Candidates for the decision model | Every current section; every chain with its settled head and tip; every directive not superseded or cancelled; every sibling group not dissolved. Result-dependency candidates are work still in flight (at most 16) and open groups. Trimmed to the 24 most recent sections if over the per-question limit |
| Trivial messages skip the decision call? | No. The first message of an empty conversation asks only the gate and clarification questions |
| Do decision and decomposition calls count against concurrency? "Per provider"? | Only answer, clarification-question and synthesis runs take a slot. Routing, label calls and join-backs take none. One pool, keyed `openrouter`. A conversation's messages are routed in submission order (C2) |
| Backoff | Standard: 3 retries at 1 s, 2 s, 4 s, accepting `Retry-After` up to 60 s. Persistent: 8 retries up to 30 s apart, accepting `Retry-After` up to 10 min. No jitter. Routing failures (408, 429, 502, 503, an empty 200, a dropped connection) retry under the same setting |
| Pinned decision model, tuned thresholds | `typesafe/jev-1.13`. Thresholds were swept on the 44-example corpus: `targetChoice` 0.7, `clearlyCorrective` 0.8, `composite` 0.65, `dependency` 0.6, `clarification` 0.75, ambiguity floor 0.25. Each is on its best plateau, 42/44 |
| Which earlier work a message refers to | A referent strategy behind one interface, chosen in settings: `tree-walk` (default) or `one-pass`, with a per-routing decision budget. Measured live at about 0.3% of an answer's cost; bounded at 3.7%. See [dependency-decisioning.md](dependency-decisioning.md) |
| Context warning | At 80 % of the model's limit, shown as a note on the section. A run fails before it starts only when the token count is exact. When the count is an estimate, a run over the limit warns and runs |
| Chunk size for stored output | First text at once. After that, 96 characters or 80 ms, whichever comes first. Always flushed before the terminal event |
| Embedded secrets store | A separate IndexedDB database, `committee-secrets`, opened only in the Worker |
| Wording for the concurrency hold | "Waiting for a free slot". It is shown only after the scheduler records `directive-slot-held`, which happens when the limit actually holds ready work. Until then the status reads "Responding…" |
| Stage that assigns fragments their chain and target | Atomic message: the gate. Composite: one further batched decision call after decomposition, with one question set per fragment |
| Superseded-input detection | Three kinds of replaced input: a replaced result, an unread correction to a brief the run read, and a replaced session-wide requirement. Each is detected by comparing the run's recorded context with current state. There is no estimate of whether the result would change |
| Where Compare is shown | A setting, `debug.comparePlacement`: `sidebar` (default, unchanged) or `inline`, a card on the message opened by “Show decomposition” (split messages: by the “split from one message” link). Inline, the side panel has no Compare tab. Both placements are built from the same parts (`features/debug/compare/compare-parts.tsx`); fixture `?fixture=compare-inline`, screenshots `screenshots/review/compare-inline-*.png` |

## Review rounds

There were three review rounds after the contract and recovery reviews. Each review was read-only. One core fixer and one web fixer applied the fixes.

### Recovery review (before round 1)

All seven findings were confirmed and fixed in `86fb27c`, with tests in `core/src/recovery/acceptance/review.test.ts`:

- Released but unstarted work waits again for a revised prerequisite.
- A redo chain releases held work only after the chosen redos.
- Later work waits for a replacement still in flight.
- A re-formed join-back keeps a late-retried member's marker.
- Join-backs descend from the replacement node.
- A second revision rewinds to the last finished answer.
- "Redid … by default" appears only on work that was in flight.

### Round 1: 36 findings. Fixed in `75053ff`, `71eb23e` (core) and `7dada48` (web)

**Core and routing: 17 fixed.**

- **Second sibling group at a non-tip node (blocker).** Its join-back landed on a chain that had moved on. It now forks onto a branch chain.
- **Join-chain parents.** They are always the current leaves (C20). A parent still in flight is waited for.
- **Work on a group member.** Work that consumes a member is placed under that member. Work that builds on one member and waits for another depends on the whole group.
- **Barrier deadlock (blocker).** The barrier deadlocked a sequential composite; that is fixed.
- **Requirement change plus a question (blocker).** The question was lost. It is now kept, through a new unit question `asks`.
- **Undo split.**
  - It ends after an inferred revision.
  - It ends after a split's clarification is answered.
- **Requirement revisions.**
  - Unaffected running work is no longer stopped.
  - Every reader of the old requirement is offered in the choice with default (`CandidateWork.consumedRequirements`).
  - Replacing a requirement needs corrective wording.
- **Weak targets.** A lone weak target is elicited unless something else places the unit with confidence.
- **Composite target choice.** Parts keep their own clear targets.
- **Barrier queue item.** A barrier-held queue item names the part it waits for.
- **Stop.** Stop on started work waiting for a slot records it as stopped.
- **Routing retries.** Transient routing errors retry, through `routingRetryPlanner`.
- **Context limit.** It is decided only on an exact count.
- **Thresholds.** Swept live; the defaults are kept as the tuned values.

**Web: 15 fixed.**

- Answer line breaks are kept.
- A retry after partial output no longer jumps.
- Request Stop/Retry moved into the header and take no height.
- A routing failure is a status line, not a failed mark.
- Key prompt: it animates out; its first-run wording is stable; it scrolls on short viewports.
- The elicitation modal has a height cap.
- Queue items animate their height.
- The countdown bar moves continuously.
- Escape clears Focus while a modal is shown.
- "Reply to this" moves focus to the message box.
- Mini-map: edges no longer cross labels, and an overflow fade marks where it scrolls.
- Dark chain colors are kept apart from the state colors.
- Faint text contrast and touch hit areas are fixed.

**Passed on:**

- The phone-height operation graph drawer went to the web fixer and was fixed in round 2.
- Focus on a fork and the prerequisite label were passed to core. Focus was fixed in round 3; the label is still open.

### Round 2: 16 findings, 3 of them duplicates. Fixed in `05d08ce`, `24d8a5e` (core) and `dd2fecb` (web)

**Core: 6 fixed.**

- **C2 (blocker).** A follow-up ran with no context while its prerequisite was still being routed. Messages are now routed in submission order.
- **T3.** A reply's target superseded during routing is redirected when the plan is applied, and the transcript shows "Replying to the revised version".
- **"Also give me luxury options".** Sent as a reply to running work that starts its chain, it now waits for that work and continues from it. This is a deviation from 05's table, which says such work runs at once. PLAN §2, repair 0, records it.
- **Regenerate after "Continue without".** The new run waits for the rerun of the waived work.
- **Choice-with-default holds.** Held work keeps its queue item and its recovery choice.
- **R3/R4 (blocker).** Work waiting for a slot before a retry now follows a revised prerequisite.

**Web: 5 fixed.**

- Focus preview no longer changes layout.
- The phone drawer height is capped, with a 144 px minimum for the transcript.
- A single answer is named in its header, and a queue item's prerequisite links to its section.
- A group with only one outcome has no header count.
- The collapsed excerpt is plain text.

**Left for round 3:**

- **Focus on a fork.** Fixed in round 3.
- **Stale choice-with-default option.** Fixed by the final gate.
- **Label mismatch.** Still open.

### Round 3: 26 findings. Fixed in `9cdb30b` (core) and `41ebb27` (web), then the final gate

**Core: 11 fixed.**

- **T3.** "Reply to this" stays on superseded sections.
- **C10.** Restarted work descends from the current join-back.
- **C19.** A weak referent that would change placement is elicited, not added silently.
- **Free-slot status.** "Waiting for a free slot" appears only when the limit really holds the work (`directive-slot-held`).
- **`plannedGroupIds`.** It is projected for not-started dependents of open groups.
- **Superseded link text.** It names the cause of the supersession.
- **Operation graph.** Edges go to the members a closed group still waits for, and to cancelled prerequisites.
- **Focus.**
  - It credits the marker section that was actually read.
  - It highlights consumed corrections.
  - It keeps superseded sections as the chain's own.
  - It counts a run on its node's current chain.
- **"New conversation".** It reopens an existing empty conversation instead of storing another.

**Web: 4 fixed.**

- The empty-state "New conversation" button opens what it creates.
- There is no Failed mark while a retry or a rate-limit wait is pending.
- Candidate excerpts are plain text.
- 32 distinct chain colors.

`playwright` is declared as a dev dependency.

**Fixed by the final gate:**

- **Superseded link text (web).** The superseded row now renders the projection's `linkText` ("See the regenerated version", and so on) instead of the fixed "See the revision".
- **Stale choice-with-default option.** This was a round-2 finding that was still present. Work the user stops or cancels during the wait is dropped from the options. Cancelled work never gets "Redid … by default". The test is `choice with default · work stopped by the user during the wait leaves the choice and is never "Redid … by default"`.
- **Root README.** It is added.

**Left open:** see "Known gaps" below.

### Final gate

- `pnpm --filter @committee/web lint` exited 1. The e2e helpers `useCheapModels` and `useEnvironmentKey` tripped `rules-of-hooks`. They are renamed `applyCheapModels` and `applyEnvironmentKey`; the affected flows were rerun and pass.
- The e2e screenshots were regenerated by this run.

### After the final gate: referent strategies (2026-11-11)

Closes the round-3 routing blocker and the related major finding; see [dependency-decisioning.md](dependency-decisioning.md) for the design, the measurements and the cost calculation.

| Command | Result |
|---|---|
| `pnpm typecheck` | 5 packages, no errors |
| `pnpm test` | 53 files, 735 tests passed, 0 failed (core 390, web 89) |
| `pnpm --filter @committee/web lint` | Exit 0, warnings only |
| `pnpm build` | Succeeds |
| `pnpm smoke` | 4 files, 13 tests passed. Corpus: tree walk 54/55, one pass 53/55, tree walk with the live decomposer 53/55. J on both siblings 25/25 per strategy; a follow-up naming two sections 10/10 per strategy. The J request through the whole backend with live answers: 4 of 4 (two sent while the siblings ran, two after the join-back) |

The e2e flows were not rerun. Settings gained a "Referents" choice on the Routing tab; it was opened and switched in Chromium by hand.

### After the final gate: decision budget, strategy selection, and the spec section (2026-11-11)

Three changes, one commit each: the decision token budget as a setting, with the pipeline's own request drawing from it; strategy selection ("decision-inception"); and the specification of both, with the context summaries, in [11 · Architecture, "Dependency attachment"](../spec/11-architecture.md#dependency-attachment). Evidence in [dependency-decisioning.md](dependency-decisioning.md).

| Command | Result |
|---|---|
| `pnpm typecheck` | 5 packages, no errors |
| `pnpm test` | 58 files, 1,113 tests passed, 0 failed (core 763, web 89) |
| `pnpm --filter @committee/web lint` | Exit 0, warnings only |
| `pnpm build` | Succeeds |
| `pnpm smoke` | 4 files, 28 tests passed. Corpus, 62 examples: one pass 58, tree walk (the default) 61 (60 in one of three runs), selected by rules 61 in all three, selected by the decision model 61 (60 in one of three). J on both siblings 25/25 and a follow-up naming two sections 10/10 with each of nine configurations. The J request through the whole backend with live answers: 4 of 4 |

The e2e flows were not rerun. Settings → Routing gained "Choosing the strategy" and "Decision budget"; both were opened and switched in Chromium, light and dark, at desktop width only.

### Hard stop, first pass, rules by default, DA1–DA5 (2026-11-12)

The user's decisions of 2026-11-12, in [dependency-decisioning.md](dependency-decisioning.md) · "The hard stop, the best node found so far, the first pass, and rules by default": strategy selection defaults to the rules; the decision budget is a hard stop and routing uses the best node found so far without asking the user; every routing starts with a first pass over the five most recent answer sections that no later one of them builds on; invariants 11 and 12 and acceptance conditions DA1–DA5 are part of the specification.

| Command | Result |
|---|---|
| `pnpm typecheck` | 5 packages, no errors |
| `pnpm test` | 58 files, 1,120 tests passed, 0 failed (core 770, web 89) |
| `pnpm --filter @committee/web lint` | Exit 0, warnings only |
| `pnpm build` | Succeeds |
| `pnpm smoke` | 4 files, 28 tests passed. Corpus, 62 examples, one run: one pass 58, tree walk with long runs searched 61, selected by rules (the default) 61, selected by the decision model 61. No score changed: with the default budget no corpus routing reaches a limit, so no question to the user became a placement. The first pass saves the tree walk 11 requests on the corpus (100 → 89). J on both siblings 25/25 and a follow-up naming two sections 10/10 with each of nine configurations. The J request through the whole backend with live answers: 4 of 4 |

The e2e flows were not rerun, and nothing was looked at in a browser: the Settings wording ("By rules … The default.") and the run inspector's new "Decision budget" row are covered by the jsdom tests only.

The specification's own status lines (README and 12) said "No production code exists" until 2026-11-12; they now say the first version is implemented and point here.

### The operations, the last relevant node, start candidates (2026-11-12)

The user's decisions of 2026-11-12, in [dependency-decisioning.md](dependency-decisioning.md) · "The model, the operations, and the search":

- **The question "does it refer to anything built on this?" is removed.** A tree walk descends below an unbranched run only when a section, a sibling group or a part of that run is plausible.
- **The operations a search uses are one interface**, `ReferentOperations` (`core/src/ports/referent-operations.ts`): Point, Group, Segment and Several, decision-backed; Estimate, Structure, Describe and Cost, free. `one-pass` and `tree-walk` are policies over it with no wording, question ID or budget arithmetic of their own. An oracle over a labelled set of relevant nodes drives the same policies in tests with no decision provider.
- **A long unbranched run is searched for its last relevant node**: up to 24 parts a round, the latest plausible part opened and asked about section by section; when no Point confirms, the plausible part before it. A correction still gets every relevant section.
- **A tree walk can start at candidates** besides the roots: `CoreDependencies.candidateSource`, none by default (later the same day: a lexical index, on by default, see "The candidate source" below). The start set is the roots and the candidates reduced to their non-ancestor set (`reduceToNonAncestors`); a start that is not plausible hands over to what it displaced, and so does every start when the message refers to several sections.

| Command | Result |
|---|---|
| `pnpm typecheck` | 5 packages, no errors |
| `pnpm test` | 60 files, 1,195 tests: 1,194 passed (core 839, web 95). The one failure is not from this change: `protocol/src/contracts.test.ts › defaults match the specification` counts the debug toggles and was not updated when `debug.comparePlacement` was added (`ddd7e5f`) |
| `pnpm --filter @committee/web lint` | Exit 0, warnings only |
| `pnpm build` | Succeeds |
| `pnpm smoke` | 4 files, 28 tests passed (run twice; the first run's output was not captured). Corpus, 62 examples, one run: one pass 58 (unchanged to the token), tree walk with long runs searched **59 (61 before)**, selected by rules (the default) **61 (unchanged)**, selected by the decision model 61. J on both siblings 25/25 and a follow-up naming two sections 10/10 with each of nine configurations. The J request through the whole backend with live answers: 4 of 4. Cost grid: worst guarded cell 1.99× |

**What it cost.** The configured tree walk misses two corpus examples it routed before (`deep-run-middle-section`, `deep-run-other-branch`): the referent is in the middle of a run below a brief the decision model does not find plausible for the message, so nothing below the brief is asked about and the reply continues the end of its line instead of branching from the section meant. With decisions strictly as labelled a third example is missed, `live-referent-beyond-window`; live the brief is plausible there and it is found. The default (rules) is not affected: inside the window it chooses one pass. A candidate source that names the referent routes all three as labelled (tested with a scripted source); no retrieval is built.

Not done: the e2e flows were not rerun and nothing was looked at in a browser (no client code changed). The spec (11 · "Referent strategies") still describes the removed question and the search of every relevant chunk; it is being edited separately.

### Measuring tokens (2026-11-12)

Token figures are now also measured with no network: a mock of the Decisions API counts each request with a tokenizer (`gpt-tokenizer`, `o200k_base`, a proxy for the decision model's own, calibrated to its reported counts). [dependency-decisioning.md](dependency-decisioning.md) · "Measuring tokens".

| What | Result |
|---|---|
| Tokens measured with a tokenizer over a mock Decisions API (`providers/src/decision-tokens.test.ts`, `decision-tokens.smoke.test.ts`) | Corpus, calibrated tokenizer against live: one pass 93,352 / 92,592, tree walk 109,913 / 108,412, rules 108,866 / 107,841 (recorded again with the lexical candidate source as the default; with no source 109,090 / 108,935 and 110,610 / 110,263); the guard's estimate is 7 to 9% low. Tokenizer ÷ (characters ÷ 4): 0.79 to 1.03, mean 0.90. **Cost grid: worst guarded cell 1.99× by the estimate, 2.79× by the tokenizer; 208 of 360 cells over 2×** (every 120-token and most 300-token cells). Live, the worst cell's request was reported at 1.30 × its estimate. Recorded, not fixed: a calibrated estimator is proposed, not applied. Applied the same day: see "The guard's estimate, refitted" |

### The candidate source: a lexical index (2026-11-12)

The user: "build a real candidate source … Start with lexical index. Recall this is merely to help the search as a seed hints." [dependency-decisioning.md](dependency-decisioning.md) · "The candidate source: a lexical index".

- **A word index over the conversation's answer sections** (`core/src/routing/candidates/lexical.ts`; title, request counted twice, whole answer; BM25) hands the tree walk candidate sections for each unit: places to start besides the roots. Seed hints only: a candidate is asked about by itself like any other section, no score of the index is read, and Estimate still returns nothing.
- **Returned**: sections whose score is at least 0.3 of the weight of the unit's words and at least half the best section's, best first, ties by recency, at most 12. The first-pass sections are left out (they are asked about anyway). A message that only names a change ("make that shorter", "combine both") gets none.
- **Setting** `settings.routing.candidateSource`: `lexical` (the default) or `none`; Settings → Routing → "Candidate sections". An injected `CoreDependencies.candidateSource` still wins. The routing decision records which source ran and what it returned with its scores; the run inspector shows it as "Candidate sections".
- **Strategy selection is unchanged**: one pass asks about every listed section and ignores candidates; they matter where the rules choose the tree walk.

| Command | Result |
|---|---|
| `pnpm typecheck` | 5 packages, no errors |
| `pnpm test` | 62 files, 1,360 tests, all passed (core 996, web 95). The recorded figures of `providers/src/decision-tokens.test.ts` that depend on the default were updated (the tree walk's and the rules' corpus totals, and the two ratios over all requests); nothing was loosened |
| `pnpm --filter @committee/web lint` | Exit 0, warnings only |
| `pnpm build` | Succeeds |
| `pnpm smoke` | Run once in full: 5 files, 36 tests passed; its output was not captured, so `referents.smoke.test.ts` was run a second time for the figures (25 tests passed). Corpus, 62 examples, source off → on: one pass 58 → 58 (74 requests, 92,592 tokens both ways), tree walk with long runs searched **59 → 61** (84 → 85 requests, 108,935 → 108,412 tokens), selected by rules (the default) **61 → 61** (83 → 82 requests, 110,263 → 107,841 tokens). J on both siblings 25/25 and a follow-up naming two sections 10/10 with each of twelve configurations. Cost grid: worst guarded cell 1.99×, unchanged; 2.00× on a message that names answers, with or without the source |

**What it recovers.** `deep-run-middle-section` and `deep-run-other-branch`, the two examples the configured tree walk lost when "anything built on this?" was removed, are routed as labelled again with nothing scripted, and `live-referent-beyond-window` takes two requests where it took three. With decisions as labelled the tree walk and the strategy the rules select both route 62 of 62.

**Time.** 10,000 sections (35 MB of text) are indexed in 1.9 s, once per conversation per backend start; after that a routing costs 3 to 4 ms to bring the index up to date and about 2 ms for a query.

Not done: the e2e flows were not rerun. The Settings control and the inspector row were looked at in the fixture gallery in a browser, not in a live conversation. Limits (words only, English stop list, a threshold set on 62 examples, a plausible wrong candidate displacing a root) are in the document.

### The guard's estimate, refitted (2026-11-12)

The main session's decision: apply the calibrated estimate proposed under "Measuring tokens". [dependency-decisioning.md](dependency-decisioning.md) · "The estimate, refitted".

- **`estimateRequestTokens` / `estimateDecisionTokens`**: 300 + 0.35 per character of state + 7 per question + 0.32 per character of question text (before 265 + 0.2 + 7 + 0.24). Never below the count the decision model reported on 70 live requests (`providers/src/openrouter/test-support/estimate-fixture.data.ts`, re-sent by `decision-estimate.smoke.test.ts`, held by `decision-estimate.test.ts`); 1.01 to 1.30 times it.
- **The 2× bound now holds by tokenizer counts** on all 360 guarded grid cells, asserted in `decision-tokens.test.ts`: worst 1.80× (8,000 × 120, bushy, tree walk with runs listed), 2.00× by the estimate (1.997, 50 × 300, nested forks). Before: 2.79× and 208 cells over.
- **`SHORTEST_ANSWER_TOKENS` is unchanged (100), and open**: at 100 no cell is over 2×; a floor of 135 or 155 would let every 120-token cell cost up to 2.39× or 2.72× its own answer (recorded).
- **Corpus**: no score or request count changed with decisions as labelled; four long-run examples are searched in smaller parts. Live, with the lexical source: one pass 58/62, tree walk 61/62, rules 61/62, as before.
- **Two deterministic tests resized, none loosened against the bound**: the relative-budget search test (`referents.test.ts`) uses 2,500-token answers where it used 1,700, and the selector's request bound (`selection.test.ts`) is 1,100 estimated tokens where it was 900. The spec needed no change: its sentence that the bound holds down to answers of about 100 tokens (11 · "Decision budget") is now true as the decision model counts tokens, where before it held only by the estimate.

| Command | Result |
|---|---|
| `pnpm typecheck` | 5 packages, no errors |
| `pnpm test` | 63 files, 1,363 tests, all passed |
| `pnpm --filter @committee/web lint` | Exit 0, warnings only |
| `pnpm build` | Succeeds |
| `pnpm smoke` (`decision-estimate.smoke.test.ts`; `referents.smoke.test.ts`, the three lexical-source corpus configurations) | Passed. Estimate not below any of 42 reported counts; corpus scores 58, 61, 61 |

### Spec edits of `39c381d`: combined limits, ordered messages, the persisted deadline, tabs and conversations (2026-11-12)

- **Combined total output limit → atomic (Q102, D5).** The decision gate asks one more question, `combinedlimit` ("one limit on its answers taken together … a limit for each answer on its own does not count"). At or above the composite threshold the message is one directive whose instruction is the whole message, the limit included, and the decomposer is not called. The decomposer reports a combined limit apart from the barrier (`Decomposition.combinedLimit`); when only it sees one, the message is still routed as one request. `combined-limit` is no longer a `WholeRequestBarrier` reason (protocol, decomposer schema and prompt, Compare's wording). A message that also makes a requirement conversation-wide still calls the decomposer, for the requirement's text, and is then routed atomic. Live (`typesafe/jev-1.13`, 3 rounds, with reference and live decompositions): the combined-limit examples score 0.96 to 0.98 on `combinedlimit` and route atomic; the per-part example 0.03 to 0.04 and is decomposed; the order and ready/blocked examples 0.03 to 0.04, unchanged.
- **Ordered-message decomposition (Q104, D3).** `settings.routing.orderedMessages`: `decompose` (the default, today's behaviour, so D3 holds as worded) or `atomic`; Settings → Models, under the decomposition model. With `atomic`, a message the decomposer gives an explicit output order is routed as one request with no barrier, after one confirming decision question (`ordered`), and only when the order is not just its parts' dependencies ("find X, and then plan around it" stays a split). The gate does not ask about order: live, a gate question scored "…, and then make an itinerary from …" at 0.58 to 0.80. Live with `atomic` and the live decomposer (2 rounds): "but put the translation first" atomic both times; the sequential, independent, ready/blocked and topological-order examples as labelled.
- **Default-choice deadline across a restart (Q101).** Already built: `elicitation-raised` records `deadlineAt` as an absolute time and the recovery slice's startup reaction carries out an elapsed default once (an open elicitation only) or sets the timer for what is left. Tests added for closed before and reopened after, reopened before (the recorded deadline holds even when the wait setting changed meanwhile), and two further restarts after the default ran (one `elicitation-defaulted`, the work redone once).
- **Tabs (Q99).** The Web Lock logic moved to `web/src/worker/ownership.ts` (`runAsOwner`) and is tested with a fake lock manager: the first tab serves, later tabs stand by in the already-open state, the next in line takes over when the owner releases the lock. The store test covers standby turning to ready when the Worker's `ready` arrives. The e2e flow `secondTab` covers it in a browser.
- **Conversations (Q100).** The app has several conversations (sidebar list). The backend loads every conversation at start and schedules every one from one pool (`schedule()` in `core/src/engine/backend.ts`); the client never tells it which one is open. Tests: `conversations (Q100) · …` in `core/src/engine/acceptance/conversations.test.ts` (runs in one conversation go on while the other is used and hold its work at "Waiting for a free slot"; ready work of two conversations starts in submission order) and `Q100 · opening another conversation …` in `web/src/backend/store.test.tsx` (switching sends no command). The settings comment that said "per provider" now says app-wide.
- **Recorded token figures changed.** The gate's new question adds 48 questions and about 3,000 tokenizer tokens over the corpus in each configuration, no request: `providers/src/decision-tokens.test.ts` re-recorded with the earlier figures in its comments; the cost-grid bound still holds on all 360 cells (worst 1.82× by tokenizer, 1.994× by estimate). The live figures quoted in [dependency-decisioning.md](dependency-decisioning.md) predate the question.
- **Changed tests.** `D3 (review)` used a combined limit as its barrier; it now uses an explicit order. The corpus's `split-combined-limit-barrier` became `combined-limit-atomic` (and `combined-limit-atomic-new` was added); `split-per-part-limit-no-barrier` no longer carries a `combined-limit` barrier in its reference decomposition. Gate question lists in `validation.test.ts` and `F3 (routing)` gained `combinedlimit`.

## How to run

```sh
pnpm install
pnpm dev                                          # http://localhost:5173; key prompt on first open
pnpm typecheck
pnpm test                                         # unit (node) and web (jsdom) projects
pnpm vitest run --project unit packages/core      # one package
pnpm vitest run --project web packages/web
pnpm --filter @committee/web lint
pnpm build
OPENROUTER_KEY=… pnpm smoke                       # live provider tests and the routing corpus
OPENROUTER_KEY=… pnpm dev                         # then, in another shell:
COMMITTEE_URL=http://localhost:5173/ pnpm e2e     # all flows; or name some: pnpm e2e corrective reload
```

On the dev server, `/?fixtures` opens the fixture gallery.

## Known gaps

**Routing (live model)**

- **J request on one sibling (round 3, blocker; closed).** Which earlier work a message refers to is now decided by a referent strategy behind one interface (`ReferentStrategy`; [dependency-decisioning.md](dependency-decisioning.md)). Both strategies ask about a sibling group as a whole, as the join-back it will be, beside its members. Live, with titles as a live run records them, the J request was placed on both siblings in 25 of 25 runs with each strategy (five cases, five runs); with the round-3 questions the spec's wording went to the neighborhoods alone every time. Through the whole backend with live answers (`providers/src/j-request.smoke.test.ts`) J waited for the group and read both members in 4 of 4 runs. Tests: `C19 · J, clear about A and weak about B, builds on the two together: …`, `C9 · …` in `routing/acceptance/referents.test.ts`; live in `providers/src/referents.smoke.test.ts`.
- **Follow-up naming two sections (round 3, major; closed).** Inferred in 10 of 10 live runs with each strategy (two siblings; two separate trees). "Compare the itinerary with the sky explanation" is a join chain again, after the section question was reworded to cover comparing and combining.
- **Corpus scores.** 55 examples. Live decision model with reference decompositions: tree walk 54/55, one pass 53/55; with the live decomposer 53/55. The remaining miss under both is `split-correction-and-new-work`: the new part's handling chain scores below the threshold. One pass also misses `live-referent-beyond-window` by construction. The corpus is still too small to separate threshold values within each plateau.
- **A referent below work the message does not refer to (2026-11-12; open).** The tree walk asks nothing below an unbranched run that is not plausible, and the question that used to look below ("anything built on this?") is removed. A referent that is neither one of the five first-pass sections nor a start candidate, under a root the decision model scores below 0.25, is not reached: two corpus examples live with the configured tree walk (59/62, 61 before), none with the default, which uses one pass inside the window. What recovers it is a candidate source (`CoreDependencies.candidateSource`: retrieval hits as places to start; the port exists, no retrieval does) or an estimator behind `ReferentOperations.estimate`. **Since later that day, mostly closed:** the lexical candidate source, on by default, names the referent when the message shares words with it; live the configured tree walk is back at 61/62. Still open for a reply that names old work in other words: no embedding index is built. [dependency-decisioning.md](dependency-decisioning.md) · "What removing the question costs".
- **Long conversations and long runs.** The pipeline's own request lists the 24 most recent sections. The tree walk reaches older ones: a run of only children (or the old one-answer roots of a flat conversation) that is too long to ask about section by section is searched in chunks of about 12, each named by its requests, and only a relevant chunk is asked about one by one (since 2026-11-12: only the latest relevant chunk, for the last relevant section of the run; sections above one already confirmed are not asked about at all). Live, a section of a 200-section chain and one of 199 unrelated answers are found in three requests (8,000 and 9,700 decision tokens); before, both fell back to one pass and were lost. One pass still does not reach them. Two switches, off by default, also skip short runs: "Start at the trunk base" and "Hop between branch points" (Settings → Routing). Limits: with the default budget a referent is found up to about 1,200 to 2,000 older sections and is out of reach after that (just beyond, the chunks are asked but the relevant one cannot be listed: the message then goes to the best node found so far, and the user is not asked); a section that only its answer text identifies is not found by a chunk question; in conversations of short answers (about 250 tokens) the price guard leaves no room for a search. Details and measurements: `docs/build/dependency-decisioning.md` · "Long runs" and "The price guard".
- **Hop between branch points, redefined (2026-11-12).** `settings.routing.treeWalk.hopBetweenBranchPoints`, off by default. On, the tree walk does not search an unbranched run for the last relevant section: a message that refers to a run, and to nothing built on it, continues from the run's last section, which was not asked about by itself (DA3 reworded). A correction keeps the search. No strategy selector turns it on; it applies as set whenever the tree walk runs. On the corpus it saves 4.2% of the live decision tokens and moves three placements to the end of their runs (`long-chain-old-section` E2 → E198, `deep-run-middle-section` D2 → D5, `deep-run-other-branch` H2 → H4). The corpus has two sets of expectations since 2026-11-12: the default ones, unchanged, and hop-on ones (`CorpusExample.hop`, only these three differ, each derived from the spec's rule), which a routing by the tree walk with the switch on is scored against. Hop-on now scores 62/62 with decisions as labelled and the lexical source (59/62 with none, the three `below` examples, as off) and 61/62 live, as off (the one miss in both is `split-correction-and-new-work`; before, 58/62 counted against the default labels). Routing has no limit on what a run may read, so the last section is always taken; the rule for a limit is implemented and tested only. See [dependency-decisioning.md](dependency-decisioning.md#hop-between-branch-points-redefined).
- **Context summaries for decisioning: interface only.** `settings.routing.useSummaryIfAvailable` and `backgroundSummaries` exist end to end (Settings → Routing), with a port for a summary provider and one for a summariser. The only provider returns a node's real context chain unchanged and the only summariser produces nothing, so neither setting changes anything yet. A run's context is never a summary. Design, the proposed policy for what to summarise and when, and what is open: `docs/build/context-summaries.md`.
- **Decision cost guard.** One routing's decision requests cost at most twice the answer it routes, priced on the cheapest answer model, for answers of 100 tokens and more; asserted on a grid of 360 cells of conversations up to a million tokens (`cost-grid.test.ts`). The pipeline's own request draws from the same budget: under short answers it lists fewer answer sections, the most recent, down to the first-pass sections alone (at most five), and the routing decision says so. Below 100 tokens an answer the smallest request exceeds the bound and routing costs at most twice a 100-token answer ($0.0001): open.
- **Strategy selection ("decision-inception"): by rules by default** (since 2026-11-12; `off` before, and a stored mode is kept). `settings.routing.strategySelection` (`off` | `rules` | `decision-model`; Settings → Routing → "Choosing the strategy") puts a strategy selector in front of the referent strategy: it chooses the strategy and the tree walk's switches for each routing from the shape of the genealogy, counts only. The rules add no request; the decision model's one request (about 800 tokens) is inside the routing's budget, falls back to the rules when it fails, is not confident or does not fit, and is reused from the event log while the shape's signature is the same. The choice and its reason are recorded with the routing decision and shown in the run inspector. Live, 62 examples: rules 61/62 at 1.34 requests a routing (the default tree walk: 60 to 61/62 at 1.61); the decision model 60 to 61/62 at 2.03 without reuse, so it does not beat the rules and is not the default. [dependency-decisioning.md](dependency-decisioning.md) · "Strategy selection".
- **The decision budget is a hard stop (2026-11-12).** When a limit stops a referent strategy, nothing more is asked of the decision model and the user is not asked which section is meant. Where routing would have asked, the message is placed on the best node found so far: of the sections asked about by themselves (and sibling groups asked about as a whole) that score at least 0.25, a descendant before its ancestor, then the higher score, then the more recent. With none plausible it refers to nothing there. Every routing first asks about the five most recent answer sections that no later one of them builds on, so there are candidates. A message whose old referent the budget put out of reach is therefore placed without a question, on a recent section or on its handling chain; the routing decision and the run inspector say so. With budget to spare, an ambiguous target is still put to the user. [dependency-decisioning.md](dependency-decisioning.md) · "The hard stop, the best node found so far, the first pass, and rules by default".
- **Decision token budget.** One setting, `routing.tokenBudget` (Settings → Routing → Decision budget): an absolute number of decision input tokens per routing, or, the default, 2% of the tokens in the conversation's log (every user message and every attempt's text, retired attempts included), at least 16,000 and at most 40,000. It covers every decision request of the routing, and a routing may use the smaller of it and the price guard's allowance. With the default a search finds a referent up to about 1,200 to 2,000 older sections (about 300 to 700 with a fixed 16,000). The request and question caps (4 further requests, 96 questions) stay as backstops. The price guard's prices default to the cheapest answer model's and are settings (`routing.costGuard`), not read from the model catalog. Evidence and what is open: [dependency-decisioning.md](dependency-decisioning.md) · "The token budget".
- **No "none of these" for a single candidate.** The single-candidate target-ambiguity modal has no "Not about an earlier answer" option. The protocol's answer needs at least one section.
- **Routing order.** A message waiting on a routing retry, for example after a 429 under Persistent, holds back routing of every later message in its conversation. The bubble shows the earlier message's routing status, but there is no indicator on the later ones.
- **Undo split while a later message routes.** When an earlier message is re-routed by Undo split while a later one is already being routed, the later one is not routed again.

**Projections and UI**

- **Two names for one piece of work (open since round 1; closed).** The directive's label is now the one name: the projections show answer section titles, chain labels (`chain-created` carries `labelDirectiveId`), pause causes, recovery buttons, redo options and superseded-input notes under the directive's current label, so all change together when `directive-labeled` arrives. `STATE_VERSION` is 3. Routing candidates still carry the stored section title. Test: `names · the generated label replaces the provisional one in the section title, chain label, queue item, status, recovery choice, mini-map and operation graph`.
- **Late-retry rail color (round 3, minor; closed).** Re-verified. The section's rail moving to the base chain's color is correct: the retry runs on the base chain as work continuing from the join-back (01 · "Chain colors", Q78, Q92). The failed attempt keeps the fork. The user message's rail had lost the fork; it now lists every chain one of its runs was handled on, as Focus does. Test: `late retry · rails: the retry is handled on the base chain in its color; the failed attempt, the message and Focus keep the fork it ran on`.
- **Run inspector ancestry order (round 3, minor; closed).** The context builder records a join-back after its members, and the run inspector orders every node after its parents, which also fixes attempts recorded earlier. Test: `run inspector · "Context ancestry, root first" lists every node after the nodes it is a child of`.
- **Two Retry buttons on a routing failure (closed).** Only the request's Retry in the message header remains (10 · Controls). Test: `P7 (routing) · …` now checks that there is exactly one Retry.
- **Motion review.** Motion has not had the `review-animations` pass; the skill cannot be invoked from an agent session. Queue items animate `height`, which is a deliberate exception.
- **Light-theme colors.** Chain 1 is 0.050 OKLab from `--warning`. Faint and muted ink are close together.
- **Chain colors past the eighth** use CSS relative color syntax, which needs a current browser.
- **Bundle size.** The main chunk is 1.9 MB. Nothing besides the gallery is code-split.
- **Plain text or Markdown.** Core's preamble asks for plain text while the transcript renders Markdown. Models mix the two.

**Providers and runtime**

- **`Retry-After` is ignored in the browser.** OpenRouter's CORS headers do not expose it, so a 429 or 503 in the Worker falls back to the policy's backoff.
- **Routing retry count resets on restart.** It is held in memory, so after a restart a message still routing starts again with a fresh count.

**Tests**

- **The e2e flows are live.** They are therefore not deterministic in timing. There is no scripted-provider mode for the Worker (round 3, minor; open).
- **Not exercised in a browser:** clarifications, the target-ambiguity and choice-with-default panels, Undo split and join chains.

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

Every condition has its canonical test, titled with its ID. All 61 pass in the final run. Where reviews added more tests under the same ID, they are listed too. Paths are relative to `packages/`.

| ID | Canonical test file | Further tests under the ID | Result |
|---|---|---|---|
| D1–D4 | `core/src/routing/acceptance/decomposition.test.ts` | `D3 (review)`, `D4 (review)` in `core/src/routing/acceptance/review-2.test.ts` | pass |
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
| E3, E4 | `core/src/recovery/acceptance/elicitation.test.ts` | `E3/E4 (…)` in `core/src/recovery/acceptance/review-2.test.ts` | pass |
| F1–F9 | `core/src/recovery/acceptance/failure.test.ts` | `F2 (engine)` in `named.test.ts`; `F3 (routing)` in `core/src/routing/acceptance/review-2.test.ts`; `F3 (web)` in `web/src/features/transcript/transcript.test.tsx` | pass |

The architecture invariants I1–I10 also pass. They are in `core/src/{engine,routing,recovery}/acceptance/invariants.test.ts`.

## Decisions for "Left to the build" (12 · Build plan)

PLAN §7 has the full reasoning for each.

| Choice | Decision |
|---|---|
| Candidates for the decision model | Every current section; every chain with its settled head and tip; every directive not superseded or cancelled; every sibling group not dissolved. Result-dependency candidates are work still in flight (at most 16) and open groups. Trimmed to the 24 most recent sections if over the per-question limit |
| Trivial messages skip the decision call? | No. The first message of an empty conversation asks only the gate and clarification questions |
| Do decision and decomposition calls count against concurrency? "Per provider"? | Only answer, clarification-question and synthesis runs take a slot. Routing, label calls and join-backs take none. One pool, keyed `openrouter`. A conversation's messages are routed in submission order (C2) |
| Backoff | Standard: 3 retries at 1 s, 2 s, 4 s, accepting `Retry-After` up to 60 s. Persistent: 8 retries up to 30 s apart, accepting `Retry-After` up to 10 min. No jitter. Routing failures (408, 429, 502, 503, an empty 200, a dropped connection) retry under the same setting |
| Pinned decision model, tuned thresholds | `typesafe/jev-1.13`. Thresholds were swept on the 44-example corpus: `targetChoice` 0.7, `clearlyCorrective` 0.8, `composite` 0.65, `dependency` 0.6, `clarification` 0.75, ambiguity floor 0.25. Each is on its best plateau, 42/44 |
| Context warning | At 80 % of the model's limit, shown as a note on the section. A run fails before it starts only when the token count is exact. When the count is an estimate, a run over the limit warns and runs |
| Chunk size for stored output | First text at once. After that, 96 characters or 80 ms, whichever comes first. Always flushed before the terminal event |
| Embedded secrets store | A separate IndexedDB database, `committee-secrets`, opened only in the Worker |
| Wording for the concurrency hold | "Waiting for a free slot". It is shown only after the scheduler records `directive-slot-held`, which happens when the limit actually holds ready work. Until then the status reads "Responding…" |
| Stage that assigns fragments their chain and target | Atomic message: the gate. Composite: one further batched decision call after decomposition, with one question set per fragment |
| Superseded-input detection | Three kinds of replaced input: a replaced result, an unread correction to a brief the run read, and a replaced session-wide requirement. Each is detected by comparing the run's recorded context with current state. There is no estimate of whether the result would change |

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

- **J request on one sibling (round 3, blocker; open).** Placing the spec's J request ("an itinerary from the neighborhoods and the activities") depends on Jev scoring both siblings. When the second referent scores below the 0.25 ambiguity floor, or "refers to several" is answered no, J is placed on one sibling and reads only that one.
  - The round-3 coverage rule (`referentCovered`) admits a second sibling only when it is above the floor and the several-sections answer is yes.
  - The corpus has no example with live-style titles for this case.
  - A fix needs routing work and a corpus run, not a small change.
- **Follow-up naming two sections (round 3, major; open).** It is not inferred as multi-target and raises the target-ambiguity modal instead. Same cause and same remedy as the J request.
- **Corpus scores.** 42/44 with reference decompositions and 39/44 with the live decomposer. The corpus is too small to separate threshold values within each plateau. The round-3 C19 change was not re-run against the live corpus beyond `pnpm smoke`'s floor, which passes.
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

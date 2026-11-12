# Decision index: Q1–Q98

> **Archived.** Historical record, kept read-only and no longer maintained. The current specification is [docs/spec/](../spec/README.md); see the [archive README](README.md) for how to read this file.

One row per question. “Outcome” is a one-line summary; the linked record holds the full entry and, where preserved, the user's own words. “Later change” follows the user's standing rule that a later answer supersedes an earlier one on clear conflict: **superseded** means a later question replaced part or all of the outcome, **refined** means a later question added detail without contradicting it.

Record links: [EIR](decisions/early-interview-record.md) early interview record · [S1](decisions/scenarios/01-independent-requests.md)–[S6](decisions/scenarios/06-failure-cancellation-recovery.md) scenarios · [EL](decisions/elicitation.md) elicitation methods · [TD](decisions/technical-design.md) technical design · [MVP](decisions/mvp-decisions.md) MVP decisions · [RB](decisions/review-batch-q78-q88.md) review batch Q78–Q88.

## Early interview (Q1–Q10)

| Q | Outcome | Later change | Record |
|---|---|---|---|
| Q1 | Initial scope is text and read-only work; no concurrent edits, sends or other external mutations. | None | [EIR](decisions/early-interview-record.md#q1--initial-scope-conversation-or-shared-resource-actions) |
| Q2 | A dependency means needing an unavailable result; topic overlap alone is not one. | None | [EIR](decisions/early-interview-record.md#q2--what-constitutes-a-dependency) |
| Q3 | Preserve the original message; chains see its fragments; join trees only when truly necessary. | Refined by Q4, Q53 | [EIR](decisions/early-interview-record.md#q3--preserve-a-composite-message-as-a-parent) |
| Q4 | Decomposition identifies shared requirements; err toward one atomic request for tightly linked topics. | Refined by Q17, Q25 | [EIR](decisions/early-interview-record.md#q4--do-fragments-inherit-shared-requirements) |
| Q5 | A join creates a new join chain, with its own color, attached to both source leaves; sources stay continuable. | **Superseded in part** by Q88 (two or more sources, not two); refined by Q76, Q78, Q86 | [EIR](decisions/early-interview-record.md#q5--does-a-join-create-a-new-chain) |
| Q6 | Revision is a distinct routing outcome that supersedes affected work. | Refined by Q35–Q43 | [EIR](decisions/early-interview-record.md#q6--are-corrections-a-distinct-routing-outcome) |
| Q7 | Display in request order, separate from a topological processing queue; status badge on the user message and an up-arrow to pending work. | **Superseded**: request-ordered answer slots by Q12–Q14 (ADR-0003); badge and up-arrow by Q81. The display/operation-queue distinction stands. | [EIR](decisions/early-interview-record.md#q7--display-order-versus-processing-order) |
| Q8 | Join-back records completed parallel results in request order without a synthesis call; mini-map shows a dotted oval. | Refined by Q28–Q33 | [EIR](decisions/early-interview-record.md#q8--bookkeeping-join-back-versus-model-synthesis) |
| Q9 | Composite answers stream as independent sections. | Refined by Q18, Q19, Q23, Q25, Q26 | [EIR](decisions/early-interview-record.md#q9--independently-streaming-composite-sections) |
| Q10 | A lightweight reply affordance on each assistant message; elicit only when an untargeted reply is genuinely ambiguous. | **Superseded in part** by Q20 (targets are per answer section, with Jev inference) | [EIR](decisions/early-interview-record.md#q10--explicit-reply-targeting-and-ambiguity) |

## Scenario 1: independent requests (Q11–Q16)

| Q | Outcome | Later change | Record |
|---|---|---|---|
| Q11 | An unrelated request receives its required inputs plus explicitly shared instructions and preferences, never another request's topic history. Wording recovered from the user on 2026-11-10. | Refined by Q17 (how a requirement becomes session-wide) and Q76 (unrelated work starts a new chain) | [RB2](decisions/review-batch-q89-q98.md#q11--recovered-wording) |
| Q12 | Drop fixed request-ordered answer slots; a pending “responding” bubble is pushed down when an independent reply finishes first. | None (it supersedes Q7's order) | [EIR](decisions/early-interview-record.md#supplemental-q12--why-the-original-q7-answer-order-changed), [ADR-0003](adr/0003-allow-replies-to-overtake-pending-work.md) |
| Q13 | User messages always keep submission order. | None | [S1](decisions/scenarios/01-independent-requests.md) (summary only; question wording not preserved), [EIR](decisions/early-interview-record.md#supplemental-q12--why-the-original-q7-answer-order-changed) |
| Q14 | A reply's position is fixed at its first visible answer output, not at completion; status text is not output. | Refined by Q51, Q83 | [S1](decisions/scenarios/01-independent-requests.md) (summary only; question wording not preserved), [ADR-0003](adr/0003-allow-replies-to-overtake-pending-work.md) |
| Q15 | Follow output at the live bottom; otherwise keep the reading position and show “New output ↓”. | None | [S1](decisions/scenarios/01-independent-requests.md#scroll-and-queue-presentation) (summary only; question wording not preserved) |
| Q16 | A submitted dependent message appears at once; a linked queue item above the composer names what it waits for and clears when processing starts. | None | [S1](decisions/scenarios/01-independent-requests.md#confirmed-queue-representation) |

## Scenario 2: composite requests (Q17–Q27)

| Q | Outcome | Later change | Record |
|---|---|---|---|
| Q17 | Requirements are local unless the user explicitly signals session-wide scope. | Refined by Q70 (session-wide means within one conversation) | [S2](decisions/scenarios/02-composite-requests.md#q17-requirement-scope) |
| Q18 | One reply group per original message; sections placed at their own first output within it; explicit ordering wins. | Exception added by Q23 | [S2](decisions/scenarios/02-composite-requests.md#q18-normal-composite-reply-placement) |
| Q19 | Ready fragments proceed and only blocked ones queue, unless an output-order qualifier queues the whole request. | Refined by Q25 | [S2](decisions/scenarios/02-composite-requests.md#q19-ready-versus-dependency-blocked-fragments) |
| Q20 | Each answer section has its own reply target; Jev may infer one or several targets; genuine ambiguity is elicited. | Refined by Q43, Q74 | [S2](decisions/scenarios/02-composite-requests.md#q20-reply-targets) |
| Q21 | A fragment's failure fails the overall request. | **Superseded** by Q24 and Q27 (failure is local to the directive) | [S2](decisions/scenarios/02-composite-requests.md#q21-failure) |
| Q22 | Stop a section or a whole request; keep visible text as stopped; cancel queued work in scope only. | Refined by Q48, Q50 | [S2](decisions/scenarios/02-composite-requests.md#q22-stop-controls) |
| Q23 | Clarification goes in additional responses; the clarified answer is a later response, not inserted into the original group. | Refined by Q26 | [S2](decisions/scenarios/02-composite-requests.md#q23-clarification-continuations) |
| Q24 | A failed directive does not stop its unfinished siblings; only that directive is marked failed. | Clarified by Q27 | [EIR](decisions/early-interview-record.md#q24--what-happens-to-siblings-when-a-directive-fails) |
| Q25 | Constraints relating outputs (order, combined limits, integrated presentation) make the whole request wait; distributable ones do not. | None | [S2](decisions/scenarios/02-composite-requests.md#q19-ready-versus-dependency-blocked-fragments) |
| Q26 | Clarification questions can appear immediately even while a whole-request constraint keeps answer work queued. | None | [S2](decisions/scenarios/02-composite-requests.md#q23-clarification-continuations) |
| Q27 | Failure is local to the affected directive; no overall failed status. | None | [S2](decisions/scenarios/02-composite-requests.md#q21-failure), [EIR](decisions/early-interview-record.md#q24--what-happens-to-siblings-when-a-directive-fails) |

## Scenario 3: forks and join-back (Q28–Q32)

| Q | Outcome | Later change | Record |
|---|---|---|---|
| Q28 | Completed parallel exchanges join back automatically in submission order, with no synthesis call or extra message. | Refined by Q49 | [S3](decisions/scenarios/03-related-parallel-work.md#q28-automatic-join-back) |
| Q29 | A continuation may start with whatever completed context exists; a sibling finishing later is not injected into it. | None | [S3](decisions/scenarios/03-related-parallel-work.md#q29-continuation-while-a-sibling-runs) |
| Q30 | Siblings stay independently continuable; work needing more than one sibling depends on the full join-back, never a subset. | None | [S3](decisions/scenarios/03-related-parallel-work.md#q30-independent-sibling-branches-and-full-join-back) |
| Q31 | No routine fork/join messages in chat; rails, Focus and inspectors show relationships and what each run consumed. | Refined by Q87 (which inspectors are behind debug toggles) | [S3](decisions/scenarios/03-related-parallel-work.md#ux--q31) |
| Q32 | A sibling group is the forks from one starting context; it admits new forks while open and closes when all finish. | None | [S3](decisions/scenarios/03-related-parallel-work.md#q32-sibling-group-membership-and-closure) |

## Scenario 4: result-dependent work (Q33–Q34)

| Q | Outcome | Later change | Record |
|---|---|---|---|
| Q33 | Dependents wait for successful completion, not streaming text; a full join-back waits for its group to close and finish. | Refined by Q48, Q49 | [S4](decisions/scenarios/04-result-dependent-work.md#q33-result-readiness) |
| Q34 | Dependent work may reconcile sources within established requirements, asking only for consequential gaps or conflicts. | None | [S4](decisions/scenarios/04-result-dependent-work.md#q34-reconciliation-within-established-requirements) |

## Scenario 5: revisions (Q35–Q46)

| Q | Outcome | Later change | Record |
|---|---|---|---|
| Q35 | A clear revision stops a running target and starts a replacement, or follows a finished one with a replacement; other work is untouched. | None | [S5](decisions/scenarios/05-revisions-targeting-ambiguity.md#q35-applying-a-clear-revision) |
| Q36 | Revisions propagate along actual dependencies: queued work retargets, running work restarts, completed work stays. | None | [S5](decisions/scenarios/05-revisions-targeting-ambiguity.md#q36-propagating-the-revision-along-actual-dependencies) |
| Q37 | A reply is a revision only when its wording corrects or replaces; otherwise it is additional work. | Refined by Q74 (threshold), Q79 (not a command) | [S5](decisions/scenarios/05-revisions-targeting-ambiguity.md#q37-classifying-a-revision) |
| Q38 | Status-only bubbles vanish on supersession; visible text stays, marked superseded; the replacement is a new response with rewound context. | Contrasted by Q83 (retries stay in the same bubble) | [S5](decisions/scenarios/05-revisions-targeting-ambiguity.md#q38-superseded-attempts-in-the-transcript-and-in-the-replacements-context) |
| Q39 | Later context uses the correction plus the replacement in place of the superseded body; historical runs keep what they saw. | None | [S5](decisions/scenarios/05-revisions-targeting-ambiguity.md#q39-context-for-dependent-work) |
| Q40 | Completed work built on a superseded result gets a quiet note and a manual Regenerate; no auto-regeneration. | **Superseded in part** by Q79 (Regenerate also cancels ongoing work first) | [S5](decisions/scenarios/05-revisions-targeting-ambiguity.md#q40-completed-dependents-built-on-a-superseded-result) |
| Q41 | Revising queued work edits it in place; nothing is stopped or marked superseded. | None | [S5](decisions/scenarios/05-revisions-targeting-ambiguity.md#q41-revising-work-that-has-not-started) |
| Q42 | A shared-requirement revision elicits which affected work to redo, with a default that runs if unanswered. | Refined by Q44–Q46, Q84 | [S5](decisions/scenarios/05-revisions-targeting-ambiguity.md#q42-revising-a-shared-requirement) |
| Q43 | A reply to a superseded section targets its replacement and says so. | None | [S5](decisions/scenarios/05-revisions-targeting-ambiguity.md#q43-replying-to-a-superseded-section) |
| Q44 | The default preselects work judged actually affected; queued affected work always updates; unselected finished work keeps its result. | Refined by Q84 | [EL](decisions/elicitation.md#q44-the-default) |
| Q45 | The default runs on the next unanswered message or after a wait (setting, 30 s); affected running work stops at once. | Refined by Q84 | [EL](decisions/elicitation.md#q45-no-response-and-waiting) |
| Q46 | Defaults only for reasonable, reversible choices; target ambiguity, clarification and recovery never default. | None | [EL](decisions/elicitation.md#q46-where-defaults-are-allowed) |

## Scenario 6: failure and recovery (Q47–Q54)

| Q | Outcome | Later change | Record |
|---|---|---|---|
| Q47 | Retry policy is a setting: Standard (default, 3 automatic retries), Persistent, or Manual; each retry is a new attempt with rewound context. | Refined by Q75, Q83 | [S6](decisions/scenarios/06-failure-cancellation-recovery.md#q47-retry-policy) |
| Q48 | A dependent of a failed or stopped prerequisite pauses with Retry, Continue without, or Cancel, and no default. | None | [S6](decisions/scenarios/06-failure-cancellation-recovery.md#q48-dependents-of-a-failed-or-stopped-prerequisite) |
| Q49 | A failed or stopped member closes its group; the join-back records a marker, replaced by a later successful retry. | Extended to interrupted members and **superseded in part** by Q92 (a retry after closure descends from the join-back) | [S6](decisions/scenarios/06-failure-cancellation-recovery.md#q49-join-back-with-a-failed-or-stopped-member) |
| Q50 | No overall status for mixed results; per-section states and a count; retrying reruns only unfinished sections. | None | [S6](decisions/scenarios/06-failure-cancellation-recovery.md#q50-mixed-result-requests) |
| Q51 | A failure before any output counts as output for placement; its retry fills the same bubble. | None | [S6](decisions/scenarios/06-failure-cancellation-recovery.md#q51-failure-before-any-answer-output) |
| Q52 | No server is assumed; lost attempts are marked interrupted, distinct from failed and stopped, with the same retry choices. | None | [S6](decisions/scenarios/06-failure-cancellation-recovery.md#q52-interrupted-attempts) |
| Q53 | A sequential composite is shown as split user messages in topological order, linked to the original, with Undo split. | Refined by Q85 | [S2](decisions/scenarios/02-composite-requests.md#sequential-decomposition-shown-user-side-added-with-q48) |
| Q54 | Interrupted attempts follow the retry setting; queued work stays queued. | None | [S6](decisions/scenarios/06-failure-cancellation-recovery.md#q54-retrying-interrupted-attempts) |

## Technical design (Q55–Q77)

| Q | Outcome | Later change | Record |
|---|---|---|---|
| Q55 | One TypeScript backend runs embedded in the client or on a server (ADR-0005). | None | [TD](decisions/technical-design.md#q55-portable-backend-adr-0005) |
| Q56 | Client is a TypeScript web app on Vite and Tailwind. | None | [TD](decisions/technical-design.md#q56-client-stack) |
| Q57 | The backend builds every run's context itself; models are called through OpenRouter (ADR-0005). | None | [TD](decisions/technical-design.md#q57-context-ownership-and-provider-adr-0005) |
| Q58 | Append-only domain event log with cached projections behind storage adapters (ADR-0006). | None | [TD](decisions/technical-design.md#q58-event-log-and-projections-adr-0006) |
| Q59 | Routing pipeline: Jev gate, decomposition only for composites, deterministic validation, scheduling. | Refined by Q68 (Jev via OpenRouter Decisions) | [TD](decisions/technical-design.md#q59-routing-pipeline) |
| Q60 | Per-provider concurrency limit (setting, default 4); ready work in submission order; dependents release on success. | None | [TD](decisions/technical-design.md#q60-scheduling-policy) |
| Q61 | Every acceptance condition becomes a deterministic test on a scripted fake provider; a labelled corpus evaluates routing. | None | [TD](decisions/technical-design.md#q61-test-strategy) |
| Q62 | Client sends commands and receives an ordered event stream; embedded backend in a Web Worker. | **Superseded in part** by Q79 (command list corrected; “revise” removed) | [TD](decisions/technical-design.md#q62-shared-interface) |
| Q63 | Build the embedded backend first, with IndexedDB and in-memory adapters. | None | [TD](decisions/technical-design.md#q63-storage-adapters-and-build-order) |
| Q64 | Embedded keys stored locally apart from the event log; server keys never reach the client. | **Superseded in part** by Q68 (no separate Jev key) | [TD](decisions/technical-design.md#q64-keys) |
| Q65 | Per-role model choice (answer, decomposition, synthesis for join chains, pinned decision model). | Refined by Q78 (continuing from a join-back is an answer run) | [TD](decisions/technical-design.md#q65-model-settings) |
| Q66 | pnpm workspace: `core`, `providers`, `storage`, `protocol`, `web`, later `server`. | None | [TD](decisions/technical-design.md#q66-repo-layout) |
| Q67 | Compaction out of scope; interim: count tokens, warn near the limit, fail non-retryably rather than truncate. | Confirmed by Q82 | [TD](decisions/technical-design.md#q67-context-growth) |
| Q68 | Routing questions go to OpenRouter's Decisions API (Jev models); one OpenRouter key covers everything. | None | [TD](decisions/technical-design.md#q68-routing-through-openrouter-decisions) |
| Q69 | One event log per conversation; ULIDs, sequence numbers, stable entity IDs, versioned events upcast on read. | None | [TD](decisions/technical-design.md#q69-event-identity-and-versioning) |
| Q70 | Multiple conversations, one log each; nothing crosses conversations; retry policy, models and keys are app-wide. | None | [TD](decisions/technical-design.md#q70-multiple-conversations) |
| Q71 | Five milestones from `core` with fake provider to revisions, recovery and inspectors; injected providers sit outside core. | None | [TD](decisions/technical-design.md#q71-milestone-order-and-core-boundary) |
| Q72 | The Web Worker calls OpenRouter directly, no CORS proxy. | None | [TD](decisions/technical-design.md#q72-browser-access) |
| Q73 | MVP: the user pastes an OpenRouter key into settings; OAuth PKCE deferred. | None | [MVP](decisions/mvp-decisions.md#q73-openrouter-key-entry) |
| Q74 | Pin a versioned decision model; below thresholds, elicit the target or treat a reply as additional work. | None | [TD](decisions/technical-design.md#q74-decision-thresholds) |
| Q75 | OpenRouter errors mapped to transient or non-retryable treatment under Q47. | None | [TD](decisions/technical-design.md#q75-openrouter-error-mapping) |
| Q76 | Context assembled mechanically from genealogy; placement is new chain, continue a chain, or new join chain of two leaf-node cousins or separate trees. | **Superseded in part** by Q88 (two or more sources); refined by Q78, Q86 | [TD](decisions/technical-design.md#q76-context-selection) |
| Q77 | No decision-provider fallback; keep a `DecisionProvider` interface. | None | [TD](decisions/technical-design.md#q77-decision-provider-fallback) |

## Review batch (Q78–Q88)

| Q | Outcome | Later change | Record |
|---|---|---|---|
| Q78 | Work continuing from a full join-back (scenario 4's J) is the same chain continuing, not a join chain. | None | [RB](decisions/review-batch-q78-q88.md#q78--what-chain-is-the-itinerary-j-i2) |
| Q79 | Revision is a routing outcome, not a command; Regenerate cancels ongoing work then redoes it; Continue without, Cancel and conversation commands added. | None | [RB](decisions/review-batch-q78-q88.md#q79--the-command-list-i6) |
| Q80 | A directive is the unit of work that produces one answer section. | None | [RB](decisions/review-batch-q78-q88.md#q80--directive-i7) |
| Q81 | Pending status lives on the responding bubble; no badge on the user message; up-arrow dropped. | None | [RB](decisions/review-batch-q78-q88.md#q81--pending-work-navigation-i1) |
| Q82 | Q67's interim context-limit rule confirmed. | None | [RB](decisions/review-batch-q78-q88.md#q82--context-limit-i3) |
| Q83 | A retry after partial output streams in the same bubble beneath the collapsed failed text. | None | [RB](decisions/review-batch-q78-q88.md#q83--retry-after-partial-output-i4) |
| Q84 | Running work stopped for a default-choice wait cannot be deselected and is always redone (recommendation rejected). | None | [RB](decisions/review-batch-q78-q88.md#q84--stopped-for-a-default-choice-wait-then-deselected-i5) |
| Q85 | Undo split is offered until a split message shows answer text or gets a reply; it stops running attempts and restarts one atomic request. | None | [RB](decisions/review-batch-q78-q88.md#q85--undo-split-after-work-has-started-i8) |
| Q86 | A join chain's parents are always leaves of their chains (recommendation of any node rejected). | Count settled by Q88 | [RB](decisions/review-batch-q78-q88.md#q86--join-chain-sources-i9) |
| Q87 | Run inspector proposal accepted (seven items); rails, Focus and split link always on; mini-map, operation graph and run inspector behind debug toggles. | None | [RB](decisions/review-batch-q78-q88.md#q87--inspectors-i10) |
| Q88 | A join chain may have two or more parents, each a leaf. | None | [RB](decisions/review-batch-q78-q88.md#q88--how-many-sources-may-a-join-chain-have) |

## Second review batch (Q89–Q98)

Record: [RB2](decisions/review-batch-q89-q98.md). All ten were answered, in two rounds; the second round is at the end of the record and takes priority.

| # | Outcome | Later change | Record |
|---|---|---|---|
| Q89 | Every fork, and any later branch from one sibling, has its own chain color; the join-back and work continuing from it keep the color of the chain the siblings forked from (recommendation rejected in part). | None | [RB2](decisions/review-batch-q89-q98.md#q89--chain-identity-of-forks-and-branches) |
| Q90 | Work continuing from a join-back uses the answer model; the join-back just appends the siblings' exchanges to their common history. | Narrows Q65's "synthesis/join chains" role to join chains | [RB2](decisions/review-batch-q89-q98.md#q90--model-for-work-continuing-from-a-join-back-1) |
| Q91 | Cancelled is a state of its own: work cancelled before it started is recorded as cancelled (first-round reading of "treated as stopped" superseded). | None | [RB2](decisions/review-batch-q89-q98.md#q91--confirmed-reading) |
| Q92 | A sibling group closes once every member has completed, or has failed, been stopped, or been interrupted and is not retrying. After closure, a retry of any such member runs as a descendant of the join-back. | **Supersedes in part** Q49 (a retry no longer takes the member's place in the join-back) | [RB2](decisions/review-batch-q89-q98.md#q92--confirmed-reading) |
| Q93 | Nothing extra: a composite's answer is one reply with its sections, so a pending section is found there. | None | [RB2](decisions/review-batch-q89-q98.md#q93--reaching-a-pending-section-without-debug-views) |
| Q94 | Compare is surfaced to the user for sequential composites (the split link) and sits behind a debug toggle for independent composites (recommendation rejected). | Refines Q87 | [RB2](decisions/review-batch-q89-q98.md#q94--compare-for-composites-that-were-not-split) |
| Q95 | Target-ambiguity and choice-with-default elicitations are a modal above the composer. What happened is noted at the bottom of the redone work if it was in flight; if it had finished, the redo is a new response. | None | [RB2](decisions/review-batch-q89-q98.md#q95--confirmed-reading) |
| Q96 | A retry after a user-stopped section behaves as Q83; the context of everything depending on the retried work is updated, even at the cost of prompt caching. | None | [RB2](decisions/review-batch-q89-q98.md#q96--retrying-a-stopped-section) |
| Q97 | Work needing an earlier node plus another line joins at the current leaves, whose ancestry already includes that node. | None | [RB2](decisions/review-batch-q89-q98.md#q97--work-needing-a-non-leaf-node-together-with-another-line) |
| Q98 | A clarification question has a reply affordance; a targeted reply is the answer, and an untargeted next message may be recognized as the answer by target inference. | None | [RB2](decisions/review-batch-q89-q98.md#q98--recognizing-an-answer-to-a-clarification-question) |

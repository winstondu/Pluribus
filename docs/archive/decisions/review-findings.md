> **Archived.** Historical record, kept read-only and no longer maintained. The current specification is [docs/spec/](../../spec/README.md); see the [archive README](../README.md) for how to read this file.

# Open issues

Found in the review of 2026-11-10 (after Q77). Nothing here reopens a settled decision; each item is a contradiction between documents, a gap the accepted decisions do not cover, or a statement that was never confirmed. Recommendations are proposals until the user accepts them.

Purely stale text (status lines, "deferred to a later scenario" notes whose scenario has since settled) was corrected in place and is listed at the end.

## Status

All eleven issues are resolved: I1–I10 by Q78–Q87 ([review batch record](review-batch-q78-q88.md)) and I11 by the [early interview record](early-interview-record.md). The one point those answers left unaddressed was settled by Q88. The original findings are kept as the reason each question was asked.

## Settled afterwards

- **More than two sources for a join chain (Q88):** two or more, each a leaf. Supersedes the “two” in Q5 and Q76.

## Resolved findings

### I1: Pending-work navigation was never reconciled — resolved by Q81

**Resolved (Q81):** Pending status is on the responding bubble; no badge on the user message and no up-arrow. See the [review batch record](review-batch-q78-q88.md).

Original finding:

The original design put a changing status badge on each user message and an up-arrow to earlier pending work. ADR-0003 replaced fixed answer slots with responding bubbles, and [scenario 1](scenarios/01-independent-requests.md) says the badge and up-arrow "must be reconciled with this new layout". No later question did so. The Chat prototype still shows the old pattern.

Decide: where pending status lives (user message, responding bubble, or both) and whether any jump-to-pending affordance remains.

Early record: the badge and up-arrow come from Q7, whose answer-order rule Q12 replaced. The record notes that the earlier concept "must not silently override later accepted UX", so this stays open.

### I2: What chain is scenario 4's J? — resolved by Q78

**Resolved (Q78):** J is the same chain continuing; the join-back resumes the chain A and B forked from. See the [review batch record](review-batch-q78-q88.md).

Original finding:

J (the itinerary) needs sibling results A and B, so it depends on the full join-back (Q30). Two readings exist:

- Q76 lists "continue an existing chain, including continuing from a join-back" separately from "new join chain", and limits join chains to leaf-node cousins or separate trees. Siblings are not cousins, so J is an ordinary continuation.
- Scenario 4 is titled "result-dependent work and join chains", the selected association view and the prototypes color J as its own chain, and Q65 has a separate model role for "synthesis/join chains".

Decide: when work continues from a full join-back, is it the same chain continuing or a new chain with its own identity and color? And which model role (answer or synthesis) does it use?

Early record: Q5 defines a join chain as a new-colored child of the leaf nodes of "the two original chains"; Q8 says a join-back makes future context look "as if the model answered the first message and then the second". Both fit the first reading, but neither addresses J directly.

### I3: Q67's interim context-limit behavior is unconfirmed — resolved by Q82

**Resolved (Q82):** The interim rule is confirmed. See the [review batch record](review-batch-q78-q88.md).

Original finding:

[Technical design](technical-design.md) Q67 marks its interim rule (count tokens, warn near the limit, fail the directive as non-retryable rather than truncate) as "proposed, not separately confirmed". Q75 already relies on it for `context_length_exceeded`, and the index said there were no open MVP questions.

Decide: confirm the interim rule, or replace it.

### I4: Where a retry's output appears after partial text was visible — resolved by Q83

**Resolved (Q83):** The retry streams in the same bubble beneath the collapsed, failed partial text. See the [review batch record](review-batch-q78-q88.md).

Original finding:

Q51 covers failure before any output: the retry fills the same bubble. Q38 makes a revision's replacement a new response at its own first output. Q47 says failed partial text stays visible, marked failed, and each retry is a new attempt. It does not say where the retry's answer goes when partial text is already showing, including for automatic retries that show only "Retrying…".

Decide: same bubble below or replacing the failed partial, or a new response as in Q38.

### I5: Running work stopped during a default wait, then deselected — resolved by Q84

**Resolved (Q84):** Recommendation rejected: running work stopped for the wait cannot be deselected and is always redone. See the [review batch record](review-batch-q78-q88.md).

Original finding:

Q45 stops affected running work as soon as a shared-requirement revision is elicited. Q44 says unselected *finished* work keeps its result with the superseded-input note. If the user deselects work that was running and has already been stopped, nothing says what it becomes.

Decide: it stays stopped with a Retry action, restarts under the old requirement, or cannot be deselected.

### I6: The command list in Q62 does not match the accepted behavior — resolved by Q79

**Resolved (Q79):** Revision is a routing outcome, not a command. Regenerate, Continue without, Cancel, and conversation commands are added; Regenerate cancels ongoing work first. See the [review batch record](review-batch-q78-q88.md).

Original finding:

Q62 lists the commands "submit, stop, retry, revise, answer elicitation, undo split, change settings".

- **Revise** as a command conflicts with Q37, where a revision is recognized only from corrective wording in a submitted message. Either there is an explicit Revise action in the UI (not specified anywhere), or revision is an outcome of routing and not a command.
- Missing but required by accepted behavior: Regenerate (Q40), the paused-dependent choices Continue without and Cancel (Q48), and creating, listing, or deleting conversations (Q70).

Decide: whether Revise is a user action. The missing commands can then be added as a correction.

### I7: "Directive" is used but never defined — resolved by Q80

**Resolved (Q80):** A directive is the unit of work that produces one answer section. See the [review batch record](review-batch-q78-q88.md).

Original finding:

Q27 and scenario 6 make failure "local to the affected directive", and the term appears in the index, scenarios 2 and 6, and the technical design. It is not in the glossary, and "fragment", "answer section", and "request" are used alongside it.

Proposed definition: the unit of work that produces one answer section, either an atomic request or one fragment of a composite. Confirm or correct before it goes in the glossary.

Early record: the word is the user's own, from Q24 ("Just indicate the failure of one directive"), where it is used for one fragment of a composite alongside its siblings. That is consistent with the proposed definition.

### I8: Undo split after work has started — resolved by Q85

**Resolved (Q85):** Undo split is offered until a split message shows answer text or gets a reply; it stops running attempts and restarts one atomic request. See the [review batch record](review-batch-q78-q88.md).

Original finding:

Q53 says Undo split "restores one atomic request". Split messages are independent targets that may already be running, finished, or replied to.

Decide: until when Undo split is offered, and what happens to attempts already produced by the split messages.

### I9: Which nodes a join chain may draw on — resolved by Q86

**Resolved (Q86):** Recommendation rejected: a join chain's parents are always leaves. More than two sources: allowed (Q88). See the [review batch record](review-batch-q78-q88.md).

Original finding:

Q76 describes a join chain as "merging two leaf-node cousins within one tree, or merging previously separate trees". ADR-0002 and the glossary say it attaches to "specific source nodes".

Decide: may a join chain draw on an earlier, non-leaf node (for example through an explicit reply target), and on more than two sources?

Early record: Q5's answer says "attached to both previous leaf nodes on the two original chains", which matches Q76's wording. It was describing the two-chain example, not ruling on other cases.

### I10: Inspector content is not specified in the project docs — resolved by Q87

**Resolved (Q87):** The run inspector proposal is accepted; rails, Focus, and the split link are always available, other inspectors behind debug toggles. See the [review batch record](review-batch-q78-q88.md).

Original finding:

Scenarios promise that "inspecting an answer shows what its run actually consumed" (Q31) and name the context inspector, the Compare inspector, the genealogy map, and the operation graph. Their content is defined only by the prototypes and by a seven-item "run inspector proposal" in the external discussion record, which was never accepted. Separately, the original framing was "debug toggles", but Q53 opens the Compare inspector from an ordinary transcript link.

Decide: accept the run inspector proposal (or amend it), and whether inspectors are always available or behind a debug setting.

Early record: the user requested these as debug views (chain mini-map with IDs, chain association in chat, rewritten-fragment inspection, operation topology). Their content beyond that is still unspecified.

### I11: Question numbers with no record — resolved

Recovered from the original design chat on November 10, 2026: [Q1–Q10 and Q24 with context](early-interview-record.md), plus Q12's ordering correction. Q24 was not withdrawn: it rejects stopping unfinished siblings and indicates failure on the affected directive. Q27 explicitly replaces Q21's overall failure with directive-local failure. No new user decision is needed for this record gap.


## To settle during the build, no user-visible promise at stake

These are recorded in [build scope, now part of the specification](../../spec/README.md).

- Which sections, chains, and nodes are supplied to the decision model as candidates (Q20 deferred this; Q76 does not cover it).
- Whether trivial messages skip the decision call (Q59 defers this to latency measurements).
- Whether decision and decomposition calls count against the concurrency limit (Q60).
- Concrete numbers for the Persistent retry policy and for Standard's backoff (Q47).
- Which decision model version is pinned (Q74), and the thresholds tuned on the corpus.
- Where the embedded secrets store lives (Q64).

## Stale text corrected in this review

| Document | Was | Now |
|---|---|---|
| Design index | One paragraph narrating Q27–Q77; "reconcile status-badge details during scenario 1"; "no open MVP questions" | Status table; constraints and selected UX moved to the [specification](../../spec/README.md); open issues linked |
| Scenario 1 | Status said cross-cutting policies "are being specified with scenario 2"; "Deferred" listed topics as future | Status and pointers updated to the scenarios that settled them; badge and up-arrow note points to I1 |
| Scenario 2 | "Recovery details and later scenarios remain open"; Q21, Q22, and the batch status deferred retries and cancellation labels to "the recovery scenario"; "No implementation stack selected" | Points to Q47–Q50 and the technical design; Q24 gap points to I11 |
| Scenario 3 | "Unresolved and deferred" listed scenarios 4 and 6 as future | Replaced with pointers to Q33, Q48, Q49 |
| Scenario 4 | Failure and stopped-result handling "remain recovery-scenario decisions"; "Deferred" list | Pointers to Q36, Q47–Q49, Q60 |
| Scenario 6 | Q48 ended with an unexplained "see also" to scenario 2 | States why: Q48's discussion introduced sequential decomposition, settled as Q53 |
| Elicitation methods | Table omitted the paused-dependent choice (Q48) and the confidence threshold (Q74) | Added as a fourth kind and a source note |
| Technical design | Decisions in question order; Jev direct-API facts read as current constraints | Grouped by area, text unchanged; facts marked as background since Q68 |
| Glossary | Flat list; several terms used across scenarios were missing | Grouped; added requirement scope, split message, queue item, elicitation, superseded-input note, waiting for capacity, retry, recovery choice |

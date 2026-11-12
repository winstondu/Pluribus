> **Archived.** Historical record, kept read-only and no longer maintained. The current specification is [docs/spec/](../../spec/README.md); see the [archive README](../README.md) for how to read this file.

# Review batch record: Q78–Q88

Asked and answered on November 10, 2026, after the post-Q77 review. Each question closes one item from [open issues](review-findings.md). Each entry gives the question, the recommendation put to the user, the user's answer verbatim, and the resulting decision. Where the answer was shorter than the recommendation, the entry says what was taken as accepted and what was not addressed. The user later confirmed every such reading (Q79, Q81, Q84, Q85, Q87); each entry carries a **Confirmed** line.

The decisions are applied in the scenario documents, [elicitation methods](elicitation.md), the [technical design](technical-design.md), the [specification](../../spec/README.md), and the [glossary](../../spec/glossary.md). This file is the source record; those documents hold the current wording.

Standing rule from the user, given with these answers: “later answers supercede the responses to earlier ones, if there is a clear conflict.” Within this batch that applies to Q81 over Q7 (status badge and up-arrow) and to Q79's wording of Regenerate over Q40's narrower one.

## Q78 — What chain is the itinerary J? (I2)

**Context:** J needs sibling results A and B, so it depends on their full join-back (Q30). Q76 lists "continue an existing chain, including continuing from a join-back" separately from "new join chain", but scenario 4's title, the prototypes, and Q65's synthesis model role treated J as its own join chain.

**Recommendation:** The same chain continuing. The join-back resumes the chain A and B forked from; J carries that chain's identity and uses the answer model. A new join chain (own color, synthesis model) is created only when combining cousins or separate trees.

**Answer:** “J is on the same chain continuing. The join back resumes the chain A & B forked from.”

**Decision:** Work that continues from a full join-back is on the chain the siblings forked from. It is not a join chain and gets no new chain identity or color. The model-role part of the recommendation (answer model for J, synthesis model only for join chains) follows from this and was not separately discussed.

## Q79 — The command list (I6)

**Context:** Q62 listed "revise" as a client command, but Q37 recognizes a revision only from a submitted message's wording. The list also lacked Regenerate (Q40), Continue without and Cancel for paused work (Q48), and conversation management (Q70).

**Recommendation:** Remove "revise" as a command. Add Regenerate, Continue without, Cancel, and create, list, and delete conversation.

**Answer:** “Yes, revise is what routing concludes, and regenerate is the ‘cancel the ongoing work and revise with the new version’”

**Decision:** Revision is a routing outcome of a submitted message, not a command. Regenerate is a command: it cancels any ongoing work for that item and redoes it against the new version of what it depends on. The remaining additions (Continue without, Cancel, conversation create/list/delete) were taken as accepted under the "Yes".

**Note:** Q40 introduced Regenerate for *completed* work built on a superseded result. The answer's wording also covers work that is still running when Regenerate is used; that ongoing work is cancelled first.

**Confirmed:** Regenerate cancels any ongoing work for its item and then redoes it against the new version; Continue without, Cancel, and conversation create, list, and delete are commands. The user confirmed this reading afterwards: “Yes, these are all fair assumptions and record as such for my answers to them”.

## Q80 — "Directive" (I7)

**Context:** Failure is "local to the affected directive" (Q24, Q27), but the term had no definition.

**Recommendation:** The unit of work that produces one answer section: an atomic request, or one fragment of a composite.

**Answer:** “Yes. The unit of work that produces one answer section”

**Decision:** Accepted. Added to the glossary.

## Q81 — Pending-work navigation (I1)

**Context:** Q7's status badge on the user message and up-arrow to earlier pending work were never reconciled with responding bubbles (Q12–Q14, ADR-0003).

**Recommendation:** Pending status lives on the responding bubble or section only, with no badge on the user message. Drop the up-arrow; a pending section inside an already-placed group can be reached from the operation queue.

**Answer:** “Yes, on the responding bubble”

**Decision:** Pending status is shown on the responding bubble (or pending section), not on the user message. The up-arrow is dropped. This supersedes the badge and arrow from Q7.

**Confirmed:** The up-arrow is dropped, and a pending section inside an already-placed group is reached from the operation queue. The user confirmed this reading afterwards: “Yes, these are all fair assumptions and record as such for my answers to them”.

## Q82 — Context limit (I3)

**Context:** Q67's interim rule was marked "proposed, not separately confirmed", yet Q75 relied on it.

**Recommendation:** Confirm it: count tokens before each run, warn near the limit, and fail the directive as non-retryable instead of silently truncating.

**Answer:** “yes”

**Decision:** Confirmed. Compaction itself remains out of scope (Q67).

## Q83 — Retry after partial output (I4)

**Context:** Q51 covers failure before any output. Q47 did not say where a retry's answer appears when failed partial text is already visible.

**Recommendation:** In the same bubble. The failed partial text collapses, marked failed, and the retry streams beneath it at the position already fixed. Unlike a revision's replacement (Q38), a retry is the same request and does not become a new response.

**Answer:** “yes”

**Decision:** Accepted as recommended, for automatic and manual retries.

## Q84 — Stopped for a default-choice wait, then deselected (I5)

**Context:** A shared-requirement revision stops affected running work at once and asks which work to redo (Q42, Q45). Q44 covered only *finished* work the user leaves unselected.

**Recommendation:** The deselected work stays stopped with its partial text and a Retry action.

**Answer:** “User can't deselect.”

**Decision:** The recommendation was rejected. Affected work that was running, and was stopped for the wait, cannot be deselected: it is always redone under the revised requirement. The user's choice applies only to finished work (redo it, or keep it with the superseded-input note). Queued affected work already always picks up the change (Q44).

**Confirmed:** Affected work that was running and was stopped for the wait is always redone; the choice applies only to finished work. The user confirmed this reading afterwards: “Yes, these are all fair assumptions and record as such for my answers to them”.

## Q85 — Undo split after work has started (I8)

**Context:** Q53's Undo split "restores one atomic request", but split messages may already be running or answered.

**Recommendation:** Offer Undo split only until any split message shows answer text or receives a reply. Undoing stops running attempts, drops their status-only bubbles (as in Q38), and restarts as one atomic request.

**Answer:** “Yes, undoing stops any running attempts and restarts as one atomic”

**Decision:** Accepted as recommended, including the window in which Undo split is offered.

**Confirmed:** Undo split is offered only until a split message shows answer text or receives a reply. The user confirmed this reading afterwards: “Yes, these are all fair assumptions and record as such for my answers to them”.

## Q86 — Join-chain sources (I9)

**Context:** Q76 says a join chain merges "two leaf-node cousins"; ADR-0002 and the glossary said "specific source nodes".

**Recommendation:** Any specific nodes, two or more, with leaves as the default.

**Answer:** “New join chains only via leaves of a chain. There is too much complexity for little added benefit if we allow new join chains with genealogy parents who are not leaves.”

**Decision:** The recommendation was rejected. A join chain's parents are always leaves of their chains at the moment the join chain is created. A non-leaf node cannot be a join chain's parent.

**Not addressed here:** whether a join chain may have more than two sources. Settled by Q88 below.

## Q87 — Inspectors (I10)

**Context:** Scenarios promise context inspection (Q31), but inspector content existed only in prototypes and in an unaccepted seven-item proposal in the external discussion record. It was also unclear whether inspectors are always available.

**Recommendation:** Accept the run inspector proposal. Margin rails with Focus and the "split from one message" link are always available; the mini-map, operation graph, and run inspector sit behind debug toggles.

**Answer:** “Yes, accept the run inspector proposal.”

**Decision:** The run inspector proposal is accepted; its seven items are recorded in the technical design. The visibility split (rails, Focus, and the split link always available; mini-map, operation graph, and run inspector behind debug toggles) was taken as accepted under the "Yes" and matches the user's original request for debug views.

**Confirmed:** Margin rails, Focus, and the split link are always available; the mini-map, operation graph, and run inspector sit behind debug toggles. The user confirmed this reading afterwards: “Yes, these are all fair assumptions and record as such for my answers to them”.

## Q88 — How many sources may a join chain have?

**Context:** Q86 required a join chain's parents to be leaves but did not say how many there may be. Q5 and Q76 both describe two.

**Options offered:** “Two only” or “Two or more”, with no recommendation.

**Answer:** “Two or more”

**Decision:** A join chain has two or more parents, each a leaf of its chain when the join chain is created. Under the standing rule, this supersedes the “two” in Q5 and Q76.

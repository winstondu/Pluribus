> **Archived.** Decision record. History only; the current specification is [`docs/spec/`](../../spec/README.md). See the [archive README](../README.md).

# Review batch record: Q89–Q98, and Q11 recovered

Asked on November 10, 2026, after an independent consistency review of `docs/spec/`. Ten questions were put to the user, each with a recommendation. The user first answered five and supplied the lost wording of Q11, then, after asking for more context, answered the other five and settled the three readings left open. The second round is recorded at the end of this file and, under the standing rule, takes priority over the first-round entries wherever they differ. Each entry gives the question, the recommendation, the user's answer verbatim, the decision, and any reading that the answer leaves to be confirmed.

Standing rule: a later answer supersedes an earlier one wherever the two clearly conflict.

## Q11 — recovered wording

The user pasted the original question and confirmed the answer.

**Question:** “Q11 — Should an unrelated request inherit only explicitly shared context? B needs its translation input, but not A’s discussion of atmospheric scattering. It might still need a conversation-wide instruction such as ‘Keep your answers brief.’”

**Recommendation:** “give B its required inputs and explicitly shared instructions/preferences. Don’t automatically import A’s topic history. We’ll specify how instructions acquire shared scope separately.”

**Answer:** “I agree to the recommendation”

**Decision:** An unrelated request receives its own required inputs plus explicitly shared instructions and preferences, and never another request's topic history. How instructions become shared was settled later by Q17 (session-wide only when the user says so explicitly), and the mechanism by Q76 (unrelated work starts a new chain).

## Q89 — Chain identity of forks and branches

**Context:** Q78 puts forks and the work after their join-back on “the chain A and B forked from”, and Q30 lets B be continued alone. The answers did not say whether a fork, or a later branch from one sibling, has a chain identity and color of its own.

**Recommendation:** Forks and the join-back continuation keep the identity and color of the chain they forked from. A branch that diverges after the group has closed gets its own.

**Answer:** “A fork, or a later branch from one sibling, gets it own chain color”

**Decision:** The recommendation was rejected in part. Every fork has its own chain color, and so does a later branch from one sibling. The join-back, and work continuing from it, resume the color of the chain the siblings forked from (Q78, unchanged).

## Q90 — Model for work continuing from a join-back

**Not answered.** The user's reply numbered its second answer “90”, but its content (“no state to show”) answers Q91; see below. Q90 remains open.

## Q91 — Cancelled work that never started

**Context:** Stop cancels queued work in its scope (Q22), and the recovery choice can cancel a paused request (Q48). The state list has no “cancelled”.

**Recommendation:** Show it as stopped. It was ended deliberately by the user and offers Retry like other stopped work. No new state.

**Answer:** “yes, no state to show” (given under the number 90; the user's answers followed the five questions highlighted in the summary, where this was the second)

**Decision, as read:** Accepted. There is no separate cancelled state; cancelled work that never started is treated as stopped.

**To confirm:** that the answer was to Q91 and not Q90, and that “no state to show” means no *new* state (shown as stopped) as recommended, not that cancelled work shows no state at all.

## Q92 — Interrupted sibling and group closure

**Context:** Q49 lets a failed or stopped member close its group. Under Manual retry an interrupted member may never run again, which would keep the group open forever.

**Recommendation:** It does not close the group while it can still retry automatically. Once it is waiting for a manual Retry it counts as ended, the join-back records it with an interrupted marker, and dependents get the recovery choice.

**Answer:** “We should close the group then. Retries then make that message be descended from the join back”

**Decision:** An interrupted member closes its group, like a failed or stopped one. The join-back records it with an interrupted marker. If the interrupted work is retried afterwards, the retry is not a member of the closed group: it runs as a descendant of the join-back.

**To confirm:**

- Whether the group closes as soon as a member is interrupted, or only once that member is waiting for a manual Retry. The specification records the first reading (interrupted counts as ended, exactly like failed and stopped).
- Whether “retries descend from the join-back” also applies to retries of *failed* and *stopped* members after their group has closed. Q49 says a successful retry “takes B's place in future context”. The specification applies the new rule to interrupted members only and leaves Q49 as it was.

## Q93, Q94 — not answered

Reaching a pending section without debug views; Compare for composites that were not split. Both remain open.

## Q95 — Where elicitations appear

**Context:** Clarification questions are additional responses and the recovery choice is on the queue item. Nothing placed target-ambiguity and choice-with-default elicitations.

**Recommendation:** In the transcript, directly below the message that caused them, where the recorded outcome then stays.

**Answer:** “It can just be a modal above the input box.”

**Decision:** The recommendation was rejected. Target-ambiguity and choice-with-default elicitations appear as a modal above the composer.

**Not addressed:** where the record of what happened (“Redid J by default”, Q45) is shown after the modal closes.

## Q96, Q97 — not answered

Where a retry's output goes after a user-stopped section; work that needs a non-leaf node together with another line. Both remain open.

## Q98 — Recognizing an answer to a clarification question

**Context:** The default of a choice-with-default runs when the user “sends another message without answering” (Q45), so answers and unrelated messages must be told apart.

**Recommendation:** The clarification question carries a reply affordance like any answer section. A targeted reply is the answer; an untargeted next message has its target inferred as usual and may be recognized as the answer.

**Answer:** “The clarification question carries a reply affordance like any answer section. A targeted reply is the answer; an untargeted next message has its target inferred as usual and may be recognized as the answer.”

**Decision:** Accepted as recommended.

---

# Second round: remaining answers and confirmed readings

Given the same day, after the user asked for more context on each open point. Where an entry here differs from the first-round entry above, this one is current.

## Q90 — Model for work continuing from a join-back

**Recommendation:** The answer model. The synthesis model is used only by join chains.

**Answer:** “Use the answer model. It effectively is just appending the request response of both A and B to their common history, and then the followup via so.”

**Decision:** Accepted. Work continuing from a join-back is an ordinary answer run: the join-back appends the siblings' exchanges to their common history, and the follow-up continues from there.

## Q93 — Reaching a pending section without debug views

**Recommendation:** No extra route. The pending section is visible in its group; the operation graph is an additional route when enabled.

**Answer:** “Well, given the prototype, its one single reply with 3 sections in that scenario. No need for anything extra.”

**Decision:** Accepted. A composite's answer is one reply with its sections, so a pending section is found in that reply. Nothing extra is added.

## Q94 — Compare for composites that were not split

**Recommendation:** Available for any composite message through the same kind of always-available link.

**Answer:** “Compare for independent composites sit behind debug. While for sequential is something we actually surface to user.”

**Decision:** The recommendation was rejected. For a sequential composite, the “split from one message” link and Compare are surfaced to the user. For an independent composite, Compare is behind a debug toggle.

## Q96 — Retrying a stopped section

**Recommendation:** Identical to Q83: the retry streams in the same bubble beneath the collapsed stopped text.

**Answer:** “Identical to Q83. The underlying geneaologies that depend on B get updated (even if this means losing some prompt caching)”

**Decision:** Accepted. In addition: when B is retried, the context of everything that depends on B is updated to reflect the retry, even at the cost of prompt caching.

## Q97 — Work needing a non-leaf node together with another line

**Recommendation:** The join chain attaches to the current leaves of those chains; a leaf's ancestry already includes the earlier node.

**Answer:** “Go with recommended. As we said in Q86, we want to avoid complexity for now.”

**Decision:** Accepted.

## Q91 — confirmed reading

**Reading offered:** cancelled work that never started is treated as stopped, with no new state; or it shows no state at all.

**Answer:** “record J as cancelled if B is cancelled.”

**Decision:** Neither reading. **Cancelled** is a state of its own: work that was cancelled before it started is recorded as cancelled. This supersedes the first-round reading above.

**Reading applied:** the example put to the user was J, queued behind B, being cancelled either by stopping the whole request or by choosing “Cancel itinerary” after B did not finish. The specification records J as cancelled in both cases. It does not read the answer as changing Q48, under which stopping B alone pauses J and does not cancel it.

## Q92 — confirmed reading

**Points to confirm:** when the group closes; and whether the rule that a retry descends from the join-back also applies to failed and stopped members.

**Answer:** “Group closes once all members are either interrupted (and not retrying) or completed. This applies to failed and stopped members as well.”

**Decision:** A sibling group closes once every member has either completed, or has failed, been stopped, or been interrupted and is not retrying. A member that is still retrying, automatically or because a retry was started, keeps the group open. Once the group has closed, a retry of any member that did not complete, whether failed, stopped, or interrupted, runs as a descendant of the join-back.

**Supersedes:** the first-round reading that an interrupted member closes the group immediately; and the part of Q49 under which a later successful retry “takes B's place” in the join-back. After closure the join-back keeps the member's marker, and the retry's exchange follows it.

## Q95 — confirmed reading

**Point to confirm:** where the record of what happened is shown after the modal closes.

**Answer:** “In this scenario (assuming the ‘actually the trip is four days’ while J is still in flight), we revise J with small note at the bottom of J. If J was finished when we sent the ‘actually, the trip is four days’, it would just be a new response message entirely.”

**Decision:** If J was still in flight, J is revised and carries a small note at its bottom saying what happened. If J had already finished, the redone J is a new response.

**Reading applied:** the note sits at the bottom of the redone J. Where the redone J's text streams when the in-flight J had already shown partial text follows Q38 (the partial text stays, superseded, and the replacement is a new response); the answer was not read as changing that.

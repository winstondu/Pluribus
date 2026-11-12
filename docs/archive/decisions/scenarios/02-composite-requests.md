> **Archived.** Historical record, kept read-only and no longer maintained. The current specification is [docs/spec/](../../../spec/README.md); see the [archive README](../../README.md) for how to read this file.

# Scenario 2: composite requests and shared requirements

Status: settled (Q17–Q27, Q53, Q85). Q24 is recovered in the [early interview record](../early-interview-record.md#q24--what-happens-to-siblings-when-a-directive-fails). No production implementation exists.

## Accepted foundation

- Preserve the original message and conservatively split independent intents. Closely related comparisons or integrated outputs stay atomic.
- Fragments receive applicable requirements and source provenance.
- Compare is the selected decomposition inspector; Fragments is retained for later.

## Accepted decisions Q17–Q23

### Q17: Requirement scope

Requirements are local to the addressed request/fragments unless the user explicitly signals session-wide scope, such as “from now on” or “in this chat”. Explicitly shared instructions apply across chains.

### Q18: Normal composite reply placement

Normally, one reply group corresponds to the original message. First section output fixes its transcript position; independent sections within it take positions at first visible output, and pending sections may be overtaken. Later sections stay in that group. Explicit output ordering takes precedence. Q23 introduces an exception for clarification continuations.

### Q19: Ready versus dependency-blocked fragments

Without a result-level qualifier requiring coordination, ready fragments proceed and only dependency-blocked fragments queue. The composer queue names the waiting part and prerequisite; the parent can show mixed state.

If the request has an output-order qualifier, keep the whole request queued rather than starting the otherwise-ready fragment. Example: while recommendation A is in flight, “Summarize that recommendation and separately translate this menu, but put the translation first” queues the whole request. This is a deliberate scheduling constraint beyond the fragment's own result dependency, not merely buffering an already generated answer.

Q25 accepted: constraints relating outputs (ordering, combined limits, integrated presentation) require whole-request waiting when a part is blocked. Distributable requirements, such as “each answer under 100 words”, do not create this barrier.

### Q20: Reply targets

Each answer section has its own explicit reply target. Untargeted follow-ups can also have their target section(s) inferred through Jev, including multiple sections of the previous composite response. This does not add a whole-response reply button. Targeting identifies context, not automatically a revision or a mandatory join.

Existing ambiguity elicitation remains applicable: genuinely ambiguous targeting is resolved through UX rather than a silent guess. Jev receives candidate section identities and relevant context; it selects among existing targets, not inventing new section text. The classifier questions, evaluation, and thresholds are in the [technical design](../technical-design.md) (Q59, Q61, Q74); the candidate-history search policy is left to the build ([build scope, now part of the specification](../../../spec/README.md)).

### Q21: Failure

Q27 supersedes Q21: failure applies only to the affected directive, not the overall request. Indicate the failed directive, allow unfinished siblings to continue, and preserve successful output. Do not propagate one directive’s failure into an overall failed status. Retry behavior is settled in [scenario 6](06-failure-cancellation-recovery.md) (Q47).

### Q22: Stop controls

Allow stopping a section or all work for the request. Preserve visible text as partial/stopped, cancel queued work within that scope, and leave unrelated requests running. User-requested stopping is distinct from an execution failure. There is no aggregate cancellation status ([scenario 6](06-failure-cancellation-recovery.md), Q50).

### Q23: Clarification continuations

Unambiguous independent sections may proceed while clarification is sought for affected sections. Display one response containing the unblocked sections, additional response(s) containing clarification questions, and later additional response(s) containing final results. Do not reopen the earlier sectioned response to insert the clarified answer. These responses remain associated with the original request and relevant fragments.

Ambiguity in a shared requirement blocks the affected fragments. Q26 accepted: clarification questions can appear immediately in separate responses even when a whole-request output constraint keeps answer work queued. Required information and prerequisite results must be available before that answer work proceeds.

### Sequential decomposition shown user-side (added with Q48)

When a composite message has a clear sequential ordering, where a later part needs an earlier part's result, decompose it on both the execution side and the user side: display it as separate user messages in order. Example: A (neighborhoods) is sent first; then one message asks for B (activities) and J (an itinerary using A and B). The transcript shows B and J as two user messages, and J depends on the full A/B join-back. The original message remains preserved (Compare inspector). Independent composites still display as one message with sections (Q18).

Q53 accepted: the split messages appear immediately, in order, as normal user bubbles joined by a faint “split from one message” link that opens the Compare inspector with the exact original text. Each split message is its own target for replies, revisions, and stops; J gets the usual queue item. **Undo split** restores one atomic request.

Q85 accepted: Undo split is offered only until any split message shows answer text or receives a reply. Undoing stops any running attempts, drops their status-only bubbles (as in Q38), and restarts the work as one atomic request.

Rewrite ordering is topological: every split message appears after the messages it depends on. With A already sent and a single “B + C + J” message where J needs A, B, and C, the bubbles appear as B, C, then J. Independent parts (B, C) keep their original textual order.

## Concrete cases

1. Ready + blocked: a pending destination recommendation, followed by a request for its summary plus an unrelated menu translation. Translation can proceed; summary queues.
2. Ordered variant: add “put the translation first” to case 1. Whole request queues.
3. Clarification: “Translate this menu and explain what happened yesterday.” Translation is returned in the initial answer; the event clarification and its eventual answer appear in additional responses.
4. Failure: menu translation succeeds but the independent research section fails. Indicate the failed research directive and allow siblings to continue. Failure remains local to that directive; the overall request is not marked failed.

## Decision batch status

Q17–Q27 are settled with the exceptions recorded above. Q24 explicitly keeps unfinished siblings running when one directive fails; Q27 clarifies that failure is local to the affected directive. See the [original answer and context](../early-interview-record.md#q24--what-happens-to-siblings-when-a-directive-fails). Error-retry mechanics, cancellation labels, and downstream failure propagation were settled in [scenario 6](06-failure-cancellation-recovery.md) (Q47–Q50).

## Acceptance conditions

- Local brevity instructions do not silently become session-wide preferences.
- Normal composite groups preserve their positions after first output; output-order requirements are honored.
- In case 1 the ready translation can run before A completes; in case 2 it does not.
- Explicit section reply targets resolve to their chosen fragments; an untargeted follow-up may infer one or several section targets through Jev.
- A failed directive is visibly identified, does not stop unfinished siblings, and does not mark the overall request failed.
- Clarification questions are not blocked by the whole-request answer barrier.
- Section stop leaves unrelated requests running and preserves visible partial text.
- A clarification-derived answer appears as a later response, not a retroactive insertion into the original answer group.
- Undo split is unavailable once any split message shows answer text or has a reply; before that, it stops running attempts and restarts one atomic request (Q85).

## Technical choices

Classifier thresholds (Q74), the concurrency limit (Q60), provider and context format (Q57), and storage (Q58, Q63) are settled in the [technical design](../technical-design.md). Scheduling fairness and context compaction remain deferred (Q60, Q67). Tools are out of scope.

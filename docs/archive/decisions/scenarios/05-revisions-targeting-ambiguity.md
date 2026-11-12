> **Archived.** Historical record, kept read-only and no longer maintained. The current specification is [docs/spec/](../../../spec/README.md); see the [archive README](../../README.md) for how to read this file.

# Scenario 5: revisions, reply targeting, and ambiguity

Status: Q35–Q46 settled, with Q79 and Q84 refinements; scenario complete. Default-choice details (Q44–Q46) live in [elicitation methods](../elicitation.md). No production implementation exists.

Already settled elsewhere: per-section reply targets, Jev inference of one or several target sections for untargeted replies, UX elicitation for genuinely ambiguous targets (Q20), local requirement scope (Q17), and clarification continuations as additional responses (Q23).

## Concrete conversation

The established trip brief is Kyoto, five days, November, moderate budget. A recommends neighborhoods; B recommends activities; J builds an itinerary from the full A/B join-back.

The user replies to A: “Actually, use a luxury budget for the neighborhood recommendations.”

## Accepted behavior

### Q37: Classifying a revision

A reply is a revision only when its wording corrects or replaces earlier work (“actually”, “instead”, “change to”, “no, …”). Otherwise it is additional work, such as a fork alongside A (“Also give me luxury options”), and A is not superseded.

### Q35: Applying a clear revision

- A running: stop the current attempt and start a replacement attempt with the corrected requirement, as though it were the new request.
- A finished: retain A as superseded and generate the replacement as a follow-up response; do not rewrite A.
- B and its requirements are unchanged. The luxury budget is local to the neighborhood recommendations (Q17), not a change to the whole trip brief.

### Q38: Superseded attempts in the transcript and in the replacement's context

| A's state at revision | Transcript | Replacement A′ context |
|---|---|---|
| Running, no answer text yet (status only) | A's responding bubble is dropped without a trace | Rewound: A′ starts as the new request |
| Running, some answer text visible | Partial text stays in place, collapsed, marked “Superseded — revised below”, linked to A′ (Q22, ADR-0003) | Rewound: the visible partial text is **not** in A′'s context |
| Finished | A stays, marked superseded, linked to A′ | A is part of the chain history; A′ is a follow-up that sees A and the correction |

In every case A′ is a new response positioned at its own first output. It never streams into A's original bubble or composite group (Q23).

### Q36: Propagating the revision along actual dependencies

- J queued: retarget J's prerequisite to the replacement and keep waiting.
- J running: stop the affected attempt; restart once the replacement prerequisites are ready.
- J completed (built on the first A): J stays as it was. Later messages depending on J also take in the revised A.
- Unaffected branches continue unchanged.
- J's replacement prerequisite remains the full sibling join-back. Revising A never permits bypassing B (or any other group member).

### Q39: Context for dependent work

Work that takes in the revised A (via the join-back or J's chain) receives the user's correction plus A′ in A's place, without the superseded A's body. The context inspector still shows A existed and was superseded. Historical runs keep the context they actually consumed: completed J's record still shows the original A.

Under Q36 this mainly affects completed work and its later continuations; queued or running J simply waits for A′.

### Q40: Completed dependents built on a superseded result

A completed J that consumed the original A gets a quiet note (“Based on superseded neighborhood recommendations”) and a **Regenerate** action that reruns J against the full join-back including A′. No automatic regeneration. Only completed work that actually consumed the superseded result is marked.

Q79 accepted: Regenerate is a user command. It cancels any ongoing work for that item and redoes it against the new version of what it depends on. A revision, by contrast, is never a command; it is what routing concludes from a submitted message's wording (Q37).

Implementation notes (decide later): staleness can be detected by checking whether any of J's consumed dependencies now has a superseding replacement. A finer optional check could estimate whether the replacement would actually change J's response before showing the note.

### Q41: Revising work that has not started

A queued request is updated in place: nothing is stopped or marked superseded. The submitted message stays in the transcript, the revision message appears in submission order, and the queue item reads e.g. “Revised · waiting for neighborhoods + activities”. Dependencies are unchanged, so J still waits for the full join-back.

### Q42: Revising a shared requirement

Example: “Actually, the trip is four days, not five.” This revises the shared trip brief that A, B and J consumed, not a single section.

Committee identifies the core work that may need redoing among the brief's consumers, then elicits from the user which of it to redo, offering a default choice that executes if the user does not respond. Chosen work follows Q35/Q36; work not chosen keeps its result with the Q40 superseded-input note. Q84 accepted: affected work that was running, and was stopped for the wait, cannot be deselected and is always redone; the choice applies to finished work. Future work uses the revised brief. Committee pre-selects the work it judges actually affected (Q44); running affected work stops at once and the default runs on the next unanswered message or after the user-configurable wait, 30 seconds by default (Q45). The elicitation pattern is general and lives in [elicitation methods](../elicitation.md).

### Q43: Replying to a superseded section

A reply targeting a superseded section resolves to its current replacement (A′), with a small “Replying to the revised version” note. The superseded attempt stays visible but is not a target for new work. Wanting the earlier version back is itself a revision or new work under Q37.

## Acceptance conditions

- Corrective wording supersedes the target; additive wording creates additional work and leaves the target current.
- A revision to a running A stops that attempt and starts a replacement; B keeps running untouched.
- A′ never sees A's stopped partial text; A′ following a finished A sees A and the correction.
- A status-only bubble disappears on supersession; visible partial or finished text stays in place, marked superseded and linked to A′.
- A′ appears as a new response, never inside A's original bubble or group.
- Queued J waits for A′ and the rest of the full join-back, never a subset.
- Running J restarts from the replacement prerequisites.
- Completed J is not rewritten or auto-regenerated; it shows a superseded-input note with Regenerate. Later work depending on J receives the correction plus A′, not the old A body.
- Revising a queued request edits it in place without changing its dependencies.
- Work not depending on A is unaffected.
- A shared-requirement revision elicits which affected work to redo, and the default executes without a response; unchosen finished work keeps its result with the superseded-input note.
- Affected work that was running when a shared requirement was revised cannot be deselected and is redone (Q84).
- Regenerate cancels any ongoing work for its item before redoing it against the new version (Q79).
- A reply to a superseded section targets its replacement and says so.

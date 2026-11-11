# 06 · Revisions

What happens when the user corrects or replaces work they already asked for. Whether a message is a revision at all is decided in [reply targets and routing outcomes](05-reply-targets-and-routing.md).

Running example. Trip brief: Kyoto, five days, November, moderate budget. A recommends neighborhoods, B recommends activities, J builds an itinerary from the A/B join-back. The user replies to A: "Actually, use a luxury budget for the neighborhood recommendations." A′ is the replacement.

## Revising one piece of work

What happens depends on the state of the target (Q35, Q38, Q41):

| A's state | A's attempt | Transcript | A′ reads |
|---|---|---|---|
| Queued, not started | Nothing is stopped or superseded; the request is updated in place | The original message stays; the revision message appears in submission order; the queue item reads "Revised · waiting for …". Dependencies are unchanged | The corrected request |
| Running, status only | Ended and superseded | The responding bubble is dropped without a trace | Rewound context: A′ starts as the new request |
| Running, answer text visible | Ended and superseded | Partial text stays, collapsed, marked "Superseded — revised below", linked to A′ | Rewound context: the partial text is not included |
| Finished | Kept as history, marked superseded | A stays, marked superseded, linked to A′ | A's chain history: A′ is a follow-up that sees A and the correction |

An attempt that Committee ends for a revision is superseded, not stopped: its dependents follow the replacement and are not paused.

In the three cases where A had started, A′ is a new response positioned at its own first output. It never streams into A's bubble or reply group.

The revision is local. B and its requirements are unchanged: the luxury budget applies to the neighborhood recommendations, not to the whole trip brief (Q17).

## Effect on work that depends on the target

Dependents follow their actual dependencies (Q36):

| J's state | Behavior |
|---|---|
| Queued | Its prerequisite is retargeted to the replacement, and it keeps waiting |
| Running | The affected attempt is stopped; it restarts once the replacement prerequisites are ready |
| Completed on the original A | Left exactly as it was, with a superseded-input note (below) |

- Unaffected branches continue unchanged.
- A revision never permits bypassing the full join-back. J still waits for every member of the group.

## Context after a revision

- Work that takes in the revised A, through the join-back or through J's chain, receives the user's correction plus A′ in A's place, without the superseded body (Q39).
- Views of context still show that A existed and was superseded.
- Historical runs keep what they actually read: a completed J's record still shows the original A.

## Completed work built on a superseded result

- It gets a quiet **superseded-input note**, for example "Based on superseded neighborhood recommendations", and a **Regenerate** action. Only work that actually consumed the superseded result is marked (Q40).
- Nothing regenerates automatically. The user may be content with the existing result.
- **Regenerate** is a user command. It cancels any work still in progress for that item and redoes it against the new version of what it depends on. For J that is the full join-back including A′ (Q40, Q79).

## Revising a shared requirement

Example: "Actually, the trip is four days, not five." This changes the brief that A, B, and J all consumed.

- Committee identifies the work that may need redoing among the brief's consumers and asks the user which to redo, using a **choice with default** ([elicitation](07-elicitation.md), Q42).
- The pre-selected default is the work Committee judges actually affected. For a four-day trip that is J, the itinerary, not A or B (Q44).
- Affected work that is running stops at once and is always redone; it cannot be deselected. Affected queued work always picks up the change. The user's choice applies to finished work (Q44, Q45, Q84).
- Chosen finished work is redone as in the tables above. Finished work not chosen keeps its result with the superseded-input note and Regenerate.
- All future work uses the revised brief.

## Edge cases

| Situation | Behavior |
|---|---|
| "Also give me luxury options" as a reply to A | Not a revision. A fork alongside A; A is not superseded |
| A is revised while B is still running | B is untouched |
| A is revised after J has finished | J is not rewritten; note plus Regenerate. Later work depending on J receives the correction plus A′ |
| The user revises J while J is still queued | J is edited in place and still waits for the full join-back |
| The user replies to the superseded A afterwards | The reply targets A′ ([reply targets](05-reply-targets-and-routing.md)) |
| The user wants the earlier version back | That is a new revision or new work |
| Regenerate is used while the item is running again | The running work is cancelled first |

## Acceptance conditions

- **R1.** A revision to a running A stops that attempt and starts a replacement; B keeps running untouched.
- **R2.** A′ never sees A's stopped partial text; A′ following a finished A sees A and the correction.
- **R3.** Queued J waits for A′ and the rest of the full join-back, never a subset.
- **R4.** Running J restarts from the replacement prerequisites.
- **R5.** Completed J is not rewritten or auto-regenerated; it shows a superseded-input note with Regenerate. Later work depending on J receives the correction plus A′, not the old A body.
- **R6.** Revising a queued request edits it in place without changing its dependencies.
- **R7.** Work not depending on A is unaffected.
- **R8.** Regenerate cancels any ongoing work for its item before redoing it against the new version.

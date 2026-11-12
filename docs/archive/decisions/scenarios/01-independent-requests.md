> **Archived.** Historical record, kept read-only and no longer maintained. The current specification is [docs/spec/](../../../spec/README.md); see the [archive README](../../README.md) for how to read this file.

# Scenario 1: independent requests finish out of order

Status: settled (Q11–Q16, Q81). No production implementation exists.

## Concrete conversation

1. User sends A: “Explain why the sky is blue.” A starts generating.
2. User sends B: “Translate ‘sopa de verduras’ into English.” A is still running.
3. B answers “vegetable soup” before A finishes.
4. User reads B; A then completes.

## Settled behavior

- B does not wait for A merely because A arrived first.
- User messages always retain submission order.
- For requests without a result dependency between them, reply placement follows first visible answer output. B can appear above A's pending responding bubble without waiting for A.
- Once a reply starts showing answer text, its relative transcript position is fixed; later completions cannot reorder it. Status text in a responding bubble is not answer output.
- A dependent follow-up cannot use overtaking to bypass its prerequisite result. Detailed dependent-request behavior belongs to scenario 4.
- B receives its required inputs plus explicitly shared instructions/preferences, excluding unrelated A topic history.
- A has a responding bubble while pending. Q81 accepted: pending status is shown on the responding bubble (or pending section), not as a badge on the user message, and the earlier up-arrow to pending work is dropped. A pending section inside an already-placed group can be reached from the operation queue.
- Reply targeting is available on assistant messages.
- The chain and operation inspectors represent actual context and scheduling separately.

## Scroll and queue presentation

- Follow output while the reader is at the live bottom.
- If the reader scrolls away, preserve reading position and show a “New output ↓” affordance.
- When a submitted follow-up needs an in-flight reply, clearly show its queued status above the text field.
- An independent request is eligible to process without waiting for unrelated in-flight replies. Do not label it dependency-queued.

## Confirmed queue representation

Q16 is accepted: sending immediately adds the user message in chronological submission order. A linked item above the composer indicates why it is waiting and identifies the required reply. This item clears when processing begins; the submitted message stays in the transcript.

Q11, Q13, Q14, Q15, and Q16 are accepted. Fixed request-ordered answer slots are superseded. Processing status is not answer output. Cross-cutting choices made alongside this scenario are recorded in [scenario 2](02-composite-requests.md); the historical prototypes still show the superseded layout.

## Acceptance conditions already supported by decisions

- With available capacity, B can execute before A completes.
- If independent B starts showing an answer before A, B appears ahead of A's pending bubble even though A was requested first.
- If A starts showing an answer first but B completes first, A stays ahead of B.
- User A remains before user B in both cases.
- If B needs A's result, B cannot emit its dependent answer before that required result is available.
- B's answer is accessible while A is in progress.
- A reader who scrolled away is not pulled to new output; a reader at the live bottom follows it.
- A result-dependent follow-up has a visible queued indicator above the composer, while independent work is not misrepresented as dependency-queued.
- The debug view does not falsely claim B consumed A's unfinished answer.
- Pending status appears on A's responding bubble; user message A carries no status badge and there is no up-arrow to pending work (Q81).

## Specified elsewhere

Composite requests: [scenario 2](02-composite-requests.md). Fork join-back: [scenario 3](03-related-parallel-work.md). Synthesis and dependent requests: [scenario 4](04-result-dependent-work.md). Revision propagation: [scenario 5](05-revisions-targeting-ambiguity.md). Failure and cancellation: [scenario 6](06-failure-cancellation-recovery.md). Capacity limits, routing confidence, and provider mechanics: [technical design](../technical-design.md) (Q60, Q74, Q75). Tools are out of scope.

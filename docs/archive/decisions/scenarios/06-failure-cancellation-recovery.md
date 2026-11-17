> **Archived.** Historical record, kept read-only and no longer maintained. The current specification is [docs/spec/](../../../spec/README.md); see the [archive README](../../README.md) for how to read this file.

# Scenario 6: failure, partial results, cancellation, and recovery

Status: settled (Q47–Q52, Q54, Q83; Q53 is recorded in [scenario 2](02-composite-requests.md)). A directive is the unit of work that produces one answer section (Q80). No production implementation exists.

## Concrete conversation

The established trip brief is Kyoto, five days, November, moderate budget. A recommends neighborhoods; B recommends activities; J builds an itinerary from the full A/B join-back.

1. A finishes.
2. B streams part of its answer, then fails (provider error). Variant: the user stops B.
3. J is queued on the full join-back.

## Already settled (carried over)

- Failure is local to the affected directive; siblings continue, successful output stays, and there is no overall failed status (Q27).
- Stop a section or a whole request; preserve visible text as partial/stopped, cancel queued work in that scope, leave unrelated requests running. Stopping is distinct from failure (Q22).
- Dependent work waits for successful completion, never provisional streaming text; a full join-back dependency waits for its group to close and finish; subsets cannot bypass it (Q30, Q33).
- A replacement attempt after a stopped running attempt starts with rewound context; visible partial text stays in the transcript but is not consumed (Q38).
- Completed work built on a later-replaced input gets a superseded-input note and manual Regenerate (Q40).
- Choice-with-default elicitation is allowed only for reasonable, reversible actions ([elicitation methods](../elicitation.md)).

## Accepted behavior

### Q47: Retry policy

Retry behavior is a user setting:

- **Standard (default):** up to 3 automatic retries with exponential backoff for transient errors (network drops, provider errors). Rate limits wait as the provider indicates, shown as “Waiting for capacity” rather than as a dependency wait. Status text only (“Retrying…”); no user prompt.
- **Persistent:** like Standard, but keeps waiting on rate limits and transient errors longer before giving up.
- **Manual:** no automatic retries; every failure goes straight to the Retry action.

Non-retryable errors (refusals, invalid requests) skip automatic retries. When retries are exhausted, the directive is marked failed with a **Retry** action. Each retry is a new attempt with rewound context: failed partial text stays visible, marked failed, and is never consumed.

### Q48: Dependents of a failed or stopped prerequisite

J stays queued and **paused**; it never proceeds on a subset of siblings. Its queue item names the cause (“Paused — activities failed” or “stopped”) and offers Retry activities, Continue without activities (J consumes the full join-back with B recorded as failed/stopped), or Cancel itinerary. No default: Committee waits. Stopping B never cancels J, which is outside B's stop scope (Q22). A successful retry unpauses J.

Discussing this question introduced sequential decomposition (a message asking for B and for J, which needs B, is shown as two user messages); that rule is recorded in [scenario 2](02-composite-requests.md) and settled as Q53.

### Q49: Join-back with a failed or stopped member

A failed or stopped member counts as finished for closing the group. The join-back records B's request and a failed/stopped marker, without partial text. A later successful retry B′ takes B's place in future context (Q39 pattern); completed work that consumed the marker gets the superseded-input note with Regenerate (Q40).

### Q50: Mixed-result requests

No overall status label (Q27). Each section shows its own state; while mixed, the group header shows a compact count such as “2 done · 1 failed · 1 stopped”. Stopping the whole request marks each unfinished section stopped, with no “request cancelled” badge. Retrying a request retries only its unfinished sections and reuses the finished sections' results.

### Q51: Failure before any answer output

The failure notice counts as visible output for placement: the bubble is fixed where it was when it failed (ADR-0003). A later successful retry appears in that same bubble, since nothing was shown there to override.

### Q83: Retry after partial output

When failed partial text is already visible, the retry's answer appears in the same bubble: the failed partial text collapses, marked failed, and the retry streams beneath it at the position already fixed. This holds for automatic and manual retries. Unlike a revision's replacement (Q38), a retry is the same request and does not become a new response.

### Q52: Interrupted attempts

Do not assume a server component; whatever executes a run (client or server) can be interrupted, e.g. app closed, connection lost, crash, or deploy. An attempt lost this way is marked **interrupted**, distinct from failed and stopped, and gets the same retry choices as Q47/Q48.

### Q54: Retrying interrupted attempts

Follow the retry setting (Q47). Under Standard and Persistent, an interrupted attempt retries automatically once something can execute it again, counting against the same retry limit with rewound context. Under Manual it waits with the Retry choices. Work that was queued when the interruption happened stays queued; it waits for prerequisites and has nothing to retry.

## Acceptance conditions

- Transient failures retry per the user's retry setting (Standard by default) with status text only; non-retryable errors go straight to failed.
- Each retry is a new attempt that never consumes earlier partial text.
- J paused on a failed or stopped B never runs on a subset; it waits for the user's Retry / Continue without / Cancel choice.
- A failed or stopped member closes the group; a successful retry replaces it in future context.
- Mixed-result requests show per-section states and a count, never an overall failed or cancelled label.
- Retrying a request reruns only unfinished sections.
- A reply that failed before any output stays fixed where it failed; its retry fills the same bubble.
- A retry after visible partial output streams in the same bubble beneath the collapsed, failed partial text, not as a new response (Q83).
- An interrupted attempt is labeled interrupted and offers the same retry choices; under Standard/Persistent it retries automatically within the retry limit.

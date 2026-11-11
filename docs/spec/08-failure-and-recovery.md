# 08 · Failure, stopping, and recovery

What happens when work does not finish.

Running example. A (neighborhoods) has finished. B (activities) streams part of its answer and then fails with a provider error, or the user stops it. J (itinerary) is queued on the full A/B join-back.

## Four ways work ends without completing

| State | Cause | Visible text |
|---|---|---|
| **Failed** | An execution error, after any automatic retries | Stays, marked failed |
| **Stopped** | The user ended it deliberately | Stays, marked partial and stopped |
| **Interrupted** | Whatever was executing it stopped unexpectedly: app closed, connection lost, crash | Stays, marked interrupted |
| **Cancelled** | The user cancelled it before it started | None; it never ran |

These are distinct states and are labeled distinctly.

## Failure is local

- Only the affected directive fails. Its siblings keep running, and successful output stays (Q24, Q27).
- There is no overall failed or cancelled status for a request. Each section shows its own state. While results are mixed, the group header shows a compact count such as "2 done · 1 failed · 1 stopped" (Q50).

## Stopping

- The user can stop one section, or all work for a request (Q22).
- Visible text is kept as partial. Queued work within the stopped scope is cancelled. Unrelated requests keep running.
- Stopping a whole request marks each unfinished section stopped. There is no "request cancelled" badge (Q50).
- Stopping B never cancels J: J is outside B's stop scope (Q48).
- Work cancelled before it started, by a stop or by the Cancel recovery choice, is recorded as **cancelled**, a state of its own (Q91).

## Retries

Retry behavior is a user setting (Q47):

| Policy | Behavior |
|---|---|
| **Standard** (default) | Up to 3 automatic retries with exponential backoff for transient errors such as network drops and provider errors. Rate limits wait as the provider indicates, shown as "Waiting for capacity", never as a dependency wait. Status text only ("Retrying…"); no prompt |
| **Persistent** | As Standard, but keeps waiting on rate limits and transient errors for longer before giving up |
| **Manual** | No automatic retries. Every failure goes straight to the Retry action |

- Non-retryable errors, such as refusals and invalid requests, skip automatic retries. Which provider responses are transient is in [architecture](11-architecture.md).
- When retries are exhausted, the directive is marked failed and offers a **Retry** action.
- Each retry is a new attempt with rewound context. Earlier partial text is never consumed.
- A retry's output appears in the same bubble. If failed or stopped partial text was visible, it collapses, keeping its mark, and the retry streams beneath it ([transcript and placement](03-transcript-and-placement.md), Q51, Q83, Q96).
- When work is retried, the context of everything that depends on it is updated to reflect the retry, even at the cost of prompt caching (Q96).
- Retrying a request retries only its unfinished sections and reuses the results of the finished ones (Q50).

## Dependents of work that did not finish

- J stays queued and becomes **paused**. It never proceeds on a subset of siblings (Q48).
- Its queue item names the cause ("Paused — activities failed", or "stopped") and offers the **recovery choice**:
  - **Retry activities.** A successful retry unpauses J.
  - **Continue without activities.** J consumes the full join-back with B recorded as failed or stopped.
  - **Cancel itinerary.**
- There is no default. Committee waits.

## Join-back with a member that did not finish

- The group closes once every member has completed, or has failed, been stopped, or been interrupted and is not retrying. A member that is still retrying keeps it open (Q49, Q92).
- The join-back records that member's request and a failed, stopped, or interrupted marker, without its partial text.
- A retry B′ started after the group has closed is not a member: it runs as a descendant of the join-back, so the join-back keeps B's marker and B′'s exchange follows it. This holds for failed, stopped, and interrupted members alike (Q92). Completed work that consumed only the marker gets the superseded-input note with Regenerate ([revisions](06-revisions.md#completed-work-built-on-a-superseded-result)).

## Interruption

- No server is assumed. Whatever executes runs, in the client or on a server, can be interrupted (Q52).
- Under Standard and Persistent, an interrupted attempt retries automatically once something can execute it again. It counts against the same retry limit and starts with rewound context. Under Manual it waits with the Retry action (Q54).
- Its dependents get the same recovery choice as for failed or stopped work.
- An interrupted member that is retrying automatically keeps its sibling group open. One that is not retrying, such as under Manual, lets the group close like a failed or stopped member (Q92).
- Work that was only queued when the interruption happened stays queued. It has nothing to retry.

## Context limit

When a run's context would exceed the model's limit, the directive fails as non-retryable. Context is never silently truncated. The user is warned when a chain is near the limit (Q67, Q82).

## Edge cases

| Situation | Behavior |
|---|---|
| B fails before showing any answer text | The failure notice fixes the bubble's position; a successful retry fills that bubble |
| B fails after partial text, Standard policy | "Retrying…" status; the retry streams beneath the collapsed partial text in the same bubble |
| The user stops B while J is queued on the join-back | J is paused, not cancelled |
| The user picks "Continue without activities" and B is later retried successfully | B′ runs as a descendant of the join-back; the completed J gets a superseded-input note with Regenerate |
| A composite has one finished, one failed, and one stopped section, and the user retries the request | Only the failed and stopped sections run again |
| The tab is closed mid-answer and reopened, Standard policy | The attempt is marked interrupted and retried automatically within the retry limit |
| B is interrupted while A has completed, Manual policy, then retried by the user | The group had closed with B marked interrupted; the retry runs as a descendant of the join-back |
| Same, Standard policy | B is retrying automatically, so the group stays open and the retry is still a sibling |
| The user stops B with partial text showing, then retries it | The retry streams in the same bubble beneath the collapsed stopped text |
| The user stops a whole request while its dependent part is still queued | The running sections are stopped; the queued part is cancelled |
| Out of provider credits | Non-retryable; the directive fails with a message saying so |

## Acceptance conditions

- **F1.** A failed directive is visibly identified, does not stop unfinished siblings, and does not mark the overall request failed.
- **F2.** Stopping a section leaves unrelated requests running and preserves visible partial text.
- **F3.** Transient failures retry per the user's retry setting (Standard by default) with status text only; non-retryable errors go straight to failed.
- **F4.** Each retry is a new attempt that never consumes earlier partial text.
- **F5.** J paused on a failed or stopped B never runs on a subset; it waits for the user's Retry, Continue without, or Cancel choice.
- **F6.** A failed or stopped member that is not retrying lets the group close; a retry after closure runs as a descendant of the join-back.
- **F7.** Mixed-result requests show per-section states and a count, never an overall failed or cancelled label.
- **F8.** Retrying a request reruns only unfinished sections.
- **F9.** An interrupted attempt is labeled interrupted and offers the same retry choices; under Standard and Persistent it retries automatically within the retry limit.

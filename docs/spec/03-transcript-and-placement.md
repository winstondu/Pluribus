# 03 · Transcript and placement

Where things appear in the visible conversation, and when.

## Order

- **User messages keep submission order, always** (Q13). Split messages are the one refinement: they appear in dependency order ([messages and decomposition](02-messages-and-decomposition.md)).
- **A reply takes its position when its first answer text becomes visible, and never moves afterwards** (Q14). Completion order does not reorder anything.
- Status text ("Retrying…", "Waiting for capacity") is not answer text and fixes nothing.
- A failure notice does count: a reply that fails before any answer text is fixed where it was when it failed (Q51).
- Replies with no result dependency between them can therefore **overtake**: if B shows text first, B sits above A's pending bubble even though A was requested first (Q12).
- Overtaking never bypasses a dependency. A dependent reply cannot show its answer before the result it needs is available.

## Pending work

- A directive with no answer text yet is shown as a **responding bubble**, which is pushed down as other replies take their places.
- Pending status is shown on the responding bubble or pending section. There is no status badge on the user message and no up-arrow to earlier pending work (Q81).
- A pending section inside a reply group that has already been placed stays inside that group. The reply is one unit with its sections, so nothing further is needed to find it (Q93).

## Reply groups

- An independent composite gets one reply group for the original message. The group's position is fixed by its first section's first output. Within the group, sections take their positions at their own first output, and pending sections may be overtaken. Later sections stay in the group (Q18).
- An explicit output order in the request takes precedence over first-output ordering (Q18).
- While results are mixed, the group header shows a compact count, such as "2 done · 1 failed · 1 stopped". There is never an overall failed or cancelled label (Q50).

## Responses that are never inserted into earlier ones

| Case | Where the new output goes |
|---|---|
| A clarification question, and the answer that follows it | Additional responses after the initial one; the earlier sectioned response is not reopened (Q23) |
| A revision's replacement | A new response at its own first output, never inside the original bubble or group (Q38) |
| A retry after failure with no output | The same bubble (Q51) |
| A retry after partial output | The same bubble: the failed or stopped partial text collapses, keeping its mark, and the retry streams beneath it. A retry is the same request, so it is not a new response (Q83, Q96) |

## What supersession and stopping leave behind

| State when it happened | Transcript |
|---|---|
| Superseded while status-only | The responding bubble is dropped without a trace (Q38) |
| Superseded with answer text visible | Text stays in place, collapsed, marked "Superseded — revised below", linked to the replacement (Q38) |
| Superseded after finishing | Stays, marked superseded, linked to the replacement (Q38) |
| Stopped by the user | Visible text stays, marked partial and stopped (Q22) |
| Cancelled before starting | Marked cancelled; there is no text (Q91) |
| Failed | Visible text stays, marked failed (Q47) |

## Lifecycle noise

Automatic forks and join-backs add nothing to the chat. Context relationships are shown by the association views ([debug views](09-debug-views.md)), not by messages (Q31).

## Scrolling

- While the reader is at the live bottom, follow new output.
- If the reader has scrolled away, keep their position and show "New output ↓" (Q15).

## Composer queue

- A submitted message appears in the transcript immediately, in submission order (Q16).
- If it waits on in-flight work, a linked **queue item** above the composer says why and names what it waits for. The item clears when processing begins; the message stays in the transcript.
- For a dependency on a full join-back, the named prerequisite is the whole sibling group, including members admitted before it closes.
- Work that is free to proceed is never shown as dependency-queued.

Queue item wording changes with the situation: "Revised · waiting for neighborhoods + activities" after a revision to queued work (Q41); "Paused — activities failed" with recovery choices when a prerequisite fails (Q48).

## Acceptance conditions

- **P1.** If independent B starts showing an answer before A, B appears ahead of A's pending bubble even though A was requested first.
- **P2.** If A starts showing an answer first but B completes first, A stays ahead of B.
- **P3.** User message A remains before user message B in both cases.
- **P4.** B's answer is accessible while A is in progress.
- **P5.** A reader who scrolled away is not pulled to new output; a reader at the live bottom follows it.
- **P6.** A result-dependent follow-up has a visible queued indicator above the composer; independent work is not shown as dependency-queued.
- **P7.** Pending status appears on A's responding bubble; user message A carries no status badge and there is no up-arrow to pending work.
- **P8.** A composite reply group keeps its position after first output; an explicit output order is honored.
- **P9.** A clarification-derived answer appears as a later response, not as a retroactive insertion into the original answer group.
- **P10.** A status-only bubble disappears on supersession; visible partial or finished text stays in place, marked superseded and linked to the replacement.
- **P11.** A replacement appears as a new response, never inside the original bubble or group.
- **P12.** A reply that failed before any output stays fixed where it failed; its retry fills the same bubble.
- **P13.** A retry after visible partial output streams in the same bubble beneath the collapsed, failed partial text, not as a new response.

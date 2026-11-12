# 10 · Front-end interface

Two things live here: what the user sees and can do, and the interface between the client and the Committee backend that makes it possible. The behavior behind each control is specified in documents 02–08; this document is the inventory a front-end builder works from.

The selected chat style is **Sections**, illustrated by the [chat prototype](../../prototypes/ui/chat-directions.html). The prototype shows style only: it predates responding bubbles, first-output placement, and local failure. Visual styling beyond the selected direction is the builder's choice. The inspection views are in [debug views](09-debug-views.md).

## Part 1: What the user sees

### Screens

| Surface | Contents |
|---|---|
| Conversation list | The user's conversations; create, open, delete (Q70) |
| Transcript | User messages and replies for one conversation |
| Composer | Text entry, with queue items and elicitation modals above it |
| Settings | See [user settings](#user-settings) |
| Inspection views | Margin rails, Focus, and the split link (with Compare for split messages) are always available; the mini-map, operation graph, run inspector, and Compare for independent composites are behind debug toggles. See [debug views](09-debug-views.md) |

### Transcript elements

| Element | Appearance and rules | Spec |
|---|---|---|
| User message | Appears at once, in submission order | [03](03-transcript-and-placement.md) |
| Split messages | Ordinary user bubbles joined by a faint "split from one message" link that opens Compare; **Undo split** while available | [02](02-messages-and-decomposition.md) |
| Responding bubble | Placeholder for a directive with no answer text; carries pending status; pushed down as other replies take their places | [03](03-transcript-and-placement.md) |
| Reply | Fixed in place from its first answer text | [03](03-transcript-and-placement.md) |
| Reply group | One group per composite message, a section per fragment, each progressing on its own; header count when results are mixed | [03](03-transcript-and-placement.md) |
| Additional response | Clarification questions and the answers they unblock; revision replacements | [03](03-transcript-and-placement.md) |
| Superseded attempt | Collapsed, marked, linked to its replacement | [06](06-revisions.md) |
| Failed, stopped, or interrupted attempt | Visible text kept, labeled with its state | [08](08-failure-and-recovery.md) |
| Superseded-input note | Quiet note on completed work whose input was replaced, with Regenerate | [06](06-revisions.md) |
| Margin rails and Focus | Always-available chain association for each message | [09](09-debug-views.md) |
| "New output ↓" | Shown when new output arrives while the reader is scrolled away | [03](03-transcript-and-placement.md) |

### Controls

| Control | Where | Effect |
|---|---|---|
| Send | Composer | Submits a message |
| Reply to this | Each answer section | Sets an explicit reply target for the next message |
| Stop | Each running section; each request | Stops that section, or all unfinished work for the request |
| Retry | A failed, stopped, or interrupted section; a request | Starts a new attempt; on a request, only its unfinished sections |
| Regenerate | Completed work with a superseded-input note | Cancels any of that work still in progress and redoes it against the new version |
| Undo split | Split messages, until one shows answer text or gets a reply | Restores one atomic request |
| Retry / Continue without / Cancel | A paused queue item | The recovery choice |
| Choose section | Target-ambiguity modal above the composer | Picks among candidate sections (Q95) |
| Choose work to redo | Choice-with-default modal above the composer | Edits the pre-selection until the default runs (Q95) |
| Answer | Clarification question | Reply to the question through its reply affordance; an untargeted next message may also be recognized as the answer (Q98) |

There is no Revise control. A revision is recognized from the wording of a submitted message (Q79).

### Composer queue

Items above the composer, each linked to its message in the transcript. An item names what the message waits for and clears when processing begins ([03](03-transcript-and-placement.md#composer-queue)).

### Fixed wording

Text the specification pins down. Other copy is the builder's choice.

| Text | Where |
|---|---|
| "New output ↓" | Scroll affordance |
| "split from one message" | Link joining split messages |
| "Retrying…" | Status during automatic retries |
| "Waiting for capacity" | Status while held by a provider's rate limit |
| "Revised · waiting for neighborhoods + activities" (pattern) | Queue item after revising queued work |
| "Paused — activities failed" / "… stopped" (pattern) | Queue item for a paused request |
| "Superseded — revised below" | Collapsed superseded partial text |
| "Based on superseded neighborhood recommendations" (pattern) | Superseded-input note |
| "Replying to the revised version" | Reply aimed at a superseded section |
| "Redid J by default" (pattern) | Small note at the bottom of redone work after a default ran |
| "2 done · 1 failed · 1 stopped" (pattern) | Mixed-result group header |
| "Out of OpenRouter credits" | Failure message for exhausted credits |

### States a section can show

Pending (responding bubble), streaming, completed, failed, stopped, interrupted, cancelled, superseded. A request as a whole never shows failed or cancelled.

### Accessibility and motion

- Hover and keyboard focus both preview chain association; click or tap pins it.
- Views that animate respect the reduced-motion preference.
- New output never moves the viewport of a reader who has scrolled away.

### User settings

| Setting | Default | Notes |
|---|---|---|
| Retry policy | Standard | Standard, Persistent, or Manual (Q47) |
| Wait before a default choice runs | 30 seconds | (Q45) |
| Concurrency limit | 4 | (Q60) |
| Model per role | — | Answers (including work continuing from a join-back), decomposition, synthesis for join chains, decisions (Q65, Q90) |
| Decision confidence thresholds | Tuned on the routing corpus | Sent to the backend (Q74) |
| Dependency attachment | Strategy selection by rules; configured strategy, used when selection is off: tree walk, long unbranched runs searched; hop between branch points off; candidate sections from the lexical index; decision budget 2% of the conversation's log; context summaries off | The referent strategy and start at the trunk base, both used when selection is off; hop between branch points, used whenever the tree walk runs: a message about a section inside an unbranched run continues from the run's last section, which saves decision tokens and makes the answer read everything after the relevant part of the run; strategy selection (off, rules, or decision model); the candidate source (none, or the lexical index); the decision budget (absolute, or a share of the conversation's log); whether context summaries are used and generated ([architecture](11-architecture.md#dependency-attachment)) |
| OpenRouter key | None | Pasted by the user; settings show only whether a key is configured (Q64, Q73) |
| Debug view toggles | — | Mini-map, operation graph, run inspector, Compare for independent composites (Q87, Q94) |
| Where Compare is shown | Side panel | Side panel, or a card on the decomposed message in the transcript, opened from the message header (or, for split messages, from the “split from one message” link). With the card, the side panel has no Compare tab |

Retry policy, models, and keys apply to the whole app. Session-wide requirements belong to one conversation (Q70).

## Part 2: Client and backend

The backend owns all coordination: routing, scheduling, context assembly, and records. The client renders state and sends the user's intentions. The same interface serves a backend embedded in the browser and, later, one on a server (Q55, Q62).

### Shape of the interface

- The client sends **commands**.
- The backend sends an ordered stream of **domain events and projection updates**.
- The client can request the backend's **current state** (a projection snapshot) at any time, for example on load or reconnect.
- In the embedded deployment the backend runs in a Web Worker; closing the tab interrupts running work. A server deployment uses WebSocket, or SSE with POST.

### Commands

| Command | Carries | Spec |
|---|---|---|
| Submit message | Text; optional explicit reply target(s) | [05](05-reply-targets-and-routing.md) |
| Stop | A section, or a whole request | [08](08-failure-and-recovery.md) |
| Retry | A section, or a whole request | [08](08-failure-and-recovery.md) |
| Regenerate | An item with a superseded-input note | [06](06-revisions.md) |
| Continue without | A paused request | [08](08-failure-and-recovery.md) |
| Cancel | A paused request | [08](08-failure-and-recovery.md) |
| Answer elicitation | The elicitation and the user's choice | [07](07-elicitation.md) |
| Undo split | A set of split messages | [02](02-messages-and-decomposition.md) |
| Change settings | The settings above | — |
| Create, list, delete conversation | — | (Q70) |

The list is as corrected by Q79. Revision is not a command.

### What the client reads

Four projections, each kept current by the event stream (Q58):

| Projection | Feeds |
|---|---|
| Transcript | Messages, reply groups, sections and their states, positions |
| Queue | Composer queue items and elicitations awaiting an answer |
| Genealogy | Margin rails, Focus, mini-map |
| Operation graph | Operation graph view |

The client never decides placement, ordering, dependencies, or context. It displays what the projections say.

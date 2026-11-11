# 02 · Messages and decomposition

How a submitted message becomes one or more directives.

## Atomic or composite

- The **original message** is always preserved exactly as typed (Q3).
- A message is **composite** only when it contains independent intents that can be answered separately. Split conservatively: several topics are not evidence of several intents. Tightly related topics, a requested contrast, or one integrated output stay **atomic** (Q4).
  - Atomic: "Explain caching and indexes for beginners."
  - Composite: "Explain why the sky is blue, and separately translate this menu into French. Keep both accessible to a beginner."
- Each **fragment** of a composite carries the requirements that apply to it and a link to its source text. Both the source span and any rewritten fragment text are recorded, so a lost requirement can be traced to decomposition.
- Fragments are not joined afterwards merely because they came from one message (Q3).

## Requirement scope

- A requirement is **local** by default: it covers the request or fragments it was addressed to (Q17).
- It is **session-wide** only when the user says so explicitly, for example "from now on" or "in this chat". Session-wide requirements apply across all chains in that conversation, and never across conversations (Q17, Q70).
- A **shared requirement** within one message is given to every fragment it applies to (Q4).

## How a composite is shown and run

**Independent parts.** The message stays one user message. Its answer is one reply group with a section per fragment, each progressing on its own (Q9, Q18). See [transcript and placement](03-transcript-and-placement.md).

**Sequential parts.** When a later part needs an earlier part's result, the message is shown as separate user messages, the **split messages** (Q53):

- They appear immediately, as ordinary user bubbles, joined by a faint "split from one message" link that opens the Compare view with the exact original text. This is surfaced to every user; for an independent composite, Compare is a debug view (Q94).
- Order is topological: every split message appears after the ones it depends on. Parts that do not depend on each other keep their original textual order. With A already sent and one message asking for B, C, and J (where J needs A, B, and C), the bubbles appear as B, C, J.
- Each split message is its own target for replies, revisions, and stops. A dependent one gets the usual queue item.

**Undo split** restores one atomic request. It is offered only until any split message shows answer text or receives a reply. Using it stops any running attempts, drops their status-only bubbles, and restarts the work as one atomic request (Q53, Q85).

## Ready and blocked parts

- A fragment that needs nothing unavailable proceeds at once. Only a fragment that needs an unavailable result is dependency-queued; its queue item names the waiting part and what it waits for (Q19).
- **Whole-request barrier.** If the message relates its outputs to one another (an explicit order, a combined limit, an integrated presentation) and any part is blocked, the whole request waits. This is a deliberate scheduling constraint, not buffering of an answer already generated (Q19, Q25).
- A requirement that can be applied to each part separately, such as "each answer under 100 words", creates no barrier (Q25).
- Clarification questions are never held back by the barrier (Q26). See [elicitation](07-elicitation.md).

## Edge cases

| Situation | Behavior |
|---|---|
| A recommendation is in flight; the user sends "Summarize that recommendation and separately translate this menu" | The translation runs now; the summary is dependency-queued |
| Same, plus "but put the translation first" | The whole request is queued until the recommendation finishes |
| "Translate this menu and explain what happened yesterday" (which event is unclear) | The translation is answered in the initial response; the clarification question and the eventual explanation appear as additional responses |
| "Keep both answers under 100 words total" | A combined limit relates the outputs, so the whole-request barrier applies if a part is blocked |
| A split message has started streaming | Undo split is no longer offered |

## Acceptance conditions

- **D1.** A local brevity instruction does not silently become a session-wide preference.
- **D2.** With a recommendation A in flight, an unrelated translation requested alongside a summary of A can run before A completes.
- **D3.** With an output-order qualifier on that request, the translation does not start before A completes.
- **D4.** Undo split is unavailable once any split message shows answer text or has a reply; before that, it stops running attempts and restarts one atomic request.

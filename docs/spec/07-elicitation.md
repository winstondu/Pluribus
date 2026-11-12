# 07 · Elicitation

When Committee asks the user to decide, and when it may go ahead on its own.

## The four kinds

| Kind | Trigger | While waiting | Default? |
|---|---|---|---|
| **Target ambiguity** | An untargeted reply could plausibly address different answer sections (target confidence below the threshold). Not raised when routing the reply reached its [decision budget](11-architecture.md#decision-budget): the best node found so far is used | The reply is not acted on | Never. The user chooses among existing sections (Q10, Q20, Q74) |
| **Clarification** | Missing information, or incompatible user requirements, blocks a directive | Unaffected work proceeds; the affected answer waits | Never (Q23, Q26, Q34) |
| **Choice with default** | Committee can propose a reasonable action, but its scope is the user's call | Affected running work stops; affected queued work holds; unaffected work continues | Yes (Q42, Q44–Q46) |
| **Recovery choice** | A dependency-queued request's prerequisite failed, was stopped, or was interrupted | The request stays paused | Never (Q48, Q52) |

**Where each appears.** Clarification questions are additional responses in the transcript. The recovery choice is on the paused request's queue item. Target-ambiguity and choice-with-default elicitations appear as a modal above the composer (Q95).

## Clarification

- Questions appear immediately as additional responses, even when a whole-request barrier is holding the answer work (Q26).
- Directives that are not affected proceed and are answered in the initial response. The clarification question, and later the answer it unblocks, appear as additional responses. The earlier sectioned response is never reopened (Q23).
- An ambiguous shared requirement blocks every fragment it applies to.
- Answer work proceeds only when both the required information and any prerequisite results are available.
- A clarification question carries a reply affordance like any answer section. A reply targeted at it is the answer. An untargeted next message has its target inferred as usual and may be recognized as the answer (Q98).
- Work that draws on several results asks only for a consequential missing preference or incompatible requirements, not for every disagreement between its sources (Q34).

## Choice with default

Used for a revision to a shared requirement ([revisions](06-revisions.md#revising-a-shared-requirement)).

- Committee lists the work it judges may need redoing and pre-selects the work it judges actually affected. This is a bounded selection among existing items (Q44).
- The default is carried out when the user sends another message without answering, or when the wait elapses. The wait is a user setting, 30 seconds by default (Q45).
- The choice stays editable until the default is carried out. What happened is then recorded on the work itself: if the work was still in flight, the redone work carries a small note at its bottom, for example "Redid J by default"; if it had already finished, the redo is a new response (Q45, Q95).
- Work that was running and was stopped for the wait cannot be deselected; it is always redone. Queued affected work always picks up the change. The choice applies to finished work (Q44, Q84).

**When a default is allowed.** Only when the default is a reasonable, reversible action. Any new kind of elicitation may adopt a default only if it meets that bar (Q46).

## Recovery choice

Shown on the paused request's queue item, naming the cause, for example "Paused — activities failed". The choices are to retry the prerequisite, continue without it, or cancel the paused request ([failure and recovery](08-failure-and-recovery.md#dependents-of-work-that-did-not-finish)). Committee waits for as long as it takes.

## Acceptance conditions

- **E1.** Clarification questions are not blocked by the whole-request answer barrier.
- **E2.** Incompatible user requirements or a consequential missing preference elicit clarification.
- **E3.** A shared-requirement revision elicits which affected work to redo, and the default executes without a response; unchosen finished work keeps its result with the superseded-input note.
- **E4.** Affected work that was running when a shared requirement was revised cannot be deselected and is redone.

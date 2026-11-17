# 07 · Elicitation

When Pluribus asks the user to decide, and when it may go ahead on its own.

## The four kinds

| Kind | Trigger | While waiting | Default? |
|---|---|---|---|
| **Target ambiguity** | An untargeted reply could plausibly address different answer sections (target confidence below the threshold). Not raised when routing the reply reached its [decision budget](11-architecture.md#decision-budget): the best node found so far is used. Not raised either when the reply brings several lines of work together: the lines are joined ([reply targets](05-reply-targets-and-routing.md#joining-instead-of-asking)) | The reply is not acted on | Never. The user chooses among existing sections (Q10, Q20, Q74) |
| **Clarification** | Missing information, or incompatible user requirements, blocks a directive | Unaffected work proceeds; the affected answer waits | Never (Q23, Q26, Q34) |
| **Choice with default** | Pluribus can propose a reasonable action, but its scope is the user's call | Affected running work stops; affected queued work holds; unaffected work continues | Yes (Q42, Q44–Q46) |
| **Recovery choice** | A dependency-queued request's prerequisite failed, was stopped, or was interrupted | The request stays paused | Never (Q48, Q52) |

**What is recorded.** A target-ambiguity elicitation records the decision behind it: the questions put to the decision model, their answers, and the thresholds in force. The reply has no routing decision of its own until the user has chosen, so this is what says why Pluribus asked.

**Where each appears.** Clarification questions are additional responses in the transcript. The recovery choice is on the paused request's queue item. Target-ambiguity and choice-with-default elicitations appear as a modal above the composer (Q95).

## Clarification

- Before a directive starts visible answer text, it has a typed readiness result: ready or clarification needed (Q103). Existing routing/decomposition findings may establish readiness; otherwise a preparation step does so. A clarification question is an additional response, not ordinary answer text classified after streaming.

- Questions already identifiable appear immediately as additional responses, even while prerequisites are pending or a whole-request barrier is holding the answer work (Q26, Q105). Remaining readiness checks run after required results arrive, before answer generation; unchanged checks may be reused.
- If generation later discovers consequential missing information, it stops, retains labeled partial text, and asks a clarification question as an additional response. The directive is paused and waiting on user input, not successful or failed. Dependents remain blocked; the eventual answer is another additional response (Q106).
- Directives that are not affected proceed and are answered in the initial response. The clarification question, and later the answer it unblocks, appear as additional responses. The earlier sectioned response is never reopened (Q23).
- An ambiguous shared requirement blocks every fragment it applies to.
- Answer work proceeds only when both the required information and any prerequisite results are available.
- A clarification question carries a reply affordance like any answer section. A reply targeted at it is the answer. An untargeted next message has its target inferred as usual and may be recognized as the answer (Q98).
- Work that draws on several results asks only for a consequential missing preference or incompatible requirements, not for every disagreement between its sources (Q34).

## Choice with default

Used for a revision to a shared requirement ([revisions](06-revisions.md#revising-a-shared-requirement)).

- Pluribus lists the work it judges may need redoing and pre-selects the work it judges actually affected. This is a bounded selection among existing items (Q44).
- The default is carried out when the user sends another message without answering, or when the wait elapses. The wait is a user setting, 30 seconds by default (Q45).
- The deadline persists across tab closure. If it has elapsed when the app restarts, the default executes once after recovery without asking again (Q101).
- The choice stays editable until the default is carried out. What happened is then recorded on the work itself: if the work was still in flight, the redone work carries a small note at its bottom, for example "Redid J by default"; if it had already finished, the redo is a new response (Q45, Q95).
- Work that was running and was stopped for the wait cannot be deselected; it is always redone. Queued affected work always picks up the change. The choice applies to finished work (Q44, Q84).

**When a default is allowed.** Only when the default is a reasonable, reversible action. Any new kind of elicitation may adopt a default only if it meets that bar (Q46).

## Recovery choice

Shown on the paused request's queue item, naming the cause, for example "Paused — activities failed". The choices are to retry the prerequisite, continue without it, or cancel the paused request ([failure and recovery](08-failure-and-recovery.md#dependents-of-work-that-did-not-finish)). Pluribus waits for as long as it takes.

## Acceptance conditions

- **E1.** Clarification questions are not blocked by the whole-request answer barrier.
- **E2.** Incompatible user requirements or a consequential missing preference elicit clarification.
- **E3.** A shared-requirement revision elicits which affected work to redo, and the default executes without a response; unchosen finished work keeps its result with the superseded-input note.
- **E4.** Affected work that was running when a shared requirement was revised cannot be deselected and is redone.

- **E5.** Visible answer generation starts only after typed readiness is established. Known questions are asked while prerequisites are pending, with remaining checks after results arrive. Late clarification pauses the directive for user input, retains partial text, and does not release dependents; unaffected work proceeds (Q103, Q105, Q106).

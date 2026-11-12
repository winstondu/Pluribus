# Typed readiness, pausing for input, and the compatibility list

Build record for 07 · "Clarification" (Q103, Q105, Q106), 08 · the pause for user input, 11 · "Pipeline" stage 4 and "Models" (Q107), and acceptance condition E5. The specification is authoritative; this says how it was built and what the build chose where the text leaves room. The implementation interview (Q99–Q107) is not in the repository, so the readings below are from the specification's sentences alone; they are listed at the end.

## The typed result

`Readiness` (`packages/protocol/src/model.ts`) is `{ kind: 'ready' }` or `{ kind: 'clarification-needed', reason, question, about }`. A directive's current result, with what established it, is a `ReadinessRecord`: `source` (`routing`, `preparation`, `answer`, `generation`), `awaitingResults`, `basis`, `model`. It is recorded by the event `directive-readiness-established`, kept on the directive (`DirectiveRow.readiness`) and shown in the run inspector. Replay folds the events; nothing is asked again.

The rule that enforces E5's first clause is one function, `readinessStands` (`packages/core/src/engine/readiness.ts`): an answer directive's run is sent to the model only when its record is `ready`, was not established while results were still awaited, and, if a preparation step made it, was made for exactly this input. The scheduler and `beginAttempt` both use it.

## Who establishes it, and when the preparation step runs

| Source | When | Model call |
|---|---|---|
| `routing` | When the plan is carried out. A unit a clarification blocks is `clarification-needed`; every other unit is `ready`. For a unit that waits for a result the finding is provisional (`awaitingResults`) | None beyond routing's own |
| `preparation` | When a directive is released and its record does not stand: it waited for results that have now arrived, its request was revised in place, or it has no record (a log from before this change) | One structured call on the decomposition model |
| `answer` | When the user answers its clarification question | None |
| `generation` | When its run stops to ask (below). Always `clarification-needed` | None: the signal arrives in the run's own stream |

**The preparation step is skipped for every directive that never waited for a result.** That is the common case (a new question, a reply that builds on finished work, each independent fragment of a composite), and for it routing's finding is the readiness result at no cost. The step runs only where the specification says a check remains: "remaining readiness checks run after required results arrive, before answer generation" (Q105). Why not for every directive: it would add a model call and its latency to every answer, and routing has already asked the clarification question of every unit.

What the step costs when it does run: one non-streaming call on the decomposition model (`anthropic/claude-haiku-5.5` by default) whose input is the answer run's own input, so about the answer's input tokens at the cheap model's price, plus a few dozen output tokens. It takes no concurrency slot and runs while the directive waits for one. "Unchanged checks may be reused": the record carries a digest of the input it checked (`basis`, `inputDigest`), so a retry, or a restart after an interruption, with the same input does not call it again; a changed input (a prerequisite was revised) does.

A preparation step that fails establishes nothing, so no answer is generated: the directive's attempt is recorded as failed before it reads anything, and the retry setting applies as for any execution error. Core does not guess `ready`.

The port is `Preparer` (`packages/core/src/ports/preparer.ts`), a required member of `CoreDependencies`. `ScriptedPreparer` (`@committee/core/testing`) answers `ready` unless scripted and records every request. `createOpenRouterPreparer` (`packages/providers/src/openrouter/preparer.ts`) sends the run's input as one quoted transcript under a strict JSON schema, so the model judges the request and cannot answer it.

## Timing (Q105)

- A question routing can identify is asked at once: the question is a directive of its own that waits for nothing and is never held by the whole-request barrier, so it is out while a prerequisite is pending or the barrier holds the answer work. This was already so (E1); what is new is that the blocked directive is `paused` with reason `awaiting-input`, and that its readiness says so.
- An answer given while a prerequisite is still pending leaves the directive waiting for the result alone; its record is `ready`, `awaitingResults: true`, so the remaining check runs when the result arrives.
- The remaining check is the preparation step above. If it finds a question, the question is an additional response whose text is recorded at once (no answer run writes it), and the directive is paused.

## Late clarification (Q106)

The model provider port has a typed terminal stream event, `clarification-needed` (`reason`, `question`, `usage`), beside `completed`, `failed` and `cancelled`. Core asks for it with `ModelRequest.clarificationSignal`, set for answer and synthesis runs and never for a clarification question's own run.

How the OpenRouter provider carries it: on a model the compatibility list marks for it, the request has one function tool, `ask_user_for_clarification` (`question`, `reason`), with `tool_choice: auto`. A call to it arrives as `tool_calls` deltas, apart from the answer text, and ends the run with the typed event; text streamed before it stands as partial output. A call that cannot be read as a question is `malformed-response`, never a pause. Nothing is classified after streaming, and `ModelRequest` still has no tools: the tool is the wire form of the signal inside the provider.

What core does with the event, in one step: `attempt-paused` (the attempt's state is `paused`, its text kept), `directive-readiness-established` (`generation`), then the clarification: the elicitation, the question as a directive and an additional response with its text, and `directive-held` with reason `clarification`, which pauses the directive. The directive is neither completed nor failed: nothing that waits for it is released (invariant 4) and no recovery choice is raised for its dependents, which stay dependency-queued. A paused member keeps its sibling group open. Other work is untouched.

When the user answers (a reply to the question, or a message recognised as the answer, Q98), the answer is another additional response: a new section in a `clarified-answer` response. The section that was paused is superseded with cause `clarified`: its partial text stays in place, marked "Partial — answered below" and linked to the answer; a bubble that showed no text is dropped. The new run reads its request, then every question it was asked with the user's answer, in order, and never the partial text (invariant 7).

## One paused state, two reasons

`DirectiveState` `paused` now covers both pauses of the glossary, told apart by `PauseReason` on `DirectiveRow.pause`:

| Reason | Raised by | Shown | Resumes by |
|---|---|---|---|
| `awaiting-input` | A clarification, before the work starts or after a run stopped to ask (`directive-held`, reason `clarification`) | The question, in the transcript. The section state `paused` ("Paused — waiting for your answer") when the work has a section; no queue item | The answer. Cancel is accepted (cancelled if it never ran, stopped with its text if it did); Continue without and Retry are refused |
| `dependency-recovery` | A prerequisite that failed, was stopped or was interrupted (`directive-paused`) | The queue item, "Paused — activities failed", with Retry / Continue without / Cancel | The recovery choice |

`awaiting-elicitation` is left for work held by a choice with default. Projections: `SectionView.pause` and the section state `paused`; `OperationView.pauseReason` under the one status `paused`; the mini-map's node state `paused`; `RunInspection.readiness` and `pauseReason`; the queue lists only dependency-recovery pauses. A clarification question whose work was stopped, cancelled or replaced while it was open is withdrawn.

Stored logs stay readable: the two new events are additions, `EVENT_SCHEMA_VERSION` is unchanged, and `STATE_VERSION` is 4, so cached state is rebuilt from the log. A directive held for a clarification in an older log folds to `paused` with reason `awaiting-input`.

## The compatibility list (Q107)

`MODEL_COMPATIBILITY` (`packages/protocol/src/models.ts`) lists the models the answer and decomposition roles may be set to, each with what it was tested for:

| Model | Structured preparation | Streamed clarification signal | Tested |
|---|---|---|---|
| `anthropic/claude-sonnet-5.5` | yes | yes | 2026-11-12 |
| `anthropic/claude-haiku-5.5` | yes | yes | 2026-11-12 |

A model is added only with a live run that covers it: `packages/providers/src/readiness.smoke.test.ts` runs both checks against every listed model. The model selector offers only the list for those two roles, with no free-text ID; `validateSettingsPatch` refuses anything else; and stored settings that name an unlisted answer or decomposition model are normalised to that role's default when they are read (`normalizeModels`), silently. Synthesis is not restricted (the specification names answer and decomposition only); a synthesis model that is not on the list runs without the signal. The decision model stays pinned.

## How the specification was read

- **"Paused" before the work starts.** The glossary's "Paused" is work waiting for user action, and 08 says a directive waiting on clarification "can also be paused, including after partial output". So a directive blocked by a clarification from the start is `paused` too, not only one that ran. 01 · "The unit of work" still describes Paused as the dependency case only.
- **Cancel on work paused for input.** The command table keeps "Cancel | A paused request" while Continue without is narrowed to dependency recovery, so the Cancel command is accepted for both reasons. The Controls table puts Retry / Continue without / Cancel on the dependency-recovery queue item only, so the interface shows no Cancel for work paused for input; its request's Stop does the same.
- **The question's text.** "A clarification question is an additional response, not ordinary answer text classified after streaming" is read as: the question never passes through the answer stream. A question routing identifies is still written by a question run of its own (an additional response from the start); one found by the preparation step or by a running answer arrives as typed data and is recorded as given.
- **"Retains labeled partial text."** The label is "Paused · partial" while paused and "Partial — answered below" afterwards; both are build wording.
- **"Reuse routing/decomposition findings when sufficient."** Read as sufficient exactly when the directive waited for no result. Decomposition contributes through the plan it shapes; it makes no readiness finding of its own.
- **Roles.** "Structured preparation and streamed clarification signals for the relevant roles" is read as: preparation on the decomposition model (the structured-output role), the signal on the answer model.

## Not done

- The readiness questions routing asks were not changed: routing's finding is the decision model's existing `needsClarification` answer against its threshold.
- No end-to-end browser flow exercises a clarification; the paused state was looked at in the fixture gallery (`?fixture=paused-awaiting-input`).
- The live check shows that both listed models return the typed result and the signal on prompts built to need them. How often an answer model signals when it should not, or does not when it should, is not measured.

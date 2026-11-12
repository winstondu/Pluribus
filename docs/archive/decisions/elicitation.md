> **Archived.** Historical record, kept read-only and no longer maintained. The current specification is [docs/spec/](../../spec/README.md); see the [archive README](../README.md) for how to read this file.

# Elicitation methods

Cross-cutting patterns for asking the user to decide. Scenario docs reference this file rather than redefining the UX.

## Kinds of elicitation

| Kind | Trigger | Waiting behavior | Source |
|---|---|---|---|
| Target ambiguity | An untargeted reply could plausibly address different answer sections (target confidence below the threshold) | No silent guess; user chooses among existing sections | Q20, Q74 |
| Clarification | Missing information or incompatible user requirements block a fragment | Questions appear immediately as additional responses; unaffected work proceeds; the affected answer waits | Q23, Q26, Q34 |
| Choice with default | Committee can propose a reasonable action but the scope is the user's call | The default executes if the user does not respond | Q42, Q44–Q46 |
| Recovery choice | A dependency-queued request's prerequisite failed, was stopped, or was interrupted | The request stays paused; no default. Choices: retry the prerequisite, continue without it, or cancel | Q48, Q52 |

## Choice with default

Used first for shared-requirement revisions (Q42): Committee lists the work it judges may need redoing and asks which to redo, preselecting a default. If the user does not respond, the default executes. Answering differently overrides it.

### Q44: The default

Pre-select the work Committee judges is actually affected (for a four-day trip: J, the itinerary, not A or B). Jev may make this bounded selection among existing items. Queued affected work always picks up the change. Unselected finished work keeps its result with the superseded-input note and Regenerate (Q40).

### Q45: No response and waiting

The default executes when the user sends another message without answering, or when the wait elapses. The wait is a user setting, defaulting to 30 seconds. While waiting, affected running work stops immediately, affected queued work holds, and unaffected work continues. The choice stays editable until the default executes; afterwards the elicitation records what happened (e.g. “Redid J by default”).

### Q84: Stopped work cannot be deselected

Affected work that was running, and was stopped for the wait, cannot be deselected: it is always redone under the revised requirement. The user's choice applies only to finished work.

### Q46: Where defaults are allowed

Only for choices whose default is a reasonable, reversible action. Target ambiguity (Q20) never silently guesses, clarification (Q23) waits for the user, and the recovery choice (Q48) has no default. A new elicitation kind may adopt a default only if it meets this bar.

---
status: accepted
---
> **Archived.** Historical record, kept read-only and no longer maintained. The current specification is [docs/spec/](../../spec/README.md); see the [archive README](../README.md) for how to read this file.

# Revisions supersede attempts and propagate along dependencies

A revision (corrective wording only) supersedes the affected attempt instead of rewriting it. A running attempt is stopped and its replacement starts with rewound context: visible partial text stays in the transcript, marked superseded, but is excluded from the replacement's context. A finished attempt remains chain history, and its replacement is a follow-up. Dependent work follows actual dependencies: queued work retargets to the replacement, running work restarts, and completed work is left intact with a superseded-input note and a manual Regenerate action. Later context uses the correction plus the replacement in place of the superseded body; historical runs keep what they consumed.

A revision of a shared requirement (Q42) instead elicits which affected work to redo, with a default that executes without a response. Replies to a superseded section target its replacement (Q43).

Alternatives rejected: in-place rewriting (loses history and breaks ADR-0003's fixed positions), carrying both versions into later context (tokens and mixed requirements), and automatic regeneration of completed dependents (cost, and the user may accept the existing result).

# Committee design archive

This folder is history. It holds the architecture decision records (ADRs) and the question-by-question decision records (Q1–Q98) from which Committee's specification was written. Nothing here is maintained, and nothing here should be edited except to repair links.

**The current specification is [`docs/spec/`](../spec/README.md)**, starting at [`docs/spec/README.md`](../spec/README.md). Terms are defined in [`docs/spec/glossary.md`](../spec/glossary.md). Where an archived file and the spec disagree, the spec wins.

## How to read these records

- **Later answers supersede earlier ones.** The user's standing rule: a later answer supersedes an earlier one wherever the two clearly conflict. In the user's words: “later answers supercede the responses to earlier ones, if there is a clear conflict.” Question numbers give the order of answers, so a higher number wins a clear conflict. Some older files state a different precedence (for example, the technical design says scenario decisions override it); the standing rule takes priority over those statements.
- **Quoted text is the user's own words.** Recommendations, context and “Decision” lines are summaries written at the time.
- **Status lines and cross-references reflect the moment each file was last edited**, not the current spec. Mentions of `spec.md`, `build-scope.md`, `design-index.md`, `open-issues.md` or `GLOSSARY.md` refer to documents that have since been replaced by `docs/spec/` (open issues survive here as [review findings](decisions/review-findings.md)).
- **[decision-index.md](decision-index.md)** lists every question Q1–Q98 with its outcome, whether it was later superseded, and where its record is.

## What is here

### ADRs (`adr/`)

| File | What it is |
|---|---|
| [0001-separate-display-from-execution.md](adr/0001-separate-display-from-execution.md) | Request-ordered display separate from dependency scheduling and selected context. Marked superseded by ADR-0003 (its fixed answer layout was replaced; the scheduling and context parts carried forward). |
| [0002-preserve-chains-through-joins.md](adr/0002-preserve-chains-through-joins.md) | Join chains versus ordinary fork join-back, refined by Q28–Q33, Q78 and Q86. |
| [0003-allow-replies-to-overtake-pending-work.md](adr/0003-allow-replies-to-overtake-pending-work.md) | Replies placed at first visible output and allowed to overtake pending bubbles (Q12–Q15). |
| [0004-revisions-supersede-attempts.md](adr/0004-revisions-supersede-attempts.md) | Revisions supersede attempts and propagate along dependencies (Q35–Q43). |
| [0005-portable-backend-owns-context.md](adr/0005-portable-backend-owns-context.md) | Portable TypeScript backend that assembles every run's context itself (Q55, Q57). |
| [0006-append-only-event-log.md](adr/0006-append-only-event-log.md) | Append-only domain event log with cached projections (Q58). |

### Decision records (`decisions/`)

| File | What it is |
|---|---|
| [early-interview-record.md](decisions/early-interview-record.md) | Q1–Q10 and Q24, recovered from the original design chat, plus a supplemental Q12 entry explaining why Q7's answer order changed. |
| [scenarios/01-independent-requests.md](decisions/scenarios/01-independent-requests.md) | Scenario 1: independent requests finishing out of order (Q11–Q16, Q81). |
| [scenarios/02-composite-requests.md](decisions/scenarios/02-composite-requests.md) | Scenario 2: composite requests, shared requirements, split messages (Q17–Q27, Q53, Q85). |
| [scenarios/03-related-parallel-work.md](decisions/scenarios/03-related-parallel-work.md) | Scenario 3: forks, sibling groups and automatic join-back (Q28–Q32). |
| [scenarios/04-result-dependent-work.md](decisions/scenarios/04-result-dependent-work.md) | Scenario 4: result-dependent work and join chains (Q33–Q34, Q78, Q86, Q88). |
| [scenarios/05-revisions-targeting-ambiguity.md](decisions/scenarios/05-revisions-targeting-ambiguity.md) | Scenario 5: revisions, reply targeting and ambiguity (Q35–Q46, with Q79 and Q84). |
| [scenarios/06-failure-cancellation-recovery.md](decisions/scenarios/06-failure-cancellation-recovery.md) | Scenario 6: failure, partial results, cancellation and recovery (Q47–Q52, Q54, Q83). |
| [elicitation.md](decisions/elicitation.md) | Cross-cutting elicitation kinds and the choice-with-default rules (Q44–Q46, Q84). |
| [technical-design.md](decisions/technical-design.md) | Batch 7 technical design: invariants and Q55–Q77 grouped by area, with Q78–Q88 applied, plus researched integration facts. |
| [mvp-decisions.md](decisions/mvp-decisions.md) | First-version-only choices (Q73). |
| [review-findings.md](decisions/review-findings.md) | The post-Q77 review, formerly `open-issues.md`: findings I1–I11 (all resolved), items left to the build, and a table of stale text corrected at the time. |
| [review-batch-q78-q88.md](decisions/review-batch-q78-q88.md) | Q78–Q88: each question with context, recommendation, the user's verbatim answer, the decision, and the user's confirmation of readings taken. |
| [review-batch-q89-q98.md](decisions/review-batch-q89-q98.md) | Q89–Q98 from the consistency review of `docs/spec/` (all answered, in two rounds), plus the recovered wording of Q11. |

## Not in this folder

- The UI prototypes live in [`prototypes/ui/`](../../prototypes/ui/README.md) and show some superseded layouts.
- The original discussion record (`concurrent-chat-design.md`) is archived as [original-discussion.md](decisions/original-discussion.md). It is the source for the selected visual treatments cited by the spec's debug views as "original discussion".

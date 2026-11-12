# 04 · Chains, dependencies, and context

The detailed rules behind the [mental model](01-mental-model.md): parallel work on a chain, what waits for what, and what each run reads.

Running example. The trip brief is established: Kyoto, five days, November, moderate budget.

1. A: "Suggest neighborhoods to stay in."
2. While A runs, B: "Suggest rainy-day activities."
3. B finishes while A is still in flight.
4. C: "Suggest indoor evening activities." C can use B and does not need A.
5. A finishes. Later the user replies to B: "Give me three cheaper alternatives."
6. J: "Use those recommendations to make a five-day itinerary."

## Forks and sibling groups

- A request that continues a chain while other work from the same starting context is in flight is a **fork**. Siblings do not see each other's in-flight results.
- The **sibling group** is defined by shared starting context, not by overlapping in time (Q32):
  - A request from the same starting context joins the group while it is open. D, starting from the trip brief while A runs, joins A and B.
  - A request that consumes a member's result is that member's descendant. C, which uses B, is not a member.
  - The group closes, and the join-back forms, once every member has completed, or has failed, been stopped, or been interrupted and is not retrying (Q92). Later branches cannot enlarge it, so continuing B on its own never postpones the join-back.
- A member that is still retrying keeps the group open. A retry started after the group has closed runs as a descendant of the join-back, not as a member ([failure and recovery](08-failure-and-recovery.md), Q92).

## Join-back

- Forms automatically when the group closes. No manual merge, no model call, no assistant message (Q8, Q28).
- Records the completed exchanges in submission order, whatever order the answers arrived in. For later context it reads as if the model had answered the first request and then the second.
- It is a child of every member. It does not claim that any member saw another's result: each historical run keeps the context it actually had.
- Work that continues from it is on the chain the siblings forked from, in that chain's color, and is an ordinary answer run: the join-back in effect appends the siblings' exchanges to their common history and the follow-up continues from there (Q90). Each fork, and any later branch from one sibling, has a chain color of its own (Q78, Q89).
- Each member stays independently continuable. The reply to B in step 5 uses B's ancestry and answer and does not import A (Q30).

## Join chains

- A **join chain** is a new chain created when work needs the context of lines that have diverged: leaves of different branches of one tree, or leaves of previously separate trees (Q5, Q76).
- Its parents are always leaves of their chains at the moment it is created. A non-leaf node cannot be a parent (Q86). It may have two or more parents (Q88).
- Source chains remain independently continuable. A later request may go to a source or to the join chain, depending on the context it needs (Q5).
- What a join chain inherited does not grow when its sources later continue.
- Join only when necessary (Q3). Work needing several members of one sibling group uses that group's join-back, not a join chain.

## Result dependencies

- A dependency means needing a result that is not yet available. Topic overlap is not a dependency (Q2). "Which is cheaper?" may be answerable independently; "Expand your second recommendation" is not.
- Dependent work waits for the needed answer to **finish successfully**. Visible streaming text never releases it (Q33).
- A dependency on one answer section needs only that section, not the rest of its reply group (Q33).
- A dependency on a full join-back waits for the group to close and finish. A sibling admitted while the group is open extends the wait; a descendant continuing one sibling does not (Q33).
- **No subset bypass.** Work needing more than one sibling depends on the full join-back. If A, B, and D are siblings, work needing A and B waits for D too (Q30).
- Dependencies must be acyclic.
- When a prerequisite fails, is stopped, or is interrupted, the dependent is paused: see [failure and recovery](08-failure-and-recovery.md).

## Context for a run

Context is assembled mechanically from the genealogy. There is no per-node relevance scoring (Q76).

A run receives:

1. The ancestry of its handling chain, including any join-backs and join chains on that line.
2. Requirements the user explicitly made session-wide (Q17).
3. Where an ancestor was revised: the user's correction plus the replacement, in place of the superseded body (Q39).
4. Where a member of a join-back failed, was stopped, or was interrupted: its request and a marker, without its partial text. If it was retried after the group closed, the retry's exchange follows as a descendant of the join-back (Q49, Q92).
5. When work is retried, the context of everything that depends on it reflects the retry, even at the cost of prompt caching (Q96).

And these hold:

- **Snapshot at start.** A run uses the completed context available when it starts. A result that finishes during the run is not injected (Q29). C keeps the context it started with when A later completes.
- **Unrelated history is excluded** because unrelated work is on a different chain.
- **Exact record.** Each attempt records exactly what it received. Later join-backs, revisions, and retries never rewrite that record (Q31, Q39).
- **Clean restart.** A replacement or retry never receives an earlier attempt's partial text (Q38, Q47).
- **No summaries.** A run's context never contains a summary of earlier work. A context summary, where one exists, is shown only to the decision model while routing ([architecture](11-architecture.md#context-summaries-for-decisions)).
- **Context limit.** Tokens are counted before each run. Near the limit the user is warned; over it, the directive fails as non-retryable. Context is never silently truncated (Q67, Q82).

## Work that draws on several results

Such work, for example J, may reconcile differing recommendations within the established requirements, weigh trade-offs, and explain its choice. It need not ask the user to settle every disagreement. It asks for clarification only when proceeding needs a consequential missing preference or when user requirements are incompatible. Its conclusion belongs to it and never rewrites its sources (Q34).

## Edge cases

| Situation | Behavior |
|---|---|
| A finishes while C is running | C's context is unchanged |
| D is sent from the trip brief while A is still running | D joins the open group; J now waits for D as well |
| The user continues B after the join-back has formed | A new branch from B; it does not inherit A and does not reopen the group |
| J is requested while B is still streaming | J is dependency-queued; B's visible partial text does not release it |
| A later request needs both J and the B-only branch | A join chain whose parents are those two leaves |
| A request needs an earlier, non-leaf node of one chain together with another line | The join chain attaches to the current leaves of those chains. A leaf's ancestry already includes the earlier node, so its content is available (Q86, Q97) |

## Acceptance conditions

- **C1.** With available capacity, B can execute before A completes.
- **C2.** If B needs A's result, B cannot emit its dependent answer before that result is available.
- **C3.** No view claims B consumed A's unfinished answer.
- **C4.** Successful sibling exchanges become available through automatic join-back in request order, regardless of answer order.
- **C5.** Join-back creates no synthesis call and no assistant answer.
- **C6.** C can start using B while A runs when C does not need A.
- **C7.** C's consumed context does not change when A later completes.
- **C8.** An explicit branch from B remains available after join-back and does not automatically inherit A.
- **C9.** A continuation requiring multiple siblings depends on their full join-back, never a subset.
- **C10.** Context inspection preserves the ancestry each historical run actually consumed.
- **C11.** D from the same starting context joins an open A/B group; C consuming B does not.
- **C12.** A closed group and its join-back cannot be enlarged by later branches.
- **C13.** Visible partial source text does not release dependent answer work.
- **C14.** A dependency on a single answer section proceeds when that section successfully finishes, without waiting for unrelated sections.
- **C15.** A full join-back dependency cannot proceed while its group remains open or unfinished.
- **C16.** An additional sibling admitted to the open group extends the full join-back dependency; a descendant continuing one sibling does not.
- **C17.** J can reconcile recommendations within the established brief and explain the trade-off without changing source answers.
- **C18.** A join chain preserves its source chains and the specific ancestry it consumed.
- **C19.** J, continuing from the A/B join-back, is on the chain A and B forked from and creates no new chain.
- **C20.** A join chain can only be created from leaves of its source chains, and may combine two or more of them.

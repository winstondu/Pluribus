> **Archived.** Historical record, kept read-only and no longer maintained. The current specification is [docs/spec/](../../../spec/README.md); see the [archive README](../../README.md) for how to read this file.

# Scenario 4: result-dependent work and join chains

Status: settled (Q33–Q34, Q78, Q86, Q88). No production implementation exists.

## Concrete conversation

A recommends Kyoto neighborhoods and B recommends activities, both using the established trip brief. J requests: “Use those recommendations to make a five-day itinerary.”

J depends on the full sibling join-back. J is on the same chain continuing: the join-back resumes the chain A and B forked from (Q78). If D joins that still-open sibling group, J also waits for D. A descendant continuing from B does not enlarge that group.

## Behavior and context

### Q33: Result readiness

Dependent work waits for the required answer to finish successfully rather than consuming provisional streaming text. For a dependency on one independently progressing answer section, that section's completion is sufficient.

A dependency on a full join-back waits for all its members: the open group must close and finish before that join-back is usable. Subsets of sibling results cannot bypass this barrier. Failed and stopped prerequisites are handled in [scenario 6](06-failure-cancellation-recovery.md) (Q48, Q49).

### Q34: Reconciliation within established requirements

J may reconcile differing source recommendations within the established trip brief, weigh trade-offs, and explain its choice. It need not ask the user to resolve every disagreement. It asks for clarification when proceeding requires a consequential missing preference or resolving incompatible user requirements.

J's conclusion belongs to J and does not rewrite A or B.

### Q78: Continuing from a join-back is not a join chain

Work that continues from a full join-back is on the chain the siblings forked from. It gets no new chain identity or color, and it is an ordinary answer run. A new join chain is created only when work combines leaf-node cousins or previously separate trees (Q76).

### Q86: Join chains attach only to leaves

A join chain's parents are always leaves of their chains at the moment it is created. A non-leaf node cannot be a join chain's parent; the added complexity is not worth the benefit.

### Q88: Two or more sources

A join chain may have two or more parents, each a leaf of its chain. This supersedes the “two” in Q5 and Q76.

### Previously accepted join rules

A new synthesis combining source chains creates a separate join chain anchored to the leaf nodes of those chains (Q5, Q86). Source chains remain independently continuable. A join's inherited context does not grow retroactively when sources later continue. Ordinary sibling join-back is bookkeeping and does not itself generate a synthesis answer.

## UX

The submitted dependent message appears immediately in submission order. A linked queue item above the composer identifies the prerequisite and clears when processing starts. For a full sibling join-back, the prerequisite is the whole group, including siblings admitted before it closes. The operation graph and context inspector expose actual dependencies and consumed ancestry; unrelated later source messages are excluded.

## Acceptance conditions

- Visible partial source text does not release dependent answer work.
- A dependency on a single answer section can proceed when that section successfully finishes, without waiting for unrelated sections.
- A full join-back dependency cannot proceed while its group remains open or unfinished.
- An additional sibling admitted to the open group extends the full join-back dependency; a descendant continuing one sibling does not.
- J can reconcile recommendations within the established brief and explain the trade-off without changing source answers.
- Incompatible user requirements or consequential missing preferences elicit clarification.
- A synthesis join preserves source chains and the specific ancestry it consumed.
- J, continuing from the A/B join-back, is on the chain A and B forked from and creates no new chain (Q78).
- A join chain can only be created from leaves of its source chains (Q86), and may combine two or more of them (Q88).

## Specified elsewhere

Revision propagation: [scenario 5](05-revisions-targeting-ambiguity.md) (Q36). Failed or stopped prerequisites and retries: [scenario 6](06-failure-cancellation-recovery.md) (Q47–Q49). Capacity and scheduling: [technical design](../technical-design.md) (Q60).

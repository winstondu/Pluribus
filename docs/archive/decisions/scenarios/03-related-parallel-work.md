> **Archived.** Historical record, kept read-only and no longer maintained. The current specification is [docs/spec/](../../../spec/README.md); see the [archive README](../../README.md) for how to read this file.

# Scenario 3: related parallel work, forks, and join-back

Status: Q28–Q32 accepted; happy-path fork and join-back behavior settled. No production implementation exists.

## Concrete conversation

The established trip brief is Kyoto, five days, November, moderate budget.

1. A: “Suggest neighborhoods to stay in.”
2. While A runs, B: “Suggest rainy-day activities.”
3. B finishes while A remains in flight.
4. C: “Suggest indoor evening activities.” C can benefit from B but does not need A.
5. A finishes. Later, the user explicitly replies to B: “Give me three cheaper alternatives.”

## Accepted behavior and context

### Q28: Automatic join-back

Completed parallel exchanges automatically become available for ordinary continuation of the chain, recorded in submission order. No manual merge, synthesis call, or extra assistant response is needed. The join-back is a child of the parallel siblings.

### Q29: Continuation while a sibling runs

C may proceed with the relevant completed context available when it starts, including the trip brief and B. It does not wait for A when it does not need A. A finishing during C's run does not inject A's result into that attempt. Work requiring an unavailable result remains dependency-queued.

### Q30: Independent sibling branches and full join-back

An explicit continuation of B uses B's ancestry and answer without automatically importing A. Join-back does not prevent independent branches on its siblings.

User refinement: work needing context from more than one sibling must depend on the full join-back. It cannot depend on only a subset of siblings. For example, if A, B, and D are siblings, work needing A and B must depend on their full join-back including D. Sibling-group membership follows Q32 below, not execution overlap alone.

### Q32: Sibling-group membership and closure

A sibling group comprises parallel forks from the same starting context. Additional forks from that starting point join the group while it remains open. A continuation consuming a sibling's result is a descendant of that sibling, not another member of the original group.

For example, while A runs and B has finished, C consuming B remains a separate descendant. D starting from A and B's original trip brief joins their still-open group. Once all members finish and their join-back forms, the group closes. Later branches cannot retroactively enlarge it. Independent continuation on B therefore does not indefinitely postpone the original join-back.

## UX — Q31

Automatic forks and join-back do not add routine lifecycle messages to the chat. The selected margin rails, Focus view, and genealogy inspector expose context relationships. Inspecting an answer shows what its run actually consumed; later join-back does not rewrite that history.

## Acceptance conditions

- Successful sibling exchanges become available through automatic join-back in request order, regardless of answer order.
- Join-back creates no synthesis call or assistant answer.
- C can start using B while A runs when C does not need A.
- C's consumed context does not change when A later completes.
- An explicit branch from B remains available after join-back and does not automatically inherit A.
- A continuation requiring multiple siblings depends on their full join-back, never a subset sibling join.
- Context inspection preserves the ancestry each historical run actually consumed.
- D from the same starting context joins an open A/B group; C consuming B does not.
- A closed group and its join-back cannot be enlarged by later branches.

## Specified elsewhere

- Result-dependent scheduling and join chains: [scenario 4](04-result-dependent-work.md) (Q33, Q34).
- Failed or stopped siblings and their effect on join-back: [scenario 6](06-failure-cancellation-recovery.md) (Q48, Q49).

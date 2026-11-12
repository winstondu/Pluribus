---
status: accepted
---
> **Archived.** Historical record, kept read-only and no longer maintained. The current specification is [docs/spec/](../../spec/README.md); see the [archive README](../README.md) for how to read this file.

# Preserve source chains through joins

A request needing both source chains can create a new join chain attached to their specific source nodes, leaving either source independently continuable. Ordinary fork join-back instead records completed exchanges in request order for future context without requiring a synthesis call; historical runs retain the context they actually saw. This avoids permanent context union and unnecessary reconciliation while making inherited context explicit.

Q28–Q31 refine ordinary fork join-back: it happens automatically and forms a child of all participating parallel siblings. Each sibling can still be branched independently. When work needs context from more than one sibling, it must depend on the full join-back rather than selecting a subset of those siblings. This restricts selection within a sibling group; it does not remove separate join chains for work combining other source chains. Q32 defines membership by shared starting context: new forks can join while the group is open, but descendants consuming sibling results are excluded. Membership closes when all members finish and join-back forms. Q33 requires a full join-back dependency to wait for the group to close and finish.

Q78 and Q86 bound the two mechanisms. Work continuing from a full join-back stays on the chain the siblings forked from; it is not a join chain. A join chain's parents are always leaves of their chains when it is created, because non-leaf parents add complexity for little benefit; “specific source nodes” above therefore means those leaves.

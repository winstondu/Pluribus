---
status: accepted
---
> **Archived.** Historical record, kept read-only and no longer maintained. The current specification is [docs/spec/](../../spec/README.md); see the [archive README](../README.md) for how to read this file.

# Append-only domain event log with cached projections

The source of truth is an append-only log of domain events (submissions, splits, attempt lifecycle, streamed output, join-backs, elicitation answers). The transcript, genealogy, operation graph, and queue are projections, cached and updated incrementally. Storage sits behind adapter interfaces so embedded and server backends can use different stores.

This follows directly from the scenarios: history is never rewritten (ADR-0004), each attempt's consumed context must remain inspectable, and interrupted work must be recoverable after a restart. Mutable current-state tables were rejected because supersession, retries, and recovery would require reconstructing lost history. The cost is projection code and cache invalidation discipline.

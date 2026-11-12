---
status: accepted
---
> **Archived.** Historical record, kept read-only and no longer maintained. The current specification is [docs/spec/](../../spec/README.md); see the [archive README](../README.md) for how to read this file.

# Place independent replies by first visible output

User messages always retain submission order, while replies without a result dependency between them take their positions at first visible answer output and can overtake pending responding bubbles. Once answer text is visible, its relative transcript position stays fixed; a dependent follow-up must wait for its prerequisite result. This supersedes ADR-0001's fixed request-ordered answer layout while preserving dependency-based scheduling and explicitly selected context.

Processing-status text does not count as first visible answer output. Completion order does not reorder answers that have already started streaming. Follow output while the reader is at the live bottom; otherwise preserve their reading position and expose a new-output affordance.

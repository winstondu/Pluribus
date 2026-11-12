---
status: superseded by ADR-0003
---
> **Archived.** Historical record, kept read-only and no longer maintained. The current specification is [docs/spec/](../../spec/README.md); see the [archive README](../README.md) for how to read this file.

# Separate visible conversation order from execution and context

Committee preserves request order in the visible conversation while scheduling operations by their result dependencies, allowing later answers to appear while earlier requests remain in progress. Each run reads selected context rather than automatically inheriting the entire visible transcript; this preserves parallelism without implying that all agents know everything shown above their replies. Debug views expose actual context ancestry separately from operation dependencies.

---
status: accepted
---
> **Archived.** Historical record, kept read-only and no longer maintained. The current specification is [docs/spec/](../../spec/README.md); see the [archive README](../README.md) for how to read this file.

# A portable TypeScript backend owns every run's context

The Committee backend runs either embedded in the client or on a server, sharing TypeScript code behind one interface. It assembles every run's context from its own records and calls models through OpenRouter's stateless API rather than relying on provider-side conversation state.

Provider-stored conversation state cannot express rewound replacement context (Q38), replacements standing in for superseded results (Q39), join-backs, or join chains, and it would hide exactly what each run consumed. Owning context costs more tokens per call and requires our own compaction later, but keeps context inspection truthful and providers swappable. A server-only design was rejected because Committee must not assume a server (Q52); a client-only design would block later hosted execution.

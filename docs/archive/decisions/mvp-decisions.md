> **Archived.** Historical record, kept read-only and no longer maintained. The current specification is [docs/spec/](../../spec/README.md); see the [archive README](../README.md) for how to read this file.

# MVP decisions

Choices for the first shippable version only. They may be replaced without revisiting the [technical design](technical-design.md).

### Q73: OpenRouter key entry

The user pastes an OpenRouter key into settings. It is stored in the local secrets store (Q64), never in the event log. OAuth PKCE (“Connect OpenRouter”) is deferred.

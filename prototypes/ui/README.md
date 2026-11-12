# Pluribus UI prototypes

The rebuilt **React + TypeScript components and runnable preview** are in [`../react`](../react/README.md). The HTML files here remain the original visual exploration sources.

Terra-authored interactive UI samples copied into the project on November 10, 2026. These are simulated design explorations, not production UI.

| Sample | Selected direction |
| --- | --- |
| [Chat](chat-directions.html) | Sections; other initial variants retained |
| [Chain map](chain-map-directions.html) | Genealogy; Lanes retained as an exploration |
| [Decomposition](decomposition-debug-directions.html) | Compare; Fragments retained for later |
| [Chain association](chain-association-directions.html) | Margin rails + Focus, with inherited context highlighting |
| [Operation queue](operation-directions.html) | Horizontally extensible PERT-style dependency graph with completion motion |

## Runtime and limitations

These files are the original inline HTML fragments. They use the Codex visualization host for variant carousels, tooltips, and some styling; they are not standalone browser pages. JavaScript syntax was checked. Browser visual verification was blocked by a missing bundled preview stylesheet. The original chat copies remain available so previously embedded visuals continue to work.

Behavioral decisions evolved after the samples were built, especially response placement and failure handling. The [specification](../../docs/spec/README.md) governs the intended behavior; the samples illustrate selected styles, not a complete current specification. [Debug views](../../docs/spec/09-debug-views.md) describes each view and lists where each sample is out of date.

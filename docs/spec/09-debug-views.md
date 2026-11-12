# 09 · Debug views

The views that let a user (and a developer) see what Committee actually did: which chain handled each message, what each run read, how a composite message was split, and what work is waiting on what. Terms in bold are defined in the [glossary](glossary.md).

Each view below says what it shows, what was selected, and which prototype in [`prototypes/ui/`](../../prototypes/ui/README.md) illustrates it. Every view separates **Decided** (the user chose it, or it follows from a cited answer) from **Prototype detail** (present in the sample but never chosen; the build may change it). The prototypes are style samples built before several behaviors changed; [Where the prototypes are out of date](#where-the-prototypes-are-out-of-date) lists every known difference. Where a prototype and this document disagree, this document is current.

## Which views are always on

| View | Availability |
|---|---|
| Message-to-chain association: margin rails with Focus | Always available (Q87) |
| “Split from one message” link, opening the Compare inspector for a sequential composite (Q53) | Always available (Q87, Q94) |
| Compare inspector for an independent composite, shown as one message with sections | Behind a debug toggle (Q94) |
| Chain mini-map (Genealogy) | Behind a debug toggle (Q87) |
| Operation graph | Behind a debug toggle (Q87) |
| Run inspector | Behind a debug toggle (Q87) |

The user originally asked for all of these as debug views (early record, “Additional context”). Q87 moved the rails, Focus, and the split link into the ordinary interface.

## Rules shared by every view

- **Three relationships stay separate.** Context ancestry (the genealogy), result dependencies (what must finish first), and display placement (the transcript) are shown as different things. The mini-map shows ancestry; the operation graph shows dependencies and live work; the transcript shows placement. No view derives one from another (invariant 1; ADR-0001).
- **Show what a run actually consumed.** Inspecting an answer shows the context its run received. A later join-back, revision, retry, or source continuation never rewrites that record (Q29, Q31, Q39). The views must not imply that a run saw something because it appears above it in the chat, or because it shares a chain ID (scenario 1 acceptance; approved debug treatments).
- **No lifecycle chatter.** Automatic forks and join-backs add no messages to the chat. The rails, Focus, and the genealogy are how those relationships are seen (Q31).
- **One color per chain.** Each chain has a stable color. Chat coloring uses the same colors as the mini-map (original discussion, “Confirmed”). A join chain gets its own new color (Q5). Each fork, and any later branch from one sibling, gets its own color (Q89). Work continuing from a join-back stays on the chain the siblings forked from and gets no new color (Q78).
- **History is retained.** Superseded, failed, stopped, and interrupted attempts stay visible to inspection, marked, never removed (invariant 3).
- **Views are projections.** The transcript, genealogy, operation graph, and queue are all derived from the append-only event log, so every view can be rebuilt from it (Q58).

## 1. Chain mini-map (Genealogy)

**Illustrated by:** [`chain-map-directions.html`](../../prototypes/ui/chain-map-directions.html), variant **Genealogy**.

### What it shows

The conversation's genealogy: the trees of chains, with one node per exchange and edges to each node's exact parents. It answers “what could this run read?”, not “what is running?” (original discussion, “Chain joins and operation dependencies”).

### Decided

- **Genealogy** is the selected layout. **Lanes** is retained only as an exploration (original discussion, “UX exploration”; prototype README).
- Nodes are color-coded by chain, with exact IDs available on hover (early record, “Additional context”; original discussion, “Confirmed”).
- Nodes that ran in parallel (a sibling group) are grouped inside an unfilled dotted oval, which preserves the fact that they ran in parallel even after their results are joined (Q8).
- The join-back is a child of all participating siblings and continues the chain they forked from (Q28, Q78). It is bookkeeping: its record serializes the completed exchanges in submission order, and no model call produced it (Q8, Q28).
- A join chain is drawn as a new chain, in its own color, with edges to two or more parents (Q5, Q88). Each parent was a leaf of its chain when the join chain was created (Q86). Its edges point to those exact nodes, not to the current heads of the source chains, so later source continuations do not appear as its input (Q5; original discussion, “Chain joins”).
- Source chains remain continuable after a join chain or join-back; their later nodes appear on their own chains (Q5, Q30).
- Behind a debug toggle (Q87).

### Prototype detail

- Vertical flow (“dependencies flow downward”), arrow glyphs between nodes, node labels such as “A2 · Continue”, and the three-color palette.
- A detail panel under the map describing the selected node's context in one sentence, plus an inner “Debug details” checkbox that adds chain, parent, and fragment IDs.
- Clicking selects a node; IDs appear in a tooltip.
- The original discussion also proposed focus and tap access to IDs, not only pointer hover. That was not separately chosen, but it follows from the approved hover-and-focus behavior for association (section 2).

## 2. Message-to-chain association: margin rails + Focus

**Illustrated by:** [`chain-association-directions.html`](../../prototypes/ui/chain-association-directions.html), which shows the combined treatment. The Sections chat, [`chat-directions.html`](../../prototypes/ui/chat-directions.html), shows the earlier left-border coloring.

### What it shows

Which chain handled each user message and each answer section, drawn as a colored rail in the margin of the transcript, and a Focus mode that brings forward everything related to one chain and dims the rest.

### Decided

- **Margin rails + Focus**, combined, is the selected treatment. The other explored encodings (Rails alone, Chips, Focus alone) are not selected (approved debug treatments).
- Always available, not behind a debug toggle (Q87).
- A rail marks the **handling chain**. An answer handled by a join chain is colored as that chain; that it read A and B is ancestry, shown separately, not as A or B color on the answer (original discussion, “Additional debug UX exploration”).
- A composite message whose fragments went to chains A and B shows both memberships, without producing anything that looks like a third chain color (same source). The exact styling of multi-chain marks is still a visual choice; segmented marks or chips were proposed instead of a blended color (original discussion, “Confirmed” and “Confirmed debug surfaces”).
- **Focus is inheritance-aware.** Focusing a chain highlights that chain's own messages plus every message in the exact ancestry its runs consumed. Inherited messages keep their own chain's color; they are not relabeled as handled by the focused chain. Messages added to a source chain later, which the focused chain never consumed, are not highlighted merely because they share its chain ID (approved debug treatments; scenario 4 UX).
- Pointer hover and keyboard focus preview an association; click or tap pins it. Leaving a preview returns to the pinned state, or to the default when nothing is pinned (approved debug treatments).
- Split messages are joined by the faint “split from one message” link (Q53), described in section 3.

### Prototype detail

- A 3-pixel left border as the rail, and a “Debug” checkbox that turns rails, text tags (“Handled by A”, “Reads A + B”, message and fragment IDs), and the side mini-map on and off.
- Dimmed items at roughly one-third opacity, a light wash on linked items, and an outline on the matching mini-map node.
- A side panel with a small Genealogy map and a one-line description of the selection; initial selection on J.
- Tooltips carrying message and fragment IDs (U1, F-A).

## 3. Compare decomposition inspector

**Illustrated by:** [`decomposition-debug-directions.html`](../../prototypes/ui/decomposition-debug-directions.html), variant **Compare**.

### What it shows

How Committee split a composite message: the exact original text beside each **fragment**'s rewritten instruction, with the shared requirements each fragment inherited and where they came from. Its purpose is to let a lost constraint be traced to decomposition instead of being blamed on the answering model (original discussion, “Run inspector proposal”).

### Decided

- **Compare** is the selected inspector. **Fragments** is retained for a later trial and is not the default (approved debug treatments; scenario 2). The third explored variant, In context, was not selected.
- It shows the untouched source message beside the rewritten atomic instructions and their inherited requirements (original discussion, “Confirmed debug surfaces”). Both the original text and any rewrite are recorded, so the inspector can always show both (Q59).
- Fragments carry their applicable requirements with provenance; requirements are local unless the user explicitly made them session-wide (Q4, Q17).
- Rewritten fragment text comes from generative decomposition, never from the decision model, which only selects among supplied candidates (invariant 9; Q59).
- For a message split into separate user messages (sequential decomposition), the “split from one message” link between the bubbles opens Compare with the exact original text. The link is always available (Q53, Q87). Undo split is offered only until any split message shows answer text or receives a reply (Q85).
- Compare is shown in the debug side panel by default. A user setting places it instead as a card on the message in the transcript, as in the prototype: the message marks the selected **fragment**'s source span and the inherited requirements, and the card shows the rest. Both placements show the same content ([user settings](10-front-end.md#user-settings)).

### Prototype detail

- An “Inspect decomposition” control in the message header, shown only while Debug is on.
- Pills (“A · Sky”, “B · Menu”) select a fragment; the selected fragment's span in the original message is underlined in its chain color, the shared requirement is tinted, and the matching answer section gets a colored left border.
- Two columns, “Exact source” and “Rewritten prompt”, and a line “Inherited from source: …” for the shared requirement.
- The Fragments variant: numbered rows that expand to show source, rewrite, and inherited requirement.

## 4. Operation graph

**Illustrated by:** [`operation-directions.html`](../../prototypes/ui/operation-directions.html). The prototype README calls it the operation queue.

### What it shows

The live work and its prerequisites: each operation with its type and current status, and edges to the results it waits for, including generating replies and join-backs (original discussion, “Confirmed debug surfaces”). Work inside the scheduler can appear here without becoming a user-facing chain (original discussion, “Chain joins”).

### Decided

- The **Dependency map** direction was selected and refined into an activity-on-node, PERT-style network flowing left to right. Its visual direction is accepted as presented (original discussion, “UX exploration”, “Selected operation-view refinement”, “Approved debug treatments”).
- Horizontal position means dependency depth, not elapsed time. There are no duration estimates and no critical-path calculation (selected refinement).
- The surface extends horizontally without limit as the graph grows. Virtualization and loading for very large graphs are build work (selected refinement).
- Completing operations fade away, and the remaining operations move to their new positions with transform-based motion. Dependency edges stay correct through the motion. Reduced-motion preferences are respected. The selected node's details stay in place, the view never force-scrolls a user who is inspecting another part of the graph, and completed operations stay inspectable after they leave the graph (selected refinement). Exact timings are for the build to set (selected refinement).
- Waiting on prerequisites is shown differently from waiting for capacity (original discussion, “Confirmed debug surfaces”). A rate limit shows as “Waiting for capacity”, never as a dependency wait (Q47, Q60). The status names are those in [08 · Failure, stopping, and recovery](08-failure-and-recovery.md): retrying, failed, stopped, interrupted, paused (Q47–Q54).
- A pending section inside an already-placed reply group can be reached from the operation graph (Q81, which called it the operation queue). No other route is needed: the reply is one unit with its sections, so the pending section is found there (Q93).
- Behind a debug toggle (Q87).
- First-version scope is text and read-only, so tool and subagent operations do not occur yet, even though the user's original request named them (Q1; early record, “Additional context”).

### Prototype detail

- 170-by-72-pixel cards with a chain-colored left border, curved connectors, and a status line per card.
- A detail strip naming the selected operation's status, chain, message and attempt, inputs, dependencies, and what it is still waiting for.
- Demo controls (“Add demo work”, “Complete selected”, “Reset”), scroll buttons, a slot counter, and a “Recent” button that reselects the last completed operation.
- Motion values: 180 ms fade, 240 ms reflow, connectors redrawn on each frame during reflow, reflow removed under reduced motion.

## 5. Run inspector

**Illustrated by:** no dedicated prototype. The detail panels in the chain map and operation graph prototypes hint at parts of it.

### What it shows

Selecting a run reveals seven things (Q87):

1. The original user message and the source fragment.
2. The resolved instructions and applicable requirements, with provenance.
3. The exact model input for that attempt, including the selected history and result inputs.
4. The unfinished results it is waiting for, shown separately from its context ancestry.
5. The routing decision and its explanation, with decision confidence where available, presented without implying the decision was correct.
6. The attempt version, and whether its result is current, superseded, failed, stopped, or interrupted.
7. The visible answer section the result belongs to.

### Decided

- The seven items above (Q87). Item 6 uses the current attempt states; the original proposal's “cancelled” is replaced by stopped and interrupted (Q50, Q52).
- Item 3 is the attempt's recorded input, never a recomputation: a replacement or retry shows rewound context without earlier partial text (Q38, Q47); a completed run that consumed a since-superseded result still shows the original (Q39); a superseded attempt is shown as existing and superseded (scenario 5).
- Item 5 includes what [dependency attachment](11-architecture.md#what-is-recorded) recorded with the decision: a decision budget limit that was reached and the best node found so far where it was used in place of a question to the user, a routing request that listed fewer sections, whether the decision model was shown context summaries, and how the referent strategy was chosen when strategy selection is on.
- Behind a debug toggle (Q87).

### Prototype detail

None; layout and entry point are for the build.

## Where the prototypes are out of date

Later answers supersede earlier ones where they clearly conflict. Each item names the prototype behavior and the answer that replaces it.

### `chat-directions.html` (Sections)

- A status badge on the user message (“Researching”, “Drafting answers”) and an “↑ Earlier request still responding” button. Pending status belongs on the responding bubble or pending section, and the up-arrow is dropped (Q81, superseding Q7).
- A single “Reply to Sky + menu” button for the whole response. Each answer section has its own reply target, and there is no whole-response reply button (Q20).
- Request-ordered answer slots. Replies take their place at first visible output, and pending bubbles may be overtaken (Q12–Q14; scenario 1).
- Chain coloring and chips appear only while Debug is on. Margin rails are always available (Q87).
- “Inspect split” opens an inline fragment list, the unselected In context style, and only under Debug. The selected inspector is Compare (approved debug treatments).

### `chain-map-directions.html`

- Join chain J1 has exactly two sources. That is consistent with current rules, but a join chain may have two or more (Q88).
- The inner “Debug details” checkbox implies the map is visible without debug. The whole mini-map is behind a debug toggle (Q87).
- No failed or stopped sibling, superseded node, or interrupted attempt appears, so the sample does not show how the map marks them (Q39, Q49, Q52).

### `chain-association-directions.html`

- Rails, tags, and the side map all disappear when Debug is off. Rails and Focus are always available; only the side mini-map belongs behind the debug toggle (Q87).
- The multi-chain rail on U1 is a continuous A-to-B gradient, which passes through blended hues and can look like a third chain color, against the approved principle (original discussion, “Additional debug UX exploration”). The chat sample's hard 50/50 split is closer to it.
- “Bring those perspectives together” is answered by a new chain J reading A and B, which were fragments of one message. If A and B are forks of one chain, that follow-up continues from their join-back on the same chain with no new color (Q78). The sample predates Q78. A join chain is right only when A and B are separate trees or leaf-node cousins (Q76, Q86).

### `decomposition-debug-directions.html`

- “Inspect decomposition” exists only while Debug is on. The split link that opens Compare is always available (Q53, Q87).
- The sample has no split messages at all, so it does not show the “split from one message” link or Undo split (Q53, Q85).
- “↩ Reply to request” targets the whole response. Targets are per answer section (Q20).

### `operation-directions.html`

- “Waiting on tool” and “Waiting on subagent” operations. The first version has no tools (Q1; scenario 2).
- Three concurrent slots. Concurrency is a per-provider user setting, default 4 (Q60).
- “Add demo work” scrolls the graph to its right end. The refinement forbids force-scrolling a user inspecting elsewhere (selected refinement).
- Only the most recent completed operation stays reachable (“Recent”). Every retired operation must stay inspectable (selected refinement).
- No failed, stopped, interrupted, paused, retrying, or rate-limited “Waiting for capacity” states, and no recovery choices on paused work (Q47–Q54).
- No route from an operation to its pending section in the transcript (Q81).
- The join-back is drawn on the fork's chain (“Review fork”). A fork does have its own color (Q89), but the join-back continues the chain the siblings forked from, in that chain's color (Q28, Q78). The sample's palette also differs from the other samples'.
- “Ready · awaiting capacity” for ready work waiting for a free slot. Only the rate-limit wording, “Waiting for capacity”, is decided (Q47).

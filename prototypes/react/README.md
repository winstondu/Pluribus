# Pluribus React prototypes

Five Terra-authored React + TypeScript component demos, with a Vite gallery. These run in a regular browser without the Codex visualization host. The original HTML explorations remain in [`../ui`](../ui/README.md).

## Run

From this directory:

```sh
npm ci
npm run dev
```

Open the local URL Vite prints (normally `http://127.0.0.1:5173`). Node 26.5.0 was used for validation. Dependencies are recorded in `package-lock.json`.

```sh
npm run typecheck
npm test
npm run build
npm run preview
```

The gallery has direct links at `#chat`, `#decomposition`, `#genealogy`, `#association`, and `#operations`. Switching samples starts a fresh fixture; these demos do not persist state.

## Components

| Export | Source | Demonstrates |
| --- | --- | --- |
| `ChatPrototype` | [ChatPrototype.tsx](src/components/chat/ChatPrototype.tsx) | Sections by default; Flow and Activity alternatives; first-output placement fixture; section replies; composer queue; local failure |
| `DecompositionPrototype` | [DecompositionPrototype.tsx](src/components/decomposition/DecompositionPrototype.tsx) | Compare by default, Fragments alternative; original source, rewritten instructions and requirement provenance; sequential split inspection |
| `GenealogyPrototype` | [GenealogyPrototype.tsx](src/components/genealogy/GenealogyPrototype.tsx) | Exact parents, distinct fork colors, dotted sibling oval, new synthesis chain versus bookkeeping join-back |
| `ChainAssociationPrototype` | [ChainAssociationPrototype.tsx](src/components/association/ChainAssociationPrototype.tsx) | Always-visible margin rails and Focus; hard-segment multi-chain marks; J highlights consumed ancestry, not later source continuations |
| `OperationGraphPrototype` | [OperationGraphPrototype.tsx](src/components/operations/OperationGraphPrototype.tsx) | Horizontal dependency-depth graph; completion fade/reflow with attached connectors; all completed history; dependency and capacity states |

All five are named exports from [`src/components/index.ts`](src/components/index.ts). Each imports its own scoped stylesheet. The shared color and surface tokens live in [`src/styles.css`](src/styles.css); supply those tokens when embedding the components elsewhere. `OperationGraphPrototype` optionally accepts `onOpenSection(sectionId)` for linking a selected operation to another transcript surface.

## Scope

These are interactive UI fixtures, not the complete Pluribus application. There are no model calls, API keys, Jev routing, persistence, or production scheduler. Chat routing is deliberately simplified and labeled as demo behavior. Operation state changes are deterministic controls, not actual work. The graph grows by appending demo work but is not virtualized for an unbounded production dataset.

The selected visual directions are preserved, with corrections to stale HTML behaviors: section targets instead of whole-response targets, always-available rails, exact inherited context, first-output fixture placement, local failures, original-chain join-back color, and retained operation history. The current [specification](../../docs/spec/README.md) remains authoritative; this conversion is not a claim that every acceptance condition in that spec is implemented.

## Verification

Vitest and Testing Library cover reply history and targeting, transcript placement, local failure, dependency queues, decomposition provenance, inheritance-aware focus, dependency release, model-slot accounting, retained operation history, and reset during a completion fade. Browser checks additionally exercise gallery navigation, fragment selection, graph completion, genealogy inspection, debug visibility, and light/dark rendering.

# Committee MVP build plan

The contract between the agents building the MVP. `docs/spec/` says what Committee does; this says who builds which files against which interfaces. If this plan is wrong, work around it inside your own paths and report it.

Contracts already in the tree, to read before writing code:

| Read | For |
|---|---|
| `packages/protocol/src/` | IDs, `model.ts` (states, failures, placement, consumed context), `events.ts`, `commands.ts`, `projections.ts`, `patches.ts`, `backend.ts`, `wire.ts`, `settings.ts`, `wording.ts` |
| `packages/core/src/ports/` | `ModelProvider`, `DecisionProvider`, `Decomposer`, `EventStore`, `ProjectionCache`, `SecretsStore`, `Clock`, `Timers`, `Router` and `RoutingPlan`, `Backend`, `CoreDependencies` |

Field comments in those files state the rule and the Q-number. They are part of the contract.

## 1. Rules for every agent

- Touch only your paths (section 3). The shared files are listed there with one owner each.
- Libraries are compiled by the web package too, which sets `erasableSyntaxOnly`, `noUnusedLocals` and `noUnusedParameters`: no enums, no namespaces, no constructor parameter properties, no unused bindings in `protocol`, `core`, `storage`, `providers`.
- `protocol` and `core` compile without DOM or Node globals. There is no `setTimeout`, `AbortSignal`, `console`, `fetch` or `crypto` there, by design: use the `Clock`, `Timers`, `CancelSignal` and `IdFactory` ports.
- Stored and transmitted data is plain JSON. An absent value is `null`, not an optional field, in events and projections.
- Fixed wording comes from `WORDING` and the formatters in `protocol/src/wording.ts`. Core fills the `text` fields of projections with them; the client renders those fields and uses `WORDING` for its own chrome.
- Acceptance tests are titled `'<ID> · <condition>'`, one canonical test per ID in the file named in section 6. A supplementary UI test for the same condition is titled `'<ID> (web) · …'`.
- The OpenRouter key appears in exactly three places: the key prompt's input, the `change-settings` command on its way to the Worker, and the secrets store. Never in an event, a projection, an error message, a log line or a test snapshot.

## 2. Domain model decisions the contracts encode

These settle points the specification leaves to the build or states only by example. They are binding for the three core agents.

**Directive, section, attempt.** A directive is the stable identity of a piece of work across retries and revisions. A *section* is the slot its output occupies in the transcript. An *attempt* is one execution.

| Event | Directive | Section | Attempt | Genealogy node |
|---|---|---|---|---|
| Automatic or user retry | same | same (same bubble, Q51, Q83) | new | same |
| Retry after its sibling group closed (Q92) | same | same | new | new, on the base chain |
| Revision of started work, Regenerate, redo (Q38, Q40) | same | new, in a new response | new | new, replaces the old one |
| Revision of work not started (Q41) | same, instruction updated in place | same | none | same |

A `directive` prerequisite therefore follows a revision by itself: J waiting on directive A waits for A′. The superseded-input note is detected by comparing each completed attempt's `context.inputs` (directive → attempt consumed, or marker) with the directives' current results; there is no finer estimate of whether the result would change.

**States.** `DirectiveState` is the ten states of 01 plus three build refinements: `ready` (held only by the concurrency limit), `retrying` (between automatic retries), `awaiting-elicitation` (held by a clarification or a choice with default). `IN_FLIGHT_STATES` is the test for "keeps its sibling group open": it includes `retrying` and `paused`, so a group closes only when every member is completed, failed, stopped, interrupted or cancelled. A member or prerequisite cancelled before it started is recorded like a failed one, as a request and a marker (`UnfinishedOutcome`), and pauses its dependents the same way.

**Transcript order.** One rule: items whose position is fixed, in the order they were fixed, then the responding bubbles still pending, in request order. A user message is fixed on submission; a response on `response-placed` (first answer text, a failure notice, or ending without output). Sections inside a reply group follow the same rule unless the user gave an explicit output order. Core computes `transcript.order` and `response.sectionIds`; the client renders them.

**Genealogy, mechanically.** The router chooses a `Placement`; the engine applies it:

| `continue` builds on P, and | Result |
|---|---|
| P is its chain's head and has no child in flight | Same chain continues (for a join-back: the base chain, Q78) |
| P has a child in flight | Fork. Opens a sibling group at P, or joins the open one. A child that began as an ordinary continuation moves to a fork chain of its own, with anything queued behind it (`sibling-group-opened.rechained`): the only time a node changes chain |
| P is a sibling-group member, or P is not its chain's head and has no child in flight | New `branch` chain from P, own color (Q89). No sibling group, no join-back |

- `{ kind: 'sibling-group' }` as a point resolves, when the attempt starts, to the base chain's latest completed node at or after the group's current join-back: the join-back itself, or the exchange of a retry that ran after closure.
- A retry after closure is new work on the base chain placed that same way, so paused dependents read `join-back (with the marker) → retry's exchange` (Q92).
- When a member is revised after its group closed, a further `join-back-formed` for the same group replaces the earlier one once the replacement completes. Membership never changes. In context the record reads: the member's request, the correction, the replacement answer (Q39).
- Membership is by directive. A member revised while the group is open stays a member through its replacement.
- An ancestor exchange that did not complete is read as its request plus a marker, never partial text, whether it sits in a join-back or on a plain chain (`ContextOrigin: 'unfinished-exchange'`).
- `colorIndex` is the chain's ordinal in creation order. Joining back creates no chain and no color.

**Clarification.** The question is a directive of kind `clarification-question`, answered by the answer model and shown as an additional response; it is exempt from the whole-request barrier (E1). The blocked directive is `awaiting-elicitation`, has no queue item and no bubble until the answer arrives, then opens its section in a new `clarified-answer` response. Its context is the chain's ancestry, the question exchange, and the user's answer.

**Routing failure.** If the decision provider or decomposer fails, `routing-failed` is recorded, the message shows a failure notice and Retry on the request routes again. Committee never falls back to a guess.

**Interruption.** In the embedded deployment an attempt is interrupted only by losing its executor. `Backend.start()` finds attempts with no terminal event and records `attempt-interrupted`. A network drop during a run is a transient `network` failure, not an interruption.

**Stream and snapshots.** One frame per coordinator step carries the step's events and the patches from `diffSnapshots(before, after)`. To open a conversation: subscribe, then snapshot, then pass every frame through `reconcileFrame`. The run inspector's record is fetched with a `run` snapshot query, not streamed.

## 3. Module map and ownership

### protocol, core ports — architect (done)

`packages/protocol/**`, `packages/core/src/ports/**`, `docs/build/**`. Changes to these go through `requestsForOthers`.

### core — three agents, one after another

`packages/core/src/index.ts` only re-exports. Each core agent appends the one export line for its slice when it lands.

| Agent | Paths | Builds |
|---|---|---|
| core-engine (milestone 1) | `src/engine/**`, `src/testing/**` | State, reducers, coordinator, scheduler, context assembly, the four projections and the run inspection, `createBackend`, all fakes |
| core-routing (milestone 4 logic) | `src/routing/**` | The default `Router`: decision gate, decomposition, validation; split messages and Undo split; target and clarification elicitation |
| core-recovery (milestone 5 logic) | `src/recovery/**` | Retry policies, interruption recovery, stop of a request, pause and recovery choice, revisions and supersession, Regenerate, choice with default, mixed-result counts |

**How later slices extend the engine without rewriting it.** core-engine builds a registry, not a monolith:

```ts
// packages/core/src/engine/module.ts (core-engine defines the exact types)
interface CoreModule {
  name: string
  reducers?: Partial<{ [T in ConversationEventType]: Reducer<T> }>   // (state, event) => state
  commands?: Partial<{ [T in CommandType]: CommandHandler<T> }>      // (state, command, ctx) => events | CommandError
  reactions?: Reaction[]                                             // (state, event, ctx) => follow-up events and effects
  planAppliers?: PlanApplier[]                                       // how parts of a RoutingPlan become events
}
createBackend(deps: CoreDependencies, options?: Partial<CoreOptions>, modules?: CoreModule[]): Backend
```

- `engine/index.ts` exports `engineModule`; `routing/index.ts` exports `routingModule` and `createRouter`; `recovery/index.ts` exports `recoveryModule`. `createBackend` defaults `modules` to every module that exists at that point.
- A later slice adds reducers, handlers and reactions for *its* events and commands. It changes an engine file only to fix a defect, and says so in its report.
- Projections are pure functions of `ConversationState` (`engine/projections/*.ts`) with structural sharing, so `diffSnapshots` is cheap. A later slice that adds a state extends the projection function for it and the engine's projection tests keep passing.
- A step is: command or provider/timer input → events → reducers → reactions until quiet → append to the `EventStore` → one frame to subscribers. Effects (model calls, timers) start only after the step's events are appended.
- `ConversationState` is JSON and is what the `ProjectionCache` stores (`stateVersion` guards its shape).

Event and command ownership (who writes the reducer, handler and tests):

| Slice | Events | Commands |
|---|---|---|
| core-engine | `message-submitted`, `routing-decided`, `routing-failed`, `chain-created`, `node-created`, `sibling-group-opened`, `sibling-admitted`, `join-back-formed`, `directive-created`, `directive-waiting`, `directive-ready`, `directive-labeled`, `attempt-started`, `attempt-output`, `attempt-completed`, `attempt-failed` (retry `none`), `attempt-stopped`, `stop-requested` (a section), `context-limit-warned`, `response-opened`, `section-opened`, `response-placed`, `section-placed`, all app events | `submit-message`, `stop` (section), `change-settings`, `create-conversation`, `list-conversations`, `delete-conversation` |
| core-routing | `message-decomposed`, `split-undone`, `session-requirement-recorded`, `directive-held`, `elicitation-raised` / `elicitation-answered` (target ambiguity, clarification) | `undo-split`, `answer-elicitation` (target ambiguity) |
| core-recovery | `attempt-failed` (scheduled retries), `attempt-interrupted`, `retry-requested`, `stop-requested` (a request), `directive-paused`, `directive-cancelled`, `prerequisite-waived`, `prerequisites-changed`, `directive-revised-in-place`, `revision-recorded`, `regenerate-requested`, `section-superseded`, `superseded-input-noted`, `elicitation-raised` (choice with default, recovery choice), `elicitation-edited`, `elicitation-defaulted`, `elicitation-withdrawn` | `retry`, `regenerate`, `continue-without`, `cancel`, `stop` (request), `answer-elicitation` (choice with default) |

core-engine must still implement the *closing rule* in full (the group closes when no member's state is in `IN_FLIGHT_STATES`), terminal failure with `retry: none`, and stopping one section, so that milestone 1 stands alone. Before core-recovery lands, a plan with `revision` set records `routing-decided` and nothing more.

**Fakes** live in `packages/core/src/testing/` and are exported as `@committee/core/testing` (the export is already in core's `package.json`). core-engine creates `testing/index.ts` in its first commit with these names, which other agents rely on:

| Export | Behaviour |
|---|---|
| `FakeClock` | Implements `Clock` and `Timers`; `advance(ms)` fires due timers in order; `now()` never moves by itself |
| `ScriptedModelProvider` | Per request (matched by a predicate on the request, or in call order): a script of `{ afterMs, event }` steps on the fake clock, covering text, completion, each failure code, a hang, and cancellation. Records every request it received |
| `ScriptedDecisionProvider`, `ScriptedDecomposer` | Answer from a queue or a function; record requests |
| `ScriptedRouter` | Returns the `RoutingOutcome` the test supplies for each message (milestones 1–3) |
| `MemoryEventStore`, `MemoryProjectionCache`, `MemorySecretsStore` | In-memory ports for core's own tests |
| `createTestBackend(overrides?)` | A started `Backend` over all of the above, with a seeded `IdFactory`, plus the fakes for assertions |

A simulated interruption is: dispose the backend, build a new one over the same `MemoryEventStore`, start it.

### providers — `packages/providers/**`

| File | Contents |
|---|---|
| `src/openrouter/model-provider.ts` | `createOpenRouterModelProvider({ getKey, fetch })`: SSE with `eventsource-parser`, comment lines skipped, error mapping with `providerErrorCodeForStatus` and `providerError`, `Retry-After`, empty 200, mid-stream `finish_reason: "error"`, abort on cancel |
| `src/openrouter/models.ts` | Context limits from `/api/v1/models`, cached; token estimate for `countTokens` |
| `src/openrouter/decision-provider.ts` | `createOpenRouterDecisionProvider`: the live Decisions shape in `CLAUDE.md`; `noul` → `probability`; a `choice` outside the supplied options is `malformed-response` |
| `src/openrouter/decomposer.ts` | `createOpenRouterDecomposer`: `response_format` JSON schema, validated with `zod`; spans checked against the text |
| `src/*.test.ts`, `src/*.smoke.test.ts` | Unit tests with an injected `fetch`; smoke tests on `anthropic/claude-haiku-5.5` |
| `src/index.ts` | Exports the three factories. The re-export of the scripted fakes (`export * from '@committee/core/testing'`) is added by **integration**, once core's testing entry exists |

`getKey: () => Promise<string | null>` is the only way a provider sees the key. `fetch` is injected so the unit tests never touch the network.

### storage — `packages/storage/**`

| File | Contents |
|---|---|
| `src/adapter.ts` | One small key-value adapter interface with ordered range reads, used by both stores (Q58, Q63) |
| `src/indexeddb-adapter.ts`, `src/memory-adapter.ts` | The two adapters (`idb`; tests use `fake-indexeddb`) |
| `src/event-store.ts`, `src/projection-cache.ts` | `createEventStore(adapter)`, `createProjectionCache(adapter)` implementing the ports, including `EventStoreConflictError` on a gap and atomic appends |
| `src/secrets-store.ts` | `createSecretsStore(adapter)` over a **separate** IndexedDB database |
| `src/index.ts` | `openIndexedDbStorage()` → `{ eventStore, projectionCache, secretsStore }`, `createMemoryStorage()` |
| `src/conformance.ts` + tests | One suite run against both adapters |

Databases: `committee-events` (logs and cache) and `committee-secrets`.

### web — three UI agents and integration share `packages/web`

| Agent | Paths |
|---|---|
| ui-foundation | `src/app/**` (shell, sidebar, settings, key prompt, UI state), `src/backend/**` (store and hooks over `BackendClient`), `src/fixtures/**`, `src/design/**` (chain palette, shared primitives), `src/index.css`, `src/App.tsx`, `src/main.tsx`, `index.html` |
| ui-transcript | `src/features/transcript/**`, `src/features/composer/**`, `src/features/association/**` (rails and Focus) |
| ui-debug | `src/features/debug/**` (mini-map, operation graph, run inspector, Compare) |
| integration | `src/worker/**`, `packages/web/e2e/**`, root `package.json` scripts and config, the fake re-export in `packages/providers/src/index.ts`, `docs/build/STATUS.md` |

Shared files, one owner each:

| File | Owner | Others |
|---|---|---|
| `src/backend/index.ts` (hooks below) | ui-foundation | import only |
| `src/app/ui-state.ts` (store below) | ui-foundation | import only |
| `src/design/chains.ts` (`chainColor(colorIndex)`), `src/index.css` tokens | ui-foundation | import only; ask for tokens |
| `src/fixtures/types.ts`, `builder.ts`, `fixture-backend.ts`, `index.ts` (registry) | ui-foundation | add files under `src/fixtures/cases/` and one registry line each |
| `src/features/<name>/index.ts` | that feature's agent | ui-foundation imports the entry components |
| `src/backend/connect.ts` | ui-foundation writes fixture mode; integration adds Worker mode | — |
| `src/components/ui/**`, `src/components/ai-elements/**` | whoever adds a component with the shadcn or AI Elements CLI; adapt copies inside your own feature directory instead of editing shared ones | — |

Entry components, no props; each reads the store. The feature agents create these as stubs in their **first** action so the shell compiles:

| Import | Export | Owner |
|---|---|---|
| `@/features/transcript` | `TranscriptPane` | ui-transcript |
| `@/features/composer` | `ComposerDock` (elicitation modal, queue items, reply-target chip, input) | ui-transcript |
| `@/features/association` | `ChainRail`, `FocusBar` (Focus state itself is `focus` in `@/app/ui-state`, so the mini-map can drive it too) | ui-transcript |
| `@/features/debug` | `DebugSidePanel` (mini-map, run inspector, Compare tabs), `OperationGraphDrawer` | ui-debug |

Store and hooks (ui-foundation, `zustand`):

```ts
// @/backend
useBackend(): BackendClient
useSend(): <C extends Command>(command: C) => Promise<CommandResult<C['type']>>
useApp(): AppSnapshot | null                       // conversations, settings, key status
useActiveConversationId(): ConversationId | null
useTranscript(): TranscriptProjection              // of the active conversation; EMPTY_* when none
useQueue(): QueueProjection
useGenealogy(): GenealogyProjection
useOperationGraph(): OperationGraphProjection
useRunInspection(directiveId, attemptId | null): RunInspection | null   // `run` snapshot, refetched when the directive's section or attempt record changes

// @/app/ui-state — client-only state shared between features
replyTargets: SectionId[]                          // set by "Reply to this", cleared on send
focus: { pinned: ChainId | null; preview: ChainId | null }
inspected: { directiveId: DirectiveId; attemptId: AttemptId | null } | null
compare: MessageId | null                          // original message whose decomposition is open
selectedOperation: OperationId | null
reveal: { sectionId: SectionId; nonce: number } | null   // ask the transcript to scroll a section into view (Q81)
```

The store keeps records by identity as `applyPatches` returns them; components select one record by ID so a streaming section re-renders alone.

## 4. Building the UI before the backend exists

Web code depends on `BackendClient` only. Until integration wires the Worker, the app runs on `FixtureBackend`, an in-memory `BackendClient` that replays projection snapshots. It stays afterwards for tests and for `?fixture=<id>`.

```ts
// packages/web/src/fixtures/types.ts
interface Fixture {
  id: string                         // kebab-case, unique; used in ?fixture=<id>
  title: string
  covers: string[]                   // states and acceptance IDs it shows: ['P1', 'P2', 'overtaking']
  app?: Partial<AppSnapshot>         // default: one conversation, DEFAULT_SETTINGS, key configured
  initial: ConversationSnapshot
  steps?: FixtureStep[]              // scripted playback, in order
  runs?: ById<RunInspection>         // answers to `run` snapshot queries, keyed by directive ID
  respond?(command: Command, current: ConversationSnapshot): FixtureStep[] | null   // optional interactivity
}
interface FixtureStep {
  label: string                      // shown in the fixture gallery's stepper
  delayMs: number                    // after the previous step
  next: ConversationSnapshot | ((previous: ConversationSnapshot) => ConversationSnapshot)
}
```

- `FixtureBackend` turns each step into one `ConversationFrame` with `diffSnapshots(previous, next)` and an increasing `throughSeq`; it records every command in `sent` and answers `ok` unless `respond` says otherwise. Tests drive it with `backend.step()` and `backend.playAll()`; timers are used only in the browser.
- `builder.ts` gives readable construction: `fx.id('section', 'A')` → `asId('section', 'sec_A')`, and `fx.conversation().message(…).response(…).section(…).attempt(…).build()`. Fixtures are written with the builder, never as raw object literals.
- `?fixture=<id>` runs one fixture; `?fixtures` shows the gallery with a stepper. Without either, `connect.ts` uses the Worker backend.

Fixtures to exist, one file each under `src/fixtures/cases/`. ui-foundation writes the first eight; the others add theirs.

| ID | Shows | Author |
|---|---|---|
| `empty`, `no-key` | New conversation; first run with no key | ui-foundation |
| `pending`, `streaming` | Responding bubble with status; streaming text | ui-foundation |
| `overtaking` | P1 then P2 as steps: B placed above A's pending bubble; A placed first stays first | ui-foundation |
| `reply-group-mixed` | Group with done, failed, stopped, pending sections and the header count | ui-foundation |
| `trip` | The running example of 04: brief, forks A and B, join-back, J, branch B2, a join chain, an unrelated root; all four projections filled | ui-foundation |
| `failed-retry` | Failed before output; failed after partial text with a retry streaming beneath (P12, P13) | ui-transcript |
| `stopped`, `interrupted`, `cancelled` | Each mark; waiting-for-capacity and waiting-for-slot statuses | ui-transcript |
| `superseded` | Status-only bubble dropped; partial text collapsed "Superseded — revised below"; finished and superseded; superseded-input note with Regenerate; "Replying to the revised version" | ui-transcript |
| `queue-waiting`, `queue-paused` | Queue item, revised wording; paused item with the recovery choice | ui-transcript |
| `modal-target-ambiguity`, `modal-choice-default` | Both modals above the composer, the second with a countdown and a locked option | ui-transcript |
| `split-messages` | Split bubbles with the link; Undo split available, then gone after first text | ui-transcript |
| `clarification` | Question as an additional response, then the clarified answer | ui-transcript |
| `operation-states` | Every `OperationStatus`, retired operations, a pending section inside a placed group | ui-debug |
| `run-inspection` | `runs` for a started attempt, a queued directive, a superseded attempt | ui-debug |
| `compare` | An independent composite with a shared requirement | ui-debug |

## 5. UI information architecture

One screen. Regions:

```
┌──────────┬─────────────────────────────────────────────┬───────────────┐
│ Sidebar  │ Header: title · Focus bar · debug menu · ⚙  │ Debug side    │
│ New chat │─────────────────────────────────────────────│ panel (tabs): │
│ list     │ Transcript                                  │  Mini-map     │
│          │   rail │ user message                       │  Run inspector│
│          │   rail │ reply / reply group / bubble       │  Compare      │
│          │             "New output ↓"                  │               │
│          │─────────────────────────────────────────────│               │
│ Settings │ Composer dock: modal → queue items →        │               │
│          │   reply-target chip → input · Send          │               │
│          │─────────────────────────────────────────────┴───────────────│
│          │ Operation graph drawer (full width of main, scrolls sideways)│
└──────────┴──────────────────────────────────────────────────────────────┘
```

| Thing | Where | Notes |
|---|---|---|
| Conversation list | Sidebar | Create, open, delete. Collapses to a sheet under 900 px |
| Transcript | Main column, max width about 760 px | Renders `transcript.order` exactly. Pending bubbles are the tail |
| Margin rails | Left edge of every transcript item, always on | `message.chainIds` as hard segments; `section.chainId` |
| Focus | Rails, and the Focus bar in the header | Hover or keyboard focus on a rail previews; click or Enter pins; the bar shows the pinned chain with a clear button; Escape clears. Highlight `focus.own` and `focus.inherited`, dim the rest. Inherited items keep their own color |
| Request controls | Under a user message, on hover or focus | Stop and Retry from `message.actions`. Never a status badge (P7) |
| Section controls | Section footer | Exactly `section.actions`: Reply to this, Stop, Retry, Regenerate |
| Split link | Between split bubbles | "split from one message" opens Compare; Undo split beside it while `undoAvailable` |
| Queue items | Composer dock, above the input | Each links to its message. Paused items carry Retry, Continue without, Cancel |
| Modals | Composer dock, above the queue items; not a full-screen dialog | Target ambiguity and choice with default, oldest first, one at a time. The composer stays usable: sending while a choice with default is open carries out its default |
| Clarification | In the transcript | Answered with the section's Reply to this, or just by sending |
| Mini-map, run inspector, Compare | Right side panel, one tab each | A tab exists when its debug toggle is on. Compare also opens from the split link whatever the toggles say. Selecting a node or a section sets `inspected` |
| Operation graph | Bottom drawer of the main column | Behind its toggle. Selecting an operation offers "Show in transcript" (`reveal`) |
| Settings | Dialog from the sidebar | Retry policy, default wait, concurrency, models per role, thresholds, key, debug toggles |

**Key prompt.**

1. On load, `app.key.configured === false` opens the key prompt: a dialog with a password-type field, "Save key", and "Not now".
2. When `__DEV_OPENROUTER_KEY__` is non-empty (dev server only), the prompt also offers "Use the key from this environment". Only `src/app/key-prompt.tsx` reads that constant.
3. Either path sends `change-settings` with `openRouterKey: { action: 'set', key }` and then drops the value from component state. It is never put in the store, `localStorage`, or a URL.
4. Without a key the app is readable and the composer shows "Add an OpenRouter key to send messages" with a button that reopens the prompt.
5. Settings show "Key configured" or "No key", with Replace and Remove. The key itself is never displayed.

**Themes.** Light and dark through `next-themes` (`class` strategy, default `system`), a toggle in the sidebar footer. All color is tokens in `src/index.css`; no hex values in components. Both themes are checked for every fixture.

**Chain colors.** Eight tokens, `--chain-0` … `--chain-7`, each defined for light and dark with at least 3:1 contrast against the surface. `chainColor(colorIndex)` returns `var(--chain-${colorIndex % 8})`. The backend assigns `colorIndex`; the client never chooses or reorders. Per 01: a new chain, a fork, a later branch from one sibling and a join chain each have their own index; a join-back and work continuing from it use the base chain's. Start from the prototype hues (blue, clay, violet, teal) and add four that stay distinct from them and from the destructive red. A mark for several chains is hard segments, never a gradient.

**Motion.** Follow `CLAUDE.md`: load the `animate` skill first, transform and opacity only, under 300 ms, reduced motion honoured. Layout animation is allowed for a responding bubble being pushed down and for operation-graph reflow; streaming text and Focus changes do not animate layout.

## 6. Acceptance conditions and invariants

Canonical test per ID. Core tests run on `createTestBackend()` with the scripted fakes.

| IDs | Agent | Test file |
|---|---|---|
| C1–C20 | core-engine | `packages/core/src/engine/acceptance/chains.test.ts` |
| P1, P2, P3, P4, P6, P8 | core-engine | `packages/core/src/engine/acceptance/placement.test.ts` |
| D1, D2, D3, D4 | core-routing | `packages/core/src/routing/acceptance/decomposition.test.ts` |
| T1 | core-routing | `packages/core/src/routing/acceptance/targets.test.ts` |
| E1, E2 | core-routing | `packages/core/src/routing/acceptance/elicitation.test.ts` |
| P9 | core-routing | `packages/core/src/routing/acceptance/placement.test.ts` |
| T2, T3 | core-recovery | `packages/core/src/recovery/acceptance/targets.test.ts` |
| R1–R8 | core-recovery | `packages/core/src/recovery/acceptance/revisions.test.ts` |
| E3, E4 | core-recovery | `packages/core/src/recovery/acceptance/elicitation.test.ts` |
| F1–F9 | core-recovery | `packages/core/src/recovery/acceptance/failure.test.ts` |
| P10, P11, P12, P13 | core-recovery | `packages/core/src/recovery/acceptance/placement.test.ts` |
| P5, P7 | ui-transcript | `packages/web/src/features/transcript/acceptance.test.tsx` |

That is 20 + 6 + 4 + 1 + 2 + 1 + 2 + 8 + 2 + 9 + 4 + 2 = 61. T2 and T3 sit with core-recovery because they need a superseded section to exist; core-routing unit-tests the corrective-wording classification without the ID in the title.

| Invariant (11 · "Invariants") | Agent | Test file and title prefix |
|---|---|---|
| 1 Three separate relationships | core-engine | `packages/core/src/engine/acceptance/invariants.test.ts` · `I1` |
| 2 Exact consumed context | core-engine | same · `I2` |
| 4 Dependencies release only on success | core-engine | same · `I4` |
| 6 Placement | core-engine | same · `I6` |
| 10 Scope: text and read-only; no LangChain or LangGraph | core-engine | same · `I10` (no forbidden dependency in any `package.json`; core's ports expose no tool call) |
| 9 The decision model is bounded | core-routing | `packages/core/src/routing/acceptance/invariants.test.ts` · `I9` |
| 3 Append-only history | core-recovery | `packages/core/src/recovery/acceptance/invariants.test.ts` · `I3` |
| 5 Local failure | core-recovery | same · `I5` |
| 7 Rewound replacement context | core-recovery | same · `I7` |
| 8 No server assumed | core-recovery | same · `I8` |

Supplementary, without being the canonical test: ui-transcript renders P1–P4, P6–P8 and P10–P13 from fixtures (`'<ID> (web) · …'`); ui-debug tests Focus inheritance, the join-back's chain color and retired operations from the `trip` and `operation-states` fixtures; integration runs an end-to-end pass in Chromium over the Worker with the scripted fakes, and the live smoke suite.

## 7. Decisions for "Left to the build"

| Choice | Decision | Why |
|---|---|---|
| Candidates supplied to the decision model | Every current (not superseded, not dropped) section, every chain with its head, every directive not superseded or cancelled, every sibling group (`RoutingCandidates`). The router may trim to the most recent 24 sections when the state would exceed the decision model's per-question limit | Bounded by construction, and small conversations need no heuristics |
| Trivial messages skipping the decision call | No skipping. The first message of an empty conversation asks only atomic-or-composite, since there is nothing to relate it to | Latency is unmeasured; skipping is a silent guess |
| Concurrency limit scope | It counts answer and synthesis runs only. Decision and decomposition calls, and join-backs, take no slot. "Per provider" is one pool, keyed `openrouter` | Routing gates everything, so queueing it behind answers would stall the chat; every call goes through one provider today |
| Backoff | `RETRY_POLICIES` in `protocol/src/settings.ts`: Standard 3 retries at 1 s, 2 s, 4 s, accepting `Retry-After` up to 60 s; Persistent 8 retries up to 30 s apart, accepting `Retry-After` up to 10 min. No jitter. 429 waits and interruption recoveries count against the same limit | Deterministic under the fake clock; Persistent differs only in patience |
| Pinned decision model and thresholds | `typesafe/jev-1.13`; initial thresholds in `DEFAULT_SETTINGS.thresholds`, to be replaced after the routing corpus exists | Verified live; `jev-latest` does not exist on OpenRouter |
| Context warning | At 80 % of the model's limit (`CONTEXT_WARNING_RATIO`), as a note on the section | Leaves room for one more exchange |
| Chunk size for stored output | First text of an attempt at once; then 96 characters or 80 ms, whichever comes first; always before the terminal event (`CoreOptions.outputChunk`) | First text fixes placement; the rest keeps the log small without visible stutter. The same chunks are the stream, so the log and the screen agree |
| Embedded secrets store | A separate IndexedDB database, `committee-secrets`, opened only in the Worker | Apart from the event log (Q64); the Worker cannot use `localStorage` |
| Wording for the concurrency hold | "Waiting for a free slot" (`WORDING.waitingForSlot`), state `ready` | Distinct from "Waiting for capacity" and from a dependency wait |
| Stage that assigns each fragment its chain and target | After decomposition: one further batched decision call with a question set per fragment over the same candidates. The gate's message-level answers are kept in the decision record | Fragments do not exist before decomposition, and the decision model must still be the one that selects |
| Detecting a superseded input | Compare each completed attempt's recorded `context.inputs` with the current result of those directives. No estimate of whether the result would change | Exact, cheap, and never wrong in the quiet direction |

Also decided here: IDs are `<prefix>_<ULID>`; events of all conversations plus one app log (`APP_LOG`) for the conversation list and settings; `Backend.start()` loads every conversation so interrupted work resumes without the user opening it.

## 8. Order of work and reviews

1. In parallel: core-engine, providers, storage, ui-foundation, ui-transcript, ui-debug.
2. core-routing after core-engine; core-recovery after core-routing.
3. integration: Worker entry (`servePort(createBackend(…), self)`), `connect.ts` Worker mode, provider fake re-export, end-to-end and smoke runs, `docs/build/STATUS.md` with what passes.
4. Reviews, one after another, each starting from the previous one's fixes. The specification has many interacting edge cases, so one pass is not enough. Each review reads the spec chapter's "Edge cases" table row by row, not only the acceptance conditions, and records findings in `docs/build/STATUS.md`.

| Pass | Checks | Against |
|---|---|---|
| 1 Contracts | Every package builds on `protocol` and the ports as written: no duplicate types, no client-side decision about placement, ordering, dependencies or context, nothing reads one of the three relationships as another | Sections 1–3 here; invariants 1, 9 |
| 2 Chains and placement | Forks, group closing, join-back order, branches, join chains, snapshot at start, first-output placement, overtaking, reply groups | 01, 03, 04 including every edge-case row; C1–C20, P1–P9 |
| 3 Revisions, elicitation, recovery | The four revision states, dependents of a revised target, shared-requirement choice with default, retries in the same bubble, pause and the three recovery choices, retry after closure, interruption under each policy | 05–08 including every edge-case row; T, R, E, F, P10–P13 |
| 4 Interface | Every element, control and fixed wording of 10 Part 1 exists and matches; rails and Focus always on; debug views behind their toggles; both themes; reduced motion; key never visible | 09, 10; every fixture in light and dark |
| 5 End to end | A real conversation over the Worker with live models: parallel answers, a dependent follow-up, a composite, a revision, a stop and retry, reload mid-answer | README executive summary; the smoke suite |

# Committee MVP build plan

The contract between the agents building the MVP. `docs/spec/` says what Committee does; this says who builds which files against which interfaces. If this plan is wrong, work around it inside your own paths and report it.

This is revision 2. Two reviews of the contracts found gaps; section 10 lists what changed, and section 9 lists the suggestions that were not taken and why.

Contracts already in the tree, to read before writing code:

| Read | For |
|---|---|
| `packages/protocol/src/` | IDs, `model.ts` (states, failures, placement, consumed context), `events.ts`, `commands.ts`, `projections.ts`, `patches.ts`, `backend.ts`, `wire.ts`, `settings.ts`, `wording.ts` |
| `packages/core/src/ports/` | `ModelProvider`, `DecisionProvider`, `Decomposer`, `EventStore`, `ProjectionCache`, `SecretsStore`, `Clock`, `Timers`, `Router` and `RoutingPlan`, `Backend`, `CoreDependencies` |

Field comments in those files state the rule and the Q-number. They are part of the contract.

## 1. Rules for every agent

- Touch only your paths (section 3). Every file in the repository has exactly one owner there.
- Libraries are compiled by the web package too, which sets `erasableSyntaxOnly`, `noUnusedLocals` and `noUnusedParameters`: no enums, no namespaces, no constructor parameter properties, no unused bindings in `protocol`, `core`, `storage`, `providers`.
- `protocol` and `core` compile without DOM or Node globals. There is no `setTimeout`, `AbortSignal`, `console`, `fetch` or `crypto` there, by design: use the `Clock`, `Timers`, `CancelSignal` and `IdFactory` ports.
- Packages import each other by package root. Two exceptions, both sub-entries of core: `@committee/core/testing` (the fakes) and `@committee/core/ports` (the port interfaces alone). **storage and providers import from `@committee/core/ports`, never from `@committee/core`**, so they compile and test while the engine is being written.
- Stored and transmitted data is plain JSON. An absent value is `null`, not an optional field, in events and projections. Commands, which are never stored, may have optional fields.
- Fixed wording comes from `WORDING` and the formatters in `protocol/src/wording.ts`. Core fills the `text` fields of projections with them; the client renders those fields and uses `WORDING` for its own chrome.
- Acceptance tests are titled `'<ID> · <condition>'`, one canonical test per ID in the file named in section 6. A supplementary test for the same condition is titled `'<ID> (engine) · …'` or `'<ID> (web) · …'`.
- The OpenRouter key appears in exactly three places: the key prompt's input, the `change-settings` command on its way to the Worker, and the secrets store. Never in an event, a projection, an error message, a log line, a test snapshot or a recorded list of commands.

## 2. Domain model decisions the contracts encode

These settle points the specification leaves to the build or states only by example. They are binding for the three core agents.

### Directive, section, attempt

A directive is the stable identity of a piece of work across retries and revisions. A *section* is the slot its output occupies in the transcript. An *attempt* is one execution.

| What happens | Directive | Section | Attempt | Genealogy node |
|---|---|---|---|---|
| Automatic or user retry | same | same (same bubble, Q51, Q83) | new | same |
| First retry after its sibling group closed (Q92) | same | same | new | new: a child of the join-back node, on the base chain (reason `retry-after-closure`). Later retries reuse it |
| Revision of started work, Regenerate, redo (Q38, Q40) | same | new, in a new response | new | new, replaces the old one |
| Restart of a running dependent whose prerequisite was revised (Q36, R4) | same | new, in a new response of reason `prerequisite-revised`; the old one is superseded with cause `prerequisite-revised` | new | new (reason `prerequisite-revised`), replaces the old one, same planned parents, resolved again at start |
| Revision of work not started (Q41) | same, instruction updated in place | same | none | same |
| Clarification question | its own directive, kind `clarification-question` | its own, in a response of reason `clarification-question` | its own | none: it runs on the node of the first directive it blocks |

A `directive` prerequisite therefore follows a revision by itself: J waiting on directive A waits for A′.

A revision's target is in one of five states (`RevisionTargetState`). The fifth, `ended-unfinished`, is the build's: a target that had failed, been stopped, been interrupted or been cancelled is replaced exactly like running work, with rewound context.

### States

`DirectiveState` is the ten states of 01 plus three build refinements: `ready` (held only by the concurrency limit), `retrying` (between automatic retries), `awaiting-elicitation` (held by a clarification or a choice with default). `IN_FLIGHT_STATES` is the test for "keeps its sibling group open": it includes `retrying` and `paused`, so a group closes only when every member is completed, failed, stopped, interrupted or cancelled. A member or prerequisite cancelled before it started is recorded like a failed one, as a request and a marker (`UnfinishedOutcome`), and pauses its dependents the same way.

### Stopping

Stop reaches each directive in its scope (one section, or every directive of one user bubble) and does one thing per directive, by its state:

| State when Stop reaches it | Event | Becomes |
|---|---|---|
| `running` (an attempt is in flight) | `attempt-stopped` | `stopped`; visible text kept |
| `retrying`, `waiting-for-capacity` (started, no attempt in flight) | `directive-stopped` | `stopped`; the scheduled retry is cancelled |
| `dependency-queued`, `paused`, `ready`, `awaiting-elicitation` (never started) | `directive-cancelled`, cause `request-stopped` or `section-stopped` | `cancelled` |
| Already settled | none | unchanged |

The section-level Stop control is offered only on started work (`SectionView.actions.stop`); the command still accepts any section. Dependents outside the scope are never cancelled by a stop (Q48); they are paused.

### Transcript order

One rule: items whose position is fixed, in the order they were fixed, then the responding bubbles still pending, in request order. A user message is fixed on submission; a response on `response-placed` (first answer text, a failure notice, or ending without output). Sections inside a reply group follow the same rule unless the user gave an explicit output order. Core computes `transcript.order` and `response.sectionIds`; the client renders them.

**The responding bubble exists from submission.** `message-submitted` mints the message's initial `responseId`. Until routing settles, the transcript holds a response with that ID, no sections, and `routing` set (`'routing'`, `'awaiting-target'` or `'failed'` with its text). When the plan creates work answered in the initial response, `response-opened` carries the same ID and the bubble simply gains its sections. When it does not (split messages, a message that only revises, a message that only answers a clarification), the provisional response is removed. A routing failure stays a pending bubble with the failure text; it is status, fixes nothing, and Retry on the request routes again. Nothing about routing is ever drawn on the user message (P7).

### Genealogy, mechanically

The router chooses a `Placement`; the engine applies it. For `continue` on a point P, first the repair, then three cases **in this order; the first that matches wins**:

| # | Condition | Result |
|---|---|---|
| 0 | P's own directive is in flight and the unit has no `directive` prerequisite on it | Repair: P becomes its nearest ancestor that is not in flight (its starting context), then continue below. With no such ancestor the unit becomes `new-chain`; for the first node of a join chain, a join chain with the same parents |
| 1 | P has a child in flight | **Fork.** Opens a sibling group at P, or joins the open one. The base chain is P's chain. An existing child that was continuing P's chain moves to a fork chain of its own, with anything queued behind it (`sibling-group-opened.rechained`): the only time a node changes chain. An existing child that is already on its own branch chain keeps it and becomes a member as it is |
| 2 | P is a member of a sibling group (open or closed), or P is not its chain's last node | **Branch.** New `branch` chain from P, own color (Q89). No sibling group, no join-back. This includes work placed on a join-back after the base chain has already moved on from it; the router normally builds such work on the base chain's head instead |
| 3 | Otherwise: P is its chain's last node, not a member, nothing in flight beneath it | **Same chain continues** (for a join-back: the base chain, Q78) |

So: B sent while only A runs on the trip chain builds on the brief (the chain's `headNodeId`), finds A in flight beneath it, and opens the group (case 1). The first reply to finished sibling B is a branch (case 2 comes before case 3, although B is the last node of its fork chain). A second reply to B while the first is still running opens a sibling group at B whose base chain is B's fork chain (case 1 comes before case 2).

- **`CandidateChain.headNodeId`** is the chain's last node whose own work is not in flight, or null; **`tipNodeId`** is its last node whatever its state. Work that does not wait builds on the head. Work that needs a result still being produced builds on the tip and carries the prerequisite. The engine applies repair 0 to every plan, a scripted one included.
- **"A child in flight"** is a directive in `IN_FLIGHT_STATES` whose node names P exactly: its planned parent is `{ kind: 'node', nodeId: P }`, or it has started with P among its parents. Three things are nobody's child for this rule: queued work whose planned parent is still an unresolved `sibling-group` point, a late retry (below), and a clarification question (it has no node).
- **`{ kind: 'sibling-group' }`** as a point resolves, when the attempt starts, to the group's current join-back node and to nothing else. On an open group the unit must also carry the `sibling-group` prerequisite; validation adds it.
- **The cases place new work only.** A replacement node (revision, restart, Regenerate, redo) is on the chain of the node it replaces and has the same planned parents; a late retry's node is on the base chain. Neither goes through the table.
- **Late-retry tail.** The first retry of a member after its group closed gets a new node that is a child of the join-back node, on the base chain. These nodes are the group's tail (`JoinBackNodeView.lateRetryNodeIds`). For the table above they are never a chain's head, never its last node, and never a child in flight. **Reading a join-back** means: its record, then the exchange of every tail node that had completed when the reading run started, in the order the retries were requested. This holds wherever the join-back sits in an ancestry, so a dependent released by the retry reads `record (with the marker) → the retry's exchange`, work placed on the group later reads the same, and nothing is ever placed beneath later base-chain work by a retry. A dependent that already ran without the member keeps its record and gets the superseded-input note; when it is regenerated, its new node is a child of the join-back, a sibling of the node it replaces, never its descendant.
- A replacement's context never includes the exchange it replaces, with the one exception in 06: a revision of *finished* work, where A′ sees A and the correction.
- When a member is revised after its group closed, a further `join-back-formed` for the same group replaces the earlier one once the replacement has settled (completed, or ended without retrying). In context the record reads: the member's request, the correction, the replacement answer (Q39). A retry that completes after closure does not re-form the join-back.
- Membership is by directive. A member revised while the group is open stays a member through its replacement. Members are never added to a closed group.
- **Withdrawn members.** Undo split withdraws its directives from any sibling group with `siblings-withdrawn`. Withdrawn members do not count for the closing rule, are not named in wait labels and are absent from every join-back record; their nodes stay in the genealogy, marked superseded, inside the group's oval. A group that keeps one member carries on and forms a one-member join-back, which is how that member's exchange returns to the base chain. A group left with none is `dissolved` and forms no join-back.
- **A join chain over an open group.** A join chain's parent may be a `sibling-group` point ("compare the trip recommendations, still running, with the sky explanation"). The unit waits on the group; the parent resolves to the join-back node when the attempt starts, and the chain's inheritance is exact from then on.
- An ancestor exchange that did not complete is read as its request plus a marker, never partial text, whether it sits in a join-back or on a plain chain (`ContextOrigin: 'unfinished-exchange'`).
- `colorIndex` is the chain's ordinal in creation order. Joining back creates no chain and no color.

### Context assembly

One function, in core-engine, written against the whole `ContextOrigin` union. The model input is, in order:

1. The preamble.
2. The session-wide requirements in force when the run starts, in the order recorded. One that was replaced or withdrawn is not sent.
3. The ancestry, root first. For a join chain, each parent's ancestry in the order of `parents`, every node once. An exchange node is read **by its directive as it stands when the run starts**, not by the attempt that happened to run on that node (Q39, Q96):
   - the directive's request, then every correction to it, then the answer of its current result, when it has one. So an ancestor that was revised, regenerated or retried in place is read with its replacement, and the superseded body is read by nobody except the replacement of finished work;
   - when the directive has no current result because its work ended without completing: the request and a marker;
   - when its replacement is still running: the request and the corrections, and nothing else.

   A join-back node is read **as recorded**, in its latest formation: each member in submission order, as its exchange or as its request and marker, then the completed late-retry tail. A member's marker stays in the record after a late retry completes; the retry's exchange follows the record.
4. The run's own request: the directive's instruction with its requirements. For a revised directive, the original instruction and then the correction; nothing rewrites the instruction with a model. For the replacement of *finished* work the old exchange comes first: the request, the superseded answer, then the correction (06: "A′ is a follow-up that sees A and the correction"). In every other replacement and retry no earlier text of the directive is read.
5. For a directive that was blocked by a clarification: the question, then the user's answer.

`ConsumedContext` records the messages, the nodes read, the result read per directive (`inputs`), the corrections read (`corrections`) and the session-wide requirements read (`sessionRequirementIds`).

### Detecting a superseded input

A completed attempt that is its directive's current result has a superseded input when any of these holds; there is no finer estimate of whether the result would change:

| Kind | Condition |
|---|---|
| `result` | A directive in its `context.inputs` now has a different current result, or none: a revision replaced it, or the attempt read only a marker and a retry has since completed |
| `correction` | A `revision-recorded` of scope `shared-requirement` targets a directive in its `context.inputs`, its message is not in the attempt's `context.corrections`, and the revision's choice with default has been resolved without redoing this work |
| `session-requirement` | A requirement in its `context.sessionRequirementIds` was replaced or withdrawn by a revision, with the same proviso about the choice |

`superseded-input-noted` lists every such input. Work that is itself superseded or still in flight is never noted.

### Revisions

- **One piece of work** (scope `work`): not started → `directive-revised-in-place` (and `directive-waiting` with `revised: true` when it has a queue item). Anything else → `section-superseded` (cause `revision`), a new node, a new response of reason `revision-replacement`, a new section. `RevisionRecorded.targets[].sectionId` is null for a target that has no section yet (a directive blocked by a clarification).
- **Dependents** are the directives whose latest attempt's `context.inputs` name the target, plus the queued ones whose prerequisites do. Queued: nothing but a refreshed `directive-waiting`. Running: the restart row of the table above. Completed: the note.
- **A composite message with corrective parts.** `RoutingPlan.revisions` is a list. Each corrective fragment is one `PlannedRevision` with its `fragment`; it is recorded in `message-decomposed` as a `FragmentRecord` of kind `revision`, whose `directiveId` is the first directive it revises. The other fragments are ordinary units. A reply with one unit beside its revisions is not grouped.
- **A shared requirement** (scope `shared-requirement`). When the revision is recorded:
  1. `elicitation-raised` (choice with default) over the router's `affected` list: running and queued work locked, finished work selectable.
  2. Each running option: `section-superseded` (cause `redo`, naming the elicitation, ending the attempt), a new node, a response of reason `redo`, a new pending section, and `directive-held` (`choice-with-default`).
  3. Each queued option: `directive-held`.
  When the user confirms, sends another message, or the wait elapses: `elicitation-answered` or `elicitation-defaulted`; every held directive goes back to `directive-ready` or `directive-waiting`; each chosen finished option is superseded and redone the same way; every other consumer gets `superseded-input-noted`. With an empty `affected` list no elicitation is raised and the detection rule applies at once.
- **"Redid J by default".** No event carries the note. The transcript projection adds it when `elicitation-defaulted` arrives, to the work that elicitation redid: the replacement of every section superseded with cause `redo` for it, and the current section of every directive that was held for it. A redo the user confirmed has no note.
- **Session-wide requirements** can be replaced (`session-requirement-recorded.replacesRequirementId`) or withdrawn (`session-requirement-withdrawn`). A corrective message that does either is a `shared-requirement` revision whose `targetRequirementIds` name them.

### Clarification

- Clarifications are on the plan (`RoutingPlan.clarifications`), one entry per question with every unit it blocks, so one ambiguous shared requirement is asked once.
- The question is a directive of kind `clarification-question`, answered by the answer model and shown as an additional response. It is exempt from the whole-request barrier (E1), takes a concurrency slot like any answer run, has no genealogy node of its own, and is never a sibling-group member or anyone's child.
- Its input is the ancestry of the first directive it blocks, then its own request, which core composes from the blocked requests and the plan's `about`.
- A blocked directive is `awaiting-elicitation`, has no queue item and no bubble until the answer arrives, then opens its section in a new `clarified-answer` response. Its input ends with its own request, the question (`clarification-question`), and the user's answer (`clarification-answer`).
- The answering message creates no directive. Its rail (`MessageView.chainIds`) is the chains of the directives it released.

### Undo split

Available while no section of the split shows answer text and no later message targets, builds on or waits for any of its directives. One step: `section-superseded` (cause `undo-split`) for each of its sections, ending any running attempt and dropping status-only bubbles; `siblings-withdrawn` where they were members; `split-undone`. The original message returns to the transcript at the position it was submitted at, with its provisional responding bubble, and is routed again with `forcedComposition: 'atomic'`. The plan that comes back is carried out like any other; nothing is restored by hand.

### Routing failure and lost routing

- If the decision provider or decomposer fails, `routing-failed` is recorded and Retry on the request routes again. An outcome no module handles is recorded the same way. Committee never falls back to a guess.
- `routing-decided` and every event that carries its plan out are appended in one step.
- A message is *waiting for a routing outcome* from each of `message-submitted`, `routing-retried` (Retry on a request whose routing failed), `split-undone`, and the `elicitation-answered` that chose its targets, until a `routing-decided`, a `routing-failed` or a target-ambiguity `elicitation-raised` for it follows. While it waits, its responding bubble shows the routing status.
- A message found still waiting when `Backend.start()` runs lost its routing with the executor. It is routed again, under every retry policy. Nothing was recorded for the lost routing, so nothing is repeated.

### Interruption and the single executor

In the embedded deployment an attempt is interrupted only by losing its executor. `Backend.start()` finds attempts with no terminal event and records `attempt-interrupted`. A network drop during a run is a transient `network` failure, not an interruption.

Exactly one backend may run over the local stores. The Worker asks for the Web Lock `committee-backend` before it builds the backend. If another tab holds it, the Worker posts the wire message `{ kind: 'standby', reason: 'another-tab' }`, keeps waiting for the lock, and starts normally when the other tab closes; the page shows `WORDING.openInAnotherTab` meanwhile. A second tab therefore never marks the first tab's live attempts interrupted and never forks a log.

### Stream and snapshots

One frame per coordinator step carries the step's events and the patches from `diffSnapshots(before, after)`. Frames carry events in their streamed form (`toStreamedEvent`): `attempt-started` travels without the model input. To open a conversation: subscribe, then snapshot, then pass every frame through `reconcileFrame`. The run inspector's record, with the exact input, is fetched with a `run` snapshot query; the `events` query returns stored events in full.

## 3. Module map and ownership

### protocol, core ports: architect

`packages/protocol/**`, `packages/core/src/ports/**`, `packages/core/package.json` (the export map), `docs/build/PLAN.md`. Changes to these go through `requestsForOthers`.

### core: three agents, one after another

`packages/core/src/index.ts` only re-exports. Each core agent appends the one export line for its slice when it lands.

| Agent | Paths | Role |
|---|---|---|
| core-engine (milestone 1) | `src/engine/**`, `src/testing/**` | **What events mean, and everything a plan can state.** The state shape, every reducer, the four projections and the run inspection, context assembly, the coordinator and scheduler, `createBackend`, all fakes |
| core-routing (milestone 4 logic) | `src/routing/**` | **Deciding about a message.** The default `Router` (decision gate, decomposition, validation), target-ambiguity and clarification elicitation, Undo split |
| core-recovery (milestone 5 logic) | `src/recovery/**` | **Deciding what follows work that did not finish or was corrected.** Retry policies, pause and the recovery choice, revisions, Regenerate, choice with default, superseded-input notes |

**One owner for meaning.** core-engine writes the reducer for *every* event in `events.ts`, the projections over the whole state, and the context assembler over the whole `ContextOrigin` union, including for events it never emits itself. It tests those by folding hand-written event sequences. The later slices decide *when* to emit events: command handlers, reactions, plan appliers, outcome handlers, the retry planner. A later slice changes a file under `engine/` only to fix a defect, and says so in its report. The core agents run one after another, so such a fix never collides.

```ts
// packages/core/src/engine/module.ts (core-engine defines the exact types)
interface CoreModule {
  name: string
  commands?: Partial<{ [T in CommandType]: CommandHandler<T> }>
      // (state, command, ctx) => events | CommandError | null. null passes to the next module that handles the type.
  reactions?: Reaction[]
      // (state, event, ctx) => follow-up events and effects. Run in module order until quiet.
  planAppliers?: PlanApplier[]
      // (state, plan, ctx) => events. Each takes the parts of a RoutingPlan it knows; all run in one step.
  outcomeHandlers?: Partial<{ [K in 'target-ambiguity']: OutcomeHandler<K> }>
      // What to do with a routing outcome that is not a plan. `failed` is the engine's.
  retryPlanner?: RetryPlanner
      // (state, directiveId, cause: { kind: 'failed', error } | { kind: 'interrupted' }, now) => RetryPlan. The last module that has one wins.
  startupReactions?: StartupReaction[]
      // (state, ctx) => events and effects, run by start() for each conversation after its log is folded.
  createRouter?: (deps: CoreDependencies) => Router
      // Used when deps.router is absent. The last module that has one wins.
}
createBackend(deps: CoreDependencies, options?: Partial<CoreOptions>, modules?: CoreModule[]): Backend
```

- `engine/index.ts` exports `engineModule`; `routing/index.ts` exports `routingModule` and `createRouter`; `recovery/index.ts` exports `recoveryModule`. `createBackend` defaults `modules` to every module that exists at that point, engine first.
- `ctx` gives a handler what it may do besides returning events: mint IDs, read the clock and settings, `ctx.route(messageId, { chosenTargets?, forcedComposition? })` to route a message again, and schedule a timer that comes back as an input to a later step.
- `createBackend` throws when it has neither `deps.router` nor a module with `createRouter`.
- Projections are pure functions of `ConversationState` (`engine/projections/*.ts`) with structural sharing, so `diffSnapshots` is cheap.
- A step is: command or provider/timer input → events → reducers → reactions until quiet → append to the `EventStore` → one frame to subscribers. Effects (model calls, timers, routing) start only after the step's events are appended.
- `ConversationState` is JSON and is what the `ProjectionCache` stores (`stateVersion` guards its shape).

**Who builds each behaviour.** One builder each; "decides" means emits the events, "applies" means carries a plan's statement out.

| Behaviour | Builder | Notes |
|---|---|---|
| Reducers, projections, run inspection, context assembly for every event and origin | core-engine | Folded from hand-written logs where the engine does not emit the event |
| Applying a plan's `units`: chains, nodes, sibling groups, directives, prerequisites, responses, sections, the repairs and the three placement cases | core-engine | With `ScriptedRouter` plans |
| Composite presentation: reply group, `sectionOrder`, `outputOrder`, split messages (minting their message IDs, topological order), `message-decomposed` | core-engine | From the plan. core-routing produces the plan, nothing else |
| Whole-request barrier (`directive-waiting.heldByBarrier`, release) | core-engine | Canonical D3 and E1 run the real pipeline in core-routing; the engine adds `'D2 (engine)'` and `'D3 (engine)'` with scripted plans |
| Session-wide requirements: `session-requirement-recorded`, `-withdrawn`, and their place in context | core-engine | From `plan.sessionRequirements` and `withdrawnSessionRequirementIds` |
| Redirect of an explicit target on a superseded section (Q43) | core-engine | A pure function over sections; canonical T3 is core-recovery's, where superseded sections first exist |
| `section-superseded` as a primitive: ends a running attempt, drops a status-only bubble, collapses partial text, marks finished work | core-engine | Emitted by core-routing (Undo split) and core-recovery (revisions) |
| The closing rule, join-back formation and re-formation, and what `siblings-withdrawn` does to them | core-engine | Undo split emits `siblings-withdrawn`; a revision's reaction asks for the re-formation |
| Stop, both scopes, by the table in section 2 | core-engine | |
| Terminal failure; carrying out a scheduled `RetryPlan` (timer, then a new attempt in the same section); `attempt-interrupted` on start; routing a lost message again on start | core-engine | Asks the `retryPlanner`. Until core-recovery supplies one, the engine's default answers `none` (`non-retryable` for a non-retryable error, `manual-policy` otherwise) |
| Label generation: after `directive-created` for a unit with `labelIsProvisional`, call `Decomposer.label` when it exists and record `directive-labeled`. No concurrency slot; a failure is ignored | core-engine | providers implements `label` |
| The routing pipeline behind `Router` | core-routing | `routingModule.createRouter` |
| `target-ambiguity` outcome: raise the elicitation, hold the message, route again with `chosenTargets` | core-routing | `outcomeHandlers` |
| `plan.clarifications` and `plan.answersElicitationId`: the question directive, `directive-held`, release on the answer | core-routing | `planAppliers` |
| Undo split | core-routing | `undo-split` command; uses the engine's primitives and `ctx.route` |
| The retry planner for the three policies; the `retry` command, including the late-retry node | core-recovery | |
| Pausing dependents, the recovery choice, Continue without, Cancel | core-recovery | Before it lands, a dependent of work that ended unfinished stays dependency-queued |
| `plan.revisions`: every row of the revision tables, the choice with default and its timer, Regenerate, `superseded-input-noted` | core-recovery | `planAppliers`, reactions, `startupReactions` for deadlines |

Who emits which events, and who handles which commands:

| Slice | Emits | Commands |
|---|---|---|
| core-engine | `message-submitted`, `routing-decided`, `routing-failed`, `routing-retried`, `message-decomposed`, `session-requirement-recorded`, `session-requirement-withdrawn`, `chain-created`, `node-created`, `sibling-group-opened`, `sibling-admitted`, `join-back-formed`, `directive-created`, `directive-waiting`, `directive-ready`, `directive-labeled`, `directive-stopped`, `directive-cancelled` (stops), `stop-requested`, every `attempt-*` event, `context-limit-warned`, `response-opened`, `section-opened`, `response-placed`, `section-placed`, all app events | `submit-message`, `stop`, `retry` (only for a request whose routing failed: route again; passes otherwise), `change-settings`, `create-conversation`, `list-conversations`, `delete-conversation` |
| core-routing | `split-undone`, `siblings-withdrawn`, `section-superseded` (undo split), `directive-held` (clarification), `elicitation-raised` and `elicitation-answered` (target ambiguity, clarification) | `undo-split`, `answer-elicitation` (target ambiguity; passes otherwise) |
| core-recovery | `retry-requested`, `directive-paused`, `directive-cancelled` (recovery), `prerequisite-waived`, `prerequisites-changed`, `directive-revised-in-place`, `revision-recorded`, `regenerate-requested`, `section-superseded` (revision, prerequisite revised, regenerate, redo), `superseded-input-noted`, `directive-held` (choice with default), `elicitation-raised` (choice with default, recovery choice), `elicitation-answered` (those two), `elicitation-edited`, `elicitation-defaulted`, `elicitation-withdrawn`, and the node, response and section events of replacements | `retry`, `regenerate`, `continue-without`, `cancel`, `answer-elicitation` (choice with default; passes otherwise) |

**Fakes** live in `packages/core/src/testing/` and are exported as `@committee/core/testing`. core-engine creates `testing/index.ts` in its first commit with these names, which other agents rely on:

| Export | Behaviour |
|---|---|
| `FakeClock` | Implements `Clock` and `Timers`; `advance(ms)` fires due timers in order; `now()` never moves by itself |
| `ScriptedModelProvider` | Per request (matched by a predicate on the request, or in call order): a script of `{ afterMs, event }` steps on the fake clock, covering text, completion, each failure code, a hang, and cancellation. Records every request it received |
| `ScriptedDecisionProvider`, `ScriptedDecomposer` | Answer from a queue or a function; record requests |
| `ScriptedRouter` | Returns the `RoutingOutcome` the test supplies for each message (milestones 1–3) |
| `MemoryEventStore`, `MemoryProjectionCache`, `MemorySecretsStore` | In-memory ports for core's own tests |
| `createTestBackend(overrides?)` | A started `Backend` over all of the above, with a seeded `IdFactory`, plus the fakes for assertions |

A simulated interruption is: dispose the backend, build a new one over the same `MemoryEventStore`, start it.

### providers: `packages/providers/**`

| File | Contents |
|---|---|
| `src/openrouter/model-provider.ts` | `createOpenRouterModelProvider({ getKey, fetch })`: SSE with `eventsource-parser`, comment lines skipped, error mapping with `providerErrorCodeForStatus` and `providerError`, `Retry-After`, empty 200, mid-stream `finish_reason: "error"`, abort on cancel |
| `src/openrouter/models.ts` | Context limits from `/api/v1/models`, cached; token estimate for `countTokens` |
| `src/openrouter/decision-provider.ts` | `createOpenRouterDecisionProvider`: the live Decisions shape in `CLAUDE.md`; `noul` → `probability`; a `choice` outside the supplied options is `malformed-response` |
| `src/openrouter/decomposer.ts` | `createOpenRouterDecomposer`: `decompose` with a `response_format` JSON schema, validated with `zod`, spans checked against the text; and **`label`**, a short noun phrase for an atomic request, on the same decomposition model |
| `src/*.test.ts`, `src/*.smoke.test.ts` | Unit tests with an injected `fetch`; smoke tests on `anthropic/claude-haiku-5.5` |
| `tsconfig.json` | Add `"types": ["node"]`: under TypeScript 7 `@types/node` is not included by default, and the smoke tests read `process.env.OPENROUTER_KEY` |
| `src/index.ts` | Exports the three factories. The re-export of the scripted fakes (`export * from '@committee/core/testing'`) is added by **integration**, once core's testing entry exists |

`getKey: () => Promise<string | null>` is the only way a provider sees the key. `fetch` is injected so the unit tests never touch the network. Import port types from `@committee/core/ports`.

### storage: `packages/storage/**`

| File | Contents |
|---|---|
| `src/adapter.ts` | One small key-value adapter interface with ordered range reads, used by both stores (Q58, Q63) |
| `src/indexeddb-adapter.ts`, `src/memory-adapter.ts` | The two adapters (`idb`; tests use `fake-indexeddb`) |
| `src/event-store.ts`, `src/projection-cache.ts` | `createEventStore(adapter)`, `createProjectionCache(adapter)` implementing the ports, including `EventStoreConflictError` on a gap and atomic appends |
| `src/secrets-store.ts` | `createSecretsStore(adapter)` over a **separate** IndexedDB database |
| `src/index.ts` | `openIndexedDbStorage()` → `{ eventStore, projectionCache, secretsStore }`, `createMemoryStorage()`. The conformance suites are the sub-entry `@committee/storage/conformance` (`src/conformance.ts`), because they import `vitest` and the root entry is bundled into the Worker |
| `src/conformance.ts` + tests | `describeEventStore(name, make)`, `describeProjectionCache(name, make)`, `describeSecretsStore(name, make)`: one suite, run against both adapters |
| `src/core-fakes.test.ts` | Written by **integration**, the one file in this package that is not storage's: runs the same suites against `MemoryEventStore`, `MemoryProjectionCache` and `MemorySecretsStore` from `@committee/core/testing`, so core's tests and the real stores are held to one contract |

Databases: `committee-events` (logs and cache) and `committee-secrets`. Import port types and `EventStoreConflictError` from `@committee/core/ports`.

### web: three UI agents and integration share `packages/web`

Ownership is by path and is disjoint. Nobody edits a file outside their row, and no file is listed twice.

| Agent | Paths |
|---|---|
| ui-foundation | `package.json`, `components.json`, `vite.config.ts`, `tsconfig*.json`, `index.html`, `src/App.tsx`, `src/main.tsx`, `src/index.css`, `src/env.d.ts`, `src/app/**` (shell, sidebar, settings, key prompt, UI state, standby notice), `src/backend/**`, `src/design/**`, `src/components/**`, `src/lib/**`, `src/hooks/**`, `src/test/**`, `src/fixtures/*.ts`, and its own case files (table in section 4) |
| ui-transcript | `src/features/transcript/**`, `src/features/composer/**`, `src/features/association/**` (rails and Focus), and its own case files |
| ui-debug | `src/features/debug/**` (mini-map, operation graph, run inspector, Compare), and its own case files |
| integration | `src/worker/**`, `packages/web/e2e/**`, root `package.json`, `vitest*.config.ts` and other root config, `packages/providers/src/index.ts` (the one re-export line), `packages/storage/src/core-fakes.test.ts`, `docs/build/STATUS.md` |

Rules that keep it disjoint:

- **Fixture cases.** `src/fixtures/cases/<id>.ts` belongs to the author named for that ID in section 4 and default-exports one `Fixture`. The registry is `import.meta.glob('./cases/*.ts', { eager: true })` in `src/fixtures/index.ts`: nobody adds a registry line, and nobody edits another agent's case.
- **Components.** Only ui-foundation runs the shadcn or AI Elements CLI, edits `package.json`, or touches `src/components/**`. Its first commit installs everything the other two need: button, input, textarea, label, checkbox, switch, slider, select, radio-group, tabs, dialog, sheet, popover, tooltip, dropdown-menu, collapsible, scroll-area, separator, badge, alert, skeleton, plus the AI Elements already present. A feature agent that needs a variant copies the component into its own feature directory and adapts the copy. One that needs something not installed writes a local primitive and asks in `requestsForOthers`.
- **No file changes hands.** Where one agent's code must call another's that may not exist yet, it finds it with `import.meta.glob`, which matches nothing without failing:
  - Entry components. The shell reads them through `src/app/features.ts` (ui-foundation): `import.meta.glob('../features/*/index.ts', { eager: true })`, looked up by feature and export name, rendering nothing for one that is missing. The shell compiles and runs whether or not a feature exists, and nobody writes a placeholder in another agent's directory.
  - Worker mode. `src/backend/connect.ts` (ui-foundation) chooses fixture mode or Worker mode. For Worker mode it globs `'../worker/client.ts'` and calls its default export, `connectWorker(hooks: { onStandby(reason: StandbyReason): void }): PortClient` (integration). It sets the status to `standby` from the hook, `ready` when `client.ready` resolves, `failed` when it rejects, and `failed` with "Worker backend not wired" while the file does not exist.
- **Test setup.** `src/test/setup.ts` polyfills what jsdom lacks and the installed components use: `ResizeObserver`, `window.matchMedia`, `Element.prototype.scrollIntoView`, `hasPointerCapture`/`setPointerCapture`/`releasePointerCapture`.

**The foundation contract comes first.** ui-transcript and ui-debug import ui-foundation's store, hooks, UI state, fixture builder and test helper. ui-foundation's **first commit** contains all of the following, complete and typechecking (bodies may be simple, signatures are final), and the other two UI agents start from a tree that has it. A feature agent that finds `src/backend/index.ts` missing waits for it; it never writes its own copy:

```ts
// @/backend  (src/backend/index.ts) — a zustand store over a BackendClient, and hooks
createBackendStore(client: BackendClient): BackendStore        // subscribes, loads the app snapshot, opens a conversation on demand
BackendProvider(props: { store: BackendStore; children: ReactNode })
useBackend(): BackendClient
useBackendStatus(): 'connecting' | 'standby' | 'ready' | 'failed'
useSend(): <C extends Command>(command: C) => Promise<CommandResult<C['type']>>
useApp(): AppSnapshot | null                                   // conversations, settings, key status
useActiveConversationId(): ConversationId | null
useOpenConversation(): (id: ConversationId | null) => void
// one record by ID: a streaming section re-renders alone
useTranscriptOrder(): readonly TranscriptItemRef[]
useMessage(id: MessageId): MessageView | undefined
useResponse(id: ResponseId): ResponseView | undefined
useSection(id: SectionId): SectionView | undefined
useAttempt(id: AttemptId): AttemptView | undefined
useChain(id: ChainId): ChainAssociation | undefined
useSplit(originalMessageId: MessageId): SplitView | undefined
useOperation(id: OperationId): OperationView | undefined
// whole projections, for views that need all of one (Focus, mini-map, graph); EMPTY_* when no conversation is open
useTranscript(): TranscriptProjection
useQueue(): QueueProjection
useGenealogy(): GenealogyProjection
useOperationGraph(): OperationGraphProjection
useRunInspection(directiveId: DirectiveId | null, attemptId: AttemptId | null): RunInspection | null

// @/app/ui-state  (src/app/ui-state.ts) — client-only state shared between features: useUiState(selector)
replyTargets: SectionId[]                    // set by "Reply to this", cleared on send
focus: { pinned: ChainId | null; preview: ChainId | null }
inspected: { directiveId: DirectiveId; attemptId: AttemptId | null } | null
compare: MessageId | null                    // original message whose decomposition is open
selectedOperation: OperationId | null
reveal: { sectionId: SectionId; nonce: number } | null     // ask the transcript to scroll a section into view (Q81)
keyPromptOpen: boolean
// actions
toggleReplyTarget(id), clearReplyTargets(), previewFocus(chainId | null), pinFocus(chainId | null),
inspect(target | null), openCompare(messageId | null), selectOperation(id | null), revealSection(sectionId),
openKeyPrompt(), closeKeyPrompt()

// @/design/chains
chainColor(colorIndex: number): string       // `var(--chain-${colorIndex % 8})`

// @/fixtures  (types.ts, builder.ts, fixture-backend.ts, index.ts) — section 4
Fixture, FixtureStep, FixtureResponse, fx, createFixtureBackend, FixtureBackend, fixtures, getFixture

// @/test/render  (src/test/render.tsx)
renderWithBackend(ui: ReactElement, options?: { fixture?: Fixture; client?: BackendClient }):
  RenderResult & { backend: FixtureBackend | null; store: BackendStore }
      // mounts ui inside BackendProvider with a fresh ui-state; default fixture is `empty`
```

- `useRunInspection` takes a `run` snapshot when its arguments change and again after every frame of that conversation that patches the queue, the operation graph, or that directive's section or attempts, with at most one request in flight. A streaming text append (`transcript.attempt-text`) is none of those, so it does not refetch per chunk, and item 4 (what the run still waits for) cannot go stale.
- The store keeps records by identity as `applyPatches` returns them.

Entry components, no props; each reads the store. Each feature's `index.ts` exports exactly these names, which is how `src/app/features.ts` finds them:

| Import | Export | Owner |
|---|---|---|
| `@/features/transcript` | `TranscriptPane` | ui-transcript |
| `@/features/composer` | `ComposerDock` (elicitation modal, queue items, reply-target chip, input) | ui-transcript |
| `@/features/association` | `ChainRail`, `FocusBar` (Focus state itself is `focus` in `@/app/ui-state`, so the mini-map can drive it too) | ui-transcript |
| `@/features/debug` | `DebugSidePanel` (mini-map, run inspector, Compare tabs), `OperationGraphDrawer` | ui-debug |

## 4. Building the UI before the backend exists

Web code depends on `BackendClient` only. Until integration wires the Worker, the app runs on `FixtureBackend`, an in-memory `BackendClient` that replays projection snapshots. It stays afterwards for tests and for `?fixture=<id>`.

```ts
// packages/web/src/fixtures/types.ts
interface Fixture {
  id: string                         // kebab-case, unique, equal to the case file's name; used in ?fixture=<id>
  title: string
  covers: string[]                   // states and acceptance IDs it shows: ['P1', 'P2', 'overtaking']
  app?: Partial<AppSnapshot>         // default: the fixture's conversations, DEFAULT_SETTINGS, key configured
  initial: ConversationSnapshot      // the open conversation
  others?: ConversationSnapshot[]    // further conversations in the list
  steps?: FixtureStep[]              // scripted playback, in order
  runs?: { [directiveId: string]: { latest: RunInspection; byAttempt?: { [attemptId: string]: RunInspection } } }
                                     // answers to `run` queries: byAttempt[attemptId] when asked for one, else latest
  respond?(command: Command, current: ConversationSnapshot): FixtureResponse | null   // optional interactivity
}
interface FixtureStep {
  label: string                      // shown in the fixture gallery's stepper
  delayMs: number                    // after the previous step
  next: ConversationSnapshot | ((previous: ConversationSnapshot) => ConversationSnapshot)
}
interface FixtureResponse {
  result?: CommandResult             // default: ok with an empty output. Give an error to show a rejected command
  steps?: FixtureStep[]              // played after the command
  app?: AppSnapshot                  // replaces the app state and emits an AppFrame
}

// packages/web/src/fixtures/fixture-backend.ts
createFixtureBackend(fixture: Fixture, options?: { timers?: boolean }): FixtureBackend
interface FixtureBackend extends BackendClient {
  readonly sent: readonly Command[]  // every command received, with any OpenRouter key replaced by '[redacted]'
  readonly current: ConversationSnapshot
  step(): boolean                    // play the next step now; false when none is left
  playAll(): void
}
```

- `FixtureBackend` turns each step into one `ConversationFrame` with `diffSnapshots(previous, next)`, no events, and an increasing `throughSeq`. Tests drive it with `step()` and `playAll()`; timers run only when `timers` is true (the browser).
- It keeps its own `AppSnapshot` and answers the app commands itself, each with an `AppFrame`: `change-settings` (merged with `applySettingsPatch`; a key sets `key.configured` and is dropped), `create-conversation` (returns the new summary), `list-conversations`, `delete-conversation`. `respond` is asked first and may override.
- `builder.ts` gives readable construction. Names are local handles, every reference is by name, and `build()` throws on a dangling one. The builder fills what can be derived (a message's `responseIds`, a response's `sectionIds`, a section's `attemptIds` and `messageId`, operation `depth`, default actions for a state) so a case states only what it shows. ui-foundation may add options; these names are fixed:

```ts
fx.id(kind, name)                    // asId(kind, `${ID_PREFIX[kind]}_${name}`): fx.id('section', 'A') is sec_A
fx.conversation(name?)               // a ConversationBuilder
  .chain(name, { kind?, base?, label? })                  // colorIndex is the order of declaration
  .message(name, text, { chains?, replyingTo?, routing?, split?, actions?, decomposition? })
  .response(name, { message, reason?, grouped?, placed?, routing?, header? })
  .section(name, { response, chain, state, directive?, title?, directiveState?, status?, notes?, superseded?, replaces?, kind?, asks?, placed?, actions? })
  .attempt(name, { section, state, text?, number?, origin?, markText?, collapsed?, failure? })
  .queueItem(name, { directive, message, state, text, waitingFor?, revised?, heldByBarrier?, recovery? })
  .elicitation(view)
  .node(name, { chain, directive, parents?, state?, reason?, group?, replaces? })
  .group(name, { start, base, members, state?, withdrawn? })
  .joinBack(name, { group, members, lateRetries? })
  .operation(name, { label, chain, status, kind?, statusText?, dependsOn?, waitingFor?, heldByBarrier?, barrierWaitingFor?, section?, group?, retired? })
  .focus(chain, { inherited })       // own is derived from what the chain handled
  .order(...names)                   // only when the default (fixed items as declared, then pending responses) is not wanted
  .build(): ConversationSnapshot
fx.from(snapshot)                    // a builder continuing from a snapshot, for steps
```

- Fixtures are written with the builder, never as raw object literals.
- `?fixture=<id>` runs one fixture; `?fixtures` shows the gallery with a stepper. Without either, `connect.ts` uses the Worker backend.

Fixtures to exist, one file each under `src/fixtures/cases/`, owned by the author named:

| ID | Shows | Author |
|---|---|---|
| `empty`, `no-key` | New conversation; first run with no key | ui-foundation |
| `routing` | The provisional responding bubble: "Routing…", then a routing failure with Retry on the request. No status on the user message | ui-foundation |
| `pending`, `streaming` | Responding bubble with status; streaming text | ui-foundation |
| `overtaking` | P1 then P2 as steps: B placed above A's pending bubble; A placed first stays first | ui-foundation |
| `reply-group-mixed` | Group with done, failed, stopped, pending sections and the header count | ui-foundation |
| `trip` | The running example of 04: brief, forks A and B, join-back, J, branch B2, a join chain, an unrelated root; all four projections filled; a second conversation in `others` | ui-foundation |
| `failed-retry` | Failed before output; failed after partial text with a retry streaming beneath (P12, P13) | ui-transcript |
| `stopped`, `interrupted`, `cancelled` | Each mark; waiting-for-capacity and waiting-for-slot statuses | ui-transcript |
| `superseded` | Status-only bubble dropped; partial text collapsed "Superseded — revised below"; finished and superseded; superseded-input note with Regenerate; "Replying to the revised version" | ui-transcript |
| `section-notes` | The context-near-limit note; "Redid itinerary by default" at the bottom of redone work | ui-transcript |
| `queue-waiting`, `queue-paused` | Queue item, revised wording; paused item with the recovery choice | ui-transcript |
| `barrier-ordered-group` | A queue item held by the whole-request barrier; a reply group in an explicit output order | ui-transcript |
| `modal-target-ambiguity`, `modal-choice-default` | Both modals above the composer, the second with a countdown and a locked option; `respond` rejects one command to show an error | ui-transcript |
| `split-messages` | Split bubbles with the link; Undo split available, then gone after first text | ui-transcript |
| `clarification` | Question as an additional response, then the clarified answer | ui-transcript |
| `genealogy-marks` | Failed and stopped siblings, a late retry, a superseded node, interrupted and cancelled nodes, a branch, a join chain with three parents, a later source continuation | ui-debug |
| `operation-states` | Every `OperationStatus`, an operation held by the barrier with its barrier edges, retired operations, a pending section inside a placed group | ui-debug |
| `run-inspection` | `runs` for a started attempt, a queued directive, and two attempts of one directive (`byAttempt`), one of them superseded | ui-debug |
| `compare` | An independent composite with a shared requirement and one corrective fragment | ui-debug |

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

| Thing | Where | Owner | Notes |
|---|---|---|---|
| Conversation list | Sidebar | ui-foundation | Create, open, delete. Collapses to a sheet under 900 px |
| Standby notice | Whole window | ui-foundation | `WORDING.openInAnotherTab` while `useBackendStatus()` is `standby`; the app appears when it turns `ready` |
| Transcript | Main column, max width about 760 px | ui-transcript | Renders `transcript.order` exactly. Pending bubbles are the tail |
| Responding bubble during routing | In the transcript, like any pending response | ui-transcript | A response with `routing` set shows `routing.text`; when `routing.state` is `failed`, the failure text. Nothing on the user message (P7) |
| Margin rails | Left edge of every transcript item, always on | ui-transcript | `message.chainIds` as hard segments; `section.chainId` |
| Focus | Rails, and the Focus bar in the header | ui-transcript | Hover or keyboard focus on a rail previews; click or Enter pins; the bar shows the pinned chain with a clear button; Escape clears. Highlight `focus.own` and `focus.inherited`, dim the rest. Inherited items keep their own color |
| Request controls | Under a user message, on hover or focus | ui-transcript | Stop and Retry from `message.actions`. Never a status badge (P7) |
| Section controls | Section footer | ui-transcript | Exactly `section.actions`: Reply to this, Stop, Retry, Regenerate |
| **Inspect run** | Section footer, and beside each listed attempt | ui-transcript | Shown only when `settings.debug.runInspector` is on. Calls `inspect({ directiveId, attemptId })`; the side panel opens on the run inspector tab. This is the run inspector's entry point (09 §5 leaves it to the build) |
| **Inspect decomposition** | Under a user message whose `decomposition` is not null | ui-transcript | Shown only when `settings.debug.compareIndependent` is on. Calls `openCompare(messageId)` |
| Split link | Between split bubbles | ui-transcript | "split from one message" calls `openCompare(originalMessageId)`, whatever the toggles say; Undo split beside it while `undoAvailable` |
| Queue items | Composer dock, above the input | ui-transcript | Each links to its message. Paused items carry Retry, Continue without, Cancel |
| Modals | Composer dock, above the queue items; not a full-screen dialog | ui-transcript | Target ambiguity and choice with default, oldest first, one at a time. The composer stays usable: sending while a choice with default is open carries out its default |
| Clarification | In the transcript | ui-transcript | Answered with the section's Reply to this, or just by sending |
| Mini-map, run inspector, Compare | Right side panel, one tab each | ui-debug | A tab exists when its debug toggle is on; the Compare tab also exists whenever `compare` is set. The panel reads `inspected` and `compare`; selecting a mini-map node also calls `inspect`. The run inspector's own list of attempts (`RunInspection.attempts`) moves between versions |
| Operation graph | Bottom drawer of the main column | ui-debug | Behind its toggle. Selecting an operation offers "Show in transcript" (`revealSection`) and, when the run inspector is on, "Inspect run". A barrier hold is drawn as a different kind of edge from a result dependency |
| Settings | Dialog from the sidebar | ui-foundation | Retry policy, default wait, concurrency, models per role, thresholds, key, debug toggles |

**Key prompt.**

1. On load, `app.key.configured === false` opens the key prompt (`keyPromptOpen`): a dialog with a password-type field, "Save key", and "Not now".
2. When `__DEV_OPENROUTER_KEY__` is non-empty (dev server only), the prompt also offers "Use the key from this environment". Only `src/app/key-prompt.tsx` reads that constant.
3. Either path sends `change-settings` with `openRouterKey: { action: 'set', key }` and then drops the value from component state. It is never put in the store, `localStorage`, or a URL.
4. Without a key the app is readable and the composer (ui-transcript) shows "Add an OpenRouter key to send messages" with a button that calls `openKeyPrompt()`.
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

That is 20 + 6 + 4 + 1 + 2 + 1 + 2 + 8 + 2 + 9 + 4 + 2 = 61. T2 and T3 sit with core-recovery because they need a superseded section to exist; core-routing unit-tests the corrective-wording classification without the ID in the title. P8 and C14 need a reply group, which core-engine builds from a scripted `independent-composite` plan.

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

**Named tests for the cases the reviews found.** Beyond the canonical ones, each of these exists under this title, in its owner's test directory:

| Title | Agent |
|---|---|
| `first fork · B sent while only A runs is a fork beside A, not a child of running A` | core-engine |
| `placement · the first reply to a finished sibling opens a branch chain in its own color` | core-engine |
| `placement · a second reply to a sibling while the first is running opens a sibling group at that sibling` | core-engine |
| `placement · continue on an in-flight node without its prerequisite is repaired to its starting context` | core-engine |
| `D2 (engine) · …`, `D3 (engine) · …` with scripted plans | core-engine |
| `supersession · status-only bubble dropped, partial text collapsed, finished work marked`, folded from a hand-written log | core-engine |
| `stop · work between automatic retries becomes stopped and its retry never fires`, with a scripted `retryPlanner` | core-engine |
| `stop · a single section that has not started is cancelled` | core-engine |
| `routing · pending status is on the provisional response from submission, never on the message` | core-engine |
| `start · a message whose routing was lost is routed again` | core-engine |
| `stream · attempt-started is framed without the model input and stored with it` | core-engine |
| `clarification · one ambiguous shared requirement is asked once and blocks both fragments` | core-routing |
| `clarification · the clarified run's input ends with the question and the answer` | core-routing |
| `undo split · forks withdrawn from an open group leave it consistent; a group left empty is dissolved` | core-routing |
| `join chain · a parent on an open sibling group resolves to its join-back at start` | core-routing |
| `composite · one corrective fragment and one new fragment are planned and recorded` | core-routing |
| `late retry · continue without B, retry B, regenerate J: J′ is a child of the join-back, reads B′, and never descends from J` | core-recovery |
| `late retry · a retry requested while a continue-without dependent runs does not fork it` | core-recovery |
| `E3 (correction) · a consumer of a revised brief that was not redone gets the note although the brief was not replaced` | core-recovery |
| `choice with default · work stopped for the wait carries "Redid … by default" only after the default ran` | core-recovery |
| `revision · a failed target is replaced with rewound context` | core-recovery |
| `revision · a running dependent restarts in a new response once the replacement prerequisite is ready` | core-recovery |
| `session requirement · a replaced requirement is no longer sent` | core-recovery |
| `Focus · inherited items are highlighted in their own color; later source items are not`, `rail · a join-back continues in the base chain's color` from the `trip` fixture | ui-transcript |
| `inspect · the run inspector affordance appears only with its toggle and sets inspected` | ui-transcript |
| `operation graph · retired operations stay inspectable; a barrier hold is drawn apart from a dependency` | ui-debug |
| `second tab · stands by, records nothing, and takes over when the first closes` (Chromium) | integration |

Supplementary, without being the canonical test: ui-transcript renders P1–P4, P6, P8 and P10–P13 from fixtures (`'<ID> (web) · …'`); integration runs an end-to-end pass in Chromium over the Worker with the scripted fakes, and the live smoke suite.

## 7. Decisions for "Left to the build"

| Choice | Decision | Why |
|---|---|---|
| Candidates supplied to the decision model | Every current (not superseded, not dropped) section, every chain with its settled head and its tip, every directive not superseded or cancelled, every sibling group that is not dissolved (`RoutingCandidates`). The router may trim to the most recent 24 sections when the state would exceed the decision model's per-question limit | Bounded by construction, and small conversations need no heuristics |
| Trivial messages skipping the decision call | No skipping. The first message of an empty conversation asks only atomic-or-composite, since there is nothing to relate it to | Latency is unmeasured; skipping is a silent guess |
| Concurrency limit scope | It counts answer runs (clarification questions included) and synthesis runs only. Decision, decomposition and label calls, and join-backs, take no slot. "Per provider" is one pool, keyed `openrouter` | Routing gates everything, so queueing it behind answers would stall the chat; every call goes through one provider today |
| Backoff | `RETRY_POLICIES` in `protocol/src/settings.ts`: Standard 3 retries at 1 s, 2 s, 4 s, accepting `Retry-After` up to 60 s; Persistent 8 retries up to 30 s apart, accepting `Retry-After` up to 10 min. No jitter. 429 waits and interruption recoveries count against the same limit | Deterministic under the fake clock; Persistent differs only in patience |
| Pinned decision model and thresholds | `typesafe/jev-1.13`; initial thresholds in `DEFAULT_SETTINGS.thresholds`, to be replaced after the routing corpus exists | Verified live; `jev-latest` does not exist on OpenRouter |
| Context warning | At 80 % of the model's limit (`CONTEXT_WARNING_RATIO`), as a note on the section | Leaves room for one more exchange |
| Chunk size for stored output | First text of an attempt at once; then 96 characters or 80 ms, whichever comes first; always before the terminal event (`CoreOptions.outputChunk`) | First text fixes placement; the rest keeps the log small without visible stutter. The same chunks are the stream, so the log and the screen agree |
| Embedded secrets store | A separate IndexedDB database, `committee-secrets`, opened only in the Worker | Apart from the event log (Q64); the Worker cannot use `localStorage` |
| Wording for the concurrency hold | "Waiting for a free slot" (`WORDING.waitingForSlot`), state `ready` | Distinct from "Waiting for capacity" and from a dependency wait |
| Stage that assigns each fragment its chain and target | After decomposition: one further batched decision call with a question set per fragment over the same candidates. The gate's message-level answers are kept in the decision record | Fragments do not exist before decomposition, and the decision model must still be the one that selects |
| Detecting a superseded input | The three-kind rule in section 2: a replaced result, an unread correction to a consumed brief, a replaced session-wide requirement. Each is a comparison of the attempt's recorded context with current state. No estimate of whether the result would change | Exact, cheap, and never wrong in the quiet direction |

Also decided here: IDs are `<prefix>_<ULID>`; events of all conversations plus one app log (`APP_LOG`) for the conversation list and settings, where `settings-changed` stores the whole settings; `Backend.start()` loads every conversation so interrupted work resumes without the user opening it; the Worker's real ports are in `packages/web/src/worker/system.ts`, written by integration: a `Clock` over `Date.now`, `Timers` over `setTimeout`, and `createIdFactory(createUlidFactory(Date.now, Math.random))`.

### Decisions made by core-routing

Recorded by core-routing when milestone 4 landed. The code is `packages/core/src/routing/`.

**Which candidates the decision model is asked about** (`routing/supply.ts`). Everything comes from `RoutingInput.candidates`, so nothing outside it can be selected (invariant 9):

| Question | Candidates |
|---|---|
| Reply targets | The most recent 24 current sections (`MAX_SECTIONS`), explicit targets always included; open clarification questions are sections like any other and are asked "does it answer this question?" |
| Result dependencies | Work still in flight (at most 16, `MAX_DEPENDENCIES`) and open sibling groups. Finished work is never a dependency candidate: only an unavailable result can be waited for (Q2) |
| Handling chain | Every chain (at most 24), offered as a `choice`; used only when no target and no dependency places the unit |
| Corrections of conversation-wide requirements | The session-wide requirements in force |
| Affected work of a shared-requirement revision | Every directive whose latest attempt consumed the corrected brief (`CandidateWork.consumed`), in one further call |

**The question set** is the same for the whole message and for each fragment (`routing/questions.ts`): corrective wording, shared scope, relation (`new` / `addition` / `dependent`), one yes/no per target candidate and whether it refers to several sections at once, the handling chain, one yes/no per dependency candidate, one per session-wide requirement, needs-clarification and its reason; a fragment also gets one yes/no per earlier fragment the decomposer proposed as a dependency. The gate adds `composite` and `sessionwide`. Every question is `noul` or `choice` over supplied numbers or fixed enums; the decision model never writes text. The first message of an empty conversation asks only `composite`, `sessionwide` and the clarification questions: there is nothing to relate it to.

**Thresholds** (Q74), by question: `composite` for the gate; `clearlyCorrective` for corrective wording, shared scope, explicit conversation-wide wording and a change to a session-wide requirement; `targetChoice` for inferring a target, with the ambiguity rule below; `dependency` for result dependencies, dependencies between fragments, the whole-request barrier and the pre-selection of affected work; `clarification` for clarifications. The thresholds in force, and `ambiguityFloor`, are recorded on every `RoutingDecision`.

**Target ambiguity.** A section at or above `targetChoice` is inferred; several may be. When the model says the message refers to several sections and one is clear, every section at or above 0.25 (`AMBIGUITY_FLOOR`) is a target too: the second of two referents is consistently scored lower. When none reaches `targetChoice`, two or more sections at or above the floor make the target ambiguous and the user is asked; one weak candidate alone is not a choice between sections, so the unit is placed by its handling chain. A message whose relation is `new` and is not corrective is never ambiguous.

**Which stage assigns each fragment its chain and target.** For an atomic message, the gate. For a composite, the second batched call after decomposition, with a question set per fragment over the same candidates; the gate's message-level answers stay in the decision record's `questions`. Explicit and chosen targets go to the fragments that refer to them (score at or above the floor).

**Placement follows from the selections** (`derivePlacement`): the points a unit builds on are its target sections' nodes, the nodes of the work it needs, the groups it needs, and earlier units it needs. None and relation `new`: a new chain. None otherwise: the chosen chain's settled head (its tip when nothing has settled; the engine's repair 0 applies). Two or more members of one sibling group become the group, and an open group is also a prerequisite. A point already in another point's ancestry is dropped. One point: `continue`; several: a join chain. The relation recorded is `result-dependent` when a prerequisite remains, otherwise `addition` (or `new`), with the model's probability for it.

**Decomposition** is called when the gate judges the message composite, and also when the gate confirms explicit conversation-wide wording or a change to a session-wide requirement: only the decomposer may write a requirement's text (invariant 9). With fewer than two fragments the message stays atomic. A requirement is session-wide only when the gate confirmed explicit wording; the decomposer saying so is not enough (D1). Spans out of bounds, repeated keys, and references to unknown fragments or candidates are `malformed-response`, never repaired.

**Revisions.** A unit is a revision when corrective wording is at or above `clearlyCorrective` and it names something to correct: a target's work or a session-wide requirement. Any change to a session-wide requirement makes it `shared-requirement`; so does shared scope, but only when other work consumed a target: a correction of work nothing else read is local to it. In a shared-requirement revision the targets are the work that established the brief; a target that itself consumed another target is affected work instead. Corrective wording with two or more plausible targets and none clear is a target ambiguity; with no plausible target and no requirement to change, it is additional work.

**Clarification.** `about` is fixed wording per reason (the decision model writes nothing); the question's instruction is composed by core (`clarificationInstruction`) from the blocked requests and `about`. The question section's title is "Question" and its label "question about {labels}". A shared requirement that the gate judges ambiguous is one clarification for every unit that carries it; otherwise each unit is asked separately. A message is the answer when it targets an open question explicitly, or when the gate infers the question as its target (Q98); the answer releases each held directive into a new `clarified-answer` response per user bubble.

**Undo split** also withdraws the split's clarification questions (their sections superseded, their elicitations withdrawn).

**A message routed again keeps its options.** Retry after a routing failure, and a routing lost with the executor, route with the chosen targets of its latest answered target-ambiguity elicitation and with `forcedComposition: 'atomic'` after Undo split (`queries.routeOptionsFor`).

**The routing corpus** is `packages/core/src/routing/corpus/`: 44 labelled examples over hand-written scenes, each with the spec reference that justifies its label. `evaluateCorpus({ decisionProvider, decomposer?, settings? })` routes every example and reports mismatches by topic; without a decomposer it uses each example's reference decomposition, so the decision model is evaluated alone. A core test runs it with a provider that answers as the labels say (`oracleDecisionProvider`), which checks the deterministic stages. The live run belongs in a providers smoke test. A first live run against `typesafe/jev-1.13` on 2026-11-11, with `DEFAULT_SETTINGS.thresholds`, matched 42 of 44 labels; the floor, the several-sections question and the shared-brief rule above came from the misses of the run before it (34 of 44). The thresholds themselves were not changed: they are the architect's defaults.

### Decisions made by core-engine and core-recovery

Recorded by integration from the slices' reports, so that the plan matches the code.

- **Command handlers are asked from the last module to the first.** A slice overrides the engine's default and returns `null` to fall back to it. Reactions, plan appliers and startup reactions run in module order (engine, routing, recovery).
- **The engine's default `retry`** retries failed, stopped, interrupted or cancelled sections and requests, in place or as the late-retry node after closure; recovery overrides it and returns `null` for a request whose routing failed.
- **A join-chain node is not a "child in flight" of its sources** (`childrenInFlight` counts single-parent continuations only), so a source chain stays independently continuable while a join chain over it runs (04, C18).
- **Corrections in an ancestor read:** corrections recorded before the ancestor's current result started are read before its answer, later ones after it.
- **Queue items** appear only while a directive is dependency-queued or paused, never while it is `ready` and waiting for a slot (P6).
- **Work released but not yet started still counts as queued** and waits again when a prerequisite's result is replaced (R3); the engine also refuses to start queued work whose prerequisites stopped being satisfied after its release.
- **Queued work gains a `directive` prerequisite** on any input it would read whose replacement is still running (`waitForInFlightReads`, R5).
- **A member's replacement node becomes the member's node**, and join-backs formed or re-formed afterwards are its children; a late retry's node never does.
- **A second revision of a running replacement** rewinds to the last finished answer that a revision replaced and reads it between the corrections made before and after it.
- **Only work that was in flight carries "Redid … by default".** Finished work redone by default is only the new `redo` response.

### Decisions made by integration

- **One Worker per page.** `src/worker/client.ts` returns one `PortClient` for every call, so React's StrictMode double mount never starts a second Worker that would stand by behind the first. The Worker takes the `committee-backend` lock with `ifAvailable` first; when that fails it posts `standby` and waits for the lock.
- **The model catalog is read when the Worker starts.** Every run's tokens are counted before it starts, and the first count reads OpenRouter's catalog; reading it at start keeps the first run after a load from showing "Waiting for a free slot" while a slot is free.
- **End-to-end flows** are `packages/web/e2e/run.mjs` (`pnpm e2e`), live against OpenRouter with the cheap model for every generative role; they are not part of `pnpm test`. The live routing corpus runs in `pnpm smoke` (`packages/providers/src/routing-corpus.smoke.test.ts`).

## 8. Order of work and reviews

1. **ui-foundation's contract commit** (section 3, "The foundation contract comes first"). Nothing else in `packages/web` starts before it is in the tree.
2. In parallel: core-engine, providers, storage, the rest of ui-foundation, ui-transcript, ui-debug.
3. core-routing after core-engine; core-recovery after core-routing.
4. integration: the Worker entry (take the `committee-backend` lock, post `standby` while waiting, then `servePort(createBackend(…), self)`), `src/worker/client.ts` and `src/worker/system.ts`, the provider fake re-export, `core-fakes.test.ts` in storage, end-to-end and smoke runs, `docs/build/STATUS.md` with what passes.
5. Reviews, one after another, each starting from the previous one's fixes. The specification has many interacting edge cases, so one pass is not enough. Each review reads the spec chapter's "Edge cases" table row by row, not only the acceptance conditions. Reviewers are read-only: a review reports its findings in its result, and the agent that then applies the fixes appends each finding and what was done about it to `docs/build/STATUS.md` (integration creates the file; later fixers append under a heading for their pass).

| Pass | Checks | Against |
|---|---|---|
| 1 Contracts | Every package builds on `protocol` and the ports as written: no duplicate types, no client-side decision about placement, ordering, dependencies or context, nothing reads one of the three relationships as another | Sections 1–3 here; invariants 1, 9 |
| 2 Chains and placement | Forks, group closing, join-back order, branches, join chains, snapshot at start, first-output placement, overtaking, reply groups | 01, 03, 04 including every edge-case row; C1–C20, P1–P9 |
| 3 Revisions, elicitation, recovery | The five revision target states, dependents of a revised target, shared-requirement choice with default, retries in the same bubble, pause and the three recovery choices, retry after closure and the late-retry tail, interruption under each policy | 05–08 including every edge-case row; T, R, E, F, P10–P13 |
| 4 Interface | Every element, control and fixed wording of 10 Part 1 exists and matches; rails and Focus always on; debug views behind their toggles and reachable; both themes; reduced motion; key never visible | 09, 10; every fixture in light and dark |
| 5 End to end | A real conversation over the Worker with live models: parallel answers, a dependent follow-up, a composite, a revision, a stop and retry, reload mid-answer, a second tab | README executive summary; the smoke suite |

## 9. Reviewed and declined

Every finding of the two contract reviews was confirmed against the specification and fixed. Four of the *suggested fixes* were not taken as written; the finding behind each is still resolved, another way.

- **Dissolve a sibling group left with fewer than two members after Undo split.** Declined for a group that keeps one member; only a group left with none is dissolved. The remaining member is already a fork with its own chain, and 01 says "Each chain has one stable color", so moving it back would change a color a second time. Its result also has to return to the base chain, and 04 gives the way: "the join-back in effect appends the siblings' exchanges to their common history and the follow-up continues from there". A one-member join-back does exactly that.
- **Make late retries a linear tail and resolve a sibling-group point to the end of it.** Declined in that form. A second late retry requested while the first is still running would have to be a child of running work, which the fix for the first-fork finding forbids, so the tail cannot be kept linear. Instead every late retry is a child of the join-back and the tail is read with the record. This is 08's own wording: "it runs as a descendant of the join-back, so the join-back keeps B's marker and B′'s exchange follows it", and 04: "When work is retried, the context of everything that depends on it reflects the retry".
- **Route a lost message again "per the policy".** Declined in favour of the reviewer's other option, every policy. 08's Manual policy is "No automatic retries. Every failure goes straight to the Retry action": it governs failures of attempts. A message whose routing was lost has no attempt and no recorded failure, and 03 says "A submitted message appears in the transcript immediately" with the expectation that it is acted on.
- **Add a withdrawn value to `JoinBackMember.outcome`.** Not needed: a withdrawn member is absent from the record, so later context never reads an undone fragment's request. 02 says Undo split "restarts the work as one atomic request"; the fragments it replaces are history, not context.

## 10. What changed in revision 2

For agents who read revision 1. Each line is a review finding and where its fix lives.

| Finding | Fix |
|---|---|
| Work stopped for a choice with default could not carry "by default" | `SupersessionCause.redo` has no `byDefault`; `SectionOpened` has no `note`; the note is derived from `elicitation-defaulted` (section 2, Revisions) |
| First fork: building on a node still in flight | `CandidateChain.headNodeId` is the settled head, `tipNodeId` the last node; repair 0 of the placement table |
| Late retry placed under later base-chain work | The late-retry tail (section 2); `JoinBackNodeView.lateRetryNodeIds` |
| Stop between retries had no event | `directive-stopped`; `DirectiveCancelled.cause` gains `section-stopped`; the Stopping table |
| A shared-requirement revision was invisible to the note | `ConsumedContext.corrections` and `sessionRequirementIds`; `SupersededInput` by kind; the detection table |
| Undo split of forks | `siblings-withdrawn`; `SiblingGroupView.withdrawnNodeIds` and state `dissolved` |
| Revision targets that ended unfinished or have no section | `RevisionTargetState` gains `ended-unfinished`; `targets[].sectionId` is nullable |
| No origin for a clarification exchange | `ContextOrigin` gains `clarification-question` and `clarification-answer`; the question runs on the blocked directive's node |
| One question for several fragments | `RoutingPlan.clarifications`; `PlannedUnit.clarification` is gone |
| A composite with a corrective part | `RoutingPlan.revisions` is a list with `fragment`; `FragmentRecord.kind`; `RevisionRecorded.fragmentId` |
| Restart of a dependent had no row or reason | The table in section 2; `prerequisite-revised` in `NodeReason` and `ResponseReason` |
| Pending status during routing sat on the message | `MessageSubmitted.responseId`; `ResponseView.routing`; `MessageView.routingFailure` is gone |
| Routing lost with the executor | `Backend.start()` routes it again |
| Barrier hold invisible to inspection | `OperationView.heldByBarrier` and `barrierWaitingFor`; `RunInspection.barrier` |
| P8 and C14 needed a reply group in milestone 1; barrier, split messages and session requirements had no builder | core-engine applies everything a plan states ("Who builds each behaviour") |
| Undo split could not ask for atomic routing | `RoutingInput.forcedComposition`; `SplitUndone` no longer names a restored directive |
| Session-wide requirements could not change | `replacesRequirementId`; `session-requirement-withdrawn`; `PlannedRevision.targetRequirementIds` |
| Placement rows overlapped; a join chain could not sit over an open group | The ordered table; a `sibling-group` point as a join-chain parent |
| The module registry lacked seams | `outcomeHandlers`, `retryPlanner`, `startupReactions`, `createRouter`, handlers that pass with `null`, `ctx.route` |
| Undo split needed `section-superseded` before its owner existed | core-engine owns every reducer and that primitive |
| A second tab | The single-executor lock, the `standby` wire message, `useBackendStatus` |
| Web ownership overlapped; shared files had no owner | The disjoint path table, the glob registry, ui-foundation owns components and config |
| Feature agents built against an unwritten store | The foundation contract and its exact names; step 1 of section 8 |
| No way to select a run or an independent composite | "Inspect run" and "Inspect decomposition", owned by ui-transcript |
| Fixture `runs` keyed by directive only; rejected commands and app changes | `runs` by directive then attempt; `FixtureResponse`; `others`; the new cases |
| storage and providers loaded the engine | `@committee/core/ports` |
| providers had no Node types | `"types": ["node"]` in its tsconfig (providers' own change) |
| Frames carried the whole model input | `StreamedConversationEvent`, `toStreamedEvent` |
| The run inspector's wait list went stale | The refetch rule under the foundation contract |
| `chainIds` undefined for a message with no directive | Documented on `MessageView.chainIds` |
| Labels, the system clock, the no-key composer action had no owner | core-engine and providers; integration; `openKeyPrompt()` |
| Small inconsistencies | `settings-changed` stores whole settings; Focus tests moved to ui-transcript; P7 is canonical only; the storage suites also run on core's fakes; reviewers report, fixers write STATUS.md |

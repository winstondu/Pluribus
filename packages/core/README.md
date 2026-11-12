# @pluribus/core

The deterministic core: event log, reducers, projections, context assembly, placement, scheduling and the coordinator. No I/O; every dependency comes in through `src/ports` (`CoreDependencies`). The contracts are `packages/protocol` and `docs/build/PLAN.md`.

| Path | Owner | Contents |
|---|---|---|
| `src/ports/` | architect | The port interfaces (`@pluribus/core/ports`) |
| `src/engine/` | core-engine | State, a reducer for every event, the four projections and the run inspection, context assembly, plan application and placement, the lifecycle reactions, the coordinator (`createBackend`) |
| `src/routing/` | core-routing | The routing pipeline, validation, clarification and target elicitation, Undo split |
| `test/` | By source area | Test suites, including acceptance and projection rebuild tests |
| `testing/` | By source area | Shared scenarios, port fakes, and routing evaluation helpers. Other packages can use the fakes and evaluation helpers from `@pluribus/core/testing`. |

## Using it (the web integration)

Import from the package root. Importing `@pluribus/core` registers the routing and recovery modules, so `createBackend` runs all three slices (engine, routing, recovery, in that order) and uses the routing pipeline as its router when `deps.router` is absent:

```ts
import { createBackend } from '@pluribus/core'
const backend = createBackend({ modelProvider, decisionProvider, decomposer, eventStore, projectionCache, secretsStore, clock, timers, ids })
await backend.start()   // folds every log, records lost attempts as interrupted (retried per policy), routes lost messages again, resumes timers
```

`Backend` (`src/ports/backend.ts`) is the whole surface: `send(command)` for every command of `protocol/commands.ts`, `subscribe(listener, filter?)` for `StreamFrame`s (events in their streamed form plus projection patches), `snapshot({ kind: 'app' | 'conversation' | 'run' | 'events' })`, `dispose()`. Commands and what answers them:

| Command | Handled by | Effect |
|---|---|---|
| `submit-message` | engine | `message-submitted`, then routing. A pending choice with default is carried out first (recovery) |
| `stop` | engine | One section or a whole request: live attempts stopped, started work between attempts stopped, unstarted work cancelled; dependents outside the scope are paused (recovery) |
| `retry` | engine | A routing failure routes again; otherwise unfinished sections retry in their own bubble, or as a late retry after the join-back. A paused dependent of the retried work waits again (recovery) |
| `regenerate` | recovery | Only on work with a superseded-input note; cancels the item's work still in progress, then redoes it in a new response |
| `continue-without`, `cancel` | recovery | The recovery choice on a paused directive (its queue item's `recovery`) |
| `answer-elicitation` | routing (target ambiguity), recovery (choice with default; `confirm: false` edits the selection) | |
| `undo-split` | routing | While `SplitView.undoAvailable` |
| app commands | engine | Conversations, settings, the key (secrets store only) |

The client renders the four projections and `RunInspection` exactly; every control it may offer is in `MessageView.actions`, `SectionView.actions`, `QueueItemView.recovery` and `QueueProjection.elicitations`.

## A step

Input (a command, a provider event, a routing outcome, a timer) → events, each applied by its reducer at once (`ctx.emit`) → reactions, for every event of the step, until quiet → one atomic append → projections → one frame → effects. Effects (model streams, routing, timers, labels, aborts) start only after the append. Steps run one at a time across every conversation.

## Adding behaviour: `CoreModule`

A slice exports a `CoreModule` (`src/engine/module.ts`) and registers it from its own `index.ts`:

```ts
import { registerCoreModule, type CoreModule } from '../engine'
export const recoveryModule: CoreModule = { name: 'recovery', /* … */ }
registerCoreModule(recoveryModule)
```

and appends its line to `src/index.ts` (`export * from './recovery'`). `createBackend(deps, options?, modules?)` defaults `modules` to the engine followed by the registered modules, in registration order.

| Field | Called | Order |
|---|---|---|
| `commands[type]` | For a conversation command. Return events, `{ events, output }`, a `CommandError`, or `null` to pass | **Last module first**, so a slice overrides the engine's default and returns `null` to fall back to it |
| `reactions` | `(state, event, ctx)` for every event of a step until no reaction emits | Module order |
| `planAppliers` | `{ parts, apply(state, plan, { messageId }, ctx) }` after `routing-decided`, all in one step. A plan with a non-empty part no applier names is refused (`routing-failed`) | Module order |
| `outcomeHandlers['target-ambiguity']` | For that routing outcome. Without one it is recorded as `routing-failed` | Last wins |
| `retryPlanner` | `(state, directiveId, { kind: 'failed', error } \| { kind: 'interrupted' }, now, settings) => RetryPlan`. The engine carries a `scheduled` plan out (timer, `directive-ready`, a new attempt in the same section) | Last wins. The engine's default answers `none` |
| `startupReactions` | `(state, ctx)` once per conversation in `start()`, after its log is folded | Module order |
| `timers[kind]` | When a timer set with `ctx.setTimer(kind, key, at, payload)` fires | Last module that has the kind |
| `createRouter` | When `deps.router` is absent | Last wins |

`ctx` (`StepContext`): `state` (including this step's events), `emit`, `ids`, `now`, `settings`, `route(messageId, { chosenTargets?, forcedComposition? })`, `setTimer`/`cancelTimer`, `retryPlan`, `abortAttempt`, `flushOutput` (call it before ending a live attempt yourself), `requestLabel`.

## What the engine already gives a slice

- **Every reducer.** Each event in `events.ts` has one (`REDUCERS`); slices decide when to emit, never what an event means. Fix a reducer only for a defect, and say so.
- **Primitives** (`src/engine/lifecycle.ts`, `plan.ts`): `supersedeSection` (ends a live attempt as superseded, records visible output), `formJoinBack(ctx, groupId, replacing)` (re-formation after a revision), `stopWork`, `retryDirective` (in place, or the late-retry node after closure), `settleWait`/`computeWait` (first state, release, barrier), `placeSection`, `placeUnit`, `checkPlan`.
- **Queries** (`queries`): in-flight tests, chain head and tip, children in flight, point resolution, prerequisite satisfaction, labels.
- **Context assembly** over the whole `ContextOrigin` union (`assembleContext`), including corrections, replacements of finished work, join-back records with the late-retry tail, clarification question and answer.
- **Projections** are pure functions of `ConversationState`, memoized on what they read (`projections/tracking.ts`). Read the state only through the `state` argument you are given, so the dependency tracker sees it. `rebuildSnapshot` computes from scratch; the tests compare the two.
- **Already reactive**: release on success only, the whole-request barrier, the closing rule, placement at first visible output, scheduled-retry timers, interruption and lost routing on start.

## Tests

`createTestBackend()` gives a started backend over every fake (`FakeClock`, `ScriptedModelProvider`, `ScriptedRouter`, the scripted decision provider and decomposer, the memory stores) with a seeded ID factory. `advance(ms)` fires timers one at a time and settles between them; `restart()` is a simulated interruption. Plan builders: `atomic`, `independent`, `sequential`, `noUnits`, `spanOf`. Model scripts: `answer`, `say`, `fail`, `done`; a script without a terminal step hangs until cancelled.

## The routing slice (`src/routing/`)

`routingModule` (registered by `src/routing/index.ts`) supplies the default router (`createRouter`, used when `deps.router` is absent): the decision gate over `DecisionProvider`, generative decomposition over `Decomposer`, deterministic validation (`validatePlan`). It carries out the `clarifications` and `answersElicitationId` parts of a plan, raises the target-ambiguity elicitation and handles its `answer-elicitation`, and handles `undo-split`. Its decisions are in `docs/build/PLAN.md` §7, "Decisions made by core-routing".

The routing corpus lives in `testing/routing/corpus/`. Its labelled examples use hand-written scenes (`scene()`). `evaluateCorpus({ decisionProvider, decomposer?, settings? })` runs those examples and `formatCorpusReport` formats the results. A provider smoke suite runs the corpus with the live OpenRouter decision provider.

Routing suites live in `test/routing/`, including the acceptance suites (D1–D4, T1, E1, E2, P9, I9, the named routing cases of PLAN §6, T2 and T3 on the routing side), the referent suites in `test/routing/referents/`, and `test/routing/validation.test.ts`. The corpus suite in `test/routing/corpus/corpus.test.ts` uses a provider that answers as labelled. `routingScenario()` in `testing/acceptance/routing.ts` runs the real router over scripted decisions stated by name.

Engine acceptance tests live in `test/engine/acceptance/` (C1–C20, P1–P4, P6, P8, I1, I2, I4, I6, I10, the named cases of PLAN §6, and reducers folded from hand-written logs). The rebuild property tests live in `test/engine/projections/rebuild.test.ts`.

The review findings on the routing slice are pinned in `test/routing/acceptance/review.test.ts`.

/**
 * The engine: what events mean, everything a routing plan can state, and
 * the coordinator. See packages/core/README.md for the extension points.
 */
export { createBackend, createEngine, type Engine, type EngineInternals } from './backend'
export { engineModule, registerCoreModule, defaultModules } from './engine-module'
export type {
  CommandHandler,
  CommandHandlerResult,
  CommandHandlers,
  ConversationCommandType,
  CoreModule,
  OutcomeHandler,
  PlanApplier,
  PlanPart,
  PlanTarget,
  Reaction,
  RetryCause,
  RetryPlanner,
  RouteOptions,
  RoutingRetryPlanner,
  StartupReaction,
  StepContext,
  TimerHandler,
} from './module'
export { isCommandError } from './module'
export { emptyConversationState, STATE_VERSION, STATE_TABLES } from './state'
export type * from './state'
export { reduce, fold, REDUCERS, type Reducer } from './reducers'
export * as queries from './queries'
export {
  assembleContext,
  contextChainOf,
  ancestryOf,
  sessionRequirementsInForce,
  requestText,
  markerText,
  correctionText,
  PREAMBLE,
  type AssembledContext,
} from './context'
export { fullChainContextProvider, noContextSummariser } from './summaries'
export { checkPlan, placeUnit, nearestSettledAncestor, unitsApplier, type PlanCheck } from './plan'
export {
  computeWait,
  settleWait,
  notStartedInSection,
  startedInSection,
  formJoinBack,
  placeSection,
  supersedeSection,
  stopWork,
  retryDirective,
  isRetryable,
  liveAttempt,
  defaultRetryPlanner,
  defaultRoutingRetryPlanner,
  RETRY_TIMER,
  type WaitDecision,
} from './lifecycle'
export { routingCandidates, resolveTargets } from './candidates'
export { Projector, projectSnapshot, rebuildSnapshot, runInspection, undoSplitAvailable } from './projections'

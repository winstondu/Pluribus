/**
 * Core's injected dependencies (Q71) and the seams other packages build
 * against. Interfaces only, apart from the cancel source and one error
 * class.
 *
 * Implementations:
 * - `@pluribus/providers`: ModelProvider, DecisionProvider, Decomposer over OpenRouter
 * - `@pluribus/storage`: EventStore, ProjectionCache, SecretsStore over IndexedDB and in memory
 * - `@pluribus/core/testing`: scripted and in-memory fakes of all of them, and the fake clock
 */
export type { CancelSignal, CancelSource } from './cancel'
export { NEVER_CANCELLED, createCancelSource } from './cancel'
export type { CancelTimer, Clock, Timers } from './clock'
export type {
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
  ModelStreamTerminal,
  TokenCount,
} from './model-provider'
export type {
  ChoiceAnswer,
  ChoiceQuestion,
  DecisionAnswerFor,
  DecisionProvider,
  DecisionQuestion,
  DecisionQuestions,
  DecisionRequest,
  DecisionResult,
  NoulAnswer,
  NoulQuestion,
  ScoreAnswer,
  ScoreQuestion,
} from './decision-provider'
export type {
  DecomposeRequest,
  DecomposeResult,
  DecomposedFragment,
  DecomposedRequirement,
  Decomposer,
  Decomposition,
  DecompositionCandidate,
  LabelRequest,
  LabelResult,
} from './decomposer'
export type { CachedState, EventStore, JsonValue, ProjectionCache, SecretName, SecretsStore } from './stores'
export { EventStoreConflictError } from './stores'
export type {
  CandidateChain,
  CandidateGroup,
  CandidateSection,
  CandidateWork,
  PlannedClarification,
  PlannedRevision,
  PlannedSessionRequirement,
  PlannedUnit,
  Router,
  RoutingCandidates,
  RoutingInput,
  RoutingOutcome,
  RoutingPlan,
} from './router'
export type {
  ReferentGate,
  ReferentQuestions,
  ReferentRequest,
  ReferentResult,
  ReferentSection,
  ReferentStrategy,
  ReferentUnit,
  ScoredSection,
  UnitReferents,
} from './referent-strategy'
export type {
  GroupNode,
  GroupProbe,
  PointProbe,
  Probe,
  ReferentNode,
  ReferentOperations,
  ReferentTree,
  SectionNode,
  SeveralProbe,
} from './referent-operations'
export type { Backend, CoreDependencies, CoreOptions } from './backend'
export { DEFAULT_CORE_OPTIONS } from './backend'

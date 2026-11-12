/**
 * @pluribus/core/testing — port fakes and routing evaluation helpers
 * shared by core tests and other packages.
 *
 * A simulated interruption is: dispose the backend, build a new one over the
 * same `MemoryEventStore`, start it (`TestBackend.restart`).
 */
export { FakeClock } from './fake-clock'
export {
  ScriptedModelProvider,
  answer,
  askUser,
  done,
  fail,
  requestTextOf,
  say,
  type RequestMatch,
  type ScriptStep,
} from './scripted-model-provider'
export { ScriptedDecisionProvider, ScriptedDecomposer } from './scripted-providers'
export { ScriptedPreparer, needsClarification, readyToAnswer } from './scripted-preparer'
export {
  ScriptedRouter,
  atomic,
  independent,
  noUnits,
  sequential,
  spanOf,
  type PlanExtras,
  type UnitSpec,
} from './scripted-router'
export { MemoryEventStore, MemoryProjectionCache, MemorySecretsStore } from './memory-stores'
export { createTestBackend, type TestBackend, type TestBackendOverrides } from './test-backend'
export * from './routing/corpus'
export {
  COST_GRID_MESSAGE,
  COST_GRID_ROWS_PER_SIZE,
  COST_GRID_SEEDED_MESSAGE,
  COST_GRID_SIZES,
  costGridRows,
  decisionDollars,
  formatCostGrid,
  worstCaseCandidateSource,
  type CostGridChannel,
  type CostGridOptions,
  type CostGridRow,
  type DecisionCost,
} from './routing/referents/cost-grid'
export { createOracleOperations, type OracleOperations, type OracleOptions } from './routing/referents/oracle'

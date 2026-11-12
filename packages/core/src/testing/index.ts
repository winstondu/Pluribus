/**
 * @committee/core/testing — fakes for every port, for core's own tests and
 * for the other packages. Never imported by production code.
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

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
  done,
  fail,
  requestTextOf,
  say,
  type RequestMatch,
  type ScriptStep,
} from './scripted-model-provider'
export { ScriptedDecisionProvider, ScriptedDecomposer } from './scripted-providers'
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

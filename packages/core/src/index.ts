/**
 * @committee/core — event log, projections, coordinator, routing pipeline and
 * validation. No I/O: everything outside is injected through the ports.
 *
 * This file only re-exports. Each slice of core adds one line for its own
 * `index.ts` when it lands (see docs/build/PLAN.md, "Core"):
 *
 *   export * from './engine'     // createBackend, state, projections
 *   export * from './routing'    // createRouter, validatePlan
 *   export * from './recovery'   // retry policies, revisions, recovery
 *
 * Fakes for tests are a separate entry, `@committee/core/testing`, so that
 * production bundles never pull them in by accident. The ports alone are a
 * third entry, `@committee/core/ports`: storage and providers import from
 * it, so they compile and test without loading the engine.
 */
export * from './ports'
export * from './engine'

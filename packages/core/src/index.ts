/**
 * @pluribus/core — event log, projections, coordinator, routing pipeline and
 * validation. No I/O: everything outside is injected through the ports.
 *
 * This file only re-exports. Each slice of core adds one line for its own
 * `index.ts` when it lands (see docs/build/PLAN.md, "Core"):
 *
 *   export * from './engine'     // createBackend, state, projections
 *   export * from './routing'    // createRouter, validatePlan
 *   export * from './recovery'   // retry policies, revisions, recovery
 *
 * Fakes and routing evaluation helpers are available from
 * `@pluribus/core/testing`. Storage and providers implement the ports
 * exposed by `@pluribus/core/ports`.
 */
export * from './ports'
export * from './engine'
export * from './routing'
export * from './recovery'

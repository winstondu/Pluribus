import type { CoreModule } from './module'
import { defaultRetryPlanner, defaultRoutingRetryPlanner, engineCommands, engineReactions, engineStartup, engineTimers } from './lifecycle'
import { unitsApplier } from './plan'

/**
 * The engine's own module: the defaults every slice builds on. Commands:
 * `submit-message`, `stop`, and `retry` (route again after a routing
 * failure; retry unfinished work in place, or after the join-back when its
 * group has closed). Later modules override any of these by handling the
 * same command and returning `null` to fall back here.
 */
export const engineModule: CoreModule = {
  name: 'engine',
  commands: engineCommands,
  reactions: engineReactions,
  planAppliers: [unitsApplier],
  retryPlanner: defaultRetryPlanner,
  routingRetryPlanner: defaultRoutingRetryPlanner,
  startupReactions: [engineStartup],
  timers: engineTimers,
}

const registered: CoreModule[] = []

/**
 * Adds a slice's module to the defaults of `createBackend`. A slice calls
 * this from its own `index.ts`, so `export * from './routing'` in the
 * package index is enough to include it. Registering the same name twice
 * replaces the earlier one.
 */
export function registerCoreModule(module: CoreModule): void {
  const index = registered.findIndex((m) => m.name === module.name)
  if (index >= 0) registered.splice(index, 1, module)
  else registered.push(module)
}

/** The engine first, then every registered module in registration order. */
export function defaultModules(): CoreModule[] {
  return [engineModule, ...registered]
}

/**
 * The routing slice of core: the routing pipeline behind `Router`
 * (11 · "Routing"), the referent strategies it takes its reply targets from,
 * validation, the clarification and target-ambiguity elicitations, and
 * Undo split. Importing this registers `routingModule` with the engine's
 * defaults.
 */
import { registerCoreModule } from '../engine'
import { routingModule } from './module'

export { createRouter } from './pipeline'
export { validatePlan, topological, resolveUnitTargets, derivePlacement, AMBIGUITY_FLOOR, type Validation, type TargetResolution } from './derive'
export { routingModule, clarificationInstruction, answerClarification } from './module'
export { MAX_SECTIONS, MAX_DEPENDENCIES, MAX_CHAINS } from './supply'

registerCoreModule(routingModule)

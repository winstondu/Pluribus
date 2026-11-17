/**
 * The recovery slice of core: retry policies, paused dependents and the
 * recovery choice, revisions, the choice with default, Regenerate and
 * superseded-input notes (06, 07, 08). Importing this registers
 * `recoveryModule` with the engine's defaults.
 */
import { registerCoreModule } from '../engine'
import { recoveryModule } from './module'

export { recoveryModule } from './module'
export { policyRetryPlanner, automaticRetriesUsed } from './policy'
export { unfinishedCause } from './pause'
export { supersededInputs } from './notes'
export { replaceWork, revisionTargetState, waitForReplacedInputs, type Replacement } from './replace'
export { CHOICE_TIMER } from './revisions'

registerCoreModule(recoveryModule)

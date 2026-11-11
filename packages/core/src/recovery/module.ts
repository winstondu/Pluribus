import type { CoreModule } from '../engine'
import { notesReaction } from './notes'
import { pauseCommands, pauseReaction, unpauseOnRetry, withdrawStaleRecovery } from './pause'
import { policyRetryPlanner } from './policy'
import { CHOICE_TIMER, choiceStartup, choiceTimer, defaultOnNextMessage, reformJoinBacks, revisionCommands, revisionsApplier } from './revisions'

/**
 * The recovery slice of core (PLAN §3, core-recovery): what follows work
 * that did not finish or was corrected. The retry policies, pausing
 * dependents and the recovery choice, revisions with their effect on
 * dependents, the choice with default, Regenerate, join-back re-formation
 * and superseded-input notes. It emits events; the engine's reducers and
 * projections say what they mean.
 *
 * Retry itself (in place, or after the join-back once the group closed) is
 * the engine's `retry` command; this module's reactions follow it (a paused
 * dependent waits again for the retry).
 */
export const recoveryModule: CoreModule = {
  name: 'recovery',
  commands: { ...pauseCommands, ...revisionCommands },
  reactions: [unpauseOnRetry, pauseReaction, withdrawStaleRecovery, defaultOnNextMessage, reformJoinBacks, notesReaction],
  planAppliers: [revisionsApplier],
  retryPlanner: policyRetryPlanner,
  startupReactions: [choiceStartup],
  timers: { [CHOICE_TIMER]: choiceTimer },
}

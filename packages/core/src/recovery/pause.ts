import type { DirectiveId, PauseCause, PrerequisiteRef } from '@committee/protocol'
import { queries, settleWait, startedInSection, type CommandHandlers, type ConversationState, type DirectiveRow, type Reaction } from '../engine'

/**
 * Dependents of work that did not finish (08, Q48): a dependency-queued
 * directive whose prerequisite failed, was stopped, was interrupted or was
 * cancelled, and is not retrying, is paused with a recovery choice on its
 * queue item. It never runs on a subset of siblings (F5), and there is no
 * default: Committee waits for Retry, Continue without or Cancel.
 */

/** The first prerequisite of `d` that is unsatisfied because work behind it ended unfinished, if any. */
export function unfinishedCause(state: ConversationState, d: DirectiveRow): PauseCause | null {
  for (const ref of d.prerequisites) {
    if (queries.prerequisiteSatisfied(state, d, ref)) continue
    for (const id of behind(state, ref)) {
      if (d.waived.includes(id)) continue
      const prerequisite = state.directives[id]
      if (!prerequisite) continue
      const outcome = queries.unfinishedOutcome(prerequisite.state)
      if (outcome) return { directiveId: id, label: prerequisite.label, outcome }
    }
  }
  return null
}

function behind(state: ConversationState, ref: PrerequisiteRef): DirectiveId[] {
  return queries.prerequisiteDirectives(state, ref)
}

/** Pauses every dependency-queued directive with an unfinished prerequisite. */
export const pauseReaction: Reaction = (_state, event, ctx) => {
  if (event.type === 'attempt-output') return
  for (const id of ctx.state.directiveOrder) {
    const d = ctx.state.directives[id]
    if (!d || d.state !== 'dependency-queued') continue
    const cause = unfinishedCause(ctx.state, d)
    if (!cause) continue
    const elicitationId = ctx.ids.next('elicitation')
    ctx.emit({ type: 'elicitation-raised', elicitation: { kind: 'recovery-choice', elicitationId, pausedDirectiveId: id, cause } })
    ctx.emit({ type: 'directive-paused', directiveId: id, queueItemId: d.queueItemId ?? ctx.ids.next('queueItem'), cause, elicitationId })
  }
}

/**
 * "Retry activities": a retry of the prerequisite is the recovery choice
 * Retry (Q48). The paused directive waits again, for the retry's result.
 */
export const unpauseOnRetry: Reaction = (_state, event, ctx) => {
  if (event.type !== 'retry-requested') return
  for (const id of ctx.state.directiveOrder) {
    const d = ctx.state.directives[id]
    if (!d || d.state !== 'paused' || d.pause?.reason !== 'dependency-recovery' || d.pause.cause.directiveId !== event.directiveId) continue
    ctx.emit({ type: 'elicitation-answered', elicitationId: d.pause.elicitationId, resolution: { kind: 'recovery-choice', choice: 'retry-prerequisite' } })
    settleWait(ctx, id, true)
  }
}

/**
 * A recovery choice that no longer applies is withdrawn: the paused
 * directive was unpaused because its prerequisite is recovering (a revision
 * replaced it), or the directive itself ended (stopped, cancelled,
 * superseded).
 */
export const withdrawStaleRecovery: Reaction = (_state, event, ctx) => {
  if (event.type === 'attempt-output') return
  for (const id of ctx.state.elicitationOrder) {
    const row = ctx.state.elicitations[id]
    if (!row || row.status !== 'open' || row.record.kind !== 'recovery-choice') continue
    const d = ctx.state.directives[row.record.pausedDirectiveId]
    if (d && d.state === 'paused' && d.pause?.elicitationId === id) continue
    const recovering = d !== undefined && ['dependency-queued', 'ready', 'running', 'retrying', 'waiting-for-capacity', 'completed'].includes(d.state)
    ctx.emit({ type: 'elicitation-withdrawn', elicitationId: id, reason: recovering ? 'prerequisite-recovering' : 'subject-ended' })
  }
}

export const pauseCommands: CommandHandlers = {
  /** "Continue without activities": the paused directive runs without that result; for a group it reads the full join-back with the member's marker (Q48). */
  'continue-without': (state, command, ctx) => {
    const d = state.directives[command.directiveId]
    if (!d) return { code: 'unknown-target', message: `Unknown directive ${command.directiveId}` }
    // "Continue without" is one of the recovery choices: it applies to a dependency-recovery pause only
    // (10 · "Continue without | A request paused for dependency recovery"). Work paused for the user's
    // input resumes by the answer.
    if (d.state !== 'paused' || d.pause?.reason !== 'dependency-recovery') {
      return { code: 'not-allowed', message: 'Only a request paused for dependency recovery can continue without its prerequisite' }
    }
    const { cause, elicitationId } = d.pause
    ctx.emit({ type: 'prerequisite-waived', directiveId: d.id, waivedDirectiveId: cause.directiveId, elicitationId })
    ctx.emit({ type: 'elicitation-answered', elicitationId, resolution: { kind: 'recovery-choice', choice: 'continue-without' } })
    settleWait(ctx, d.id, true)
    return []
  },

  /** "Cancel itinerary": the paused directive is cancelled, a state of its own (Q91). */
  cancel: (state, command, ctx) => {
    const d = state.directives[command.directiveId]
    if (!d) return { code: 'unknown-target', message: `Unknown directive ${command.directiveId}` }
    if (d.state !== 'paused' || !d.pause) return { code: 'not-allowed', message: 'Only a paused request can be cancelled this way' }
    if (d.pause.reason === 'awaiting-input') {
      // Cancel applies to any paused request (10 · "Cancel | A paused request"). Work paused for input
      // that never ran is cancelled; work that ran and stopped to ask keeps its partial text and is
      // stopped, because cancelled means "before it started" (Q91). Its question is then withdrawn.
      if (startedInSection(state, d) && d.sectionId !== null) {
        ctx.emit({ type: 'directive-stopped', directiveId: d.id, sectionId: d.sectionId, scope: 'section' })
      } else {
        ctx.emit({ type: 'directive-cancelled', directiveId: d.id, cause: 'paused-cancel' })
      }
      return []
    }
    ctx.emit({ type: 'elicitation-answered', elicitationId: d.pause.elicitationId, resolution: { kind: 'recovery-choice', choice: 'cancel' } })
    ctx.emit({ type: 'directive-cancelled', directiveId: d.id, cause: 'recovery-cancel' })
    return []
  },
}

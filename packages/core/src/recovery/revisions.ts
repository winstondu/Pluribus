import { correctionText, notStartedInSection, queries, settleWait, formJoinBack, type CommandHandlers, type ConversationState, type DirectiveRow, type PlanApplier, type Reaction, type StartupReaction, type StepContext, type TimerHandler } from '../engine'
import type { PlannedRevision } from '../ports'
import type { DirectiveId, ElicitationId, MessageId, RedoOption } from '@committee/protocol'
import { revisionTargetState, replaceWork, waitForReplacedInputs } from './replace'

/**
 * Revisions (06) and the choice with default (07): what follows when routing
 * concludes that a message corrects earlier work.
 */

export const CHOICE_TIMER = 'recovery.choice-default'

function choiceKey(elicitationId: ElicitationId): string {
  return `choice:${elicitationId}`
}

// ───────────────────────────── the plan's revisions ─────────────────────────────

export const revisionsApplier: PlanApplier = {
  parts: ['revisions'],
  apply(_state, plan, target, ctx) {
    for (const revision of plan.revisions) applyRevision(ctx, revision, target.messageId)
  },
}

function applyRevision(ctx: StepContext, r: PlannedRevision, messageId: MessageId): void {
  const targets = r.targetDirectiveIds.flatMap((id) => {
    const d = ctx.state.directives[id]
    return d && d.state !== 'superseded' ? [d] : []
  })
  if (targets.length === 0 && r.targetRequirementIds.length === 0) return
  ctx.emit({
    type: 'revision-recorded',
    messageId,
    scope: r.scope,
    correction: r.correction,
    fragmentId: r.fragment?.fragmentId ?? null,
    targets: targets.map((d) => ({ directiveId: d.id, sectionId: d.sectionId, state: revisionTargetState(ctx.state, d) })),
    requirementIds: r.targetRequirementIds,
  })
  if (r.scope === 'work') {
    for (const d of targets) reviseWork(ctx, d.id, messageId, r.correction)
    return
  }
  // A shared requirement: the brief keeps its exchange and is read with the correction after it
  // ("All future work uses the revised brief", 06); work not started is corrected in place.
  for (const d of targets) {
    if (revisionTargetState(ctx.state, d) === 'not-started') reviseInPlace(ctx, d.id, messageId, r.correction)
  }
  raiseChoice(ctx, r, messageId)
}

/** One piece of work, by the state of the target (06 · "Revising one piece of work"). */
function reviseWork(ctx: StepContext, directiveId: DirectiveId, messageId: MessageId, correction: string): void {
  const d = ctx.state.directives[directiveId]
  if (!d) return
  const state = revisionTargetState(ctx.state, d)
  if (state === 'not-started') {
    reviseInPlace(ctx, directiveId, messageId, correction)
    return
  }
  // Started: superseded, not stopped; the replacement is a new response at its own first output (Q38).
  replaceWork(ctx, directiveId, {
    cause: { kind: 'revision', revisionMessageId: messageId },
    nodeReason: 'revision',
    responseReason: 'revision-replacement',
    messageId,
  })
  settleWait(ctx, directiveId, true)
  followDependents(ctx, directiveId, messageId)
}

/** Work not started is updated in place: nothing is stopped or superseded, and its dependencies are unchanged (Q41, R6). */
function reviseInPlace(ctx: StepContext, directiveId: DirectiveId, messageId: MessageId, correction: string): void {
  const d = ctx.state.directives[directiveId]
  if (!d) return
  ctx.emit({
    type: 'directive-revised-in-place',
    directiveId,
    revisionMessageId: messageId,
    instruction: `${d.revisedInstruction?.instruction ?? d.instruction}\n\n${correctionText(correction)}`,
    requirements: d.revisedInstruction?.requirements ?? d.requirements,
  })
  // Its queue item now reads "Revised · waiting for …".
  const after = ctx.state.directives[directiveId]
  if (after?.state === 'dependency-queued') settleWait(ctx, directiveId, true)
}

/**
 * Work that depends on a revised target follows its actual dependencies
 * (06 · "Effect on work that depends on the target", Q36): queued work keeps
 * waiting, now for the replacement; running work that read the target is
 * restarted in a new response once the replacement is ready; completed work
 * is left as it was and gets the superseded-input note (see notes.ts).
 */
function followDependents(ctx: StepContext, targetId: DirectiveId, messageId: MessageId): void {
  for (const id of ctx.state.directiveOrder) {
    if (id === targetId) continue
    const d = ctx.state.directives[id]
    if (!d || d.kind !== 'answer') continue
    const waits = d.prerequisites.some((p) => queries.prerequisiteDirectives(ctx.state, p).includes(targetId))
    const latest = d.attemptIds[d.attemptIds.length - 1]
    const attempt = latest ? ctx.state.attempts[latest] : undefined
    const read = attempt !== undefined && attempt.sectionId === d.sectionId && attempt.context.inputs.some((i) => i.directiveId === targetId)
    // Queued work, released or not (work held by the concurrency limit is still queued), keeps waiting,
    // now for the replacement and the rest of the full join-back (06, R3).
    if ((d.state === 'dependency-queued' || d.state === 'ready') && notStartedInSection(ctx.state, d) && waits) {
      settleWait(ctx, id, true)
    } else if (d.state === 'paused' && d.pause?.cause.directiveId === targetId) {
      // The prerequisite that did not finish is being replaced: the recovery choice no longer applies.
      settleWait(ctx, id, true)
    } else if (queries.isStartedUnsettled(d.state) && read) {
      restartDependent(ctx, id, targetId, messageId)
    }
  }
}

function restartDependent(ctx: StepContext, directiveId: DirectiveId, targetId: DirectiveId, messageId: MessageId): void {
  const d = ctx.state.directives[directiveId]
  if (!d) return
  replaceWork(ctx, directiveId, {
    cause: { kind: 'prerequisite-revised', revisionMessageId: messageId },
    nodeReason: 'prerequisite-revised',
    responseReason: 'prerequisite-revised',
    messageId: d.messageId,
  })
  waitForReplacedInputs(ctx, directiveId, [targetId])
  settleWait(ctx, directiveId, true)
}

// ───────────────────────────── choice with default ─────────────────────────────

/**
 * A revision of a shared requirement (06, Q42, Q44, Q45, Q84): the user is
 * asked which of the brief's consumers to redo. Running work is stopped at
 * once and always redone; queued work always picks up the change; the
 * choice applies to finished work. With nothing to list, nothing is asked
 * and the detection rule applies at once.
 */
function raiseChoice(ctx: StepContext, r: PlannedRevision, messageId: MessageId): void {
  const options: RedoOption[] = []
  for (const entry of r.affected) {
    const d = ctx.state.directives[entry.directiveId]
    if (!d || d.state === 'superseded' || d.kind !== 'answer') continue
    if (r.targetDirectiveIds.includes(d.id) || options.some((o) => o.directiveId === d.id)) continue
    const state = revisionTargetState(ctx.state, d)
    // Affected running work stops and affected queued work holds; work the router judged unaffected
    // continues (07 · "Choice with default"). Only finished work is the user's choice (Q44, Q84): an
    // unaffected run that finishes later gets the superseded-input note through the detection rule.
    if (state === 'not-started') {
      if (entry.preselected) options.push({ directiveId: d.id, label: d.label, state: 'queued', locked: true, preselected: true })
    } else if (state === 'running-status-only' || state === 'running-with-text') {
      if (entry.preselected) options.push({ directiveId: d.id, label: d.label, state: 'running', locked: true, preselected: true })
    } else options.push({ directiveId: d.id, label: d.label, state: 'finished', locked: false, preselected: entry.preselected })
  }
  if (options.length === 0) return
  const elicitationId = ctx.ids.next('elicitation')
  const deadlineAt = ctx.now + ctx.settings.defaultChoiceWaitMs
  ctx.emit({ type: 'elicitation-raised', elicitation: { kind: 'choice-with-default', elicitationId, revisionMessageId: messageId, options, deadlineAt } })
  for (const option of options) {
    if (option.state === 'running') {
      const d = ctx.state.directives[option.directiveId]
      if (!d) continue
      replaceWork(ctx, option.directiveId, { cause: { kind: 'redo', elicitationId }, nodeReason: 'redo', responseReason: 'redo', messageId: d.messageId })
      ctx.emit({ type: 'directive-held', directiveId: option.directiveId, elicitationId, reason: 'choice-with-default' })
    } else if (option.state === 'queued') {
      ctx.emit({ type: 'directive-held', directiveId: option.directiveId, elicitationId, reason: 'choice-with-default' })
    }
  }
  ctx.setTimer(CHOICE_TIMER, choiceKey(elicitationId), deadlineAt, { elicitationId })
}

/** The finished work currently selected for redo. */
function selectedFinished(state: ConversationState, elicitationId: ElicitationId): DirectiveId[] {
  const row = state.elicitations[elicitationId]
  if (!row || row.record.kind !== 'choice-with-default') return []
  const finished = row.record.options.filter((o) => o.state === 'finished').map((o) => o.directiveId)
  return row.selected.filter((id) => finished.includes(id))
}

/**
 * Carries out the selection (after `elicitation-answered` or
 * `elicitation-defaulted`): held work goes back to waiting or ready, and
 * each chosen finished piece of work is redone in a new response. Work not
 * chosen keeps its result and gets the note (notes.ts).
 */
function carryOut(ctx: StepContext, elicitationId: ElicitationId, redo: readonly DirectiveId[]): void {
  ctx.cancelTimer(choiceKey(elicitationId))
  const row = ctx.state.elicitations[elicitationId]
  const revisionMessageId = row?.record.kind === 'choice-with-default' ? row.record.revisionMessageId : null
  // The chosen finished work is replaced first, so everything released below waits for the new
  // version of what it read, never reading a redone request without its answer (06, 04).
  const redone: DirectiveId[] = []
  for (const id of redo) {
    const d = ctx.state.directives[id]
    if (!d || d.state === 'superseded' || queries.isInFlightState(d.state)) continue
    if (replaceWork(ctx, id, { cause: { kind: 'redo', elicitationId }, nodeReason: 'redo', responseReason: 'redo', messageId: d.messageId })) redone.push(id)
  }
  const held = ctx.state.directiveOrder.filter((id) => {
    const d = ctx.state.directives[id]
    return d?.state === 'awaiting-elicitation' && d.heldBy?.elicitationId === elicitationId
  })
  for (const id of [...held, ...redone]) {
    waitForReplacedInputs(ctx, id)
    settleWait(ctx, id, true)
  }
  // Consumers outside the choice follow the redone work as they would a revised target (06 tables).
  if (revisionMessageId !== null) for (const id of redone) followDependents(ctx, id, revisionMessageId)
}

function defaultChoice(ctx: StepContext, elicitationId: ElicitationId, trigger: 'wait-elapsed' | 'next-message'): void {
  const row = ctx.state.elicitations[elicitationId]
  if (!row || row.status !== 'open' || row.record.kind !== 'choice-with-default') return
  const redo = selectedFinished(ctx.state, elicitationId)
  ctx.emit({ type: 'elicitation-defaulted', elicitationId, trigger, redo })
  carryOut(ctx, elicitationId, redo)
}

/** The wait elapsed (Q45). */
export const choiceTimer: TimerHandler = (_state, payload, ctx) => {
  const { elicitationId } = payload as { elicitationId: ElicitationId }
  defaultChoice(ctx, elicitationId, 'wait-elapsed')
}

/** The user sent another message without answering: the default is carried out (Q45). */
export const defaultOnNextMessage: Reaction = (_state, event, ctx) => {
  if (event.type !== 'message-submitted') return
  for (const id of ctx.state.elicitationOrder) {
    const row = ctx.state.elicitations[id]
    if (row?.status === 'open' && row.record.kind === 'choice-with-default') defaultChoice(ctx, id, 'next-message')
  }
}

/** On start: a wait that elapsed while nothing ran is carried out now; others are set again. */
export const choiceStartup: StartupReaction = (state, ctx) => {
  for (const id of state.elicitationOrder) {
    const row = state.elicitations[id]
    if (row?.status !== 'open' || row.record.kind !== 'choice-with-default') continue
    if (row.record.deadlineAt <= ctx.now) defaultChoice(ctx, id, 'wait-elapsed')
    else ctx.setTimer(CHOICE_TIMER, choiceKey(id), row.record.deadlineAt, { elicitationId: id })
  }
}

// ───────────────────────────── join-back re-formation ─────────────────────────────

/**
 * A member replaced after its group closed (a revision, a redo) re-forms
 * the join-back once its replacement has settled, so later work reads the
 * correction and the replacement in the member's place (Q39). A retry that
 * completes after closure does not: its exchange follows the record (Q92).
 */
export const reformJoinBacks: Reaction = (_state, event, ctx) => {
  if (event.type === 'attempt-output') return
  for (const group of Object.values(ctx.state.groups)) {
    if (group.state !== 'closed') continue
    const current = queries.currentJoinBack(ctx.state, group.id)
    if (!current) continue
    const formedAt = ctx.state.nodeOrder.indexOf(current.nodeId)
    const due = queries.activeMembers(group).some((m) => {
      const d = ctx.state.directives[m.directiveId]
      if (!d || queries.isInFlightState(d.state) || d.state === 'superseded') return false
      const node = ctx.state.nodes[d.nodeId]
      if (!node || !node.reason || !['revision', 'regenerate', 'redo', 'prerequisite-revised'].includes(node.reason)) return false
      return ctx.state.nodeOrder.indexOf(node.id) > formedAt
    })
    if (due) formJoinBack(ctx, group.id, true)
  }
}

// ───────────────────────────── commands ─────────────────────────────

export const revisionCommands: CommandHandlers = {
  /** The choice with default: edit the selection, or confirm it (Q45, Q95). Other kinds pass. */
  'answer-elicitation': (state, command, ctx) => {
    const row = state.elicitations[command.elicitationId]
    if (!row) return { code: 'unknown-target', message: `Unknown elicitation ${command.elicitationId}` }
    if (row.record.kind === 'recovery-choice') {
      return { code: 'invalid', message: 'A recovery choice is made with Retry, Continue without or Cancel' }
    }
    if (row.record.kind === 'clarification') return { code: 'invalid', message: 'A clarification question is answered by sending a message' }
    if (row.record.kind !== 'choice-with-default') return null
    if (command.answer.kind !== 'choice-with-default') return { code: 'invalid', message: 'This elicitation asks which work to redo' }
    if (row.status !== 'open') return { code: 'not-allowed', message: 'This choice has already been carried out' }
    const options = row.record.options
    if (command.answer.redo.some((id) => !options.some((o) => o.directiveId === id))) {
      return { code: 'invalid', message: 'Only offered work can be chosen' }
    }
    const finished = options.filter((o) => o.state === 'finished').map((o) => o.directiveId)
    const redo = [...new Set(command.answer.redo)].filter((id) => finished.includes(id))
    if (!command.answer.confirm) {
      ctx.emit({ type: 'elicitation-edited', elicitationId: row.id, redo })
      return []
    }
    ctx.emit({ type: 'elicitation-answered', elicitationId: row.id, resolution: { kind: 'choice-with-default', redo, confirm: true } })
    carryOut(ctx, row.id, redo)
    return []
  },

  /**
   * Regenerate (Q40, R8): completed work with a superseded-input note is
   * redone against the new version of what it read. Any of that work still
   * in progress is cancelled first. Never automatic.
   */
  regenerate: (state, command, ctx) => {
    const section = state.sections[command.sectionId]
    if (!section) return { code: 'unknown-target', message: `Unknown section ${command.sectionId}` }
    const d = state.directives[section.directiveId]
    if (!d || d.sectionId === null) return { code: 'unknown-target', message: `Unknown work for section ${command.sectionId}` }
    if (!section.supersededInputs || section.supersededInputs.inputs.length === 0) {
      return { code: 'not-allowed', message: 'Only work with a superseded-input note can be regenerated' }
    }
    const current = d.sectionId === section.id
    const again = !current && d.sectionIds.includes(section.id) && queries.isInFlightState(d.state)
    if (!(current && d.state === 'completed') && !again) return { code: 'not-allowed', message: 'This work cannot be regenerated now' }
    regenerate(ctx, d)
    return []
  },
}

function regenerate(ctx: StepContext, d: DirectiveRow): void {
  if (d.sectionId === null) return
  ctx.emit({ type: 'regenerate-requested', directiveId: d.id, sectionId: d.sectionId })
  replaceWork(ctx, d.id, { cause: { kind: 'regenerate' }, nodeReason: 'regenerate', responseReason: 'redo', messageId: d.messageId })
  waitForReplacedInputs(ctx, d.id)
  settleWait(ctx, d.id, true)
}

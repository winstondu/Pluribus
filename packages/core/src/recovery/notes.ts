import { deepEqual, type DirectiveId, type MessageId, type SupersededInput } from '@committee/protocol'
import { queries, type ConversationState, type Reaction } from '../engine'

/**
 * Superseded-input notes (06 · "Completed work built on a superseded
 * result", Q40; PLAN §2 "Detecting a superseded input"). A completed attempt
 * that is its directive's current result is noted when something it read
 * has since been replaced:
 *
 * - `result`: a directive in its `context.inputs` now has a different
 *   current result, or none (a revision replaced it, or it read only a
 *   marker and a retry has since completed);
 * - `correction`: a shared-requirement revision corrected a directive it
 *   read, it did not read that correction, and the revision's choice with
 *   default was resolved without redoing it;
 * - `session-requirement`: a session-wide requirement it read was replaced
 *   or withdrawn, with the same proviso.
 *
 * Only inputs the work actually consumed are named. Nothing regenerates
 * automatically (R5). Work that is superseded or in flight is never noted.
 */
export function supersededInputs(state: ConversationState, directiveId: DirectiveId): SupersededInput[] {
  const d = state.directives[directiveId]
  // A clarification question is not work a superseded input could change: its answer was given.
  if (!d || d.kind !== 'answer' || d.state !== 'completed' || d.resultAttemptId === null) return []
  const attempt = state.attempts[d.resultAttemptId]
  if (!attempt) return []
  const out: SupersededInput[] = []
  const label = (id: DirectiveId): string => state.directives[id]?.label ?? 'earlier work'

  for (const input of attempt.context.inputs) {
    // A late retry reads its own marker in the record; its own result is not an input it lost.
    if (input.directiveId === d.id) continue
    if (queries.currentResult(state, input.directiveId) !== input.attemptId) {
      out.push({ kind: 'result', directiveId: input.directiveId, label: label(input.directiveId), consumedAttemptId: input.attemptId })
    }
  }

  const read = new Set(attempt.context.inputs.map((i) => i.directiveId))
  for (const revision of state.revisions) {
    if (revision.scope !== 'shared-requirement' || attempt.context.corrections.includes(revision.messageId)) continue
    if (choicePending(state, revision.messageId)) continue
    for (const target of revision.targets) {
      if (!read.has(target.directiveId)) continue
      if (out.some((o) => o.kind === 'result' && o.directiveId === target.directiveId)) continue
      out.push({ kind: 'correction', directiveId: target.directiveId, label: label(target.directiveId), revisionMessageId: revision.messageId })
    }
  }

  for (const requirementId of attempt.context.sessionRequirementIds) {
    const row = state.sessionRequirements[requirementId]
    if (!row) continue
    let by: MessageId | null = row.withdrawnByMessageId
    if (row.replacedBy !== null) by = state.sessionRequirements[row.replacedBy]?.requirement.provenance.messageId ?? by
    if (by === null || choicePending(state, by)) continue
    out.push({ kind: 'session-requirement', requirementId, label: row.requirement.text, revisionMessageId: by })
  }
  return out
}

/** True while the choice with default raised for this revision message is still open. */
function choicePending(state: ConversationState, revisionMessageId: MessageId): boolean {
  for (const id of state.elicitationOrder) {
    const row = state.elicitations[id]
    if (row?.record.kind === 'choice-with-default' && row.record.revisionMessageId === revisionMessageId && row.status === 'open') return true
  }
  return false
}

/** Notes completed work as soon as one of its inputs is superseded; a note only ever gains inputs. */
export const notesReaction: Reaction = (_state, event, ctx) => {
  if (event.type === 'attempt-output' || event.type === 'superseded-input-noted') return
  for (const id of ctx.state.directiveOrder) {
    const d = ctx.state.directives[id]
    if (!d || d.state !== 'completed' || d.sectionId === null || d.resultAttemptId === null) continue
    const found = supersededInputs(ctx.state, id)
    if (found.length === 0) continue
    const section = ctx.state.sections[d.sectionId]
    if (!section) continue
    const existing = section.supersededInputs?.attemptId === d.resultAttemptId ? section.supersededInputs.inputs : []
    const merged = [...existing]
    for (const input of found) if (!merged.some((e) => deepEqual(e, input))) merged.push(input)
    if (merged.length === existing.length) continue
    ctx.emit({ type: 'superseded-input-noted', sectionId: d.sectionId, attemptId: d.resultAttemptId, inputs: merged })
  }
}

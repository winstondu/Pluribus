import {
  pausedText,
  recoveryLabels,
  waitingText,
  type ElicitationView,
  type PrerequisiteRef,
  type QueueItemView,
  type QueueProjection,
  type WaitTargetView,
} from '@committee/protocol'
import { prerequisiteLabel, sectionTitle, unfinishedBehind, withCurrentLabel } from '../queries'
import type { ConversationState, DirectiveRow } from '../state'
import type { Memo } from './tracking'

/** Names one prerequisite for a queue item or the run inspector. */
export function waitTarget(s: ConversationState, dependent: DirectiveRow, ref: PrerequisiteRef): WaitTargetView {
  return { ref, label: prerequisiteLabel(s, ref), directiveIds: unfinishedBehind(s, dependent, ref) }
}

/** Composer queue items, in submission order of their messages, and every unresolved elicitation, oldest first. */
export function queueProjection(s: ConversationState, m: Memo): QueueProjection {
  void m
  const items: QueueItemView[] = []
  for (const id of s.directiveOrder) {
    const d = s.directives[id]
    if (!d || d.queueItemId === null) continue
    if (d.state !== 'dependency-queued' && d.state !== 'paused') continue
    const waitingFor = d.waitingFor.map((ref) => waitTarget(s, d, ref))
    let recovery: QueueItemView['recovery'] = null
    if (d.state === 'paused' && d.pause) {
      const cause = withCurrentLabel(s, d.pause.cause)
      const prerequisite = s.directives[cause.directiveId]
      const labels = recoveryLabels(cause.label, d.label)
      recovery = {
        elicitationId: d.pause.elicitationId,
        cause,
        retry: { label: labels.retry, sectionId: prerequisite?.sectionId ?? ('' as never) },
        continueWithout: { label: labels.continueWithout },
        cancel: { label: labels.cancel },
      }
    }
    items.push({
      id: d.queueItemId,
      directiveId: d.id,
      messageId: d.messageId,
      label: d.label,
      state: d.state === 'paused' ? 'paused' : 'waiting',
      revised: d.revised,
      heldByBarrier: d.heldByBarrier,
      waitingFor,
      text:
        d.state === 'paused' && d.pause
          ? pausedText(withCurrentLabel(s, d.pause.cause))
          : waitingText(
              waitingFor.map((w) => w.label),
              d.revised,
            ),
      recovery,
    })
  }

  const elicitations: ElicitationView[] = []
  for (const id of s.elicitationOrder) {
    const row = s.elicitations[id]
    if (!row || row.status !== 'open') continue
    const record = row.record
    switch (record.kind) {
      case 'target-ambiguity': {
        const message = s.messages[record.messageId]
        elicitations.push({
          kind: 'target-ambiguity',
          id,
          messageId: record.messageId,
          messageText: message?.text ?? '',
          candidates: record.candidates.map((c) => {
            const section = s.sections[c.sectionId]
            const d = section ? s.directives[section.directiveId] : undefined
            const latest = section?.attemptIds[section.attemptIds.length - 1]
            return {
              sectionId: c.sectionId,
              title: section ? sectionTitle(s, section) : '',
              excerpt: (latest ? (s.attemptText[latest] ?? '') : '').slice(0, 160),
              chainId: d?.chainId ?? ('' as never),
            }
          }),
        })
        break
      }
      case 'choice-with-default': {
        const revision = [...s.revisions].reverse().find((r) => r.messageId === record.revisionMessageId)
        elicitations.push({
          kind: 'choice-with-default',
          id,
          revisionMessageId: record.revisionMessageId,
          correction: revision?.correction ?? '',
          // Work the user stopped or cancelled during the wait is no longer part of the choice: it is not redone by default.
          options: record.options
            .filter((o) => !endedByUser(s.directives[o.directiveId]?.state))
            .map((o) => ({ ...withCurrentLabel(s, o), selected: o.locked || row.selected.includes(o.directiveId) })),
          deadlineAt: record.deadlineAt,
          waitMs: Math.max(0, record.deadlineAt - row.raisedAt),
        })
        break
      }
      case 'clarification': {
        const question = s.directives[record.questionDirectiveId]
        elicitations.push({
          kind: 'clarification',
          id,
          questionSectionId: question?.sectionId ?? ('' as never),
          blockedLabels: record.blockedDirectiveIds.map((d) => s.directives[d]?.label ?? ''),
        })
        break
      }
      case 'recovery-choice': {
        const paused = s.directives[record.pausedDirectiveId]
        if (paused?.queueItemId) elicitations.push({ kind: 'recovery-choice', id, queueItemId: paused.queueItemId })
        break
      }
    }
  }
  return { items, elicitations }
}

/** Ended deliberately by the user (Stop or Cancel): such work is never redone by a default. */
export function endedByUser(state: DirectiveRow['state'] | undefined): boolean {
  return state === 'cancelled' || state === 'stopped'
}

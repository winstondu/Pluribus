import type {
  AttemptId,
  ClarificationReason,
  ConsumedContext,
  DirectiveId,
  ModelRole,
  NodeId,
  ReadinessSource,
} from '@pluribus/protocol'
import type { ModelMessage } from '../ports'
import type { StepContext } from './module'
import type { DirectiveRow } from './state'

/**
 * Typed readiness (07 · "Clarification", Q103, Q105, Q106).
 *
 * Every answer directive has a readiness result, `ready` or
 * `clarification-needed`, recorded as `directive-readiness-established`
 * before its first `attempt-started`. Who establishes it:
 *
 * - **Routing.** The plan states which units a clarification blocks; every
 *   other unit is `ready`. No model call beyond routing's own. For a unit
 *   that waits for results the finding is provisional (`awaitingResults`).
 * - **The preparation step**, once per input: for a directive whose
 *   readiness is not standing when it is released: it waited for results
 *   that have now arrived, its request was revised in place, or it has no
 *   record. A directive that never waited for a result is never prepared.
 * - **The user's answer** to its clarification question.
 * - **The run itself**, which may stop for consequential missing
 *   information (the provider's typed `clarification-needed` signal).
 */

/** A digest of a run's exact input: equal inputs give equal digests, so an unchanged check is reused (Q105). */
export function inputDigest(messages: readonly ModelMessage[]): string {
  // FNV-1a over the roles and contents, two 32-bit lanes; deterministic and dependency-free.
  let a = 0x811c9dc5
  let b = 0x01000193
  const feed = (text: string): void => {
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i)
      a = Math.imul(a ^ code, 0x01000193) >>> 0
      b = Math.imul(b ^ (code + i), 0x811c9dc5) >>> 0
    }
    a = Math.imul(a ^ 0xff, 0x01000193) >>> 0
    b = Math.imul(b ^ 0xfe, 0x811c9dc5) >>> 0
  }
  for (const message of messages) {
    feed(message.role)
    feed(message.content)
  }
  return `${messages.length}:${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`
}

/**
 * Whether the directive's recorded readiness lets a run with this input
 * start. `digest` is only called when the record came from a preparation
 * step: that check stands while the input is the one it checked.
 */
export function readinessStands(d: DirectiveRow, digest: () => string): boolean {
  if (d.kind !== 'answer') return true
  const record = d.readiness
  if (!record || record.readiness.kind !== 'ready' || record.awaitingResults) return false
  return record.basis === null || record.basis === digest()
}

export interface KnownClarification {
  /** The answer directive that cannot go on without the answer. */
  readonly directiveId: DirectiveId
  readonly reason: ClarificationReason
  /** The question, exactly as it is shown. */
  readonly question: string
  readonly source: Extract<ReadinessSource, 'preparation' | 'generation'>
  /** For `generation`: the run that stopped to ask. */
  readonly pausedAttemptId: AttemptId | null
  /** The call that wrote the question, and exactly what it read. */
  readonly writer: {
    readonly model: string
    readonly modelRole: Extract<ModelRole, 'answer' | 'synthesis'>
    readonly parents: readonly NodeId[]
    readonly context: ConsumedContext
  }
}

/**
 * Asks a clarification question whose text is already written (by the
 * preparation step, or by a run that stopped to ask): the elicitation, the
 * question as a directive and an additional response of its own with its
 * text recorded at once, and the blocked directive paused for the user's
 * input. No model is called: the question is never answer text classified
 * after streaming (Q103).
 *
 * The question's attempt records the call that wrote it: its model and the
 * exact input it read (invariant 2).
 */
export function askKnownClarification(ctx: StepContext, c: KnownClarification): void {
  const blocked = ctx.state.directives[c.directiveId]
  if (!blocked) return
  const elicitationId = ctx.ids.next('elicitation')
  const questionDirectiveId = ctx.ids.next('directive')
  ctx.emit({
    type: 'elicitation-raised',
    elicitation: {
      kind: 'clarification',
      elicitationId,
      questionDirectiveId,
      blockedDirectiveIds: [blocked.id],
      reason: c.reason,
      source: c.source,
      pausedAttemptId: c.pausedAttemptId,
    },
  })
  ctx.emit({
    type: 'directive-created',
    directiveId: questionDirectiveId,
    kind: 'clarification-question',
    messageId: blocked.messageId,
    originalMessageId: blocked.originalMessageId,
    fragmentId: null,
    instruction: c.question,
    label: `question about ${blocked.label}`,
    requirements: [],
    relation: 'addition',
    targets: [],
    nodeId: blocked.nodeId,
    chainId: blocked.chainId,
    prerequisites: [],
    asksElicitationId: elicitationId,
  })
  ctx.emit({ type: 'directive-held', directiveId: blocked.id, elicitationId, reason: 'clarification' })
  const responseId = ctx.ids.next('response')
  ctx.emit({ type: 'response-opened', responseId, messageId: blocked.messageId, reason: 'clarification-question', grouped: false, sectionOrder: 'first-output' })
  const sectionId = ctx.ids.next('section')
  const operationId = ctx.ids.next('operation')
  ctx.emit({
    type: 'section-opened',
    sectionId,
    directiveId: questionDirectiveId,
    responseId,
    title: 'Question',
    replacesSectionId: null,
    operationId,
    explicitPosition: null,
  })
  const attemptId = ctx.ids.next('attempt')
  ctx.emit({
    type: 'attempt-started',
    attemptId,
    directiveId: questionDirectiveId,
    sectionId,
    nodeId: blocked.nodeId,
    chainId: blocked.chainId,
    operationId,
    number: 1,
    origin: 'initial',
    modelRole: c.writer.modelRole,
    model: c.writer.model,
    parents: c.writer.parents,
    context: c.writer.context,
  })
  ctx.emit({ type: 'attempt-output', attemptId, index: 0, text: c.question })
  ctx.emit({ type: 'attempt-completed', attemptId, finishReason: 'stop', usage: null })
}

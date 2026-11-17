import { joinLabels, type DirectiveId, type ElicitationId, type MessageId, type ResponseId, type SiblingGroupId } from '@pluribus/protocol'
import type { CoreDependencies, PlannedClarification, Router } from '../ports'
import {
  queries,
  resolveTargets,
  settleWait,
  supersedeSection,
  undoSplitAvailable,
  type CommandHandlers,
  type CoreModule,
  type OutcomeHandler,
  type PlanApplier,
  type StepContext,
} from '../engine'
import { createRouter } from './pipeline'

/**
 * The routing slice of core (PLAN §3, core-routing): the default router,
 * and the events that only routing decides. Everything a plan states about
 * units, groups, barriers and requirements is the engine's to apply; this
 * module carries out the parts of a plan that ask the user (`clarifications`)
 * or answer them (`answersElicitationId`), raises the target-ambiguity
 * elicitation, and handles Undo split.
 */

// ───────────────────────────── clarification ─────────────────────────────

/** The question's instruction, composed by core from the blocked requests and what is unclear (PLAN §2 "Clarification"). */
export function clarificationInstruction(requests: readonly string[], about: string): string {
  return [
    'Before the request below can be answered, the user has to supply something: ' + about + '.',
    'Ask the user one short, specific question that gets it. Do not answer the request yet.',
    '',
    ...(requests.length === 1 ? [`Request: ${requests[0] ?? ''}`] : ['Requests:', ...requests.map((r) => `- ${r}`)]),
  ].join('\n')
}

/**
 * Carries out `plan.clarifications` (Q23, Q26, Q34): one clarification
 * elicitation per question; the question as a directive of its own on the
 * node of the first directive it blocks, answered by the answer model as an
 * additional response and never held by the whole-request barrier (E1);
 * every blocked directive held, with no queue item and no bubble, until the
 * answer arrives.
 */
const clarificationApplier: PlanApplier = {
  parts: ['clarifications'],
  apply(_state, plan, _target, ctx) {
    for (const c of plan.clarifications) raiseClarification(ctx, c)
  },
}

function raiseClarification(ctx: StepContext, c: PlannedClarification): void {
  const blocked = c.blockedDirectiveIds.flatMap((id) => {
    const d = ctx.state.directives[id]
    return d ? [d] : []
  })
  const first = blocked[0]
  if (!first) return
  const elicitationId = ctx.ids.next('elicitation')
  ctx.emit({
    type: 'elicitation-raised',
    elicitation: { kind: 'clarification', elicitationId, questionDirectiveId: c.questionDirectiveId, blockedDirectiveIds: blocked.map((d) => d.id), reason: c.reason },
  })
  ctx.emit({
    type: 'directive-created',
    directiveId: c.questionDirectiveId,
    kind: 'clarification-question',
    messageId: first.messageId,
    originalMessageId: first.originalMessageId,
    fragmentId: null,
    instruction: clarificationInstruction(blocked.map((d) => d.instruction), c.about),
    label: `question about ${joinLabels(blocked.map((d) => d.label))}`,
    requirements: [],
    relation: 'addition',
    targets: [],
    nodeId: first.nodeId,
    chainId: first.chainId,
    prerequisites: [],
    asksElicitationId: elicitationId,
  })
  for (const d of blocked) ctx.emit({ type: 'directive-held', directiveId: d.id, elicitationId, reason: 'clarification' })
  const responseId = ctx.ids.next('response')
  ctx.emit({ type: 'response-opened', responseId, messageId: first.messageId, reason: 'clarification-question', grouped: false, sectionOrder: 'first-output' })
  ctx.emit({
    type: 'section-opened',
    sectionId: ctx.ids.next('section'),
    directiveId: c.questionDirectiveId,
    responseId,
    title: 'Question',
    replacesSectionId: null,
    operationId: ctx.ids.next('operation'),
    explicitPosition: null,
  })
  // Its first state (ready: it waits for nothing and no barrier holds it) follows from the engine's wait reaction.
}

/**
 * Carries out `plan.answersElicitationId` (Q98): the clarification is
 * answered by this message, and each directive it held opens its section in
 * a new `clarified-answer` response (P9), never in the earlier one, and is
 * released to wait for its prerequisites or run.
 */
const answerApplier: PlanApplier = {
  parts: ['answersElicitationId'],
  apply(_state, plan, target, ctx) {
    const elicitationId = plan.answersElicitationId
    if (elicitationId) answerClarification(ctx, elicitationId, target.messageId)
  },
}

export function answerClarification(ctx: StepContext, elicitationId: ElicitationId, answerMessageId: MessageId): void {
  const row = ctx.state.elicitations[elicitationId]
  if (!row || row.status !== 'open' || row.record.kind !== 'clarification') return
  const held = row.record.blockedDirectiveIds.filter((id) => ctx.state.directives[id]?.heldBy?.elicitationId === elicitationId)
  ctx.emit({ type: 'elicitation-answered', elicitationId, resolution: { kind: 'clarification', answerMessageId } })
  const responses = new Map<MessageId, ResponseId>()
  const byMessage = new Map<MessageId, DirectiveId[]>()
  for (const id of held) {
    const d = ctx.state.directives[id]
    if (d) byMessage.set(d.messageId, [...(byMessage.get(d.messageId) ?? []), id])
  }
  for (const [messageId, ids] of byMessage) {
    const responseId = ctx.ids.next('response')
    responses.set(messageId, responseId)
    ctx.emit({ type: 'response-opened', responseId, messageId, reason: 'clarified-answer', grouped: ids.length >= 2, sectionOrder: 'first-output' })
    for (const id of ids) {
      const d = ctx.state.directives[id]
      if (!d) continue
      ctx.emit({
        type: 'section-opened',
        sectionId: ctx.ids.next('section'),
        directiveId: id,
        responseId,
        title: d.label,
        replacesSectionId: null,
        operationId: ctx.ids.next('operation'),
        explicitPosition: null,
      })
    }
  }
  for (const id of held) settleWait(ctx, id, true)
}

// ───────────────────────────── target ambiguity ─────────────────────────────

/** The reply is not acted on: the user chooses among the candidate sections (Q10, Q20). Never a guess. */
const targetAmbiguity: OutcomeHandler<'target-ambiguity'> = (_state, outcome, target, ctx) => {
  ctx.emit({
    type: 'elicitation-raised',
    elicitation: { kind: 'target-ambiguity', elicitationId: ctx.ids.next('elicitation'), messageId: target.messageId, candidates: outcome.candidates },
  })
}

// ───────────────────────────── commands ─────────────────────────────

const commands: CommandHandlers = {
  /** Target ambiguity only; every other kind passes to the module that raised it. */
  'answer-elicitation': (state, command, ctx) => {
    const row = state.elicitations[command.elicitationId]
    if (!row) return { code: 'unknown-target', message: `Unknown elicitation ${command.elicitationId}` }
    if (row.record.kind !== 'target-ambiguity') return null
    if (command.answer.kind !== 'target-ambiguity') return { code: 'invalid', message: 'This elicitation asks which section the reply means' }
    if (row.status !== 'open') return { code: 'not-allowed', message: 'This elicitation has already been answered' }
    const offered = row.record.candidates.map((c) => c.sectionId)
    const chosen = [...new Set(command.answer.sectionIds)]
    if (chosen.length === 0) return { code: 'invalid', message: 'Choose at least one section' }
    if (chosen.some((id) => !offered.includes(id))) return { code: 'invalid', message: 'Only an offered section can be chosen' }
    // A section superseded while the question was open resolves to its replacement (Q43).
    const resolved = resolveTargets(state, chosen).sectionIds
    if (resolved.length === 0) return { code: 'not-allowed', message: 'The chosen sections no longer exist' }
    ctx.emit({ type: 'elicitation-answered', elicitationId: row.id, resolution: { kind: 'target-ambiguity', sectionIds: resolved } })
    ctx.route(row.record.messageId, { chosenTargets: resolved })
    return []
  },

  /**
   * Undo split (Q53, Q85, D4): offered until any split message shows answer
   * text or receives a reply. One step: running attempts end as
   * superseded and status-only bubbles drop; the directives leave their
   * sibling groups; the original message returns, and is routed again as
   * one atomic request.
   */
  'undo-split': (state, command, ctx) => {
    const original = state.messages[command.originalMessageId]
    const decomposition = state.decompositions[command.originalMessageId]
    if (!original || !decomposition) return { code: 'unknown-target', message: `Unknown split message set ${command.originalMessageId}` }
    if (decomposition.presentation !== 'split-messages' || decomposition.undone) return { code: 'not-allowed', message: 'This message is not shown as split messages' }
    if (!undoSplitAvailable(state, command.originalMessageId)) {
      return { code: 'not-allowed', message: 'Undo split is not available once a split message shows answer text or has a reply' }
    }
    const work = decomposition.fragments.filter((f) => f.kind === 'work').map((f) => f.directiveId)
    // Questions asked for the split's directives go with them.
    const questions = state.directiveOrder.filter((id) => {
      const d = state.directives[id]
      return d?.kind === 'clarification-question' && d.originalMessageId === command.originalMessageId
    })
    const withdrawn = [...work, ...questions]
    for (const id of withdrawn) {
      const d = ctx.state.directives[id]
      if (d?.sectionId) supersedeSection(ctx, d.sectionId, { kind: 'undo-split' }, null)
    }
    for (const id of state.elicitationOrder) {
      const row = ctx.state.elicitations[id]
      if (row?.status === 'open' && row.record.kind === 'clarification' && withdrawn.includes(row.record.questionDirectiveId)) {
        ctx.emit({ type: 'elicitation-withdrawn', elicitationId: id, reason: 'subject-ended' })
      }
    }
    const byGroup = new Map<SiblingGroupId, DirectiveId[]>()
    for (const id of work) {
      const group = queries.groupOfDirective(ctx.state, id)
      if (group) byGroup.set(group.id, [...(byGroup.get(group.id) ?? []), id])
    }
    for (const [groupId, ids] of byGroup) {
      const group = ctx.state.groups[groupId]
      if (!group) continue
      const left = queries.activeMembers(group).filter((m) => !ids.includes(m.directiveId))
      ctx.emit({ type: 'siblings-withdrawn', groupId, directiveIds: ids, dissolved: left.length === 0 })
    }
    ctx.emit({
      type: 'split-undone',
      originalMessageId: command.originalMessageId,
      splitMessageIds: decomposition.splitMessages.map((s) => s.messageId),
      withdrawnDirectiveIds: withdrawn,
    })
    ctx.route(command.originalMessageId, { forcedComposition: 'atomic' })
    return []
  },
}

export const routingModule: CoreModule = {
  name: 'routing',
  commands,
  planAppliers: [clarificationApplier, answerApplier],
  outcomeHandlers: { 'target-ambiguity': targetAmbiguity },
  createRouter: (deps: CoreDependencies): Router => createRouter(deps),
}

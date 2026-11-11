import type {
  DirectiveId,
  MessageId,
  NodeReason,
  PrerequisiteRef,
  ResponseId,
  ResponseReason,
  RevisionTargetState,
  SectionId,
  SupersessionCause,
} from '@committee/protocol'
import { NOT_STARTED_STATES } from '@committee/protocol'
import { queries, supersedeSection, type ConversationState, type DirectiveRow, type StepContext } from '../engine'

/**
 * Replacing a directive's work (PLAN §2 "Directive, section, attempt"): the
 * same directive, a new section in a new response, a new attempt, and a new
 * genealogy node that stands in for the old one with the same planned
 * parents. Used by revisions, restarts of dependents whose prerequisite was
 * revised, Regenerate, and redo from a choice with default.
 */
export interface Replacement {
  readonly cause: SupersessionCause
  readonly nodeReason: Extract<NodeReason, 'revision' | 'prerequisite-revised' | 'regenerate' | 'redo'>
  readonly responseReason: Extract<ResponseReason, 'revision-replacement' | 'prerequisite-revised' | 'redo'>
  /** The user bubble the new response answers. */
  readonly messageId: MessageId
  /** A response already opened in this step to put the section in, so several replacements share one bubble. */
  readonly responseId?: ResponseId
}

/** The new section, or null when the directive has no section to replace. */
export function replaceWork(ctx: StepContext, directiveId: DirectiveId, how: Replacement): { readonly sectionId: SectionId; readonly responseId: ResponseId } | null {
  const d = ctx.state.directives[directiveId]
  if (!d || d.sectionId === null) return null
  const oldSectionId = d.sectionId
  const base = replacedNodeBase(ctx.state, d)
  const sectionId = ctx.ids.next('section')
  supersedeSection(ctx, oldSectionId, how.cause, sectionId)
  const nodeId = ctx.ids.next('node')
  ctx.emit({
    type: 'node-created',
    nodeId,
    chainId: base.chainId,
    directiveId,
    reason: how.nodeReason,
    plannedParents: base.plannedParents,
    replacesNodeId: d.nodeId,
  })
  let responseId = how.responseId
  if (!responseId) {
    responseId = ctx.ids.next('response')
    ctx.emit({ type: 'response-opened', responseId, messageId: how.messageId, reason: how.responseReason, grouped: false, sectionOrder: 'first-output' })
  }
  ctx.emit({
    type: 'section-opened',
    sectionId,
    directiveId,
    responseId,
    title: d.label,
    replacesSectionId: oldSectionId,
    operationId: ctx.ids.next('operation'),
    explicitPosition: null,
  })
  return { sectionId, responseId }
}

/**
 * Where a replacement goes: the chain and planned parents of the node it
 * replaces. A late retry's node is not where a member's exchange lives: a
 * member replaced after a late retry is replaced on its own node, so its
 * replacement re-forms the join-back like any revised member (Q39, Q92).
 */
function replacedNodeBase(state: ConversationState, d: DirectiveRow): { chainId: DirectiveRow['chainId']; plannedParents: NonNullable<ConversationState['nodes'][string]>['plannedParents'] } {
  const node = state.nodes[d.nodeId]
  if (node && node.reason === 'retry-after-closure') {
    const group = queries.groupOfDirective(state, d.id)
    const member = group?.members.find((m) => m.directiveId === d.id)
    const memberNode = member ? state.nodes[member.nodeId] : undefined
    if (memberNode) return { chainId: memberNode.chainId, plannedParents: memberNode.plannedParents }
  }
  return { chainId: node?.chainId ?? d.chainId, plannedParents: node?.plannedParents ?? [] }
}

/** The state of a revision's target when the revision arrives (06 · "Revising one piece of work"; PLAN §2). */
export function revisionTargetState(state: ConversationState, d: DirectiveRow): RevisionTargetState {
  const section = d.sectionId ? state.sections[d.sectionId] : undefined
  const started = (section?.attemptIds.length ?? 0) > 0
  if (d.state === 'completed') return 'finished'
  if (queries.unfinishedOutcome(d.state)) return 'ended-unfinished'
  if (NOT_STARTED_STATES.includes(d.state)) return started ? 'ended-unfinished' : 'not-started'
  return section?.hasText ? 'running-with-text' : 'running-status-only'
}

/**
 * A replacement waits for the new version of what it read (06, R4, R8):
 * every directive whose result its last run consumed and whose replacement
 * has not finished becomes a prerequisite, unless a sibling-group
 * prerequisite already covers it.
 */
export function waitForReplacedInputs(ctx: StepContext, directiveId: DirectiveId, also: readonly DirectiveId[] = []): void {
  const d = ctx.state.directives[directiveId]
  if (!d) return
  const latest = d.attemptIds[d.attemptIds.length - 1]
  const read = latest ? (ctx.state.attempts[latest]?.context.inputs.map((i) => i.directiveId) ?? []) : []
  const prerequisites: PrerequisiteRef[] = [...d.prerequisites]
  let changed = false
  for (const id of [...also, ...read]) {
    if (id === directiveId) continue
    const input = ctx.state.directives[id]
    if (!input || !queries.isInFlightState(input.state)) continue
    const covered = prerequisites.some(
      (p) => (p.kind === 'directive' && p.directiveId === id) || (p.kind === 'sibling-group' && queries.prerequisiteDirectives(ctx.state, p).includes(id)),
    )
    if (covered || d.waived.includes(id)) continue
    prerequisites.push({ kind: 'directive', directiveId: id })
    changed = true
  }
  if (changed) ctx.emit({ type: 'prerequisites-changed', directiveId, prerequisites })
}

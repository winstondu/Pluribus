import {
  WORDING,
  groupCountText,
  pausedText,
  redoneByDefaultText,
  supersededInputText,
  waitingText,
  type AttemptId,
  type AttemptResultStatus,
  type AttemptView,
  type ChainAssociation,
  type ChainId,
  type DecompositionView,
  type FragmentView,
  type MessageId,
  type MessageView,
  type ReplyingToView,
  type ResponseId,
  type ResponseView,
  type RoutingStatusView,
  type SectionCounts,
  type SectionId,
  type SectionNote,
  type SectionStatus,
  type SectionView,
  type SplitView,
  type TranscriptItemRef,
  type TranscriptProjection,
} from '@committee/protocol'
import {
  isInFlightState,
  isStartedUnsettled,
  messageVisible,
  prerequisiteLabel,
  responseVisible,
  sectionDropped,
  sectionState,
  unfinishedOutcome,
} from '../queries'
import type { ConversationState, DirectiveRow, SectionRow } from '../state'
import { shareRecord, type Memo } from './tracking'

/**
 * The transcript projection: display placement and everything shown in the
 * chat. Built record by record, each record memoized on what it read.
 */
export function transcriptProjection(s: ConversationState, m: Memo): TranscriptProjection {
  return {
    order: m.get('transcript.order', '', transcriptOrder),
    messages: m.get('transcript.messages', '', messagesMap),
    responses: m.get('transcript.responses', '', responsesMap),
    sections: m.get('transcript.sections', '', sectionsMap),
    attempts: m.get('transcript.attempts', '', attemptsMap),
    chains: m.get('transcript.chains', '', chainsMap),
    splits: m.get('transcript.splits', '', splitsMap),
  }
  void s
}

// ───────────────────────────── order ─────────────────────────────

/**
 * One rule: items whose position is fixed, in the order they were fixed, then
 * the responding bubbles still pending, in request order (PLAN §2). An
 * original shown as split messages stands for them at its own position.
 */
function transcriptOrder(s: ConversationState): readonly TranscriptItemRef[] {
  const out: TranscriptItemRef[] = []
  for (const ref of s.fixedOrder) {
    if (ref.kind === 'message') {
      const message = s.messages[ref.id]
      if (!message) continue
      if (message.splitActive) {
        const decomposition = s.decompositions[ref.id]
        for (const split of decomposition?.splitMessages ?? []) {
          if (messageVisible(s, split.messageId)) out.push({ kind: 'message', id: split.messageId })
        }
      } else if (messageVisible(s, ref.id)) {
        out.push(ref)
      }
    } else if (responseVisible(s, ref.id)) {
      out.push(ref)
    }
  }
  for (const id of s.responseOrder) {
    const response = s.responses[id]
    if (response && !response.placed && responseVisible(s, id)) out.push({ kind: 'response', id })
  }
  return out
}

// ───────────────────────────── messages ─────────────────────────────

function visibleMessageIds(s: ConversationState): MessageId[] {
  const out: MessageId[] = []
  for (const id of Object.keys(s.messages) as MessageId[]) if (messageVisible(s, id)) out.push(id)
  return out
}

function messagesMap(s: ConversationState, m: Memo): TranscriptProjection['messages'] {
  const out: { [id: string]: MessageView } = {}
  for (const id of visibleMessageIds(s)) out[id] = m.get('transcript.message', id, (st, mm) => messageView(st, mm, id))
  return out
}

function messageView(s: ConversationState, m: Memo, id: MessageId): MessageView {
  const message = s.messages[id]
  if (!message) throw new Error(`No message ${id}`)
  const chainIds: ChainId[] = []
  const addChain = (chainId: ChainId | undefined): void => {
    if (chainId && !chainIds.includes(chainId)) chainIds.push(chainId)
  }
  for (const directiveId of message.directiveIds) {
    const d = s.directives[directiveId]
    if (d && d.kind === 'answer' && d.state !== 'superseded') addChain(d.chainId)
  }
  for (const directiveId of [...message.revisedDirectiveIds, ...message.releasedDirectiveIds]) addChain(s.directives[directiveId]?.chainId)

  const directives = message.directiveIds.map((d) => s.directives[d]).filter((d): d is DirectiveRow => d !== undefined)
  const current = directives.filter((d) => d.state !== 'superseded')
  const decomposition = message.kind === 'original' ? s.decompositions[id] : undefined
  return {
    id,
    kind: message.kind,
    text: message.text,
    submittedAt: message.submittedAt,
    routing: message.routing,
    chainIds,
    replyingTo: replyingTo(s, id),
    split: message.split ? { originalMessageId: message.originalMessageId, index: message.split.index, count: message.split.count } : null,
    decomposition:
      decomposition && decomposition.presentation === 'reply-group' && !decomposition.undone
        ? m.get('transcript.decomposition', id, (st) => decompositionView(st, id))
        : null,
    responseIds: message.responseIds.filter((r) => responseVisible(s, r)),
    actions: {
      stop: current.some((d) => isInFlightState(d.state)),
      retry: message.routing === 'failed' || current.some((d) => unfinishedOutcome(d.state) !== null),
    },
  }
}

function replyingTo(s: ConversationState, id: MessageId): ReplyingToView | null {
  const message = s.messages[id]
  if (!message) return null
  const original = s.messages[message.originalMessageId]
  const decision = original?.decision ?? null
  const title = (sectionId: SectionId): string => s.sections[sectionId]?.title ?? ''
  if (decision) {
    let units = decision.units
    if (message.kind === 'split') {
      const fragmentIds = message.directiveIds.map((d) => s.directives[d]?.fragmentId).filter((f) => f !== null && f !== undefined)
      units = units.filter((u) => u.fragmentId !== null && fragmentIds.includes(u.fragmentId))
    }
    const sectionIds: SectionId[] = []
    let mode: ReplyingToView['mode'] | null = null
    let redirected = false
    for (const unit of units) {
      if (unit.targets.mode === 'none') continue
      mode ??= unit.targets.mode
      if (unit.targets.redirected.length > 0) redirected = true
      for (const sectionId of unit.targets.sectionIds) if (!sectionIds.includes(sectionId)) sectionIds.push(sectionId)
    }
    if (sectionIds.length === 0 || mode === null) return null
    return {
      targets: sectionIds.map((sectionId) => ({ sectionId, title: title(sectionId) })),
      mode,
      note: redirected ? WORDING.replyingToRevised : null,
    }
  }
  if (message.explicitTargets.length === 0) return null
  return {
    targets: message.explicitTargets.map((sectionId) => ({ sectionId, title: title(sectionId) })),
    mode: 'explicit',
    note: null,
  }
}

function decompositionView(s: ConversationState, originalId: MessageId): DecompositionView {
  const decomposition = s.decompositions[originalId]
  const original = s.messages[originalId]
  if (!decomposition || !original) throw new Error(`No decomposition for ${originalId}`)
  const fragments: FragmentView[] = decomposition.fragments.map((f) => {
    const d = s.directives[f.directiveId]
    const split = decomposition.splitMessages.find((sm) => sm.fragmentId === f.fragmentId)
    return {
      fragmentId: f.fragmentId,
      index: f.index,
      kind: f.kind,
      label: f.kind === 'work' && d ? d.label : f.label,
      sourceSpans: f.sourceSpans,
      rewrittenText: f.rewrittenText,
      requirements: f.requirements,
      directiveId: f.directiveId,
      chainId: d?.chainId ?? ('' as ChainId),
      sectionId: f.kind === 'work' ? (d?.sectionId ?? null) : null,
      messageId: split?.messageId ?? null,
    }
  })
  return {
    originalMessageId: originalId,
    originalText: original.text,
    presentation: decomposition.presentation,
    fragments,
    barrier: decomposition.barrier,
    model: decomposition.model,
  }
}

// ───────────────────────────── splits ─────────────────────────────

function splitsMap(s: ConversationState, m: Memo): TranscriptProjection['splits'] {
  const out: { [id: string]: SplitView } = {}
  for (const id of Object.keys(s.decompositions) as MessageId[]) {
    const decomposition = s.decompositions[id]
    if (!decomposition || decomposition.presentation !== 'split-messages' || decomposition.undone) continue
    out[id] = m.get('transcript.split', id, (st, mm) => splitView(st, mm, id))
  }
  return out
}

function splitView(s: ConversationState, m: Memo, originalId: MessageId): SplitView {
  const decomposition = s.decompositions[originalId]
  if (!decomposition) throw new Error(`No split for ${originalId}`)
  const messageIds = decomposition.splitMessages.map((sm) => sm.messageId)
  return {
    originalMessageId: originalId,
    messageIds,
    undoAvailable: undoSplitAvailable(s, originalId),
    decomposition: m.get('transcript.decomposition', originalId, (st) => decompositionView(st, originalId)),
  }
}

/**
 * Undo split is offered until any split message shows answer text or
 * receives a reply (Q85, D4): no section of the split shows text, and no
 * later message targets, builds on, or waits for any of its directives.
 */
export function undoSplitAvailable(s: ConversationState, originalId: MessageId): boolean {
  const decomposition = s.decompositions[originalId]
  if (!decomposition || decomposition.undone || decomposition.presentation !== 'split-messages') return false
  const directiveIds = new Set(decomposition.fragments.filter((f) => f.kind === 'work').map((f) => f.directiveId))
  const sectionIds = new Set<SectionId>()
  const nodeIds = new Set<string>()
  for (const id of directiveIds) {
    const d = s.directives[id]
    if (!d) continue
    for (const sectionId of d.sectionIds) {
      sectionIds.add(sectionId)
      if (s.sections[sectionId]?.hasText) return false
    }
    nodeIds.add(d.nodeId)
  }
  for (const id of s.directiveOrder) {
    const d = s.directives[id]
    if (!d || directiveIds.has(id) || d.originalMessageId === originalId) continue
    if (d.targets.some((t) => sectionIds.has(t))) return false
    if (d.prerequisites.some((p) => p.kind === 'directive' && directiveIds.has(p.directiveId))) return false
    const node = s.nodes[d.nodeId]
    if (node?.plannedParents.some((p) => (p.kind === 'node' && nodeIds.has(p.nodeId)) || (p.kind === 'directive' && directiveIds.has(p.directiveId)))) {
      return false
    }
  }
  for (const id of s.messageOrder) {
    const message = s.messages[id]
    if (!message || id === originalId) continue
    if (message.explicitTargets.some((t) => sectionIds.has(t))) return false
  }
  return true
}

// ───────────────────────────── responses ─────────────────────────────

function responsesMap(s: ConversationState, m: Memo): TranscriptProjection['responses'] {
  const out: { [id: string]: ResponseView } = {}
  for (const id of Object.keys(s.responses) as ResponseId[]) {
    if (responseVisible(s, id)) out[id] = m.get('transcript.response', id, (st, mm) => responseView(st, mm, id))
  }
  return out
}

function responseView(s: ConversationState, m: Memo, id: ResponseId): ResponseView {
  const response = s.responses[id]
  if (!response) throw new Error(`No response ${id}`)
  const message = s.messages[response.messageId]
  let routing: RoutingStatusView | null = null
  if (!response.opened && message && message.routing !== 'routed') {
    routing =
      message.routing === 'failed'
        ? {
            state: 'failed',
            text: `${WORDING.routingFailed}: ${message.routingFailure?.message ?? ''}`.trim(),
            failure: message.routingFailure,
          }
        : { state: message.routing, text: message.routing === 'routing' ? WORDING.routing : WORDING.awaitingAnswer, failure: null }
  }
  const shown = response.sectionIds.filter((sid) => {
    const section = s.sections[sid]
    return section !== undefined && !sectionDropped(section)
  })
  let sectionIds: SectionId[]
  if (response.sectionOrder === 'explicit') {
    sectionIds = [...shown].sort((a, b) => (s.sections[a]?.explicitPosition ?? 0) - (s.sections[b]?.explicitPosition ?? 0))
  } else if (response.grouped) {
    const placed = response.placedSectionIds.filter((sid) => shown.includes(sid))
    sectionIds = [...placed, ...shown.filter((sid) => !placed.includes(sid))]
  } else {
    sectionIds = shown
  }
  let header: ResponseView['header'] = null
  if (response.grouped) {
    const counts: { -readonly [K in keyof SectionCounts]: number } = {
      done: 0,
      failed: 0,
      stopped: 0,
      interrupted: 0,
      cancelled: 0,
      inProgress: 0,
    }
    for (const sid of sectionIds) {
      const state = m.get('transcript.section', sid, (st, mm) => sectionView(st, mm, sid)).state
      if (state === 'completed') counts.done += 1
      else if (state === 'failed') counts.failed += 1
      else if (state === 'stopped') counts.stopped += 1
      else if (state === 'interrupted') counts.interrupted += 1
      else if (state === 'cancelled') counts.cancelled += 1
      else if (state === 'pending' || state === 'streaming') counts.inProgress += 1
    }
    header = { counts, countText: groupCountText(counts) }
  }
  return {
    id,
    messageId: response.messageId,
    reason: response.reason,
    grouped: response.grouped,
    placement: response.placed ? 'fixed' : 'pending',
    routing,
    sectionIds,
    header,
  }
}

// ───────────────────────────── sections ─────────────────────────────

function shownSectionIds(s: ConversationState): SectionId[] {
  const out: SectionId[] = []
  for (const id of Object.keys(s.sections) as SectionId[]) {
    const section = s.sections[id]
    if (section && !sectionDropped(section) && responseVisible(s, section.responseId)) out.push(id)
  }
  return out
}

function sectionsMap(s: ConversationState, m: Memo): TranscriptProjection['sections'] {
  const out: { [id: string]: SectionView } = {}
  for (const id of shownSectionIds(s)) out[id] = m.get('transcript.section', id, (st, mm) => sectionView(st, mm, id))
  return out
}

/** Attempts shown in a bubble: those with text, and the latest one (for its status or failure notice). */
export function shownAttemptIds(s: ConversationState, section: SectionRow): AttemptId[] {
  const latest = section.attemptIds[section.attemptIds.length - 1]
  return section.attemptIds.filter((id) => id === latest || (s.attemptText[id] ?? '') !== '')
}

function sectionStatus(s: ConversationState, d: DirectiveRow): SectionStatus | null {
  switch (d.state) {
    case 'running':
      return { kind: 'responding', text: WORDING.responding }
    case 'retrying':
      return { kind: 'retrying', text: WORDING.retrying }
    case 'waiting-for-capacity':
      return { kind: 'waiting-for-capacity', text: WORDING.waitingForCapacity }
    case 'dependency-queued':
      return { kind: 'waiting-for-results', text: waitingText(d.waitingFor.map((ref) => prerequisiteLabel(s, ref)), d.revised) }
    case 'paused':
      return { kind: 'paused', text: d.pause ? pausedText(d.pause.cause) : WORDING.awaitingAnswer }
    case 'ready':
      return { kind: 'waiting-for-slot', text: WORDING.waitingForSlot }
    case 'awaiting-elicitation':
      return { kind: 'awaiting-answer', text: WORDING.awaitingAnswer }
    default:
      return null
  }
}

function sectionView(s: ConversationState, m: Memo, id: SectionId): SectionView {
  const section = s.sections[id]
  if (!section) throw new Error(`No section ${id}`)
  const d = s.directives[section.directiveId]
  if (!d) throw new Error(`No directive for section ${id}`)
  const response = s.responses[section.responseId]
  const state = sectionState(s, id)
  const current = d.sectionId === id && section.supersession === null
  const attemptIds = shownAttemptIds(s, section)
  const latestId = section.attemptIds[section.attemptIds.length - 1]
  const latest = latestId ? s.attempts[latestId] : undefined
  const latestHasText = latestId ? (s.attemptText[latestId] ?? '') !== '' : false

  let status: SectionStatus | null = null
  if (current && (state === 'pending' || (d.state === 'running' && !latestHasText) || d.state === 'retrying' || d.state === 'waiting-for-capacity')) {
    status = sectionStatus(s, d)
  }

  const notes: SectionNote[] = []
  if (section.supersededInputs && section.supersededInputs.inputs.length > 0) {
    notes.push({
      kind: 'superseded-input',
      text: supersededInputText(section.supersededInputs.inputs.map((i) => i.label)),
      inputs: section.supersededInputs.inputs,
    })
  }
  const redone = redoneByDefault(s, section)
  if (redone) notes.push({ kind: 'redone-by-default', text: redoneByDefaultText(d.label), elicitationId: redone })
  if (section.contextWarning) {
    notes.push({
      kind: 'context-near-limit',
      text: `This chain is near the model's context limit (${section.contextWarning.inputTokens} of ${section.contextWarning.tokenLimit} tokens)`,
      inputTokens: section.contextWarning.inputTokens,
      tokenLimit: section.contextWarning.tokenLimit,
    })
  }

  let superseded: SectionView['superseded'] = null
  if (section.supersession) {
    const replacementId = section.supersession.replacementSectionId
    superseded = {
      markText: section.supersession.wasFinished ? WORDING.supersededFinished : WORDING.supersededPartial,
      replacementSectionId: replacementId,
      replacementResponseId: replacementId ? (s.sections[replacementId]?.responseId ?? null) : null,
    }
  }

  const placement: SectionView['placement'] =
    response && (response.sectionOrder === 'explicit' || !response.grouped) ? (response.placed ? 'fixed' : 'pending') : section.placed ? 'fixed' : 'pending'

  const elicitation = d.asksElicitationId ? s.elicitations[d.asksElicitationId] : undefined
  return {
    id,
    directiveId: d.id,
    responseId: section.responseId,
    messageId: response?.messageId ?? d.messageId,
    kind: d.kind,
    title: section.title,
    state,
    directiveState: d.state,
    placement,
    status,
    chainId: current ? d.chainId : (latest?.chainId ?? section.openedOnChainId),
    attemptIds,
    failure: state === 'failed' ? (latest?.failure ?? null) : null,
    superseded,
    replacesSectionId: section.replacesSectionId,
    notes,
    asksElicitationId: d.asksElicitationId,
    operationId: section.operationId,
    actions: {
      reply: section.supersession === null && (d.kind === 'answer' || elicitation?.status === 'open' || elicitation === undefined),
      stop: current && isStartedUnsettled(d.state),
      retry: current && unfinishedOutcome(d.state) !== null,
      regenerate: current && d.state === 'completed' && (section.supersededInputs?.inputs.length ?? 0) > 0,
    },
  }
  void m
}

/**
 * "Redid {label} by default" (Q45, Q95): added when `elicitation-defaulted`
 * arrives, to the replacement of every section superseded with cause `redo`
 * for it, and to the current section of every directive that was held for it.
 */
function redoneByDefault(s: ConversationState, section: SectionRow): import('@committee/protocol').ElicitationId | null {
  const replaced = section.replacesSectionId ? s.sections[section.replacesSectionId] : undefined
  const cause = replaced?.supersession?.cause
  if (cause?.kind === 'redo' && s.elicitations[cause.elicitationId]?.status === 'defaulted') return cause.elicitationId
  for (const id of s.elicitationOrder) {
    const elicitation = s.elicitations[id]
    if (!elicitation || elicitation.status !== 'defaulted' || elicitation.record.kind !== 'choice-with-default') continue
    const held = elicitation.record.options.some((o) => o.directiveId === section.directiveId && o.state === 'queued')
    const d = s.directives[section.directiveId]
    if (held && d?.sectionId === section.id && section.replacesSectionId === null) return id
  }
  return null
}

// ───────────────────────────── attempts ─────────────────────────────

function attemptsMap(s: ConversationState, m: Memo): TranscriptProjection['attempts'] {
  const out: { [id: string]: AttemptView } = {}
  for (const sectionId of shownSectionIds(s)) {
    const section = s.sections[sectionId]
    if (!section) continue
    for (const id of shownAttemptIds(s, section)) out[id] = m.get('transcript.attempt', id, (st) => attemptView(st, id))
  }
  return out
}

export function attemptResultStatus(s: ConversationState, attemptId: AttemptId): AttemptResultStatus {
  const attempt = s.attempts[attemptId]
  if (!attempt) return 'superseded'
  switch (attempt.state) {
    case 'running':
    case 'streaming':
      return 'in-flight'
    case 'completed': {
      const d = s.directives[attempt.directiveId]
      return d && d.state === 'completed' && d.resultAttemptId === attemptId ? 'current' : 'superseded'
    }
    case 'failed':
    case 'stopped':
    case 'interrupted':
      return attempt.state
    case 'superseded':
      return 'superseded'
  }
}

function attemptView(s: ConversationState, id: AttemptId): AttemptView {
  const attempt = s.attempts[id]
  if (!attempt) throw new Error(`No attempt ${id}`)
  const section = s.sections[attempt.sectionId]
  const d = s.directives[attempt.directiveId]
  const text = s.attemptText[id] ?? ''
  const hasText = text !== ''
  let markText: string | null = null
  switch (attempt.state) {
    case 'failed':
      markText = WORDING.failed
      break
    case 'stopped':
      markText = hasText ? WORDING.stoppedPartial : WORDING.stopped
      break
    case 'interrupted':
      markText = WORDING.interrupted
      break
    case 'superseded':
      markText = WORDING.supersededPartial
      break
    default:
      markText = null
  }
  const isLatest = section ? section.attemptIds[section.attemptIds.length - 1] === id : true
  const retryComing =
    d !== undefined &&
    section !== undefined &&
    d.sectionId === section.id &&
    ['retrying', 'waiting-for-capacity', 'ready', 'dependency-queued'].includes(d.state)
  const ended = ['failed', 'stopped', 'interrupted'].includes(attempt.state)
  const supersededPartial = section?.supersession !== null && section?.supersession !== undefined && !section.supersession.wasFinished && hasText
  const collapsed = supersededPartial || (ended && hasText && (!isLatest || retryComing))
  return {
    id,
    sectionId: attempt.sectionId,
    directiveId: attempt.directiveId,
    number: attempt.number,
    origin: attempt.origin,
    state: attempt.state,
    resultStatus: attemptResultStatus(s, id),
    text,
    markText,
    collapsed,
    chainId: attempt.chainId,
    nodeId: attempt.nodeId,
    model: attempt.model,
    startedAt: attempt.startedAt,
    endedAt: attempt.endedAt,
    failure: attempt.failure,
  }
}

// ───────────────────────────── chains and Focus ─────────────────────────────

function chainsMap(s: ConversationState, m: Memo): TranscriptProjection['chains'] {
  const out: { [id: string]: ChainAssociation } = {}
  for (const id of s.chainOrder) out[id] = m.get('transcript.chain', id, (st) => chainAssociation(st, id))
  return out
}

/**
 * Inheritance-aware Focus (09 §2): `own` is what the chain handled;
 * `inherited` is every message and section in the exact ancestry its runs
 * consumed, read from the attempts' consumed-context records. Work added to
 * a source chain later is in neither list.
 */
function chainAssociation(s: ConversationState, chainId: ChainId): ChainAssociation {
  const chain = s.chains[chainId]
  if (!chain) throw new Error(`No chain ${chainId}`)
  const ownMessages: MessageId[] = []
  const ownSections: SectionId[] = []
  const inheritedMessages: MessageId[] = []
  const inheritedSections: SectionId[] = []
  const add = <T>(list: T[], item: T): void => {
    if (!list.includes(item)) list.push(item)
  }
  for (const id of s.directiveOrder) {
    const d = s.directives[id]
    if (!d || d.state === 'superseded') continue
    if (d.chainId === chainId && d.sectionId) {
      add(ownMessages, d.messageId)
      const section = s.sections[d.sectionId]
      if (section && !sectionDropped(section)) add(ownSections, d.sectionId)
    }
    for (const attemptId of d.attemptIds) {
      const attempt = s.attempts[attemptId]
      if (!attempt || attempt.chainId !== chainId) continue
      for (const input of attempt.context.inputs) {
        const source = s.directives[input.directiveId]
        if (!source) continue
        add(inheritedMessages, source.messageId)
        // Only an answer that was read, or the marker of work that ended unfinished, is credited (C3):
        // a run that read only the request of work still in flight never consumed its answer.
        const read = input.attemptId ? s.attempts[input.attemptId]?.sectionId : input.marker !== null ? source.sectionId : null
        if (read) add(inheritedSections, read)
      }
    }
  }
  return {
    id: chainId,
    kind: chain.kind,
    colorIndex: chain.colorIndex,
    label: chain.label,
    focus: {
      own: { messageIds: ownMessages, sectionIds: ownSections },
      inherited: {
        messageIds: inheritedMessages.filter((id) => !ownMessages.includes(id) && messageVisible(s, id)),
        sectionIds: inheritedSections.filter((id) => !ownSections.includes(id) && s.sections[id] !== undefined),
      },
    },
  }
}

export { shareRecord }

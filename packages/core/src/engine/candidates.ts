import type { DirectiveId, NodeId, SectionId, TargetRedirect } from '@committee/protocol'
import type { CandidateChain, CandidateGroup, CandidateSection, CandidateWork, RoutingCandidates } from '../ports'
import {
  activeMembers,
  chainBusy,
  chainLabel,
  chainHead,
  chainTip,
  groupLabel,
  groupOfDirective,
  nodeParents,
  sectionDropped,
  sectionState,
  sectionTitle,
} from './queries'
import type { ConversationState } from './state'

/**
 * What a message could refer to, build on, wait for or revise (PLAN §7,
 * invariant 9): every current section, every chain with its settled head and
 * its tip, every directive not superseded or cancelled, every sibling group
 * that is not dissolved.
 */
export function routingCandidates(state: ConversationState): RoutingCandidates {
  const sections: CandidateSection[] = []
  for (const id of state.directiveOrder) {
    const d = state.directives[id]
    if (!d || d.sectionId === null || d.state === 'superseded') continue
    const section = state.sections[d.sectionId]
    if (!section || section.supersession || sectionDropped(section)) continue
    const latest = section.attemptIds[section.attemptIds.length - 1]
    const elicitation = d.asksElicitationId ? state.elicitations[d.asksElicitationId] : undefined
    sections.push({
      sectionId: section.id,
      directiveId: d.id,
      messageId: d.messageId,
      // The name every projection shows: the directive's current label (`sectionTitle`), not the title stored when the section opened.
      title: sectionTitle(state, section),
      request: d.instruction,
      excerpt: latest ? (state.attemptText[latest] ?? '').slice(0, 280) : '',
      answerLength: latest ? (state.attemptText[latest] ?? '').length : 0,
      state: sectionState(state, section.id),
      chainId: d.chainId,
      nodeId: d.nodeId,
      asksElicitationId: elicitation?.status === 'open' ? d.asksElicitationId : null,
    })
  }

  const chains: CandidateChain[] = []
  for (const id of state.chainOrder) {
    const chain = state.chains[id]
    const tip = chainTip(state, id)
    if (!chain || tip === null) continue
    chains.push({ chainId: id, kind: chain.kind, label: chainLabel(state, chain), headNodeId: chainHead(state, id), tipNodeId: tip, busy: chainBusy(state, id) })
  }

  const work: CandidateWork[] = []
  for (const id of state.directiveOrder) {
    const d = state.directives[id]
    if (!d || d.state === 'superseded' || d.state === 'cancelled' || d.kind !== 'answer') continue
    const node = state.nodes[d.nodeId]
    const latest = d.attemptIds[d.attemptIds.length - 1]
    const attempt = latest ? state.attempts[latest] : undefined
    const startNodeId: NodeId | null = node ? (nodeParents(state, node)[0] ?? null) : null
    work.push({
      directiveId: d.id,
      label: d.label,
      instruction: d.instruction,
      state: d.state,
      sectionId: d.sectionId,
      nodeId: d.nodeId,
      chainId: d.chainId,
      startNodeId,
      groupId: groupOfDirective(state, d.id)?.id ?? null,
      consumed: attempt ? attempt.context.inputs.map((i) => i.directiveId) : [],
      consumedRequirements: attempt ? attempt.context.sessionRequirementIds : [],
    })
  }

  const groups: CandidateGroup[] = []
  for (const group of Object.values(state.groups)) {
    if (group.state === 'dissolved') continue
    const joinBackId = group.joinBackIds[group.joinBackIds.length - 1]
    groups.push({
      groupId: group.id,
      open: group.state === 'open',
      baseChainId: group.baseChainId,
      startNodeId: group.startNodeId,
      memberDirectiveIds: activeMembers(group).map((m) => m.directiveId),
      joinBackNodeId: group.state === 'closed' && joinBackId ? (state.joinBacks[joinBackId]?.nodeId ?? null) : null,
      label: groupLabel(state, group),
    })
  }
  return { sections, chains, work, groups }
}

/**
 * Resolves explicit reply targets: a target on a superseded section points
 * at its current replacement, and the redirect is listed (Q43, T3). A
 * section superseded without a replacement (Undo split) has no current
 * version and is dropped.
 */
export function resolveTargets(
  state: ConversationState,
  targets: readonly SectionId[],
): { readonly sectionIds: SectionId[]; readonly redirects: TargetRedirect[] } {
  const sectionIds: SectionId[] = []
  const redirects: TargetRedirect[] = []
  for (const target of targets) {
    let current: SectionId | null = target
    const seen = new Set<SectionId>()
    while (current !== null && !seen.has(current)) {
      seen.add(current)
      const section: ConversationState['sections'][string] | undefined = state.sections[current]
      if (!section?.supersession) break
      current = section.supersession.replacementSectionId
    }
    if (current === null) continue
    if (current !== target) redirects.push({ from: target, to: current })
    if (!sectionIds.includes(current)) sectionIds.push(current)
  }
  return { sectionIds, redirects }
}

/** Directives a candidate list names, for tests. */
export function candidateDirectiveIds(candidates: RoutingCandidates): DirectiveId[] {
  return candidates.work.map((w) => w.directiveId)
}

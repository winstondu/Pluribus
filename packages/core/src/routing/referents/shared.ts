import type { NoulQuestion, ReferentRequest, ReferentUnit, ScoredSection, UnitReferents } from '../../ports'
import type { SectionId } from '@committee/protocol'
import { ancestorsOf, sectionsBelow, type GroupNode, type ReferentTree, type SectionNode, type TreeNode } from './tree'

/**
 * What both strategies share: the wording of the questions, their IDs, and
 * how scores become a unit's referents. Section numbers are the same in
 * every state text of one routing, so an ID names the same thing wherever
 * it is asked: `m_s3` (does the message refer to S3), `m_j1` (does it build
 * on the members of group 1 together), `m_u3` (does it refer to anything
 * built on S3), `m_several`.
 */
export const questionId = {
  own: (unit: ReferentUnit, node: SectionNode): string => `${unit.key}_s${node.n}`,
  group: (unit: ReferentUnit, node: GroupNode): string => `${unit.key}_j${node.index}`,
  under: (unit: ReferentUnit, node: TreeNode): string => `${unit.key}_u${node.kind === 'section' ? node.n : `j${node.index}`}`,
  several: (unit: ReferentUnit): string => `${unit.key}_several`,
  of: (unit: ReferentUnit, node: TreeNode): string => (node.kind === 'section' ? questionId.own(unit, node) : questionId.group(unit, node)),
}

const noul = (instructions: string): NoulQuestion => ({ type: 'noul', instructions })

export function severalQuestion(unit: ReferentUnit): NoulQuestion {
  return noul(`Does ${unit.name} plainly refer to more than one of the answer sections at once (for example "both", "compare", or two answers named)?`)
}

export function ownQuestion(unit: ReferentUnit, node: SectionNode): NoulQuestion {
  return noul(`Does ${unit.name} refer to answer section S${node.n} ("${node.entry.section.title}"): reply to it, build on it, compare or combine it with another answer, or correct it?`)
}

function list(items: readonly string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`
}

/**
 * The join-back as a candidate (04 · "Join-back"): asked about the group as
 * a whole, because the second of two siblings a message needs is scored
 * low when each is asked about alone.
 */
export function groupQuestion(unit: ReferentUnit, node: GroupNode): NoulQuestion {
  const members = list(node.members.map((m) => `S${m.n}`))
  return noul(
    `Does ${unit.name} build on ${members} together, the answers that were requested in parallel, rather than on one of them alone or on none of them?`,
  )
}

/** The most answers named in one "anything built on it" question. */
export const MAX_NAMED_BELOW = 12

/** Whether anything below a branch point is worth asking about: what decides a descent. */
export function underQuestion(unit: ReferentUnit, node: TreeNode): NoulQuestion {
  const below = sectionsBelow(node)
  const named = below.slice(0, MAX_NAMED_BELOW).map((s) => `S${s.n} ("${s.entry.section.title}")`)
  const more = below.length > named.length ? `, and ${below.length - named.length} more that build on these` : ''
  const subject = node.kind === 'section' ? `S${node.n}` : `${list(node.members.map((m) => `S${m.n}`))} together`
  return noul(`Does ${unit.name} refer to, or need, any of the answers built on ${subject}: ${named.join(', ')}${more}?`)
}

/**
 * From scores to referents (the last steps of the walk, applied to any
 * strategy's scores):
 *
 * 1. The relevant set: every node scored at or above `clear`.
 * 2. A node that is an ancestor of a relevant node is dropped, whatever its
 *    own score: a relevant child is better than its parent, whose content
 *    the child's context already holds. Not for a correction, which may
 *    name the brief that its descendants only consumed (06).
 * 3. A relevant group node that survives gives each of its members its
 *    score: the group's full join-back, never a subset (Q30, C9).
 *
 * Sections below `clear` that were not dropped are reported with their own
 * score: the pipeline asks the user about them or takes them as further
 * referents by its own rules.
 */
export function referentsFromScores(
  tree: ReferentTree,
  score: (node: TreeNode) => number | null,
  options: { readonly corrective: boolean; readonly clear: number },
): ScoredSection[] {
  const scored = tree.nodes.flatMap((node) => {
    const value = score(node)
    return value === null ? [] : [{ node, value }]
  })
  const dropped = new Set<TreeNode>()
  if (!options.corrective) {
    for (const { node, value } of scored) {
      if (value >= options.clear) for (const ancestor of ancestorsOf(node)) dropped.add(ancestor)
    }
  }
  const out = new Map<SectionId, number>()
  const note = (node: SectionNode, value: number): void => {
    const id = node.entry.section.sectionId
    out.set(id, Math.max(out.get(id) ?? 0, value))
  }
  for (const { node, value } of scored) {
    if (dropped.has(node)) continue
    if (node.kind === 'section') note(node, value)
    else if (value >= options.clear) for (const member of node.members) note(member, value)
  }
  return [...out].map(([sectionId, confidence]) => ({ sectionId, confidence }))
}

/** Reads every unit's referents from answers by question ID. */
export function readReferents(
  request: ReferentRequest,
  tree: ReferentTree,
  probability: (id: string) => number | null,
  corrective: ReadonlySet<string>,
): { [key: string]: UnitReferents } {
  const units: { [key: string]: UnitReferents } = {}
  for (const unit of request.units) {
    units[unit.key] = {
      sections: referentsFromScores(tree, (node) => probability(questionId.of(unit, node)), {
        corrective: corrective.has(unit.key),
        clear: request.relevance.clear,
      }),
      several: probability(questionId.several(unit)),
    }
  }
  return units
}

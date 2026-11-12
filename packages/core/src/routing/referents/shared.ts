import type { BestNodeFound, NoulQuestion, ReferentRequest, ReferentUnit, ScoredSection, UnitReferents } from '../../ports'
import type { SectionId } from '@committee/protocol'
import { ancestorsOf, rank, sectionsBelow, type GroupNode, type ReferentTree, type SectionNode, type TreeNode } from './tree'

/**
 * What both strategies share: the wording of the questions, their IDs, and
 * how scores become a unit's referents. Section numbers are the same in
 * every state text of one routing, so an ID names the same thing wherever
 * it is asked: `m_s3` (does the message refer to S3), `m_j1` (does it build
 * on the members of group 1 together), `m_u3` (does it refer to anything
 * built on S3), `m_c25_36` (does it refer to one of S25 to S36 of a run that
 * is being searched), `m_several`.
 */
export const questionId = {
  own: (unit: ReferentUnit, node: SectionNode): string => `${unit.key}_s${node.n}`,
  group: (unit: ReferentUnit, node: GroupNode): string => `${unit.key}_j${node.index}`,
  under: (unit: ReferentUnit, node: TreeNode): string => `${unit.key}_u${node.kind === 'section' ? node.n : `j${node.index}`}`,
  several: (unit: ReferentUnit): string => `${unit.key}_several`,
  /** A chunk of a searched run, by its first and last section. Chunks of one routing never share both. */
  chunk: (unit: ReferentUnit, nodes: readonly SectionNode[]): string => `${unit.key}_c${nodes[0]?.n ?? 0}_${nodes[nodes.length - 1]?.n ?? 0}`,
  /** The most recent answer, asked about beside chunk questions for comparison. Its answer is not read. */
  recent: (unit: ReferentUnit): string => `${unit.key}_recent`,
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

/** The longest request quoted for a section in a chunk question. */
export const CHUNK_DIGEST = 80

/**
 * Several sections of a run in one question, each named by the request it
 * answered: what a search asks before it asks about sections one by one.
 * Measured live (docs/build/dependency-decisioning.md · "Long runs"): the
 * request finds a single old section among 200; the title alone does not
 * always (0.31 for the itinerary, whose title is cut before the word).
 */
export function chunkQuestion(unit: ReferentUnit, nodes: readonly SectionNode[]): NoulQuestion {
  const named = nodes.map((node) => {
    const request = node.entry.section.request.replace(/\s+/g, ' ').trim()
    return `S${node.n} ("${request.length > CHUNK_DIGEST ? `${request.slice(0, CHUNK_DIGEST)}…` : request}")`
  })
  return noul(
    `Does ${unit.name} refer to one of these earlier answer sections, each named by the request it answered: ${named.join(', ')}: reply to it, build on it, compare or combine it with another answer, or correct it?`,
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
 * referents by its own rules. When the decision budget stopped the
 * strategy the user is not asked: see `bestNodeFound`.
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

/**
 * The best node found so far: what routing uses, without asking the user,
 * when the decision budget stopped a strategy before it finished (11 ·
 * "Decision budget").
 *
 * Only nodes that were asked about by themselves have a score here: a
 * section through its own question, a sibling group through the question
 * about the group as a whole. A yes to a question about several sections (a
 * chunk, "anything built on this") gives none of them a score. Of the nodes
 * scored at or above `floor`, the plausibility threshold the walk descends
 * on:
 *
 * 1. a node with a plausible descendant is passed over for the descendant,
 *    whose context already holds it (not for a correction, as in
 *    `referentsFromScores`);
 * 2. of the rest, the highest score;
 * 3. on equal scores, the most recent in conversation order (a group counts
 *    as just after its last member).
 *
 * A group resolves to every member: the full join-back, never a subset.
 * Null when nothing asked about by itself is plausible: the unit is then
 * routed as referring to nothing there.
 */
export function bestNodeFound(
  tree: ReferentTree,
  score: (node: TreeNode) => number | null,
  options: { readonly corrective: boolean; readonly floor: number },
): BestNodeFound | null {
  const plausible = tree.nodes.flatMap((node) => {
    const value = score(node)
    return value !== null && value >= options.floor ? [{ node, value }] : []
  })
  // Every ancestor of a plausible node, each visited once: a long chain of plausible answers is not walked once per answer.
  const above = new Set<TreeNode>()
  if (!options.corrective) {
    for (const { node } of plausible) {
      const stack: TreeNode[] = [node]
      for (let at = stack.pop(); at; at = stack.pop()) {
        const up: TreeNode[] = at.kind === 'group' ? [...at.members] : []
        if (at.parent) up.push(at.parent)
        for (const p of up) {
          if (above.has(p)) continue
          above.add(p)
          stack.push(p)
        }
      }
    }
  }
  let best: { readonly node: TreeNode; readonly value: number } | null = null
  for (const candidate of plausible) {
    if (above.has(candidate.node)) continue
    if (!best || candidate.value > best.value || (candidate.value === best.value && rank(candidate.node) > rank(best.node))) best = candidate
  }
  if (!best) return null
  const members = best.node.kind === 'section' ? [best.node] : best.node.members
  return { sectionIds: members.map((m) => m.entry.section.sectionId), confidence: best.value }
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

import type { SectionId } from '@pluribus/protocol'
import type { ReferentQuestions, ReferentRequest, RoutingCandidates } from '../../ports'
import { groupQuestion, ownQuestion, questionId } from './shared'
import { buildTree, type ReferentTree, type TreeNode } from './tree'

/**
 * The first pass of every routing (11 · "Referent strategies"): how many of
 * the most recent answer sections are asked about by themselves in the
 * routing request, whichever strategy runs.
 */
export const FIRST_PASS_SECTIONS = 5

const cache = new WeakMap<RoutingCandidates, readonly SectionId[]>()

/**
 * The first-pass sections of a conversation, oldest first: walking back
 * from the most recent answer section, each section that is not an ancestor
 * of one already taken, until there are `FIRST_PASS_SECTIONS`. In a
 * conversation that only ever continued one chain that is the latest
 * answer alone: every earlier one is in its context. Open clarification
 * questions are not answer sections. Read from the candidates only, so it
 * is the same however many sections the routing request lists.
 */
export function firstPassSectionIds(candidates: RoutingCandidates): readonly SectionId[] {
  const known = cache.get(candidates)
  if (known) return known
  const answers = candidates.sections.filter((s) => !s.asksElicitationId)
  const tree = buildTree({ sections: answers.map((section, i) => ({ n: i + 1, section, listed: true })), candidates })
  const above = new Set<TreeNode>()
  const taken: SectionId[] = []
  for (let i = answers.length - 1; i >= 0 && taken.length < FIRST_PASS_SECTIONS; i--) {
    const section = answers[i]
    const node = section ? tree.bySection.get(section.sectionId) : undefined
    if (!section || !node || above.has(node)) continue
    taken.push(section.sectionId)
    // Every ancestor of a taken section, each visited once however long the line.
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
  const out = taken.reverse()
  cache.set(candidates, out)
  return out
}

/**
 * The first-pass questions, which the pipeline adds to its own request for
 * every strategy: each first-pass section by itself, and each sibling group
 * one of them belongs to as a whole, when the request lists every member.
 * They carry the IDs both strategies use, so a strategy that asks the same
 * question adds nothing, and one that would not have asked reads the
 * answer like any other score.
 */
export function firstPassQuestions(request: ReferentRequest, tree: ReferentTree = buildTree(request)): ReferentQuestions {
  const out: { [id: string]: ReferentQuestions[string] } = {}
  const first = new Set(firstPassSectionIds(request.candidates))
  const nodes = tree.nodes.filter((node) =>
    node.kind === 'section'
      ? node.entry.listed && first.has(node.entry.section.sectionId)
      : node.members.every((m) => m.entry.listed) && node.members.some((m) => first.has(m.entry.section.sectionId)),
  )
  for (const unit of request.units) {
    for (const node of nodes) out[questionId.of(unit, node)] = node.kind === 'section' ? ownQuestion(unit, node) : groupQuestion(unit, node)
  }
  return out
}

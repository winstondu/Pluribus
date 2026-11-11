import type { ReferentQuestions, ReferentRequest, ReferentStrategy } from '../../ports'
import { groupQuestion, ownQuestion, questionId, readReferents, severalQuestion } from './shared'
import { buildTree, type ReferentTree } from './tree'

/**
 * One pass: every candidate is asked about in the request the pipeline
 * sends anyway. One yes/no per listed answer section, one per sibling group
 * as a whole (its join-back), and whether the unit refers to several
 * sections at once. No further request, so nothing for the budget to stop:
 * its size is bounded by the pipeline's window of sections.
 */
export const onePassStrategy: ReferentStrategy = {
  name: 'one-pass',
  questions: (request) => onePassQuestions(request, buildTree(request)),
  async resolve(request, gate) {
    return { ok: true, units: readReferents(request, buildTree(request), (id) => gate.probability(id), gate.corrective), fallback: null }
  },
}

export function onePassQuestions(request: ReferentRequest, tree: ReferentTree): ReferentQuestions {
  const out: { [id: string]: ReferentQuestions[string] } = {}
  const listed = tree.nodes.filter((n) => (n.kind === 'section' ? n.entry.listed : n.members.every((m) => m.entry.listed)))
  for (const unit of request.units) {
    if (listed.filter((n) => n.kind === 'section').length >= 2) out[questionId.several(unit)] = severalQuestion(unit)
    for (const node of listed) out[questionId.of(unit, node)] = node.kind === 'section' ? ownQuestion(unit, node) : groupQuestion(unit, node)
  }
  return out
}

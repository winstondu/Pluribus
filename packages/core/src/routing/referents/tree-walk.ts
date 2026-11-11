import type { DecisionBudget } from '@committee/protocol'
import type { ReferentAsk, ReferentQuestions, ReferentRequest, ReferentResult, ReferentStrategy, ReferentUnit } from '../../ports'
import { sectionLine } from '../supply'
import { onePassQuestions } from './one-pass'
import { groupQuestion, ownQuestion, questionId, readReferents, severalQuestion, underQuestion } from './shared'
import { buildTree, segmentFrom, type ReferentTree, type TreeNode } from './tree'

/**
 * Tree walk: breadth-first from every root of the context tree, pruned
 * where a line of work is not relevant.
 *
 * - A level is a set of segments: a node and the run of only children below
 *   it, down to the next branch point. Every node of a level is asked about
 *   in one request (questions are a record keyed by ID), together with the
 *   group node wherever a node has parallel children, and, for each branch
 *   point, whether anything built on it is relevant.
 * - The roots' level rides in the request the pipeline sends anyway. Each
 *   further level is one further request, whose state text lists only that
 *   level's answers: the conversation is never sent again.
 * - A segment is descended into when any of its nodes, or what is built on
 *   it, scores at or above the floor. Everything below an irrelevant
 *   segment is never asked about.
 * - The relevant nodes are collected, ancestors of a relevant node are
 *   dropped, and a relevant group stands for all of its members
 *   (`referentsFromScores`).
 *
 * Before every further request the walk checks the budget, keeping room for
 * its fallback. When a level does not fit it stops walking and asks the
 * one-pass questions it has not asked yet in one request; when not even
 * that fits, the referents are the relevant nodes reached so far.
 */
export const treeWalkStrategy: ReferentStrategy = {
  name: 'tree-walk',

  questions(request) {
    const tree = buildTree(request)
    const out: { [id: string]: ReferentQuestions[string] } = {}
    const listedSections = tree.nodes.filter((n) => n.kind === 'section' && n.entry.listed).length
    const level = tree.roots.map(segmentFrom)
    for (const unit of request.units) {
      if (listedSections >= 2) out[questionId.several(unit)] = severalQuestion(unit)
      for (const q of levelQuestions(unit, level, listed)) out[q.id] = q.question
    }
    return out
  },

  async resolve(request, gate, ask): Promise<ReferentResult> {
    const tree = buildTree(request)
    const answers = new Map<string, number>()
    const probability = (id: string): number | null => answers.get(id) ?? gate.probability(id)
    const done = (fallback: Extract<ReferentResult, { ok: true }>['fallback']): ReferentResult => ({
      ok: true,
      units: readReferents(request, tree, probability, gate.corrective),
      fallback,
    })

    let levels = new Map<ReferentUnit, TreeNode[][]>(request.units.map((unit) => [unit, tree.roots.map(segmentFrom)]))
    for (;;) {
      // What this level still has to ask: at the roots, only what the pipeline's request could not carry.
      const questions: { [id: string]: ReferentQuestions[string] } = {}
      const shown = new Set<TreeNode>()
      for (const [unit, level] of levels) {
        for (const q of levelQuestions(unit, level, () => true)) {
          if (probability(q.id) !== null) continue
          questions[q.id] = q.question
          shown.add(q.node)
        }
      }
      if (Object.keys(questions).length > 0) {
        const stateText = levelState(shown, request.subject)
        const reserve = fallbackCost(request, tree, probability, ask)
        const limit = exceeded(ask.remaining(), { requests: 1, questions: Object.keys(questions).length, inputTokens: ask.estimate(stateText, questions) }, reserve)
        if (limit) return fallBack(request, tree, answers, gate, ask, limit, done)
        const result = await ask(stateText, questions)
        if (result.kind === 'failed') return { ok: false, error: result.error }
        if (result.kind === 'refused') return fallBack(request, tree, answers, gate, ask, result.limit, done)
        for (const id of Object.keys(questions)) {
          const p = result.probability(id)
          if (p !== null) answers.set(id, p)
        }
      }

      const next = new Map<ReferentUnit, TreeNode[][]>()
      for (const [unit, level] of levels) {
        const below: TreeNode[][] = []
        for (const segment of level) {
          const end = segment[segment.length - 1]
          if (!end || end.children.length === 0) continue
          const scores = [...segment.map((node) => probability(questionId.of(unit, node))), probability(questionId.under(unit, end))]
          if (!scores.some((p) => p !== null && p >= request.relevance.floor)) continue
          for (const child of end.children) below.push(segmentFrom(child))
        }
        if (below.length > 0) next.set(unit, below)
      }
      if (next.size === 0) return done(null)
      levels = next
    }
  },
}

/** Whether the pipeline's own state text shows everything a question about this node names. */
function listed(node: TreeNode): boolean {
  return node.kind === 'section' ? node.entry.listed : node.members.every((m) => m.entry.listed)
}

interface LevelQuestion {
  readonly id: string
  readonly question: ReferentQuestions[string]
  /** The node the question is about: a state text must list it. */
  readonly node: TreeNode
}

/** The questions of one level for one unit, over the nodes `include` admits. */
function levelQuestions(unit: ReferentUnit, level: readonly TreeNode[][], include: (node: TreeNode) => boolean): LevelQuestion[] {
  const out: LevelQuestion[] = []
  for (const segment of level) {
    for (const node of segment) {
      if (!include(node)) continue
      out.push({ id: questionId.of(unit, node), question: node.kind === 'section' ? ownQuestion(unit, node) : groupQuestion(unit, node), node })
    }
    const end = segment[segment.length - 1]
    if (end && end.children.length > 0 && include(end)) out.push({ id: questionId.under(unit, end), question: underQuestion(unit, end), node: end })
  }
  return out
}

/** The state text of a further request: only the answers its questions name, then the subject. */
function levelState(shown: ReadonlySet<TreeNode>, subject: string): string {
  const sections = new Map<number, string>()
  for (const node of shown) {
    for (const s of node.kind === 'section' ? [node] : node.members) sections.set(s.n, sectionLine(s.entry.section, s.n))
  }
  const lines = [...sections].sort((a, b) => a[0] - b[0]).map(([, line]) => line)
  // What the pipeline's state text says under "Lines of work": which of these were requested side by side.
  const parallel = [...shown].flatMap((node) =>
    node.kind === 'group'
      ? [`${node.members.map((m) => `S${m.n}`).join(', ')} were requested in parallel from the same starting point${node.group.open ? ' and are still being answered' : ''}.`]
      : [],
  )
  return ['Answer sections of this conversation that the questions are about, oldest first:', ...lines, ...(parallel.length > 0 ? ['', ...parallel] : []), '', subject].join('\n')
}

interface Cost {
  readonly requests: number
  readonly questions: number
  readonly inputTokens: number
}

function fallbackQuestions(request: ReferentRequest, tree: ReferentTree, probability: (id: string) => number | null): ReferentQuestions {
  const out: { [id: string]: ReferentQuestions[string] } = {}
  for (const [id, question] of Object.entries(onePassQuestions(request, tree))) if (probability(id) === null) out[id] = question
  return out
}

function fallbackCost(request: ReferentRequest, tree: ReferentTree, probability: (id: string) => number | null, ask: ReferentAsk): Cost {
  const questions = fallbackQuestions(request, tree, probability)
  const count = Object.keys(questions).length
  return count === 0 ? { requests: 0, questions: 0, inputTokens: 0 } : { requests: 1, questions: count, inputTokens: ask.estimate(request.stateText, questions) }
}

/** The first limit that `cost`, with `reserve` kept back, would exceed. */
function exceeded(remaining: DecisionBudget, cost: Cost, reserve: Cost): keyof DecisionBudget | null {
  if (remaining.requests < cost.requests + reserve.requests) return 'requests'
  if (remaining.questions < cost.questions + reserve.questions) return 'questions'
  if (remaining.inputTokens < cost.inputTokens + reserve.inputTokens) return 'inputTokens'
  return null
}

async function fallBack(
  request: ReferentRequest,
  tree: ReferentTree,
  answers: Map<string, number>,
  gate: { probability(id: string): number | null },
  ask: ReferentAsk,
  limit: keyof DecisionBudget,
  done: (fallback: Extract<ReferentResult, { ok: true }>['fallback']) => ReferentResult,
): Promise<ReferentResult> {
  const probability = (id: string): number | null => answers.get(id) ?? gate.probability(id)
  const questions = fallbackQuestions(request, tree, probability)
  const count = Object.keys(questions).length
  if (count === 0) return done({ limit, to: 'one-pass' })
  const cost: Cost = { requests: 1, questions: count, inputTokens: ask.estimate(request.stateText, questions) }
  if (exceeded(ask.remaining(), cost, { requests: 0, questions: 0, inputTokens: 0 })) return done({ limit, to: 'partial' })
  const result = await ask(request.stateText, questions)
  if (result.kind === 'failed') return { ok: false, error: result.error }
  if (result.kind === 'refused') return done({ limit, to: 'partial' })
  for (const id of Object.keys(questions)) {
    const p = result.probability(id)
    if (p !== null) answers.set(id, p)
  }
  return done({ limit, to: 'one-pass' })
}

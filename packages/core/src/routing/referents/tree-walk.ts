import type { DecisionBudget } from '@committee/protocol'
import type { ReferentAsk, ReferentQuestions, ReferentRequest, ReferentResult, ReferentStrategy, ReferentUnit, UnitReferents } from '../../ports'
import { sectionLine } from '../supply'
import { STATE_TOKENS_PER_CHARACTER, estimateDecisionTokens } from './ask'
import { onePassQuestions } from './one-pass'
import { chunkQuestion, groupQuestion, ownQuestion, questionId, referentsFromScores, severalQuestion, underQuestion } from './shared'
import { buildTree, segmentFrom, type ReferentTree, type SectionNode, type TreeNode } from './tree'

/**
 * Tree walk: breadth-first from every root of the context tree, pruned
 * where a line of work is not relevant.
 *
 * - A level is a set of segments: a node and the run of only children below
 *   it, down to the next branch point. The nodes of a level are asked about
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
 * Long runs (`settings.routing.treeWalk`). The sections of a run are either
 * asked about one by one, or **searched**: asked about in chunks, each one
 * question that names its sections by their requests, and one by one only
 * inside a chunk that scored at or above the floor. A chunk too large to
 * list within `searchRunsOverTokens` is split again, at most
 * `SEARCH_FANOUT` ways per request, so a run of any length is located in a
 * number of requests logarithmic in its length. Every relevant chunk is
 * followed; none relevant ends the search. A run is searched
 * - when listing the sections of it that the pipeline's request does not
 *   already list costs more than `searchRunsOverTokens`: always;
 * - above the trunk base with `startAtTrunkBase`: of a root's run only the
 *   base (the first branch point, or the tip) is asked about by itself;
 * - between branch points with `hopBetweenBranchPoints`: of a branch's run
 *   only its end is asked about by itself.
 * Roots older than the pipeline's window that nothing was built on are one
 * such run for this purpose: a long flat conversation of unrelated answers.
 * A section is never taken as a referent from a chunk score: it is asked
 * about by itself first, or, when the budget ends the search, reported
 * below the target-choice threshold so that the user is asked.
 *
 * Before every further request the walk checks the budget, keeping room for
 * its fallback. When a request does not fit it stops walking and asks the
 * one-pass questions it has not asked yet in one request. When that
 * fallback is what cannot be afforded, the walk goes on for as long as its
 * own requests fit; after that the referents are the relevant nodes reached.
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
      for (const q of levelQuestions(unit, planLevel(request, unit, level, true))) if (q.rides) out[q.id] = q.question
    }
    return out
  },

  async resolve(request, gate, ask): Promise<ReferentResult> {
    const tree = buildTree(request)
    const { floor, clear } = request.relevance
    const threshold = request.treeWalk.searchRunsOverTokens
    const answers = new Map<string, number>()
    const probability = (id: string): number | null => answers.get(id) ?? gate.probability(id)
    const recent = mostRecent(tree)
    /** Relevant chunks and what was planned for each: resolved once those questions are answered. */
    const followed = new Map<ReferentUnit, { readonly chunk: Chunk; readonly score: number; readonly step: Refinement }[]>(request.units.map((unit) => [unit, []]))

    const done = (fallback: Extract<ReferentResult, { ok: true }>['fallback']): ReferentResult => {
      const units: { [key: string]: UnitReferents } = {}
      for (const unit of request.units) {
        // A relevant chunk whose search did not finish: its sections stay candidates, below the threshold that would take one.
        const unresolved = new Map<TreeNode, number>()
        for (const { chunk, score, step } of followed.get(unit) ?? []) {
          if (step.kind === 'split' && step.chunks.every((c) => probability(questionId.chunk(unit, c.nodes)) !== null)) continue
          for (const node of chunk.nodes) {
            if (probability(questionId.own(unit, node)) === null) unresolved.set(node, Math.max(unresolved.get(node) ?? 0, Math.min(score, clear - UNRESOLVED_MARGIN)))
          }
        }
        units[unit.key] = {
          sections: referentsFromScores(tree, (node) => probability(questionId.of(unit, node)) ?? unresolved.get(node) ?? null, {
            corrective: gate.corrective.has(unit.key),
            clear,
          }),
          several: probability(questionId.several(unit)),
        }
      }
      return { ok: true, units, fallback }
    }

    let pending = new Map<ReferentUnit, Pending>(request.units.map((unit) => [unit, { level: tree.roots.map(segmentFrom), chunks: [], list: [], again: [] }]))
    for (let root = true; ; root = false) {
      // What this round still has to ask: at the roots, only what the pipeline's request could not carry.
      const questions: { [id: string]: ReferentQuestions[string] } = {}
      const shown = new Set<TreeNode>()
      const plans = new Map<ReferentUnit, LevelPlan>()
      for (const [unit, work] of pending) {
        const plan = planLevel(request, unit, work.level, root)
        plans.set(unit, plan)
        let chunked = false
        const add = (id: string, question: ReferentQuestions[string], nodes: readonly TreeNode[], chunk = false, again = false): void => {
          if (probability(id) !== null && !again) return
          questions[id] = question
          for (const node of nodes) shown.add(node)
          chunked ||= chunk
        }
        for (const q of levelQuestions(unit, plan)) add(q.id, q.question, q.shown, q.chunk)
        for (const chunk of work.chunks) add(questionId.chunk(unit, chunk.nodes), chunkQuestion(unit, chunk.nodes), [], true)
        for (const node of work.list) add(questionId.own(unit, node), ownQuestion(unit, node), [node])
        for (const node of work.again) add(questionId.own(unit, node), ownQuestion(unit, node), [node], false, true)
        // Beside the most recent answer a chunk is judged against an alternative: without it "Make that shorter" scores 0.4 on every chunk.
        if (chunked && recent && questions[questionId.own(unit, recent)] === undefined) {
          questions[questionId.recent(unit)] = ownQuestion(unit, recent)
          shown.add(recent)
        }
      }
      if (Object.keys(questions).length > 0) {
        const stateText = levelState(shown, request)
        const reserve = fallbackCost(request, tree, probability, ask)
        const cost: Cost = { requests: 1, questions: Object.keys(questions).length, inputTokens: ask.estimate(stateText, questions) }
        const limit = exceeded(ask.remaining(), cost, reserve)
        // Not room for this request and the fallback: fall back, unless the fallback is what does not fit and this request does.
        // Then walking on is all the budget still buys (a price guard on short answers leaves less than the fallback costs).
        if (limit && (!exceeded(ask.remaining(), reserve, NOTHING) || exceeded(ask.remaining(), cost, NOTHING))) {
          return fallBack(request, tree, answers, gate, ask, limit, done)
        }
        const result = await ask(stateText, questions)
        if (result.kind === 'failed') return { ok: false, error: result.error }
        if (result.kind === 'refused') return fallBack(request, tree, answers, gate, ask, result.limit, done)
        for (const id of Object.keys(questions)) {
          const p = result.probability(id)
          if (p !== null) answers.set(id, p)
        }
      }

      const next = new Map<ReferentUnit, Pending>()
      for (const [unit, work] of pending) {
        const plan = plans.get(unit)
        if (!plan) continue
        const level: TreeNode[][] = []
        for (const { segment, chunks } of plan.segments) {
          const end = segment[segment.length - 1]
          if (!end || end.children.length === 0) continue
          const scores = [
            ...segment.map((node) => probability(questionId.of(unit, node))),
            probability(questionId.under(unit, end)),
            ...chunks.map((chunk) => probability(questionId.chunk(unit, chunk.nodes))),
          ]
          if (!scores.some((p) => p !== null && p >= floor)) continue
          for (const child of end.children) level.push(segmentFrom(child))
        }
        // The search: every relevant chunk is followed, into smaller chunks or into its sections one by one.
        const chunks: Chunk[] = []
        const list: SectionNode[] = []
        const again = new Set<SectionNode>()
        for (const chunk of [...plan.segments.flatMap((s) => s.chunks), ...plan.pooled, ...work.chunks]) {
          const score = probability(questionId.chunk(unit, chunk.nodes))
          if (score === null || score < floor) continue
          const step = refine(unit, chunk, threshold)
          followed.get(unit)?.push({ chunk, score, step })
          if (step.kind === 'split') chunks.push(...step.chunks)
          else {
            list.push(...chunk.nodes)
            if (chunk.beside) again.add(chunk.beside)
          }
        }
        if (level.length > 0 || chunks.length > 0 || list.length > 0) next.set(unit, { level, chunks, list, again: [...again] })
      }
      if (next.size === 0) return done(null)
      pending = next
    }
  },
}

/** Fewer sections than this are not worth skipping: one question about one section is the question about that section. */
export const MIN_SKIPPED = 2
/** The most chunks one run is split into in one request. */
export const SEARCH_FANOUT = 24
/** How far below the target-choice threshold a section of an unfinished search is reported. */
const UNRESOLVED_MARGIN = 0.01

/** Sections of one run, in conversation order, asked about in one question. */
interface Chunk {
  readonly nodes: readonly SectionNode[]
  /**
   * The end of the run the sections were skipped for, which was asked about without them. It is asked about again
   * beside them when they are listed: alone, the end of a hop scored 0.7 and more for a reply to a section above it.
   */
  readonly beside: SectionNode | null
}

type Refinement = { readonly kind: 'list' } | { readonly kind: 'split'; readonly chunks: readonly Chunk[] }

/** What one unit asks next: a level of segments, chunks of runs being searched, and sections to ask about one by one. */
interface Pending {
  readonly level: readonly TreeNode[][]
  readonly chunks: readonly Chunk[]
  readonly list: readonly SectionNode[]
  /** Asked about again, beside the sections of `list`. */
  readonly again: readonly SectionNode[]
}

interface LevelPlan {
  /** Nodes asked about by themselves. */
  readonly plain: readonly TreeNode[]
  /** Every segment of the level, with the chunks its searched sections were put in: they count towards its descent. */
  readonly segments: readonly { readonly segment: readonly TreeNode[]; readonly chunks: readonly Chunk[] }[]
  /** Chunks of the old one-answer lines of the roots' level, which belong to no segment that could be descended into. */
  readonly pooled: readonly Chunk[]
}

/** Whether the pipeline's own state text shows everything a question about this node names. */
function listed(node: TreeNode): boolean {
  return node.kind === 'section' ? node.entry.listed : node.members.every((m) => m.entry.listed)
}

/** What listing one section adds to a request of the walk: the characters of its line, and the tokens of its question. */
function listPart(unit: ReferentUnit, node: SectionNode): { readonly line: number; readonly question: number } {
  const line = sectionLine(node.entry.section, node.n).length
  const question = estimateDecisionTokens('', { [questionId.own(unit, node)]: ownQuestion(unit, node) }) - estimateDecisionTokens('', {})
  return { line, question }
}

/** The tokens of a list whose lines hold `characters` in all, newlines between them included, and whose questions cost `questions`. */
const listTokens = (characters: number, questions: number): number => Math.ceil(characters * STATE_TOKENS_PER_CHARACTER) + questions

/** The estimated input tokens of asking about sections one by one in a request of the walk: a line and a question each. */
function listCost(unit: ReferentUnit, nodes: readonly SectionNode[]): number {
  let characters = Math.max(0, nodes.length - 1)
  let questions = 0
  for (const node of nodes) {
    const part = listPart(unit, node)
    characters += part.line
    questions += part.question
  }
  return listTokens(characters, questions)
}

/**
 * Chunks for a run: each as many sections as can be listed within the
 * threshold; when that is more than `SEARCH_FANOUT` chunks, they are
 * grouped into that many, and a relevant one is split again.
 */
function split(unit: ReferentUnit, nodes: readonly SectionNode[], threshold: number, beside: SectionNode | null): Chunk[] {
  const leaves: SectionNode[][] = []
  let current: SectionNode[] = []
  // The cost of the chunk so far, kept as it grows: a run of thousands of sections is sized once, not once per section.
  let characters = 0
  let questions = 0
  for (const node of nodes) {
    const part = listPart(unit, node)
    if (current.length > 0 && listTokens(characters + 1 + part.line, questions + part.question) > threshold) {
      leaves.push(current)
      current = []
      characters = 0
      questions = 0
    }
    characters += (current.length > 0 ? 1 : 0) + part.line
    questions += part.question
    current.push(node)
  }
  if (current.length > 0) leaves.push(current)
  if (leaves.length <= SEARCH_FANOUT) return leaves.map((chunk) => ({ nodes: chunk, beside }))
  const out: Chunk[] = []
  for (let i = 0; i < SEARCH_FANOUT; i++) {
    const from = Math.floor((i * leaves.length) / SEARCH_FANOUT)
    const to = Math.floor(((i + 1) * leaves.length) / SEARCH_FANOUT)
    out.push({ nodes: leaves.slice(from, to).flat(), beside })
  }
  return out
}

/** The next step into a relevant chunk: its sections one by one when that fits the threshold, smaller chunks otherwise. */
function refine(unit: ReferentUnit, chunk: Chunk, threshold: number): Refinement {
  if (chunk.nodes.length <= 1 || listCost(unit, chunk.nodes) <= threshold) return { kind: 'list' }
  const chunks = split(unit, chunk.nodes, threshold, chunk.beside)
  return chunks.length <= 1 ? { kind: 'list' } : { kind: 'split', chunks }
}

/** Which nodes of a level are asked about by themselves and which are searched. */
function planLevel(request: ReferentRequest, unit: ReferentUnit, level: readonly TreeNode[][], root: boolean): LevelPlan {
  const { startAtTrunkBase, hopBetweenBranchPoints, searchRunsOverTokens: threshold } = request.treeWalk
  const plain: TreeNode[] = []
  const segments: { segment: readonly TreeNode[]; chunks: Chunk[] }[] = []
  const pool: SectionNode[] = []
  const inOrder = (nodes: readonly SectionNode[]): SectionNode[] => [...nodes].sort((a, b) => a.n - b.n)
  for (const segment of level) {
    const end = segment[segment.length - 1]
    if (!end) continue
    const branches = end.children.length > 0
    const chunks: Chunk[] = []
    const search = (nodes: readonly SectionNode[]): void => {
      if (nodes.length > 0) chunks.push(...split(unit, inOrder(nodes), threshold, end.kind === 'section' && !nodes.includes(end) ? end : null))
    }
    // What may be skipped: the answers above the end. An end that is a leaf older than the pipeline's window has
    // nothing below it to decide, so it is searched with the rest.
    const skippable: SectionNode[] = []
    for (const node of segment) {
      if (node.kind === 'section' && (node !== end || (root && !branches && !node.entry.listed))) skippable.push(node)
      else plain.push(node)
    }
    if (root) {
      const inWindow = skippable.filter((node) => node.entry.listed)
      const older = skippable.filter((node) => !node.entry.listed)
      if (startAtTrunkBase && skippable.length >= MIN_SKIPPED) {
        // A chunk of listed sections rides in the pipeline's request; one with older sections is a further request.
        search(inWindow)
        search(older)
      } else {
        // Their lines are in the pipeline's request anyway: a question each costs less than a search would save.
        plain.push(...inWindow)
        if (!branches) pool.push(...older)
        else if (listCost(unit, older) > threshold) search(older)
        else plain.push(...older)
      }
    } else if ((hopBetweenBranchPoints && skippable.length >= MIN_SKIPPED) || listCost(unit, skippable) > threshold) search(skippable)
    else plain.push(...skippable)
    segments.push({ segment, chunks })
  }
  const pooled = listCost(unit, pool) > threshold ? split(unit, inOrder(pool), threshold, null) : []
  if (pooled.length === 0) plain.push(...pool)
  return { plain, segments, pooled }
}

interface LevelQuestion {
  readonly id: string
  readonly question: ReferentQuestions[string]
  /** The nodes a state text must list for the question. A chunk question names its sections itself. */
  readonly shown: readonly TreeNode[]
  /** Whether the pipeline's own request can carry it: everything it is about is listed there. */
  readonly rides: boolean
  readonly chunk: boolean
}

/** The questions of one level for one unit. */
function levelQuestions(unit: ReferentUnit, plan: LevelPlan): LevelQuestion[] {
  const out: LevelQuestion[] = []
  for (const node of plan.plain) {
    out.push({ id: questionId.of(unit, node), question: node.kind === 'section' ? ownQuestion(unit, node) : groupQuestion(unit, node), shown: [node], rides: listed(node), chunk: false })
  }
  for (const { segment } of plan.segments) {
    const end = segment[segment.length - 1]
    if (end && end.children.length > 0) out.push({ id: questionId.under(unit, end), question: underQuestion(unit, end), shown: [end], rides: listed(end), chunk: false })
  }
  for (const chunk of [...plan.segments.flatMap((s) => s.chunks), ...plan.pooled]) {
    out.push({ id: questionId.chunk(unit, chunk.nodes), question: chunkQuestion(unit, chunk.nodes), shown: [], rides: chunk.nodes.every(listed), chunk: true })
  }
  return out
}

/** The most recent answer section: the newest the pipeline lists. */
function mostRecent(tree: ReferentTree): SectionNode | null {
  let found: SectionNode | null = null
  for (const node of tree.nodes) {
    if (node.kind !== 'section') continue
    if (!found || (node.entry.listed && !found.entry.listed) || (node.entry.listed === found.entry.listed && node.n > found.n)) found = node
  }
  return found
}

/** The state text of a further request: only the answers its questions name, then the subject. */
function levelState(shown: ReadonlySet<TreeNode>, request: ReferentRequest): string {
  const sections = new Map<number, string>()
  for (const node of shown) {
    for (const s of node.kind === 'section' ? [node] : node.members) sections.set(s.n, sectionLine(s.entry.section, s.n, request.decisionContext(s.entry.section)))
  }
  const lines = [...sections].sort((a, b) => a[0] - b[0]).map(([, line]) => line)
  // What the pipeline's state text says under "Lines of work": which of these were requested side by side.
  const parallel = [...shown].flatMap((node) =>
    node.kind === 'group'
      ? [`${node.members.map((m) => `S${m.n}`).join(', ')} were requested in parallel from the same starting point${node.group.open ? ' and are still being answered' : ''}.`]
      : [],
  )
  return ['Answer sections of this conversation that the questions are about, oldest first:', ...lines, ...(parallel.length > 0 ? ['', ...parallel] : []), '', request.subject].join('\n')
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

const NOTHING: Cost = { requests: 0, questions: 0, inputTokens: 0 }

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

import type { DecisionBudget } from '@pluribus/protocol'
import type { Probe, ReferentAsk, ReferentGate, ReferentOperations, ReferentQuestions, ReferentRequest, ReferentUnit, SegmentProbe } from '../../ports'
import { sectionLine } from '../supply'
import { estimateDecisionTokens, STATE_TOKENS_PER_CHARACTER } from './ask'
import { chunkQuestion, digest, groupQuestion, list, ownQuestion, questionId, severalQuestion } from './shared'
import type { ReferentTree, SectionNode, TreeNode } from './tree'

/**
 * The operations over the decision provider and the budget guard: the
 * default implementation of `ReferentOperations`.
 *
 * - Point, Group, Segment and Several are yes/no questions; the probes of
 *   one round are one decision request, which goes through the guard
 *   (`ReferentAsk`) and is refused when it would pass a limit.
 * - Describe: a section is shown by its line (title, request, opening of
 *   the answer, or a stored summary and the section's own content where the
 *   summary provider has one). In a round, a section asked about by itself
 *   is followed by the nearest answers it was built on, named by their
 *   requests, as context; a part of an unbranched run is followed by the
 *   first answers of the run and what the run was built on.
 * - Cost: the guard's own estimate of a request, before anything is sent.
 * - Estimate: none. A prior from wording or embeddings would go here.
 */
export interface DecisionOperations extends ReferentOperations {
  /** The questions that carry the probes in the routing request, by question ID. */
  questions(probes: readonly Probe[]): ReferentQuestions
}

export interface OperationsContext {
  readonly request: ReferentRequest
  readonly tree: ReferentTree
  /** The answers of the routing request; null while that request is being put together. */
  readonly gate: Pick<ReferentGate, 'probability'> | null
  /** The guard every further request goes through; null while the routing request is being put together. */
  readonly ask: ReferentAsk | null
}

export type OperationsFactory = (context: OperationsContext) => DecisionOperations

/** How many of the nearest answers a section was built on are shown beside it, each by its request. */
export const POINT_ANCESTRY = 2
/** How many of the first answers of an unbranched run are shown beside a question about a later part of it. */
export const SEGMENT_LEAD = 2

const NOTHING: Cost = { requests: 0, questions: 0, inputTokens: 0 }

interface Cost {
  readonly requests: number
  readonly questions: number
  readonly inputTokens: number
}

interface Built {
  readonly stateText: string
  readonly questions: ReferentQuestions
  /** Question ID per probe, in the round's order. */
  readonly ids: readonly string[]
}

export const createDecisionOperations: OperationsFactory = ({ request, tree, gate, ask }) => {
  const answers = new Map<string, number>()
  const estimate = ask ? ask.estimate : estimateDecisionTokens
  const recent = mostRecent(tree)
  const sizes = new Map<string, number>()
  const built = new WeakMap<readonly Probe[], Built>()
  const segmentIds = new Map<string, string>()
  const takenIds = new Set<string>()

  /** A part of a run is named by its first and last section; two parts that share both are told apart by their size. */
  const segmentId = (probe: SegmentProbe): string => {
    const base = questionId.chunk(probe.unit, probe.nodes)
    const signature = `${base}:${probe.nodes.length}`
    const known = segmentIds.get(signature)
    if (known) return known
    const id = takenIds.has(base) ? `${base}_${probe.nodes.length}` : base
    takenIds.add(id)
    segmentIds.set(signature, id)
    return id
  }
  const idOf = (probe: Probe): string =>
    probe.kind === 'point'
      ? questionId.own(probe.unit, probe.node)
      : probe.kind === 'group'
        ? questionId.group(probe.unit, probe.node)
        : probe.kind === 'segment'
          ? segmentId(probe)
          : questionId.several(probe.unit)
  const questionOf = (probe: Probe): ReferentQuestions[string] =>
    probe.kind === 'point'
      ? ownQuestion(probe.unit, probe.node)
      : probe.kind === 'group'
        ? groupQuestion(probe.unit, probe.node)
        : probe.kind === 'segment'
          ? chunkQuestion(probe.unit, probe.nodes)
          : severalQuestion(probe.unit)
  const lineOf = (node: SectionNode): string => sectionLine(node.entry.section, node.n, request.decisionContext(node.entry.section))

  const questions = (probes: readonly Probe[]): ReferentQuestions => {
    const out: { [id: string]: ReferentQuestions[string] } = {}
    for (const probe of probes) out[idOf(probe)] = questionOf(probe)
    return out
  }

  /** The first answers of the run a part belongs to, when the part does not start there, and what the run was built on. */
  const leads = new Map<SectionNode, { readonly lead: readonly TreeNode[]; readonly above: TreeNode | null; readonly top: TreeNode }>()
  const leadOf = (first: SectionNode): { readonly lead: readonly TreeNode[]; readonly above: TreeNode | null; readonly top: TreeNode } => {
    const known = leads.get(first)
    if (known) return known
    const before: TreeNode[] = []
    let top: TreeNode = first
    while (top.parent && top.parent.children.length === 1) {
      top = top.parent
      before.push(top)
    }
    const found = { lead: before.reverse().slice(0, SEGMENT_LEAD), above: top.parent, top }
    leads.set(first, found)
    return found
  }

  /** One round as a decision request: only the answers its questions are about, what they come from, then the subject. */
  const build = (round: readonly Probe[]): Built => {
    const cached = built.get(round)
    if (cached) return cached
    const asked: { [id: string]: ReferentQuestions[string] } = {}
    const ids: string[] = []
    const shown = new Set<TreeNode>()
    const points: SectionNode[] = []
    const segments: SegmentProbe[] = []
    const searching = new Set<ReferentUnit>()
    for (const probe of round) {
      const id = idOf(probe)
      ids.push(id)
      asked[id] = questionOf(probe)
      if (probe.kind === 'point') {
        shown.add(probe.node)
        points.push(probe.node)
      } else if (probe.kind === 'group') shown.add(probe.node)
      else if (probe.kind === 'segment') {
        segments.push(probe)
        searching.add(probe.unit)
      }
    }
    // Beside the most recent answer a part of a run is judged against an alternative: without it "Make that shorter" scores 0.4 on every part.
    if (recent) {
      for (const unit of searching) {
        if (asked[questionId.own(unit, recent)] !== undefined) continue
        asked[questionId.recent(unit)] = ownQuestion(unit, recent)
        shown.add(recent)
      }
    }
    const lines = new Map<number, string>()
    for (const node of shown) for (const s of node.kind === 'section' ? [node] : node.members) lines.set(s.n, lineOf(s))
    // What the pipeline's state text says under "Lines of work": which of these were requested side by side.
    const parallel = [...shown].flatMap((node) =>
      node.kind === 'group'
        ? [`${node.members.map((m) => `S${m.n}`).join(', ')} were requested in parallel from the same starting point${node.group.open ? ' and are still being answered' : ''}.`]
        : [],
    )
    const name = (node: TreeNode): string => (node.kind === 'group' ? `${list(node.members.map((m) => `S${m.n}`))} together` : lines.has(node.n) ? `S${node.n}` : digest(node))
    const context: string[] = []
    // Point: the nearest answers a section was built on. Sections with the same parent share one line, and sections that
    // follow one another in a run are said to: only the first of them is shown with what it was built on.
    const alone = new Set(points)
    const shownBelow = new Map<TreeNode, SectionNode[]>()
    for (const node of alone) if (node.parent) shownBelow.set(node.parent, [...(shownBelow.get(node.parent) ?? []), node])
    const follows = (node: SectionNode): boolean => node.parent !== null && node.parent.kind === 'section' && alone.has(node.parent) && shownBelow.get(node.parent)?.length === 1
    const byParent = new Map<TreeNode, SectionNode[]>()
    for (const node of alone) {
      // A stored summary already stands for the work before the section.
      if (!node.parent || follows(node) || request.decisionContext(node.entry.section) !== null) continue
      byParent.set(node.parent, [...(byParent.get(node.parent) ?? []), node])
    }
    for (const [parent, nodes] of byParent) {
      const chain: string[] = []
      for (let at: TreeNode | null = parent; at && chain.length < POINT_ANCESTRY; at = at.parent) chain.push(name(at))
      const sorted = [...nodes].sort((x, y) => x.n - y.n).map((node) => `S${node.n}`)
      context.push(`${list(sorted)} ${sorted.length > 1 ? 'build' : 'builds'} on ${chain.join(', which builds on ')}.`)
    }
    for (const head of alone) {
      if (follows(head)) continue
      let last = head
      for (let next = shownBelow.get(last); next?.length === 1 && next[0]; next = shownBelow.get(last)) last = next[0]
      if (last !== head) context.push(`S${head.n} to S${last.n} are consecutive answers of one line of work.`)
    }
    // Segment: the first answers of the run and what the run was built on. The parts of one run share one line.
    const byRun = new Map<TreeNode, { first: SectionNode; last: SectionNode; lead: readonly TreeNode[]; above: TreeNode | null }>()
    for (const probe of segments) {
      const first = probe.nodes[0]
      const last = probe.nodes[probe.nodes.length - 1]
      if (!first || !last) continue
      const { lead, above, top } = leadOf(first)
      const run = byRun.get(top)
      if (run) run.last = last
      else byRun.set(top, { first, last, lead, above })
    }
    for (const { first, last, lead, above } of byRun.values()) {
      if (lead.length === 0 && !above) continue
      const span = first === last ? `S${first.n} is an answer` : `S${first.n} to S${last.n} are consecutive answers`
      const starts = lead.length > 0 ? ` that starts with ${lead.map(name).join(', ')}` : ''
      const builds = above ? `${lead.length > 0 ? ' and' : ' that'} builds on ${name(above)}` : ''
      context.push(`${span} of one line of work${starts}${builds}.`)
    }
    const stateText = [
      'Answer sections of this conversation that the questions are about, oldest first:',
      ...[...lines].sort((a, b) => a[0] - b[0]).map(([, line]) => line),
      ...(parallel.length > 0 ? ['', ...parallel] : []),
      ...(context.length > 0 ? ['', 'Where they come from, for context only (no question is about the answers named here unless it names them itself):', ...context] : []),
      '',
      request.subject,
    ].join('\n')
    const made: Built = { stateText, questions: asked, ids }
    built.set(round, made)
    return made
  }

  const costOf = (round: readonly Probe[]): Cost => {
    if (round.length === 0) return NOTHING
    const { stateText, questions: asked } = build(round)
    return { requests: 1, questions: Object.keys(asked).length, inputTokens: estimate(stateText, asked) }
  }

  return {
    questions,
    known: (probe) => {
      const id = idOf(probe)
      return answers.get(id) ?? gate?.probability(id) ?? null
    },
    rides: (probe) =>
      probe.kind === 'point'
        ? probe.node.entry.listed
        : probe.kind === 'group'
          ? probe.node.members.every((m) => m.entry.listed)
          : probe.kind === 'segment'
            ? probe.nodes.every((node) => node.entry.listed)
            : true,
    estimate: () => null,
    describe: (node) => (node.kind === 'section' ? lineOf(node) : `${list(node.members.map((m) => `S${m.n}`))} together`),
    size(probe) {
      const id = idOf(probe)
      const known = sizes.get(id)
      if (known !== undefined) return known
      const question = estimate('', { [id]: questionOf(probe) }) - estimate('', {})
      const size = question + (probe.kind === 'point' ? Math.ceil((lineOf(probe.node).length + 1) * STATE_TOKENS_PER_CHARACTER) : 0)
      sizes.set(id, size)
      return size
    },
    fits(round, reserve = []) {
      if (!ask) return null
      const left = ask.remaining()
      const first = costOf(round)
      const second = costOf(reserve)
      const limits: readonly (keyof DecisionBudget)[] = ['requests', 'questions', 'inputTokens']
      return limits.find((limit) => left[limit] < first[limit] + second[limit]) ?? null
    },
    remaining: () => (ask ? ask.remaining() : { requests: 0, questions: 0, inputTokens: 0 }),
    async ask(round) {
      if (round.length === 0) return { kind: 'answered' }
      if (!ask) return { kind: 'refused', limit: 'requests' }
      const { stateText, questions: asked } = build(round)
      const result = await ask(stateText, asked)
      if (result.kind !== 'answered') return result
      for (const id of Object.keys(asked)) {
        const p = result.probability(id)
        if (p !== null) answers.set(id, p)
      }
      return { kind: 'answered' }
    },
  }
}

/** The most recent answer section: the newest the routing request lists. */
function mostRecent(tree: ReferentTree): SectionNode | null {
  let found: SectionNode | null = null
  for (const node of tree.nodes) {
    if (node.kind !== 'section') continue
    if (!found || (node.entry.listed && !found.entry.listed) || (node.entry.listed === found.entry.listed && node.n > found.n)) found = node
  }
  return found
}

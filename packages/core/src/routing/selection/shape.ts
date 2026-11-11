import { textTokens } from '@committee/protocol'
import type { GenealogyShape, ReferentRequest, RunShape } from '../../ports'
import { buildTree, segmentFrom, type TreeNode } from '../referents/tree'
import { FURTHER_REQUEST_ROOM } from './rules'

/**
 * The shape of the genealogy a referent strategy would read, for a strategy
 * selector (docs/build/dependency-decisioning.md · "Strategy selection"). It is read from the same
 * context tree the strategies build, so "trunk", "run" and "branch point"
 * mean here what they mean there. Counts only: nothing of what was asked or
 * answered leaves this function.
 */
export function genealogyShape(request: Pick<ReferentRequest, 'sections' | 'candidates'>): GenealogyShape {
  const tree = buildTree(request)
  const run = (segment: readonly TreeNode[]): RunShape => {
    const end = segment[segment.length - 1]
    let sections = 0
    let listedBeforeEnd = 0
    let unlisted = 0
    let tokens = 0
    for (const node of segment) {
      if (node.kind !== 'section') continue
      sections += 1
      if (!node.entry.listed) unlisted += 1
      else if (node !== end) listedBeforeEnd += 1
      tokens += textTokens(node.entry.section.request.length) + textTokens(node.entry.section.answerLength)
    }
    return { sections, listedBeforeEnd, unlisted, tokens, endsInSplit: (end?.children.length ?? 0) > 0 }
  }
  const longer = (held: RunShape | null, next: RunShape): RunShape => (held === null || next.sections > held.sections ? next : held)

  let longestTrunk: RunShape | null = null
  let longestBranchRun: RunShape | null = null
  let trunks = 0
  let branchRuns = 0
  let oldSingleRoots = 0
  let depth = 0
  // Level by level, as a walk descends: the roots' runs, then the runs below each split.
  let level: TreeNode[] = [...tree.roots]
  for (let root = true; level.length > 0; root = false) {
    depth += 1
    const next: TreeNode[] = []
    for (const start of level) {
      const segment = segmentFrom(start)
      const shape = run(segment)
      if (root) {
        trunks += 1
        longestTrunk = longer(longestTrunk, shape)
        if (shape.sections === 1 && shape.unlisted === 1 && !shape.endsInSplit) oldSingleRoots += 1
      } else if (shape.sections > 0) {
        branchRuns += 1
        longestBranchRun = longer(longestBranchRun, shape)
      }
      next.push(...(segment[segment.length - 1]?.children ?? []))
    }
    level = next
  }

  let tokens = 0
  let beyondWindow = 0
  for (const entry of request.sections) {
    tokens += textTokens(entry.section.request.length) + textTokens(entry.section.answerLength)
    if (!entry.listed) beyondWindow += 1
  }
  const groups = [...tree.byGroup.values()]
  return {
    sections: request.sections.length,
    beyondWindow,
    roots: tree.roots.length,
    oldSingleRoots,
    branchPoints: tree.nodes.filter((node) => node.children.length >= 2).length,
    depth,
    siblingGroups: { open: groups.filter((g) => g.group.open).length, closed: groups.filter((g) => !g.group.open).length },
    tokens,
    trunks,
    longestTrunk,
    branchRuns,
    longestBranchRun,
  }
}

/** 0 for none, then one more per doubling: 1, 2–3, 4–7, 8–15, … */
const bucket = (n: number): number => (n <= 0 ? 0 : Math.floor(Math.log2(n)) + 1)

const runSignature = (run: RunShape | null): string =>
  run === null ? '-' : `${bucket(run.sections)}.${bucket(run.listedBeforeEnd)}.${bucket(run.unlisted)}${run.endsInSplit ? 's' : 'l'}`

/**
 * A shape reduced to what a material change changes: every count by its
 * power of two, tokens by the thousand, and with it what the routing may
 * spend, which decides whether a walk can descend at all. Two routings with the same
 * signature are the same shape for a selector, so a choice that depends on
 * the shape alone is made once for them. A conversation that grows changes
 * signature a number of times logarithmic in its size.
 */
export function shapeSignature(shape: GenealogyShape, tokenBudget: number): string {
  return [
    'v1',
    `s${bucket(shape.sections)}`,
    `w${bucket(shape.beyondWindow)}`,
    `r${bucket(shape.roots)}`,
    `o${bucket(shape.oldSingleRoots)}`,
    `p${bucket(shape.branchPoints)}`,
    `d${bucket(shape.depth)}`,
    `g${Math.min(1, shape.siblingGroups.open)}.${bucket(shape.siblingGroups.closed)}`,
    `k${bucket(Math.floor(shape.tokens / 1000))}`,
    `t${runSignature(shape.longestTrunk)}`,
    `b${bucket(shape.branchRuns)}.${runSignature(shape.longestBranchRun)}`,
    // Whether the routing can pay for a further request at all, and otherwise its budget by the power of two.
    `q${tokenBudget < FURTHER_REQUEST_ROOM ? 0 : Number.isFinite(tokenBudget) ? bucket(Math.floor(tokenBudget / 1000)) : 'x'}`,
  ].join('|')
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`

function describeRun(run: RunShape): string {
  return `${plural(run.sections, 'answer')} (${run.tokens.toLocaleString('en-US')} tokens), ${run.unlisted.toLocaleString('en-US')} of them older than the listed ones and ${run.listedBeforeEnd.toLocaleString('en-US')} listed before its last answer; it ends ${run.endsInSplit ? 'where the line splits' : 'at a leaf'}`
}

/** The shape in words, for a decision model: a few lines of counts, and what the routing may spend. */
export function describeShape(shape: GenealogyShape, tokenBudget: number): string {
  const perSection = shape.sections > 0 ? Math.round(shape.tokens / shape.sections) : 0
  return [
    'The shape of a conversation, as counts. An answer is one request and its reply. Routing lists the most recent answers in its request and has to decide how to find the earlier answers a new message refers to.',
    `- ${plural(shape.sections, 'answer')}, ${shape.tokens.toLocaleString('en-US')} tokens in all (about ${perSection.toLocaleString('en-US')} each).`,
    `- ${shape.beyondWindow === 0 ? 'Every answer is listed in the routing request: none is older than the listed ones.' : `${plural(shape.beyondWindow, 'answer is', 'answers are')} older than the ones the routing request lists.`}`,
    `- ${plural(shape.roots, 'line')} of work started from nothing${shape.oldSingleRoots > 0 ? `, ${shape.oldSingleRoots.toLocaleString('en-US')} of them a single old answer that nothing was built on` : ''}.`,
    `- ${plural(shape.branchPoints, 'place')} where a line splits into two or more; the deepest path passes ${plural(Math.max(0, shape.depth - 1), 'split')}.`,
    `- Groups of answers requested in parallel from the same point: ${shape.siblingGroups.open} still running, ${shape.siblingGroups.closed} finished.`,
    `- Trunks (from the start of a line to its first split, or to its end): ${shape.trunks.toLocaleString('en-US')}.${shape.longestTrunk ? ` The longest has ${describeRun(shape.longestTrunk)}.` : ''}`,
    `- Runs below a split (answers that continue one branch without splitting): ${shape.branchRuns.toLocaleString('en-US')}.${shape.longestBranchRun ? ` The longest has ${describeRun(shape.longestBranchRun)}.` : ''}`,
    `- Routing may use ${Number.isFinite(tokenBudget) ? `${Math.max(0, Math.floor(tokenBudget)).toLocaleString('en-US')} decision tokens` : 'any number of decision tokens'} for this message, its own request (up to 5,400) included.`,
  ].join('\n')
}

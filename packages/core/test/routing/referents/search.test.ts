import { DEFAULT_SETTINGS, type SectionId, type TreeWalkSettings } from '@committee/protocol'
import { describe, expect, test } from 'vitest'
import type { Probe, ReferentUnit } from '../../../src/ports'
import { corpusInput, scene, sceneIds, type Scene } from '../../../testing/routing/corpus'
import { createOracleOperations, type OracleOperations } from '../../../testing/routing/referents/oracle'
import { numberedAnswerSections, supply } from '../../../src/routing/supply'
import onePassSource from '../../../src/routing/referents/one-pass.ts?raw'
import treeWalkSource from '../../../src/routing/referents/tree-walk.ts?raw'
import {
  SEARCH_FANOUT,
  ancestorsOf,
  ancestorsOfAll,
  buildTree,
  onePassPolicy,
  reduceToNonAncestors,
  startSet,
  stretchOf,
  treeWalkPolicy,
  unitReferents,
  type ReferentTree,
  type SearchInput,
  type TreeNode,
} from '../../../src/routing/referents/index'
import type { SectionNode } from '../../../src/routing/referents/tree'

/**
 * The search with no decision provider at all: the policies run over an
 * oracle that answers every probe from a labelled set of relevant nodes
 * (docs/build/dependency-decisioning.md · "The model and the operations").
 * Every probe costs one, so `searchRunsOverTokens` is a number of sections.
 */

const UNIT: ReferentUnit = { key: 'm', name: 'the new message' }
const CLEAR = 0.7
const FLOOR = 0.25
/** A run of more than this many sections is searched; fewer are asked about one by one. */
const LISTABLE = 12
const SETTINGS: TreeWalkSettings = { startAtTrunkBase: false, hopBetweenBranchPoints: false, searchRunsOverTokens: LISTABLE }

const add = (s: ReturnType<typeof scene>, handle: string, chain: string, on: string | null): void => {
  s.add(handle, { chain, on, label: handle, request: `Request ${handle}`, answer: `Answer ${handle}` })
}

/** One chain of `n`: T0 … T(n-1). */
const chain = (n: number): Scene => {
  const s = scene().chain('c', 'root', 'chat')
  for (let i = 0; i < n; i++) add(s, `T${i}`, 'c', i === 0 ? null : `T${i - 1}`)
  return s.build()
}

/** A trunk of five that splits into two long branches: a0 … and b0 …. */
const earlySplit = (length: number): Scene => {
  const s = scene().chain('c', 'root', 'chat')
  for (let i = 0; i < 5; i++) add(s, `T${i}`, 'c', i === 0 ? null : `T${i - 1}`)
  for (const side of ['a', 'b']) {
    s.chain(side, 'branch', side)
    for (let i = 0; i < length; i++) add(s, `${side}${i}`, side, i === 0 ? 'T4' : `${side}${i - 1}`)
  }
  return s.build()
}

/** Every answer N(i) is continued twice: by an aside L(i+1) that nothing follows, and by N(i+1). */
const nestedForks = (depth: number): Scene => {
  const s = scene().chain('c0', 'root', 'chat')
  add(s, 'N0', 'c0', null)
  for (let i = 1; i <= depth; i++) {
    s.chain(`l${i}`, 'branch', `aside ${i}`)
    add(s, `L${i}`, `l${i}`, `N${i - 1}`)
    s.chain(`c${i}`, 'branch', `deeper ${i}`)
    add(s, `N${i}`, `c${i}`, `N${i - 1}`)
  }
  return s.build()
}

/** Sibling groups with join-backs: J0, then a(i) and b(i) in parallel from J(i-1), joined back, and J(i) on the join-back. */
const siblingGroups = (groups: number): Scene => {
  const s = scene().chain('c', 'root', 'chat')
  add(s, 'J0', 'c', null)
  for (let i = 1; i <= groups; i++) {
    for (const side of ['a', 'b']) {
      s.chain(`${side}${i}`, 'fork', `${side}${i}`)
      add(s, `${side}${i}`, `${side}${i}`, `J${i - 1}`)
    }
    s.group(`G${i}`, { base: 'c', start: `J${i - 1}`, members: [`a${i}`, `b${i}`], open: false })
    add(s, `J${i}`, 'c', `jb_G${i}`)
  }
  return s.build()
}

/** `n` unrelated answers, and one line of three among them: R0 … and the line X0, X1, X2. */
const manyRoots = (n: number): Scene => {
  const s = scene()
  for (let i = 0; i < n; i++) {
    s.chain(`r${i}`, 'root', `topic ${i}`)
    add(s, `R${i}`, `r${i}`, null)
  }
  s.chain('x', 'root', 'x')
  for (let i = 0; i < 3; i++) add(s, `X${i}`, 'x', i === 0 ? null : `X${i - 1}`)
  return s.build()
}

const SHAPES: readonly (readonly [string, Scene])[] = [
  ['one chain', chain(200)],
  ['an early split', earlySplit(60)],
  ['nested forks', nestedForks(14)],
  ['sibling groups with join-backs', siblingGroups(8)],
  ['many roots', manyRoots(70)],
]

const treeOf = (sc: Scene): ReferentTree => {
  const input = corpusInput({ id: 'search', covers: ['targets'], note: 'a search', scene: sc, text: 'x', expect: {} })
  return buildTree({ sections: numberedAnswerSections(input, supply(input, [])), candidates: input.candidates })
}

const nodeOf = (tree: ReferentTree, handle: string): TreeNode => {
  const found = handle.startsWith('group:') ? tree.byGroup.get(sceneIds.group(handle.slice(6))) : tree.bySection.get(sceneIds.section(handle))
  if (!found) throw new Error(`No node ${handle}`)
  return found
}

interface Run {
  readonly relevant: ReadonlySet<TreeNode>
  readonly candidates?: readonly TreeNode[]
  readonly budget?: { readonly rounds?: number; readonly probes?: number }
  readonly settings?: Partial<TreeWalkSettings>
  readonly corrective?: boolean
  readonly answer?: (probe: Probe) => number | undefined
  readonly riding?: (probe: Probe) => boolean
  /** Whether a run that continues from the section fits what a run may read. Left out: every section does. */
  readonly continuable?: (node: SectionNode) => boolean
}

async function search(tree: ReferentTree, run: Run, policy = treeWalkPolicy) {
  const ops: OracleOperations = createOracleOperations({
    tree,
    relevant: () => run.relevant,
    ...(run.budget ? { budget: run.budget } : {}),
    ...(run.answer ? { answer: run.answer } : {}),
    ...(run.riding ? { riding: run.riding } : {}),
  })
  const input: SearchInput = {
    tree,
    units: [UNIT],
    relevance: { clear: CLEAR, floor: FLOOR },
    settings: { ...SETTINGS, ...run.settings },
    starts: () => run.candidates ?? [],
    corrective: () => run.corrective ?? false,
    ...(run.continuable ? { continuable: run.continuable } : {}),
  }
  const outcome = await policy.search(input, ops)
  if (!outcome.ok) throw new Error('The oracle does not fail')
  const referents = unitReferents(input, ops, UNIT, outcome.stop !== null, outcome.runEnds)
  const found = referents.sections.filter((s) => s.confidence >= CLEAR).map((s) => s.sectionId)
  return { ops, outcome, referents, found: new Set(found) }
}

/** The deepest relevant nodes, worked out the slow way: every relevant node that is no ancestor of another relevant node. */
function deepest(relevant: ReadonlySet<TreeNode>): TreeNode[] {
  return [...relevant].filter((node) => ![...relevant].some((other) => other !== node && ancestorsOf(other).has(node)))
}

/** The sections a set of nodes stands for: a group is all its members. */
const sectionsOf = (nodes: readonly TreeNode[]): Set<SectionId> => new Set(nodes.flatMap((node) => (node.kind === 'section' ? [node] : node.members)).map((node) => node.entry.section.sectionId))

/** A fixed sequence of pseudo-random numbers in [0, 1). */
function sequence(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state / 2_147_483_648
  }
}

function pick<T>(items: readonly T[], next: () => number, count: number): T[] {
  const out = new Set<T>()
  while (out.size < Math.min(count, items.length)) out.add(items[Math.floor(next() * items.length)] as T)
  return [...out]
}

/** The model: the context of a node is the node and its ancestors, so a relevant node's ancestors are relevant. */
const withAncestors = (targets: readonly TreeNode[]): Set<TreeNode> => new Set([...targets, ...ancestorsOfAll(targets)])

/** The least a walk descends on: of every run above a target, one node, its end. */
function withLineAbove(targets: readonly TreeNode[]): Set<TreeNode> {
  const out = new Set<TreeNode>(targets)
  for (const target of targets) {
    for (let above = stretchOf(target)[0]?.parent ?? null; above; above = stretchOf(above)[0]?.parent ?? null) out.add(above)
  }
  return out
}

describe('the non-ancestor set', () => {
  const tree = treeOf(siblingGroups(2))
  const n = (handle: string) => nodeOf(tree, handle)

  test('reduce · an ancestor is dropped in favour of its descendant, so no node of the result is an ancestor of another', () => {
    expect(reduceToNonAncestors([n('J0'), n('a1'), n('J1')])).toEqual([n('J1')])
    // Neither is above the other: both stay, in the order given.
    expect(reduceToNonAncestors([n('b1'), n('a1')])).toEqual([n('b1'), n('a1')])
    // A group's members are its ancestors: the join-back is a child of every member.
    expect(reduceToNonAncestors([n('a1'), n('b1'), n('group:G1')])).toEqual([n('group:G1')])
    expect(reduceToNonAncestors([n('a1'), n('J2')])).toEqual([n('J2')])
    // Duplicates are one node; nothing in, nothing out.
    expect(reduceToNonAncestors([n('a2'), n('a2'), n('J1')])).toEqual([n('a2')])
    expect(reduceToNonAncestors([])).toEqual([])
  })

  test.each(SHAPES)('reduce · %s: for any nodes, the result holds no ancestor of another, and every node dropped is an ancestor of one kept', (_name, sc) => {
    const shape = treeOf(sc)
    const next = sequence(7)
    for (let round = 0; round < 25; round++) {
      const nodes = pick(shape.nodes, next, 1 + Math.floor(next() * 8))
      const reduced = reduceToNonAncestors(nodes)
      for (const node of reduced) for (const other of reduced) expect(ancestorsOf(other).has(node)).toBe(false)
      for (const node of nodes) if (!reduced.includes(node)) expect(reduced.some((kept) => ancestorsOf(kept).has(node))).toBe(true)
    }
  })

  test('start set · the roots and the candidates, reduced; with no candidates it is the roots; a start names the nearest of what it displaced', () => {
    const roots = treeOf(manyRoots(3))
    expect(startSet(roots.roots, []).starts).toEqual(roots.roots)
    // A candidate displaces the root of its tree and leaves the other roots.
    const x1 = nodeOf(roots, 'X1')
    const set = startSet(roots.roots, [x1])
    expect(set.starts).toEqual([...roots.roots.filter((root) => root !== nodeOf(roots, 'X0')), x1])
    expect(set.displacedBy(x1, new Set())).toEqual([nodeOf(roots, 'X0')])
    expect(set.displacedBy(nodeOf(roots, 'R0'), new Set())).toEqual([])
    // Two candidates on one line: the deeper one starts, and the nearer of the two it displaced comes first, then the root.
    const deep = startSet(roots.roots, [x1, nodeOf(roots, 'X2')])
    expect(deep.starts).toContain(nodeOf(roots, 'X2'))
    expect(deep.starts).not.toContain(x1)
    expect(deep.displacedBy(nodeOf(roots, 'X2'), new Set())).toEqual([x1])
    expect(deep.displacedBy(x1, new Set([nodeOf(roots, 'X2'), x1]))).toEqual([nodeOf(roots, 'X0')])
  })
})

describe('exact: no budget', () => {
  test.each(SHAPES)('exact · %s: the search returns exactly the deepest relevant nodes', async (_name, sc) => {
    const tree = treeOf(sc)
    const next = sequence(11)
    for (let round = 0; round < 40; round++) {
      const targets = pick(tree.nodes, next, 1 + Math.floor(next() * 3))
      // Relevance as the model has it (a relevant node's ancestors are relevant), and the least a walk needs (one node of every run above).
      for (const relevant of [withAncestors(targets), withLineAbove(targets)]) {
        const { found, outcome, ops } = await search(tree, { relevant })
        expect(outcome.stop).toBeNull()
        expect(found).toEqual(sectionsOf(deepest(relevant)))
        // Nothing is asked twice.
        const asked = ops.rounds.flat().map((p) => (p.kind === 'segment' ? `c:${p.nodes.map((node) => node.key).join(',')}` : p.kind === 'several' ? 'several' : p.node.key))
        expect(new Set(asked).size).toBe(asked.length)
      }
    }
  })

  test.each(SHAPES)('exact · %s: whatever is relevant, wherever it lies, the search returns exactly the deepest relevant nodes when they are its start candidates', async (_name, sc) => {
    const tree = treeOf(sc)
    const next = sequence(13)
    for (let round = 0; round < 40; round++) {
      const relevant = new Set(pick(tree.nodes, next, 1 + Math.floor(next() * 4)))
      const { found } = await search(tree, { relevant, candidates: deepest(relevant) })
      expect(found).toEqual(sectionsOf(deepest(relevant)))
    }
  })

  test.each(SHAPES)('exact · %s: without candidates nothing below a run that is not relevant is reached, and what is returned is relevant, confirmed and holds no ancestor of another', async (_name, sc) => {
    const tree = treeOf(sc)
    const next = sequence(17)
    for (let round = 0; round < 40; round++) {
      const relevant = new Set(pick(tree.nodes, next, 1 + Math.floor(next() * 4)))
      const { found, ops } = await search(tree, { relevant })
      const labelled = sectionsOf([...relevant])
      for (const id of found) expect(labelled.has(id)).toBe(true)
      const nodes = [...found].map((id) => tree.bySection.get(id) as TreeNode)
      for (const node of nodes) {
        expect(ops.confirmed(UNIT, node) || tree.nodes.some((group) => group.kind === 'group' && group.members.includes(node as never) && ops.confirmed(UNIT, group))).toBe(true)
      }
      expect(reduceToNonAncestors(nodes)).toHaveLength(nodes.length)
    }
  })
})

describe('best effort: a budget', () => {
  test.each(SHAPES)('budget · %s: the search never exceeds the budget and returns only nodes a Point or a Group confirmed', async (_name, sc) => {
    const tree = treeOf(sc)
    const next = sequence(19)
    for (const budget of [{ rounds: 0 }, { rounds: 1 }, { rounds: 2 }, { rounds: 4 }, { probes: 3 }, { probes: 20 }, { rounds: 3, probes: 30 }]) {
      for (let round = 0; round < 12; round++) {
        const relevant = withAncestors(pick(tree.nodes, next, 1 + Math.floor(next() * 3)))
        const { ops, found, referents, outcome } = await search(tree, { relevant, budget })
        expect(ops.rounds.length).toBeLessThanOrEqual(budget.rounds ?? Number.POSITIVE_INFINITY)
        expect(ops.probes()).toBeLessThanOrEqual(budget.probes ?? Number.POSITIVE_INFINITY)
        // DA3: a section is a referent only if it was asked about by itself, or its sibling group was, as a whole.
        const byItself = (id: SectionId): boolean => {
          const node = tree.bySection.get(id)
          return node !== undefined && (ops.confirmed(UNIT, node) || tree.nodes.some((group) => group.kind === 'group' && group.members.includes(node) && ops.confirmed(UNIT, group)))
        }
        for (const id of found) expect(byItself(id)).toBe(true)
        for (const id of referents.best?.sectionIds ?? []) expect(byItself(id)).toBe(true)
        // What it found is relevant, and with the whole budget unused it is the exact answer.
        for (const id of found) expect(sectionsOf([...relevant]).has(id)).toBe(true)
        if (outcome.stop === null) expect(found).toEqual(sectionsOf(deepest(relevant)))
        // The same search again is the same search.
        const again = await search(tree, { relevant, budget })
        expect(again.ops.rounds.map((r) => r.length)).toEqual(ops.rounds.map((r) => r.length))
        expect(again.found).toEqual(found)
      }
    }
  })

  test('budget · a search the budget stopped between a Segment and its Points confirms nothing there (DA3)', async () => {
    const tree = treeOf(chain(200))
    const { found, ops, outcome, referents } = await search(tree, { relevant: new Set([nodeOf(tree, 'T40')]), budget: { rounds: 1 } })
    expect(ops.rounds).toHaveLength(1)
    expect(ops.rounds[0]?.every((p) => p.kind === 'segment')).toBe(true)
    // The oracle's routing request lists nothing, so there is no listed section left to fall back to.
    expect(outcome.stop).toEqual({ limit: 'requests', to: 'one-pass' })
    expect(found).toEqual(new Set())
    expect(referents.best).toBeNull()
  })
})

describe('the last relevant node of a run', () => {
  test('last · the probes for one relevant node in a run of n grow with the logarithm of n', async () => {
    const counts: number[] = []
    for (const n of [100, 1_000, 10_000]) {
      const tree = treeOf(chain(n))
      let most = 0
      let rounds = 0
      for (const at of [0, Math.floor(n / 3), n - 1]) {
        const target = nodeOf(tree, `T${at}`)
        const { found, ops } = await search(tree, { relevant: new Set([target]) })
        expect(found).toEqual(sectionsOf([target]))
        most = Math.max(most, ops.probes())
        rounds = Math.max(rounds, ops.rounds.length)
      }
      // Each round splits what is left at most SEARCH_FANOUT ways; the last asks about at most LISTABLE sections by themselves.
      const levels = Math.max(1, Math.ceil(Math.log(n / LISTABLE) / Math.log(SEARCH_FANOUT)))
      expect(rounds).toBeLessThanOrEqual(levels + 1)
      expect(most).toBeLessThanOrEqual(levels * SEARCH_FANOUT + LISTABLE)
      counts.push(most)
    }
    // A hundred times the sections, not three times the probes.
    expect(counts[2] ?? 0).toBeLessThan(3 * (counts[0] ?? 0))
    expect(counts[2] ?? 0).toBeLessThan(100)
  })

  test('last · of several relevant sections in a run only the part that holds the last is opened, and the last is what is returned', async () => {
    const tree = treeOf(chain(200))
    const relevant = new Set(['T10', 'T90', 'T150'].map((h) => nodeOf(tree, h)))
    const { found, ops } = await search(tree, { relevant })
    expect(found).toEqual(sectionsOf([nodeOf(tree, 'T150')]))
    // One round of Segments, one of Points: the parts that hold T10 and T90 were plausible and are not opened.
    expect(ops.rounds).toHaveLength(2)
    const points = ops.rounds.flat().filter((p) => p.kind === 'point')
    expect(points.length).toBeLessThanOrEqual(LISTABLE)
    expect(points.some((p) => p.kind === 'point' && p.node === nodeOf(tree, 'T90'))).toBe(false)
  })

  test('last · when no Point of the latest plausible part confirms, the search goes on in the plausible part before it, and never into one that was not plausible', async () => {
    const tree = treeOf(chain(200))
    const t150 = nodeOf(tree, 'T150')
    // The decision model says yes to the part that holds T150 and no to T150 itself: a Segment confirms nothing.
    const wrongYes = (probe: Probe): number | undefined => (probe.kind === 'segment' && probe.nodes.includes(t150 as never) ? 0.9 : undefined)
    const { found, ops } = await search(tree, { relevant: new Set([nodeOf(tree, 'T90')]), answer: wrongYes })
    expect(found).toEqual(sectionsOf([nodeOf(tree, 'T90')]))
    expect(ops.rounds).toHaveLength(3)
    // Round 2 opened the later part and confirmed nothing; round 3 opened the one before it. T150 is not a referent.
    expect(ops.rounds[1]?.some((p) => p.kind === 'point' && p.node === t150)).toBe(true)
    expect(ops.rounds[2]?.some((p) => p.kind === 'point' && p.node === nodeOf(tree, 'T90'))).toBe(true)
    const opened = new Set(ops.rounds.flat().flatMap((p) => (p.kind === 'point' ? [p.node] : [])))
    expect(opened.size).toBeLessThanOrEqual(2 * LISTABLE)
    // With no budget for the third round the search stops with nothing confirmed, and T150 is still not a referent.
    const stopped = await search(tree, { relevant: new Set([nodeOf(tree, 'T90')]), answer: wrongYes, budget: { rounds: 2 } })
    expect(stopped.found).toEqual(new Set())
    expect(stopped.outcome.stop?.limit).toBe('requests')
  })

  test('last · a run short enough is asked about point by point, in one round, and the result is still its last relevant section', async () => {
    const tree = treeOf(chain(LISTABLE))
    const { found, ops } = await search(tree, { relevant: new Set(['T2', 'T7'].map((h) => nodeOf(tree, h))) })
    expect(ops.rounds).toHaveLength(1)
    expect(ops.rounds[0]?.every((p) => p.kind === 'point')).toBe(true)
    expect(found).toEqual(sectionsOf([nodeOf(tree, 'T7')]))
  })

  test('last · sections above one the routing request already confirmed are not asked about: its context holds them', async () => {
    const tree = treeOf(chain(200))
    const tip = nodeOf(tree, 'T199')
    // The routing request carried the tip, and it is confirmed: the 199 answers above it need no search.
    const { found, ops } = await search(tree, { relevant: new Set([nodeOf(tree, 'T40'), tip]), riding: (p) => p.kind === 'point' && p.node === tip })
    expect(ops.rounds).toEqual([])
    expect(found).toEqual(sectionsOf([tip]))
  })

  test('last · a correction needs the relevant sections themselves: every plausible part is opened and nothing above a confirmed section is skipped', async () => {
    const tree = treeOf(chain(200))
    const relevant = new Set(['T10', 'T150', 'T199'].map((h) => nodeOf(tree, h)))
    const tip = nodeOf(tree, 'T199')
    const { referents, ops } = await search(tree, { relevant, corrective: true, riding: (p) => p.kind === 'point' && p.node === tip })
    // Both parts in one round of Points, after one round of Segments; the ancestors are kept beside their descendant.
    expect(ops.rounds).toHaveLength(2)
    expect(new Set(referents.sections.filter((s) => s.confidence >= CLEAR).map((s) => s.sectionId))).toEqual(sectionsOf([...relevant]))
  })

  test('last · old answers that nothing was built on are one run in which every relevant one is found', async () => {
    const tree = treeOf(manyRoots(70))
    const relevant = new Set(['R3', 'R40', 'R66'].map((h) => nodeOf(tree, h)))
    const { found, ops } = await search(tree, { relevant })
    expect(found).toEqual(sectionsOf([...relevant]))
    expect(ops.rounds).toHaveLength(2)
  })
})

describe('the walk', () => {
  test('walk · child runs of a relevant run are examined, the join-back among them as a whole; nothing is examined below a run that is not relevant', async () => {
    const tree = treeOf(siblingGroups(3))
    const n = (handle: string) => nodeOf(tree, handle)
    // The first group as a whole, and the line above it.
    const group = await search(tree, { relevant: new Set([n('J0'), n('group:G1')]) })
    expect(group.found).toEqual(sectionsOf([n('a1'), n('b1')]))
    expect(group.ops.rounds[1]?.map((p) => (p.kind === 'point' || p.kind === 'group' ? p.node.key : p.kind)).sort()).toEqual([n('a1').key, n('b1').key, n('group:G1').key, n('J1').key].sort())
    // The run of the join-back, G1 and J1, is relevant through G1: the runs below J1 are examined. They are not relevant, so nothing below J2 is.
    expect(group.ops.rounds.flat().some((p) => p.kind === 'point' && p.node === n('a2'))).toBe(true)
    expect(group.ops.rounds.flat().some((p) => p.kind === 'point' && p.node === n('a3'))).toBe(false)
    // A relevant node below a root that is not relevant is not reached.
    const unreachable = await search(tree, { relevant: new Set([n('J2')]) })
    expect(unreachable.found).toEqual(new Set())
    expect(unreachable.ops.rounds).toHaveLength(1)
  })

  test('walk · starting at a candidate examines its run from the top down to it, and, when that is relevant, the rest of the run and the runs below', async () => {
    const tree = treeOf(earlySplit(60))
    const n = (handle: string) => nodeOf(tree, handle)
    // a20 is the candidate. The last relevant node above it is a5; below it, a40.
    const { found, ops } = await search(tree, { relevant: new Set([n('a5'), n('a40')]), candidates: [n('a20')] })
    expect(found).toEqual(sectionsOf([n('a40')]))
    const first = ops.rounds[0] ?? []
    // The first round asks only about a0 … a20, as parts of the run; the trunk above the split is the context, not the question.
    for (const p of first) {
      expect(p.kind).toBe('segment')
      if (p.kind === 'segment') for (const node of p.nodes) expect(Number(node.entry.section.title.slice(1))).toBeLessThanOrEqual(20)
    }
    expect(ops.rounds.flat().some((p) => p.kind === 'point' && p.node === n('T2'))).toBe(false)
    expect(ops.rounds.flat().some((p) => p.kind !== 'several' && p.kind !== 'segment' && p.node === n('b0'))).toBe(false)
  })

  test('walk · safeguard: a start that displaced an ancestor and is not relevant hands over to the nearest ancestor it displaced, and nothing is asked twice', async () => {
    const tree = treeOf(earlySplit(8))
    const n = (handle: string) => nodeOf(tree, handle)
    // The candidate is in branch a; what is relevant is in branch b, with the trunk above it.
    const relevant = new Set([n('T4'), n('b3')])
    const { found, ops } = await search(tree, { relevant, candidates: [n('a2')] })
    expect(found).toEqual(sectionsOf([n('b3')]))
    // Round 1: a0 … a2, not relevant. Then the root, which a2 displaced: the trunk, and below it both branches, a only from a3 on.
    expect(ops.rounds[0]?.map((p) => (p.kind === 'point' ? p.node.key : ''))).toEqual([n('a0').key, n('a1').key, n('a2').key])
    const asked = ops.rounds.flat().flatMap((p) => (p.kind === 'point' ? [p.node.key] : []))
    expect(new Set(asked).size).toBe(asked.length)
    expect(asked).toContain(n('a5').key)
    // Without a displaced ancestor there is nothing to hand over to: a root that is not relevant ends its line.
    const none = await search(tree, { relevant, candidates: [] })
    expect(none.found).toEqual(found)
  })

  test('walk · safeguard: when the unit refers to several sections, the ancestors a relevant start displaced are started too, so a referent in another branch is found', async () => {
    const tree = treeOf(earlySplit(8))
    const n = (handle: string) => nodeOf(tree, handle)
    const relevant = new Set([n('T4'), n('a2'), n('b3')])
    const several = (yes: boolean) => (probe: Probe): number | undefined => (probe.kind === 'several' ? (yes ? 0.9 : 0.1) : undefined)
    const riding = (probe: Probe): boolean => probe.kind === 'several'
    // One referent as far as the decision model says: the candidate is relevant, so the walk stays below it.
    const one = await search(tree, { relevant, candidates: [n('a2')], answer: several(false), riding })
    expect(one.found).toEqual(sectionsOf([n('a2')]))
    // Several: the root it displaced is started as well, and the second referent, in the other branch, is found.
    const both = await search(tree, { relevant, candidates: [n('a2')], answer: several(true), riding })
    expect(both.found).toEqual(sectionsOf([n('a2'), n('b3')]))
    const asked = both.ops.rounds.flat().flatMap((p) => (p.kind === 'point' ? [p.node.key] : []))
    expect(new Set(asked).size).toBe(asked.length)
  })

  test('walk · a tree thousands of branch points deep is walked to its end: the walk does not nest with the depth of the tree', async () => {
    const tree = treeOf(nestedForks(3_000))
    const target = nodeOf(tree, 'N3000')
    const { found, ops } = await search(tree, { relevant: withAncestors([target]) })
    expect(found).toEqual(sectionsOf([target]))
    expect(ops.rounds).toHaveLength(3_001)
  })

  test('walk · with no candidates the start set is the roots, and a candidate that is a root changes nothing', async () => {
    const tree = treeOf(siblingGroups(4))
    const relevant = withAncestors([nodeOf(tree, 'a3')])
    const plain = await search(tree, { relevant })
    const same = await search(tree, { relevant, candidates: [...tree.roots] })
    expect(same.ops.rounds.map((round) => round.map((p) => (p.kind === 'point' || p.kind === 'group' ? p.node.key : p.kind)))).toEqual(
      plain.ops.rounds.map((round) => round.map((p) => (p.kind === 'point' || p.kind === 'group' ? p.node.key : p.kind))),
    )
  })
})

describe('start at the trunk base', () => {
  test('trunk base · the search still returns exactly the deepest relevant nodes', async () => {
    for (const [, sc] of SHAPES) {
      const tree = treeOf(sc)
      const next = sequence(23)
      for (let round = 0; round < 15; round++) {
        const relevant = withAncestors(pick(tree.nodes, next, 1 + Math.floor(next() * 3)))
        const { found } = await search(tree, { relevant, settings: { startAtTrunkBase: true } })
        expect(found).toEqual(sectionsOf(deepest(relevant)))
      }
    }
  })

  test('trunk base · only the last section of a trunk is asked about by itself at once and the ones skipped are one Segment, however few', async () => {
    const tree = treeOf(earlySplit(4))
    const n = (handle: string) => nodeOf(tree, handle)
    const trunk = await search(tree, { relevant: new Set([n('T4')]), settings: { startAtTrunkBase: true } })
    expect(kinds(trunk.ops.rounds[0])).toEqual([n('T4').key, `${n('T0').key}…${n('T3').key}`])
    // Below the split the branches are short: asked about one by one.
    expect(kinds(trunk.ops.rounds[1]).length).toBe(8)
  })
})

/** A round as what it asks about: a section or group by its key, a Segment by its first and last section. */
const kinds = (round: readonly Probe[] | undefined): string[] => (round ?? []).map((p) => (p.kind === 'point' || p.kind === 'group' ? p.node.key : p.kind === 'segment' ? `${p.nodes[0]?.key}…${p.nodes[p.nodes.length - 1]?.key}` : p.kind))
const rounds = (ops: OracleOperations): string[][] => ops.rounds.map((round) => kinds(round))
const HOP: Partial<TreeWalkSettings> = { hopBetweenBranchPoints: true }
const idOf = (node: TreeNode): SectionId => (node as SectionNode).entry.section.sectionId

describe('hop between branch points', () => {
  test.each([
    [20, { off: { rounds: 2, probes: 14 }, on: { rounds: 1, probes: 2 } }],
    [200, { off: { rounds: 2, probes: 29 }, on: { rounds: 1, probes: 17 } }],
    [2_000, { off: { rounds: 3, probes: 43 }, on: { rounds: 1, probes: 24 } }],
  ] as const)('hop · one relevant section in a run of %i: off, it is searched for and found; on, one round of Segments and the run\'s last section', async (n, expected) => {
    const tree = treeOf(chain(n))
    const target = nodeOf(tree, `T${Math.floor(n / 2)}`)
    const end = nodeOf(tree, `T${n - 1}`)
    const off = await search(tree, { relevant: new Set([target]) })
    expect(off.found).toEqual(sectionsOf([target]))
    expect({ rounds: off.ops.rounds.length, probes: off.ops.probes() }).toEqual(expected.off)
    expect(off.outcome.runEnds).toBeUndefined()
    expect(off.referents.runEnds).toBeUndefined()

    const on = await search(tree, { relevant: new Set([target]), settings: HOP })
    expect({ rounds: on.ops.rounds.length, probes: on.ops.probes() }).toEqual(expected.on)
    // Only Segments: no part is opened and no section is asked about by itself, the last one included.
    expect(on.ops.rounds.flat().every((p) => p.kind === 'segment')).toBe(true)
    expect(on.ops.confirmed(UNIT, end)).toBe(false)
    // The unit is placed on the run's last section and on no other: not on the section it refers to, not on a neighbor of it.
    expect(on.referents.sections).toEqual([{ sectionId: idOf(end), confidence: 0.95 }])
    const evidence = on.ops.rounds.flat().find((p) => p.kind === 'segment' && p.nodes.includes(target as SectionNode))
    expect(on.referents.runEnds).toEqual([
      {
        sectionId: idOf(end),
        confidence: 0.95,
        run: { firstSectionId: idOf(nodeOf(tree, 'T0')), lastSectionId: idOf(end), sections: n },
        evidence: evidence?.kind === 'segment' ? { firstSectionId: idOf(evidence.nodes[0] as TreeNode), lastSectionId: idOf(evidence.nodes[evidence.nodes.length - 1] as TreeNode), sections: evidence.nodes.length } : null,
        limitedByContext: false,
      },
    ])
  })

  test('hop · a run nothing refers to is asked about in the same round as with the switch off, and nothing is placed on it', async () => {
    const tree = treeOf(chain(200))
    const off = await search(tree, { relevant: new Set() })
    const on = await search(tree, { relevant: new Set(), settings: HOP })
    expect(rounds(on.ops)).toEqual(rounds(off.ops))
    expect(on.referents.sections).toEqual([])
    expect(on.referents.runEnds).toBeUndefined()
  })

  test('hop · a run that is only weakly plausible gives its last section that weak score: a weak referent, not a confirmed one', async () => {
    const tree = treeOf(chain(200))
    const t40 = nodeOf(tree, 'T40')
    const weak = (probe: Probe): number | undefined => (probe.kind === 'segment' && probe.nodes.includes(t40 as SectionNode) ? 0.4 : undefined)
    const { found, referents } = await search(tree, { relevant: new Set(), answer: weak, settings: HOP })
    expect(found).toEqual(new Set())
    expect(referents.sections).toEqual([{ sectionId: idOf(nodeOf(tree, 'T199')), confidence: 0.4 }])
    expect(referents.runEnds?.[0]).toMatchObject({ confidence: 0.4 })
  })

  test('hop · a relevant descendant: the walk goes on below the run as always, and the deepest relevant run\'s last section stands for the ones above it', async () => {
    const tree = treeOf(earlySplit(8))
    const n = (handle: string) => nodeOf(tree, handle)
    // The trunk and branch a are referred to: no section is asked about by itself anywhere.
    const both = await search(tree, { relevant: new Set([n('T2'), n('a5')]), settings: HOP })
    expect(rounds(both.ops)).toEqual([[`${n('T0').key}…${n('T4').key}`], [`${n('a0').key}…${n('a7').key}`, `${n('b0').key}…${n('b7').key}`]])
    expect(both.found).toEqual(sectionsOf([n('a7')]))
    expect(both.referents.runEnds?.map((end) => end.sectionId)).toEqual([idOf(n('a7'))])
    // Only the trunk is: the branches below it are still examined, and the trunk's last section is where the unit goes.
    const trunk = await search(tree, { relevant: new Set([n('T2')]), settings: HOP })
    expect(rounds(trunk.ops)).toEqual(rounds(both.ops))
    expect(trunk.found).toEqual(sectionsOf([n('T4')]))
    // Off, the same two units are placed on the sections they refer to.
    expect((await search(tree, { relevant: new Set([n('T2'), n('a5')]) })).found).toEqual(sectionsOf([n('a5')]))
    expect((await search(tree, { relevant: new Set([n('T2')]) })).found).toEqual(sectionsOf([n('T2')]))
  })

  test('hop · the search returns the last section of every run that holds a deepest relevant node, and of no other run', async () => {
    for (const [, sc] of SHAPES) {
      const tree = treeOf(sc)
      const next = sequence(29)
      for (let round = 0; round < 15; round++) {
        const relevant = withAncestors(pick(tree.nodes, next, 1 + Math.floor(next() * 3)))
        const { found, ops } = await search(tree, { relevant, settings: HOP })
        // A group stands for its members; a section for the last section of its run. A lone old answer is its own run.
        const expected = deepest(relevant).flatMap((node) => (node.kind === 'group' ? node.members : [stretchOf(node).filter((s) => s.kind === 'section').pop() as TreeNode]))
        expect(found).toEqual(sectionsOf(reduceToNonAncestors(expected)))
        expect(ops.probes()).toBeLessThanOrEqual((await search(tree, { relevant })).ops.probes())
      }
    }
  })

  test('hop · a correction needs the exact section it revises: for a corrective unit the switch changes no round and no referent', async () => {
    for (const [, sc] of SHAPES) {
      const tree = treeOf(sc)
      const next = sequence(31)
      for (let round = 0; round < 10; round++) {
        const relevant = withAncestors(pick(tree.nodes, next, 1 + Math.floor(next() * 3)))
        const off = await search(tree, { relevant, corrective: true })
        const on = await search(tree, { relevant, corrective: true, settings: HOP })
        expect(rounds(on.ops)).toEqual(rounds(off.ops))
        expect(on.referents).toEqual(off.referents)
        expect(on.outcome.runEnds).toBeUndefined()
      }
    }
  })

  test('hop · context limit: the deepest section a run can continue from is taken, and the sections below it are searched as with the switch off', async () => {
    const tree = treeOf(chain(200))
    const n = (handle: string) => nodeOf(tree, handle)
    const upTo = (last: number) => (node: SectionNode): boolean => Number(node.entry.section.title.slice(1)) <= last
    // T120 is the deepest section whose context fits: a unit that refers to T40 goes there, and the record says why not to the end.
    const limited = await search(tree, { relevant: new Set([n('T40')]), settings: HOP, continuable: upTo(120) })
    expect(limited.found).toEqual(sectionsOf([n('T120')]))
    expect(limited.referents.runEnds?.[0]).toMatchObject({ sectionId: idOf(n('T120')), limitedByContext: true, run: { lastSectionId: idOf(n('T199')), sections: 200 } })
    // T121 … T199 are not stood for by T120: a unit that refers to one of them has it found by a Point, as with the switch off.
    const below = await search(tree, { relevant: new Set([n('T150')]), settings: HOP, continuable: upTo(120) })
    expect(below.found).toEqual(sectionsOf([n('T150')]))
    expect(below.ops.confirmed(UNIT, n('T150'))).toBe(true)
    expect(below.referents.runEnds).toBeUndefined()
    // Both: the section found below stands for T120, which is its ancestor.
    const both = await search(tree, { relevant: new Set([n('T40'), n('T150')]), settings: HOP, continuable: upTo(120) })
    expect(both.found).toEqual(sectionsOf([n('T150')]))
    // With no limit the last section is taken; when not even the first section fits, nothing is, and the run is searched.
    expect((await search(tree, { relevant: new Set([n('T40')]), settings: HOP, continuable: () => true })).found).toEqual(sectionsOf([n('T199')]))
    const none = await search(tree, { relevant: new Set([n('T40')]), settings: HOP, continuable: () => false })
    expect(none.found).toEqual(sectionsOf([n('T40')]))
    expect(rounds(none.ops)).toEqual(rounds((await search(tree, { relevant: new Set([n('T40')]) })).ops))
  })

  test('hop · a sibling group still resolves to the whole group; a member is asked about by itself and is no evidence for the run below it', async () => {
    // T0 … T3, then a and b in parallel from T3, joined back; a is continued by a1, a2, a3.
    const s = scene().chain('c', 'root', 'chat')
    for (let i = 0; i < 4; i++) add(s, `T${i}`, 'c', i === 0 ? null : `T${i - 1}`)
    for (const side of ['a', 'b']) {
      s.chain(side, 'fork', side)
      add(s, side, side, 'T3')
    }
    s.group('G', { base: 'c', start: 'T3', members: ['a', 'b'], open: false })
    s.chain('more', 'branch', 'more')
    for (let i = 1; i <= 3; i++) add(s, `a${i}`, 'more', i === 1 ? 'a' : `a${i - 1}`)
    const tree = treeOf(s.build())
    const n = (handle: string) => nodeOf(tree, handle)
    // The group as a whole: both members, and nothing of the run a was continued by.
    const group = await search(tree, { relevant: new Set([n('T3'), n('a'), n('group:G')]), settings: HOP })
    expect(group.found).toEqual(sectionsOf([n('a'), n('b')]))
    expect(rounds(group.ops)[1]?.sort()).toEqual([n('group:G').key, n('a').key, n('b').key, `${n('a1').key}…${n('a3').key}`].sort())
    expect(group.referents.runEnds).toBeUndefined()
    // One member alone: the member, which was asked about by itself, not the end of the run below it.
    const member = await search(tree, { relevant: new Set([n('T3'), n('a')]), settings: HOP })
    expect(member.found).toEqual(sectionsOf([n('a')]))
    // A section of the run below the member: that run's last section.
    const run = await search(tree, { relevant: new Set([n('T3'), n('a2')]), settings: HOP })
    expect(run.found).toEqual(sectionsOf([n('a3')]))
    expect(run.referents.runEnds?.[0]).toMatchObject({ sectionId: idOf(n('a3')), run: { firstSectionId: idOf(n('a')), sections: 4 }, evidence: { firstSectionId: idOf(n('a1')), sections: 3 } })
  })

  test('hop · candidate sections and the two safeguards: a start that is relevant ends its run, one that is not hands over, and Several starts the displaced ancestors too', async () => {
    const tree = treeOf(earlySplit(60))
    const n = (handle: string) => nodeOf(tree, handle)
    // a20 is the candidate; a5, above it, is what the unit refers to. One round: the candidate by itself, a0 … a19 in Segments. The rest of the run needs no question.
    const started = await search(tree, { relevant: new Set([n('a5')]), candidates: [n('a20')], settings: HOP })
    expect(rounds(started.ops)).toEqual([[n('a20').key, `${n('a0').key}…${n('a11').key}`, `${n('a12').key}…${n('a19').key}`]])
    expect(started.found).toEqual(sectionsOf([n('a59')]))
    // A candidate that is itself what the unit refers to is evidence for its run like any Point: the run's last section is taken.
    const hit = await search(tree, { relevant: new Set([n('a20')]), candidates: [n('a20')], settings: HOP })
    expect(hit.ops.rounds).toHaveLength(1)
    expect(hit.found).toEqual(sectionsOf([n('a59')]))
    expect(hit.referents.runEnds?.[0]).toMatchObject({ sectionId: idOf(n('a59')), evidence: { firstSectionId: idOf(n('a20')), sections: 1 } })

    const short = treeOf(earlySplit(8))
    const m = (handle: string) => nodeOf(short, handle)
    // The candidate is in branch a; what is relevant is in branch b, under the trunk: the root the candidate displaced is started.
    const handed = await search(short, { relevant: new Set([m('T4'), m('b3')]), candidates: [m('a2')], settings: HOP })
    expect(rounds(handed.ops)).toEqual([[m('a2').key, `${m('a0').key}…${m('a1').key}`], [`${m('T0').key}…${m('T4').key}`], [`${m('a3').key}…${m('a7').key}`, `${m('b0').key}…${m('b7').key}`]])
    expect(handed.found).toEqual(sectionsOf([m('b7')]))
    // Several: the candidate's run is relevant, and the root it displaced is started all the same, so the other branch is found.
    const several = (probe: Probe): number | undefined => (probe.kind === 'several' ? 0.9 : undefined)
    const both = await search(short, { relevant: new Set([m('T4'), m('a2'), m('b3')]), candidates: [m('a2')], answer: several, riding: (p) => p.kind === 'several', settings: HOP })
    expect(both.found).toEqual(sectionsOf([m('a7'), m('b7')]))
  })

  test('hop · first-pass sections: a Point the routing request carried is evidence for its run, and a run whose sections were all asked about by themselves is left as it is', async () => {
    const tree = treeOf(earlySplit(8))
    const n = (handle: string) => nodeOf(tree, handle)
    // The ends of the two branches rode in the routing request. b7 is confirmed: its run needs no question, and it stands for the trunk.
    const firstPass = (p: Probe): boolean => p.kind === 'point' && (p.node === n('a7') || p.node === n('b7'))
    const confirmed = await search(tree, { relevant: new Set([n('T4'), n('b7')]), riding: firstPass, settings: HOP })
    expect(rounds(confirmed.ops)).toEqual([[`${n('T0').key}…${n('T4').key}`], [`${n('a0').key}…${n('a6').key}`]])
    expect(confirmed.found).toEqual(sectionsOf([n('b7')]))
    expect(confirmed.referents.runEnds).toBeUndefined()
    // Every section rode: there is nothing to save, and the last relevant section stands, as with the switch off.
    const ten = treeOf(chain(10))
    const all = await search(ten, { relevant: new Set([nodeOf(ten, 'T3')]), riding: (p) => p.kind === 'point', settings: HOP })
    expect(all.ops.rounds).toEqual([])
    expect(all.found).toEqual(sectionsOf([nodeOf(ten, 'T3')]))
    expect(all.referents.runEnds).toBeUndefined()
  })

  test('hop · the budget is a hard stop: what the rounds that were sent say about a run stands, and the best node found so far can be a run\'s last section', async () => {
    const tree = treeOf(earlySplit(8))
    const n = (handle: string) => nodeOf(tree, handle)
    const relevant = new Set([n('T2'), n('a5')])
    // No round: nothing is known, nothing is placed.
    const none = await search(tree, { relevant, settings: HOP, budget: { rounds: 0 } })
    expect(none.ops.rounds).toEqual([])
    expect(none.found).toEqual(new Set())
    expect(none.referents.best).toBeNull()
    // One round: the trunk is relevant, the branches were not asked about. The trunk's last section is the best node found so far.
    const one = await search(tree, { relevant, settings: HOP, budget: { rounds: 1 } })
    expect(one.ops.rounds).toHaveLength(1)
    expect(one.outcome.stop).toEqual({ limit: 'requests', to: 'one-pass' })
    expect(one.found).toEqual(sectionsOf([n('T4')]))
    expect(one.referents.best).toEqual({ sectionIds: [idOf(n('T4'))], confidence: 0.95 })
    // The same search again is the same search; with room it ends on branch a.
    expect(rounds((await search(tree, { relevant, settings: HOP, budget: { rounds: 1 } })).ops)).toEqual(rounds(one.ops))
    expect((await search(tree, { relevant, settings: HOP, budget: { rounds: 2 } })).found).toEqual(sectionsOf([n('a7')]))
  })

  test('hop · with start at the trunk base as well, the base and the Segments above it say whether the trunk is relevant, and no part is opened', async () => {
    const tree = treeOf(earlySplit(4))
    const n = (handle: string) => nodeOf(tree, handle)
    const { ops, found } = await search(tree, { relevant: new Set([n('T2')]), settings: { ...HOP, startAtTrunkBase: true } })
    expect(rounds(ops)).toEqual([[n('T4').key, `${n('T0').key}…${n('T3').key}`], [`${n('a0').key}…${n('a3').key}`, `${n('b0').key}…${n('b3').key}`]])
    expect(found).toEqual(sectionsOf([n('T4')]))
  })

  test('hop · old answers that nothing was built on are not a run: each relevant one is found by itself, as with the switch off', async () => {
    const tree = treeOf(manyRoots(70))
    const relevant = new Set(['R3', 'R40', 'X1'].map((h) => nodeOf(tree, h)))
    const off = await search(tree, { relevant })
    const on = await search(tree, { relevant, settings: HOP })
    expect(rounds(on.ops)).toEqual(rounds(off.ops))
    expect(on.found).toEqual(sectionsOf([...relevant]))
  })
})

describe('one pass', () => {
  test('one-pass · as a policy it asks for a Point per listed section, a Group per listed sibling group and Several, in the routing request, and nothing after', async () => {
    const tree = treeOf(siblingGroups(2))
    const ops = createOracleOperations({ tree, relevant: () => new Set(), riding: () => true })
    const input: SearchInput = { tree, units: [UNIT], relevance: { clear: CLEAR, floor: FLOOR }, settings: SETTINGS, starts: () => [], corrective: () => false }
    const opening = onePassPolicy.opening(input, ops)
    expect(opening.map((p) => p.kind).sort()).toEqual([...Array<string>(2).fill('group'), ...Array<string>(7).fill('point'), 'several'])
    expect(await onePassPolicy.search(input, ops)).toEqual({ ok: true, stop: null })
    expect(ops.rounds).toEqual([])
  })
})

describe('a policy is only policy', () => {
  test.each([['one-pass.ts', onePassSource], ['tree-walk.ts', treeWalkSource]])('policy · %s holds no question text, question ID, token estimate or decision-provider type: it is written against the operations and the structure only', (file, source) => {
    const imports = [...source.matchAll(/^import .* from '([^']+)'$/gm)].map((m) => m[1])
    expect(imports.filter((from) => from?.startsWith('.')).sort()).toEqual(file === 'one-pass.ts' ? ['../../ports', './search'] : ['../../ports', './one-pass', './search', './tree'])
    for (const banned of ['questionId', 'NoulQuestion', 'DecisionProvider', 'ReferentAsk', 'estimateDecisionTokens', 'instructions', 'inputTokens', 'stateText', 'remaining(']) expect(source).not.toContain(banned)
  })

  test('policy · defaults: the tree walk and its settings are what the pipeline hands a strategy', () => {
    expect(DEFAULT_SETTINGS.routing.treeWalk).toEqual({ startAtTrunkBase: false, hopBetweenBranchPoints: false, searchRunsOverTokens: 1_500 })
  })
})

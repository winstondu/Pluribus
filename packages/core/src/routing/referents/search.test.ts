import { DEFAULT_SETTINGS, type SectionId, type TreeWalkSettings } from '@committee/protocol'
import { describe, expect, test } from 'vitest'
import type { Probe, ReferentUnit } from '../../ports'
import { corpusInput, scene, sceneIds, type Scene } from '../corpus'
import { numberedAnswerSections, supply } from '../supply'
import onePassSource from './one-pass.ts?raw'
import treeWalkSource from './tree-walk.ts?raw'
import {
  SEARCH_FANOUT,
  ancestorsOf,
  ancestorsOfAll,
  buildTree,
  createOracleOperations,
  onePassPolicy,
  reduceToNonAncestors,
  startSet,
  stretchOf,
  treeWalkPolicy,
  unitReferents,
  type OracleOperations,
  type ReferentTree,
  type SearchInput,
  type TreeNode,
} from './index'

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
  }
  const outcome = await policy.search(input, ops)
  if (!outcome.ok) throw new Error('The oracle does not fail')
  const referents = unitReferents(input, ops, UNIT, outcome.stop !== null)
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

describe('the switches', () => {
  test.each([
    ['start at the trunk base', { startAtTrunkBase: true }],
    ['hop between branch points', { hopBetweenBranchPoints: true }],
    ['both', { startAtTrunkBase: true, hopBetweenBranchPoints: true }],
  ] as const)('switches · %s: the search still returns exactly the deepest relevant nodes', async (_name, settings) => {
    for (const [, sc] of SHAPES) {
      const tree = treeOf(sc)
      const next = sequence(23)
      for (let round = 0; round < 15; round++) {
        const relevant = withAncestors(pick(tree.nodes, next, 1 + Math.floor(next() * 3)))
        const { found } = await search(tree, { relevant, settings })
        expect(found).toEqual(sectionsOf(deepest(relevant)))
      }
    }
  })

  test('switches · with a switch on, only the last section of a run is asked about by itself at once and the ones skipped are one Segment, however few', async () => {
    const tree = treeOf(earlySplit(4))
    const n = (handle: string) => nodeOf(tree, handle)
    const kinds = (round: readonly Probe[] | undefined) => (round ?? []).map((p) => (p.kind === 'point' ? p.node.key : p.kind === 'segment' ? `${p.nodes[0]?.key}…${p.nodes[p.nodes.length - 1]?.key}` : p.kind))
    const trunk = await search(tree, { relevant: new Set([n('T4')]), settings: { startAtTrunkBase: true } })
    expect(kinds(trunk.ops.rounds[0])).toEqual([n('T4').key, `${n('T0').key}…${n('T3').key}`])
    // Below the split the branches are short: asked about one by one, the switch for them being off.
    expect(kinds(trunk.ops.rounds[1]).length).toBe(8)
    const hops = await search(tree, { relevant: new Set([n('T4')]), settings: { hopBetweenBranchPoints: true } })
    expect(kinds(hops.ops.rounds[0])).toHaveLength(5)
    expect(kinds(hops.ops.rounds[1])).toEqual([n('a3').key, `${n('a0').key}…${n('a2').key}`, n('b3').key, `${n('b0').key}…${n('b2').key}`])
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

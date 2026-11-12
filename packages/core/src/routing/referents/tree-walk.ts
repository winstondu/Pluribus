import type { DecisionBudget } from '@committee/protocol'
import type { Probe, ReferentOperations, ReferentUnit } from '../../ports'
import { onePassProbes } from './one-pass'
import { probe, strategyFromPolicy, type ReferentPolicy, type SearchInput, type SearchOutcome } from './search'
import { ancestorsOf, joinBacksOf, reduceToNonAncestors, segmentFrom, stretchOf, type GroupNode, type SectionNode, type TreeNode } from './tree'

/**
 * Tree walk: the search for the deepest relevant nodes of a unit, from a
 * start set down the lines of work that are relevant
 * (docs/build/dependency-decisioning.md · "The search").
 *
 * - **Start set.** The roots and the start candidates (`startSet`), reduced
 *   so that no start is an ancestor of another: an ancestor is dropped in
 *   favour of its descendant. Starting at a node examines the part of its
 *   unbranched run from the run's top down to the node; a root's run is
 *   examined whole.
 * - **Examining a part of a run.** A sibling group is asked about as a
 *   whole (Group) beside its members. Sections are asked about by
 *   themselves (Point) while that costs no more than
 *   `searchRunsOverTokens`; a longer part is searched for its **last
 *   relevant node**: its sections are put in parts, each one Segment probe,
 *   the latest plausible part is opened, and its sections are asked about
 *   by themselves. Only that Point can confirm a section. When no Point of
 *   the part confirms, the search goes on in the next plausible part before
 *   it. Sections above one that is already confirmed are not asked about:
 *   the confirmed one's context holds them. A correction needs the relevant
 *   nodes themselves, so for a corrective unit every plausible part is
 *   opened and nothing above a confirmed section is skipped.
 * - **Descent.** Below a run that is plausible, the rest of the run and
 *   then every child run are examined, the join-back of a sibling group
 *   among them. Nothing is examined below a run that is not plausible.
 * - **Reinstating.** A start that displaced an ancestor and is not
 *   plausible hands over to its nearest displaced ancestors; when the unit
 *   refers to several sections (Several at the target-choice threshold),
 *   the displaced ancestors of every start are started too. What was
 *   asked is not asked again.
 * - **Rounds.** Everything the walk wants to know next, for every unit, is
 *   one round. The first round rides in the routing request as far as that
 *   request lists what it names.
 * - **The budget is a hard stop.** Before each round the walk checks that
 *   the round and its fallback both fit. When they do not, it asks about
 *   the listed nodes it has not asked about in one round, if that fits, and
 *   stops; when the fallback is what cannot be afforded, it goes on for as
 *   long as its own rounds fit.
 *
 * The two switches (`settings.routing.treeWalk`) change which sections of a
 * part are asked about by themselves at once: with `startAtTrunkBase`, of a
 * root's run only the last; with `hopBetweenBranchPoints`, of any other run
 * only the last. The sections skipped are searched, however few, and the
 * last is asked about again beside the ones the search opens.
 */
export const treeWalkPolicy: ReferentPolicy = {
  name: 'tree-walk',

  opening(input, ops) {
    const walk: Walk = { input, ops, units: new Map() }
    const out: Probe[] = []
    for (const unit of input.units) {
      const listed = input.tree.nodes.filter((node) => node.kind === 'section' && ops.rides(probe.point(unit, node))).length
      if (listed >= 2) out.push(probe.several(unit))
      const first = walkUnit(walk, unit).next()
      if (!first.done) out.push(...first.value.filter((p) => ops.rides(p)))
    }
    return out
  },

  async search(input, ops): Promise<SearchOutcome> {
    const walk: Walk = { input, ops, units: new Map() }
    const steps = together(input.units.map((unit) => walkUnit(walk, unit)))
    // The fallback: what one pass would have asked in the routing request and the walk has not asked yet.
    const listed = onePassProbes(input, ops)
    for (let step = steps.next(); !step.done; step = steps.next()) {
      const round = distinct(step.value)
      const fallback = listed.filter((p) => ops.known(p) === null)
      const limit = ops.fits(round, fallback)
      // Not room for this round and the fallback: fall back, unless the fallback is what does not fit and this round does.
      // Then walking on is all the budget still buys (a price guard on short answers leaves less than the fallback costs).
      if (limit && (ops.fits(fallback) === null || ops.fits(round) !== null)) return fallBack(ops, fallback, limit)
      const result = await ops.ask(round)
      if (result.kind === 'failed') return { ok: false, error: result.error }
      if (result.kind === 'refused') return fallBack(ops, listed.filter((p) => ops.known(p) === null), result.limit)
    }
    return { ok: true, stop: null }
  },
}

export const treeWalkStrategy = strategyFromPolicy(treeWalkPolicy)

/** Fewer sections than this are not worth skipping: one question about one section is the question about that section. */
export const MIN_SKIPPED = 2
/** The most parts one run is split into in one round. */
export const SEARCH_FANOUT = 24

/** A round asks each thing once, whichever steps wanted it. */
function distinct(probes: readonly Probe[]): Probe[] {
  const seen = new Set<string>()
  return probes.filter((p) => {
    const about = p.kind === 'several' ? '' : p.kind === 'segment' ? `${p.nodes[0]?.key ?? ''}…${p.nodes[p.nodes.length - 1]?.key ?? ''}×${p.nodes.length}` : p.node.key
    const key = `${p.kind}|${p.unit.key}|${about}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function fallBack(ops: ReferentOperations, fallback: readonly Probe[], limit: keyof DecisionBudget): Promise<SearchOutcome> {
  if (fallback.length === 0) return { ok: true, stop: { limit, to: 'one-pass' } }
  if (ops.fits(fallback) !== null) return { ok: true, stop: { limit, to: 'partial' } }
  const result = await ops.ask(fallback)
  if (result.kind === 'failed') return { ok: false, error: result.error }
  return { ok: true, stop: { limit, to: result.kind === 'refused' ? 'partial' : 'one-pass' } }
}

// ───────────────────────────── the start set ─────────────────────────────

export interface StartSet {
  /** Where the walk starts: no node of it is an ancestor of another. */
  readonly starts: readonly TreeNode[]
  /**
   * The nearest of the nodes a start displaced: of the roots and candidates
   * that are its ancestors and were not started yet, those that are not an
   * ancestor of another of them.
   */
  displacedBy(start: TreeNode, started: ReadonlySet<TreeNode>): TreeNode[]
}

/**
 * The start set of a walk: the roots and the candidates, reduced to their
 * non-ancestor set (`reduceToNonAncestors`). With no candidates it is the
 * roots.
 */
export function startSet(roots: readonly TreeNode[], candidates: readonly TreeNode[]): StartSet {
  const pool = [...new Set([...roots, ...candidates])]
  return {
    starts: reduceToNonAncestors(pool),
    displacedBy(start, started) {
      const above = ancestorsOf(start)
      return reduceToNonAncestors(pool.filter((node) => above.has(node) && !started.has(node)))
    },
  }
}

// ───────────────────────────── the walk ─────────────────────────────

/** What a step of the walk wants answered before it goes on: one round's worth, never empty. */
type Step<T> = Generator<readonly Probe[], T, void>

interface Walk {
  readonly input: SearchInput
  readonly ops: ReferentOperations
  readonly units: Map<ReferentUnit, UnitWalk>
}

/** What one unit's walk has examined, so that nothing is examined or descended into twice, and what it is doing. */
interface UnitWalk {
  /** By the top of an unbranched run: how far down it was taken up, and whether anything there is plausible so far. */
  readonly examined: Map<TreeNode, { upTo: number; relevant: boolean }>
  /** Tops of the runs whose child runs were taken up. */
  readonly descended: Set<TreeNode>
  /** The steps under way. A step that takes up further runs adds them here: a tree of any depth is walked without nesting. */
  readonly tasks: Step<unknown>[]
}

/** Waits for the probes that are not known yet, and for those asked again. */
function* need(ops: ReferentOperations, probes: readonly Probe[], again: readonly Probe[] = []): Step<void> {
  const missing = probes.filter((p) => ops.known(p) === null)
  if (missing.length + again.length > 0) yield [...missing, ...again]
}

/** Runs steps side by side: what they want at the same time is one round. */
function* together<T>(steps: readonly Step<T>[]): Step<T[]> {
  const results: T[] = []
  let active = steps.map((step, i) => ({ step, i }))
  for (;;) {
    const wanted: Probe[] = []
    const still: typeof active = []
    for (const entry of active) {
      const next = entry.step.next()
      if (next.done) results[entry.i] = next.value
      else {
        wanted.push(...next.value)
        still.push(entry)
      }
    }
    if (still.length === 0) return results
    active = still
    yield wanted
  }
}

/** Runs every step under way, and those they add, side by side until none is left. */
function* drain(state: UnitWalk): Step<void> {
  for (;;) {
    const wanted: Probe[] = []
    const still: Step<unknown>[] = []
    // A step added during the pass is at the end of the list and is taken in the same pass.
    for (let i = 0; i < state.tasks.length; i++) {
      const task = state.tasks[i]
      const next = task?.next()
      if (task && next && !next.done) {
        wanted.push(...next.value)
        still.push(task)
      }
    }
    state.tasks.length = 0
    state.tasks.push(...still)
    if (still.length === 0) return
    yield wanted
  }
}

function* walkUnit(walk: Walk, unit: ReferentUnit): Step<void> {
  const { input, ops } = walk
  const state: UnitWalk = { examined: new Map(), descended: new Set(), tasks: [] }
  walk.units.set(unit, state)
  const set = startSet(input.tree.roots, input.starts(unit))
  const started = new Set<TreeNode>()
  let frontier = [...set.starts]
  for (let first = true; frontier.length > 0; first = false) {
    const parts = frontier.map((start) => startPart(start))
    // The first tier's first step rides in the routing request: what that request could carry is known from here on.
    if (first) yield* need(ops, parts.flatMap((part) => opening(walk, unit, part.stretch.slice(0, part.upTo + 1), true, part.trunk)).filter((p) => ops.rides(p)))
    // Old answers that nothing was built on are searched as one run, for every relevant one of them.
    const lone = first ? loneAnswers(walk, unit, parts) : { pooled: new Set<TreeNode>(), sections: [] }
    const plausible = new Set<TreeNode>()
    for (const part of parts) {
      if (lone.pooled.has(part.start)) plausible.add(part.start)
      else state.tasks.push(fromStart(walk, unit, state, part, () => plausible.add(part.start)))
    }
    state.tasks.push(search(walk, unit, lone.sections, 'all', { node: null }, null))
    yield* drain(state)
    for (const start of frontier) started.add(start)
    // A start that is not plausible hands over to what it displaced; a unit that refers to several sections looks there as well.
    const several = (ops.known(probe.several(unit)) ?? 0) >= input.relevance.clear
    frontier = reduceToNonAncestors(frontier.filter((start) => several || !plausible.has(start)).flatMap((start) => set.displacedBy(start, started)))
  }
}

function* all(step: Step<unknown>): Step<true> {
  yield* step
  return true
}

interface StartPart {
  readonly start: TreeNode
  readonly stretch: readonly TreeNode[]
  /** The last index examined at the start: the start itself, or the end of the run for a root. */
  readonly upTo: number
  readonly trunk: boolean
}

function startPart(start: TreeNode): StartPart {
  const stretch = stretchOf(start)
  const trunk = stretch[0]?.parent === null
  return { start, stretch, upTo: start.parent === null ? stretch.length - 1 : stretch.indexOf(start), trunk }
}

/**
 * Roots whose run never branched and whose answers older than the routing
 * request's window are few: a conversation of unrelated answers. Their old
 * answers are pooled into one run and searched together. A run with a
 * confirmed listed answer keeps its older ones out: its context holds them.
 */
function loneAnswers(walk: Walk, unit: ReferentUnit, parts: readonly StartPart[]): { readonly pooled: ReadonlySet<TreeNode>; readonly sections: SectionNode[] } {
  const { input, ops } = walk
  const pooled = new Set<TreeNode>()
  const sections: SectionNode[] = []
  for (const { start, stretch, trunk, upTo } of parts) {
    const end = stretch[stretch.length - 1]
    if (!end || !trunk || upTo !== stretch.length - 1 || end.children.length > 0) continue
    const answers = stretch.filter((node): node is SectionNode => node.kind === 'section')
    if (answers.length !== stretch.length || answers.some((node) => joinBacksOf(input.tree, node).length > 0)) continue
    const older = answers.filter((node) => !ops.rides(probe.point(unit, node)))
    if (weight(walk, unit, older) > input.settings.searchRunsOverTokens) continue
    if (endsOnly(walk, answers, trunk)) continue
    pooled.add(start)
    const confirmed = answers.some((node) => (ops.known(probe.point(unit, node)) ?? 0) >= input.relevance.clear)
    if (input.corrective(unit) || !confirmed) sections.push(...older)
  }
  return { pooled, sections: sections.sort((a, b) => a.n - b.n) }
}

/** A start: its part of the run, and, as soon as that is plausible, the rest of the run and the runs below. */
function* fromStart(walk: Walk, unit: ReferentUnit, state: UnitWalk, part: StartPart, plausible: () => void): Step<void> {
  yield* examine(walk, unit, state, part.stretch, part.upTo, true, () => {
    plausible()
    state.tasks.push(examine(walk, unit, state, part.stretch, part.stretch.length - 1, false, () => undefined))
    below(walk, unit, state, part.stretch)
  })
}

/** A run reached from above: examined, and descended below as soon as it is plausible. */
function* descend(walk: Walk, unit: ReferentUnit, state: UnitWalk, stretch: readonly TreeNode[]): Step<void> {
  yield* examine(walk, unit, state, stretch, stretch.length - 1, false, () => below(walk, unit, state, stretch))
}

/** Takes up the child runs of a run: below its end, and the join-back of every sibling group one of its sections is a member of. */
function below(walk: Walk, unit: ReferentUnit, state: UnitWalk, stretch: readonly TreeNode[]): void {
  const top = stretch[0]
  const end = stretch[stretch.length - 1]
  if (!top || !end || state.descended.has(top)) return
  state.descended.add(top)
  const children = new Set<TreeNode>([...end.children, ...stretch.flatMap((node) => joinBacksOf(walk.input.tree, node))])
  for (const child of children) state.tasks.push(descend(walk, unit, state, segmentFrom(child)))
}

/**
 * Examines a run from where it was taken up before down to `upTo`. Tells
 * `plausible`, once, as soon as anything in the run is plausible: the first
 * round of a part settles that, before a search of it is finished.
 */
function* examine(walk: Walk, unit: ReferentUnit, state: UnitWalk, stretch: readonly TreeNode[], upTo: number, start: boolean, plausible: () => void): Step<void> {
  const top = stretch[0]
  if (!top) return
  const seen = state.examined.get(top) ?? { upTo: -1, relevant: false }
  state.examined.set(top, seen)
  if (upTo <= seen.upTo) {
    // Taken up before. When another step is still examining it, that step tells its own listener.
    if (seen.relevant) plausible()
    return
  }
  const part = stretch.slice(seen.upTo + 1, upTo + 1)
  seen.upTo = upTo
  let told = false
  yield* examinePart(walk, unit, part, start, top.parent === null, () => {
    seen.relevant = true
    if (!told) plausible()
    told = true
  })
  if (seen.relevant && !told) plausible()
}

function sectionsOf(part: readonly TreeNode[]): SectionNode[] {
  return part.filter((node): node is SectionNode => node.kind === 'section')
}

/** The sibling groups a part is asked about as a whole: its group nodes, and the groups its sections are members of. */
function groupsOf(walk: Walk, part: readonly TreeNode[]): GroupNode[] {
  return [...new Set(part.flatMap((node) => (node.kind === 'group' ? [node] : joinBacksOf(walk.input.tree, node))))]
}

/** Whether only the last section of a part is asked about by itself at once and the others are searched, however few. */
function endsOnly(walk: Walk, sections: readonly SectionNode[], trunk: boolean): boolean {
  const { startAtTrunkBase, hopBetweenBranchPoints } = walk.input.settings
  return (trunk ? startAtTrunkBase : hopBetweenBranchPoints) && sections.length - 1 >= MIN_SKIPPED
}

/** The sections skipped when only the last is asked about by itself: those the routing request lists and the older ones are searched apart, so that the first can ride. */
function skippedParts(walk: Walk, unit: ReferentUnit, sections: readonly SectionNode[]): SectionNode[][] {
  const skipped = sections.slice(0, -1)
  const rides = (node: SectionNode): boolean => walk.ops.rides(probe.point(unit, node))
  return [...split(walk, unit, skipped.filter(rides)), ...split(walk, unit, skipped.filter((node) => !rides(node)))]
}

/**
 * The first step of examining a part, which does not depend on any answer:
 * its sibling groups as a whole; with a switch on, its last section and the
 * parts of the sections skipped; and at a start, the sections the routing
 * request lists, whose lines are in that request anyway.
 */
function opening(walk: Walk, unit: ReferentUnit, part: readonly TreeNode[], start: boolean, trunk: boolean): Probe[] {
  const sections = sectionsOf(part)
  const out: Probe[] = groupsOf(walk, part).map((group) => probe.group(unit, group))
  const end = sections[sections.length - 1]
  if (end && endsOnly(walk, sections, trunk)) {
    out.push(probe.point(unit, end), ...skippedParts(walk, unit, sections).map((nodes) => probe.segment(unit, nodes)))
  } else if (start) {
    out.push(...sections.map((node) => probe.point(unit, node)).filter((p) => walk.ops.rides(p)))
  }
  return out
}

function* examinePart(walk: Walk, unit: ReferentUnit, part: readonly TreeNode[], start: boolean, trunk: boolean, plausible: () => void): Step<void> {
  const { input, ops } = walk
  const { clear, floor } = input.relevance
  const sections = sectionsOf(part)
  const corrective = input.corrective(unit)
  const first = opening(walk, unit, part, start, trunk)
  /** Every probe whose answer says whether the part is plausible, and the check that tells so as soon as one does. */
  const asked: Finding = {
    probes: [...first, ...sections.map((node) => probe.point(unit, node))],
    note: () => {
      if (asked.probes.some((p) => (ops.known(p) ?? 0) >= floor)) plausible()
    },
  }
  const end = sections[sections.length - 1]
  if (end && endsOnly(walk, sections, trunk)) {
    yield* need(ops, first)
    asked.note()
    yield* follow(walk, unit, skippedParts(walk, unit, sections), corrective ? 'all' : 'last', { node: end }, asked)
  } else {
    // What comes next depends on the sections already asked about by themselves: wait for those the routing request did not carry.
    if (first.some((p) => p.kind === 'point' && ops.known(p) === null)) yield* need(ops, first)
    const groups = first.filter((p) => ops.known(p) === null)
    // A confirmed section stands for everything above it in the run, except for a correction.
    const confirmed = corrective ? -1 : sections.findLastIndex((node) => (ops.known(probe.point(unit, node)) ?? 0) >= clear)
    const open = sections.slice(confirmed + 1).filter((node) => ops.known(probe.point(unit, node)) === null)
    if (weight(walk, unit, open) <= input.settings.searchRunsOverTokens) yield* need(ops, [...groups, ...open.map((node) => probe.point(unit, node))])
    else yield* together([all(need(ops, groups)), all(search(walk, unit, open, corrective ? 'all' : 'last', { node: null }, asked))])
  }
  asked.note()
}

// ───────────────────────────── the search of a run ─────────────────────────────

/** The estimated input tokens of asking about sections one by one. */
function weight(walk: Walk, unit: ReferentUnit, nodes: readonly SectionNode[]): number {
  let total = 0
  for (const node of nodes) total += walk.ops.size(probe.point(unit, node))
  return total
}

/**
 * Where a run is split: into parts that can each be asked about section by
 * section within `searchRunsOverTokens`; when that is more than
 * `SEARCH_FANOUT` parts, they are grouped into that many, and a part that
 * is opened is split again. So a run of any length is searched in a number
 * of rounds logarithmic in its length.
 */
function split(walk: Walk, unit: ReferentUnit, nodes: readonly SectionNode[]): SectionNode[][] {
  const threshold = walk.input.settings.searchRunsOverTokens
  const leaves: SectionNode[][] = []
  let current: SectionNode[] = []
  let size = 0
  for (const node of nodes) {
    const added = walk.ops.size(probe.point(unit, node))
    if (current.length > 0 && size + added > threshold) {
      leaves.push(current)
      current = []
      size = 0
    }
    size += added
    current.push(node)
  }
  if (current.length > 0) leaves.push(current)
  if (leaves.length <= SEARCH_FANOUT) return leaves
  const out: SectionNode[][] = []
  for (let i = 0; i < SEARCH_FANOUT; i++) {
    out.push(leaves.slice(Math.floor((i * leaves.length) / SEARCH_FANOUT), Math.floor(((i + 1) * leaves.length) / SEARCH_FANOUT)).flat())
  }
  return out
}

/** What a part of a run was asked, for the question whether it is plausible. */
interface Finding {
  readonly probes: Probe[]
  /** Called after a round: tells the part's listener when something asked so far is plausible. */
  note(): void
}

/** The section that was asked about without its neighbours and is asked about again, once, beside the first of them that are. */
interface Beside {
  node: SectionNode | null
}

/**
 * Searches sections of one run. `last`: for the last relevant one. `all`:
 * for every relevant one (a correction; old answers that nothing was built
 * on). True when a Point confirmed a section.
 */
function* search(walk: Walk, unit: ReferentUnit, nodes: readonly SectionNode[], want: 'last' | 'all', beside: Beside, asked: Finding | null): Step<boolean> {
  if (nodes.length === 0) return false
  const parts = split(walk, unit, nodes)
  if (parts.length <= 1) return yield* points(walk, unit, nodes, beside)
  yield* need(walk.ops, parts.map((part) => probe.segment(unit, part)))
  return yield* follow(walk, unit, parts, want, beside, asked)
}

/**
 * Opens the plausible parts of a round of Segment probes. `last`: the
 * latest first, and an earlier one only when no Point of the later one
 * confirmed a section. `all`: every one of them, side by side.
 */
function* follow(walk: Walk, unit: ReferentUnit, parts: readonly (readonly SectionNode[])[], want: 'last' | 'all', beside: Beside, asked: Finding | null): Step<boolean> {
  const { ops, input } = walk
  asked?.probes.push(...parts.map((part) => probe.segment(unit, part)))
  asked?.note()
  const plausible = parts.filter((part) => (ops.known(probe.segment(unit, part)) ?? 0) >= input.relevance.floor)
  const open = (part: readonly SectionNode[]): Step<boolean> =>
    part.length <= 1 || weight(walk, unit, part) <= input.settings.searchRunsOverTokens ? points(walk, unit, part, beside) : search(walk, unit, part, want, beside, asked)
  if (want === 'all') return (yield* together(plausible.map(open))).some((found) => found)
  for (const part of [...plausible].reverse()) if (yield* open(part)) return true
  return false
}

/**
 * Asks about sections by themselves: the only step that can confirm one.
 * The section asked about before without its neighbours is asked about
 * again beside them, and that answer stands.
 */
function* points(walk: Walk, unit: ReferentUnit, nodes: readonly SectionNode[], beside: Beside): Step<boolean> {
  const probes = nodes.map((node) => probe.point(unit, node))
  const again = beside.node && !nodes.includes(beside.node) && probes.some((p) => walk.ops.known(p) === null) ? [probe.point(unit, beside.node)] : []
  if (again.length > 0) beside.node = null
  yield* need(walk.ops, probes, again)
  return probes.some((p) => (walk.ops.known(p) ?? 0) >= walk.input.relevance.clear)
}

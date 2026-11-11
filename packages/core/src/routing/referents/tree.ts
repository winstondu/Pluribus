import type { NodeId, SectionId, SiblingGroupId } from '@committee/protocol'
import type { CandidateGroup, CandidateWork, ReferentRequest, ReferentSection } from '../../ports'

/**
 * The context tree a referent strategy reads (01 · "Context ancestry"),
 * built from the supplied candidates only.
 *
 * - A section node is one exchange that has a current answer section. Its
 *   parent is the nearest earlier exchange it builds on that has one.
 * - A group node stands for a sibling group's join-back (04 · "Join-back":
 *   "a child of all participating siblings"): an artificial node, present
 *   when two or more members have answer sections, open group or closed.
 *   It hangs under the group's starting context beside the members, every
 *   member counts as its ancestor, and work that continues from the
 *   join-back hangs under it.
 * - A join chain appears under its first parent only: the candidates carry
 *   one starting node per exchange.
 */
export type TreeNode = SectionNode | GroupNode

interface NodeBase {
  /** `s:<sectionId>` or `g:<groupId>`. */
  readonly key: string
  parent: TreeNode | null
  readonly children: TreeNode[]
}

export interface SectionNode extends NodeBase {
  readonly kind: 'section'
  readonly n: number
  readonly entry: ReferentSection
}

export interface GroupNode extends NodeBase {
  readonly kind: 'group'
  /** Its number in question IDs: 1-based position among the supplied groups. */
  readonly index: number
  readonly group: CandidateGroup
  /** Members that have answer sections, in submission order. Two or more. */
  readonly members: SectionNode[]
}

export interface ReferentTree {
  readonly roots: readonly TreeNode[]
  /** Every node, parents before children, sections in `n` order. */
  readonly nodes: readonly TreeNode[]
  readonly bySection: ReadonlyMap<SectionId, SectionNode>
  readonly byGroup: ReadonlyMap<SiblingGroupId, GroupNode>
}

export function buildTree(request: Pick<ReferentRequest, 'sections' | 'candidates'>): ReferentTree {
  const { candidates } = request
  const workByNode = new Map<NodeId, CandidateWork>(candidates.work.map((w) => [w.nodeId, w]))
  const workByDirective = new Map(candidates.work.map((w) => [w.directiveId, w]))
  const sectionAt = new Map<NodeId, SectionNode>()
  const bySection = new Map<SectionId, SectionNode>()
  for (const entry of request.sections) {
    const node: SectionNode = { kind: 'section', key: `s:${entry.section.sectionId}`, n: entry.n, entry, parent: null, children: [] }
    bySection.set(entry.section.sectionId, node)
    if (!sectionAt.has(entry.section.nodeId)) sectionAt.set(entry.section.nodeId, node)
  }

  const byGroup = new Map<SiblingGroupId, GroupNode>()
  const groupAtJoinBack = new Map<NodeId, CandidateGroup>()
  candidates.groups.forEach((group, i) => {
    if (group.joinBackNodeId) groupAtJoinBack.set(group.joinBackNodeId, group)
    const members: SectionNode[] = []
    for (const id of group.memberDirectiveIds) {
      const work = workByDirective.get(id)
      const node = work ? sectionAt.get(work.nodeId) : undefined
      if (node && !members.includes(node)) members.push(node)
    }
    if (members.length >= 2) byGroup.set(group.groupId, { kind: 'group', key: `g:${group.groupId}`, index: i + 1, group, members, parent: null, children: [] })
  })

  /** The nearest node at or above a context node: a section there, a group whose join-back it is, or further up. */
  const nodeAt = (start: NodeId | null): TreeNode | null => {
    const seen = new Set<NodeId>()
    let at = start
    while (at !== null && !seen.has(at)) {
      seen.add(at)
      const section = sectionAt.get(at)
      if (section) return section
      const group = groupAtJoinBack.get(at)
      if (group) {
        const node = byGroup.get(group.groupId)
        if (node) return node
        at = group.startNodeId
        continue
      }
      at = workByNode.get(at)?.startNodeId ?? null
    }
    return null
  }

  const attach = (node: TreeNode, parent: TreeNode | null): void => {
    // A parent that is the node itself or one of its descendants would be a cycle in malformed candidates: treat as a root.
    for (let p = parent; p; p = p.parent) if (p === node) return
    node.parent = parent
    parent?.children.push(node)
  }
  for (const node of bySection.values()) {
    const work = workByNode.get(node.entry.section.nodeId)
    const parent = nodeAt(work?.startNodeId ?? null)
    attach(node, parent === node ? null : parent)
  }
  for (const node of byGroup.values()) attach(node, nodeAt(node.group.startNodeId))

  const order = (a: TreeNode, b: TreeNode): number => rank(a) - rank(b)
  const all: TreeNode[] = [...bySection.values(), ...byGroup.values()]
  for (const node of all) node.children.sort(order)
  const roots = all.filter((n) => n.parent === null).sort(order)
  const nodes: TreeNode[] = []
  const visit = (n: TreeNode): void => {
    nodes.push(n)
    n.children.forEach(visit)
  }
  roots.forEach(visit)
  return { roots, nodes, bySection, byGroup }
}

/** Sections by number; a group right after its last member. */
function rank(node: TreeNode): number {
  return node.kind === 'section' ? node.n : Math.max(...node.members.map((m) => m.n)) + 0.5
}

/** Every ancestor of a node. A group's members are its ancestors too: the join-back is a child of all of them. */
export function ancestorsOf(node: TreeNode): Set<TreeNode> {
  const out = new Set<TreeNode>()
  const stack: TreeNode[] = [node]
  while (stack.length > 0) {
    const at = stack.pop()
    if (!at) break
    const up: TreeNode[] = at.kind === 'group' ? [...at.members] : []
    if (at.parent) up.push(at.parent)
    for (const p of up) {
      if (out.has(p) || p === node) continue
      out.add(p)
      stack.push(p)
    }
  }
  return out
}

/** Sections below a node, nearest first. */
export function sectionsBelow(node: TreeNode): SectionNode[] {
  const out: SectionNode[] = []
  let level = [...node.children]
  while (level.length > 0) {
    const next: TreeNode[] = []
    for (const child of level) {
      if (child.kind === 'section') out.push(child)
      next.push(...child.children)
    }
    level = next
  }
  return out
}

/**
 * A node and the run of only children below it: where nothing branches
 * there is nothing to prune, so the run is asked about in one request. It
 * ends at a leaf or at a branch point (two or more children, a group node
 * among them).
 */
export function segmentFrom(node: TreeNode): TreeNode[] {
  const out = [node]
  let at = node
  while (at.children.length === 1 && at.children[0]) {
    at = at.children[0]
    out.push(at)
  }
  return out
}

/** Depth of the tree in segments: the most requests a walk can need, the pipeline's own included. */
export function branchingDepth(tree: ReferentTree): number {
  const depth = (node: TreeNode): number => {
    const segment = segmentFrom(node)
    const end = segment[segment.length - 1]
    return 1 + Math.max(0, ...(end?.children ?? []).map(depth))
  }
  return Math.max(0, ...tree.roots.map(depth))
}

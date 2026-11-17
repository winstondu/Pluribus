import type { NodeId, SectionId, SiblingGroupId } from '@pluribus/protocol'
import type { CandidateGroup, CandidateWork, GroupNode, ReferentNode, ReferentRequest, ReferentTree, SectionNode } from '../../ports'

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
export type TreeNode = ReferentNode
export type { GroupNode, ReferentTree, SectionNode }

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

  // The root of the tree a node is in so far, with the path to it shortened on every lookup: a chain of thousands of
  // answers is attached without walking it once per node.
  const towardsRoot = new Map<TreeNode, TreeNode>()
  const rootOf = (node: TreeNode): TreeNode => {
    const path: TreeNode[] = []
    let at = node
    for (let up = towardsRoot.get(at); up; up = towardsRoot.get(at)) {
      path.push(at)
      at = up
    }
    for (const passed of path) towardsRoot.set(passed, at)
    return at
  }
  const attach = (node: TreeNode, parent: TreeNode | null): void => {
    // A parent that is the node itself or one of its descendants would be a cycle in malformed candidates: treat as a root.
    if (parent && rootOf(parent) === node) return
    node.parent = parent
    if (!parent) return
    parent.children.push(node)
    towardsRoot.set(node, parent)
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
  // Depth first without recursion: a conversation that only ever continued one chain is as deep as it is long.
  const nodes: TreeNode[] = []
  const stack: TreeNode[] = [...roots].reverse()
  for (let node = stack.pop(); node; node = stack.pop()) {
    nodes.push(node)
    for (let i = node.children.length - 1; i >= 0; i--) {
      const child = node.children[i]
      if (child) stack.push(child)
    }
  }
  return { roots, nodes, bySection, byGroup }
}

/** Sections by number; a group right after its last member. */
function rank(node: TreeNode): number {
  return node.kind === 'section' ? node.n : Math.max(...node.members.map((m) => m.n)) + 0.5
}

/** The nodes directly above a node: its parent, and for a group every member (the join-back is a child of all of them). */
function above(node: TreeNode): TreeNode[] {
  const up: TreeNode[] = node.kind === 'group' ? [...node.members] : []
  if (node.parent) up.push(node.parent)
  return up
}

/** Every ancestor of a node. A group's members are its ancestors too: the join-back is a child of all of them. */
export function ancestorsOf(node: TreeNode): Set<TreeNode> {
  const out = ancestorsOfAll([node])
  out.delete(node)
  return out
}

/** Every ancestor of any of the nodes, each visited once however long the lines are. */
export function ancestorsOfAll(nodes: Iterable<TreeNode>): Set<TreeNode> {
  const out = new Set<TreeNode>()
  const stack: TreeNode[] = [...nodes]
  for (let at = stack.pop(); at; at = stack.pop()) {
    for (const p of above(at)) {
      if (out.has(p)) continue
      out.add(p)
      stack.push(p)
    }
  }
  return out
}

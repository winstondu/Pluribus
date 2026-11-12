import type { ChainId, GenealogyProjection, NodeId, NodeView, SiblingGroupId } from '@pluribus/protocol'

/**
 * Where the mini-map draws the genealogy (09 §1, the Genealogy layout).
 *
 * This is drawing only. Rows are distance from a root along parent edges,
 * so context flows downward; columns keep each chain in a straight line
 * where they can, with forks to the right of the chain they left, in the
 * order they were sent. Nothing
 * here decides ancestry, and nothing about waiting or display order is read
 * from it: every edge is one entry of a node's `parents`, as projected, and
 * every planned edge is one entry of a node's `plannedGroupIds`.
 */

export interface PlacedNode {
  readonly node: NodeView
  readonly column: number
  readonly row: number
  readonly x: number
  readonly y: number
}

export interface PlacedEdge {
  readonly key: string
  readonly from: NodeId
  readonly to: NodeId
  /** The chain of the node the edge leads to: its color. */
  readonly chainId: ChainId
  /** False while the child has not started: the parent is a placement, not yet a record of what was read. */
  readonly exact: boolean
  readonly path: string
  /** Tip of the edge, at the child. */
  readonly tip: { readonly x: number; readonly y: number }
}

/**
 * Work planned on a sibling group that has no join-back yet (09 §1): the
 * projection names the group, not a node, so the edge leaves the group's
 * oval. It is always drawn dashed: nothing has been read yet.
 */
export interface PlannedEdge {
  readonly key: string
  readonly groupId: SiblingGroupId
  readonly to: NodeId
  /** The chain of the planned node: its color. */
  readonly chainId: ChainId
  readonly path: string
  readonly tip: { readonly x: number; readonly y: number }
}

export interface PlacedGroup {
  readonly id: SiblingGroupId
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface MiniMapLayout {
  readonly nodes: readonly PlacedNode[]
  readonly byId: ReadonlyMap<NodeId, PlacedNode>
  readonly edges: readonly PlacedEdge[]
  readonly plannedEdges: readonly PlannedEdge[]
  readonly groups: readonly PlacedGroup[]
  readonly width: number
  readonly height: number
}

export const MAP = {
  columnWidth: 76,
  rowHeight: 92,
  /** Radius of an exchange node. */
  radius: 11,
  paddingX: 16,
  paddingTop: 22,
  /** Room under the last row for its label. */
  paddingBottom: 46,
  /** The label block under a node: where its lines sit, and where the block ends for one line and for two. */
  label: { first: 15, second: 28, endOne: 21, endTwo: 34 },
  /** How far a sibling group's oval reaches beyond its member nodes. */
  ovalReach: { x: 35, top: 18, bottom: 40 },
} as const

/** Whether a node carries a second label line (its state, or what a join-back is). A completed exchange has none. */
export function hasSecondLine(node: NodeView): boolean {
  return node.kind === 'join-back' || node.state !== 'completed'
}

/** The open sibling groups a node is planned on, as projected. A join-back node is never planned. */
function plannedGroupsOf(node: NodeView): readonly SiblingGroupId[] {
  return node.kind === 'exchange' ? (node.plannedGroupIds ?? []) : []
}

export function layoutGenealogy(genealogy: GenealogyProjection): MiniMapLayout {
  const { nodes, chains, groups } = genealogy
  const nodeIds = genealogy.nodeIds.filter((id) => nodes[id] !== undefined)

  // ── rows: one more than the deepest parent ──
  const previousInChain = new Map<NodeId, NodeId>()
  for (const chainId of genealogy.chainIds) {
    const ids = chains[chainId]?.nodeIds ?? []
    for (let i = 1; i < ids.length; i += 1) {
      const id = ids[i]
      const before = ids[i - 1]
      if (id && before) previousInChain.set(id, before)
    }
  }
  const rows = new Map<NodeId, number>()
  const visiting = new Set<NodeId>()
  const rowOf = (id: NodeId): number => {
    const known = rows.get(id)
    if (known !== undefined) return known
    const node = nodes[id]
    if (!node || visiting.has(id)) return 0
    visiting.add(id)
    const above = node.parents.filter((parent) => nodes[parent] !== undefined)
    // Planned on an open group: below its members, leaving the row where the group's join-back will form.
    const underGroups = plannedGroupsOf(node).flatMap((groupId) => {
      const members = (groups[groupId]?.memberNodeIds ?? []).filter((member) => nodes[member] !== undefined)
      return members.length > 0 ? [2 + Math.max(...members.map(rowOf))] : []
    })
    // A node with no resolved parent yet still sits under what its chain already has.
    const before = previousInChain.get(id)
    const anchors = above.length > 0 || underGroups.length > 0 ? above : before ? [before] : []
    const row = Math.max(anchors.length === 0 ? 0 : 1 + Math.max(...anchors.map(rowOf)), ...underGroups)
    visiting.delete(id)
    rows.set(id, row)
    return row
  }
  for (const id of nodeIds) rowOf(id)

  // ── columns: a home column per chain, as near as possible to where it came from ──
  const reserved = new Map<number, { chainId: ChainId; from: number; to: number }[]>()
  const free = (column: number, from: number, to: number, chainId: ChainId): boolean =>
    (reserved.get(column) ?? []).every((span) => span.chainId === chainId || to < span.from || from > span.to)
  const home = new Map<ChainId, number>()
  let rightmost = -1
  const nearest = (preferred: number, accept: (column: number) => boolean): number => {
    for (let distance = 0; distance < 200; distance += 1) {
      if (accept(preferred + distance)) return preferred + distance
      if (distance > 0 && accept(preferred - distance)) return preferred - distance
    }
    return preferred
  }
  for (const chainId of genealogy.chainIds) {
    const ids = (chains[chainId]?.nodeIds ?? []).filter((id) => nodes[id] !== undefined)
    const first = ids[0]
    if (!first) continue
    const chainRows = ids.map(rowOf)
    const from = Math.min(...chainRows)
    const to = Math.max(...chainRows)
    const parentColumns = (nodes[first]?.parents ?? [])
      .map((parent) => {
        const parentNode = nodes[parent]
        return parentNode ? home.get(parentNode.chainId) : undefined
      })
      .filter((column): column is number => column !== undefined)
    const preferred =
      parentColumns.length === 0
        ? rightmost + 1
        : Math.round(parentColumns.reduce((sum, column) => sum + column, 0) / parentColumns.length)
    // Roots and forks only ever go rightwards, so trees and siblings read left to right in the order they were made.
    const column =
      parentColumns.length === 0 || chains[chainId]?.kind === 'fork'
        ? nearestRight(preferred, (candidate) => free(candidate, from, to, chainId))
        : nearest(preferred, (candidate) => free(candidate, from, to, chainId))
    home.set(chainId, column)
    reserved.set(column, [...(reserved.get(column) ?? []), { chainId, from, to }])
    rightmost = Math.max(rightmost, column)
  }

  // ── cells: a node takes its chain's column unless another node of the chain is already at that depth ──
  const taken = new Set<string>()
  const cell = new Map<NodeId, number>()
  for (const id of nodeIds) {
    const node = nodes[id]
    if (!node) continue
    const row = rowOf(id)
    const preferred = home.get(node.chainId) ?? 0
    const column = nearest(
      preferred,
      (candidate) =>
        !taken.has(`${candidate}:${row}`) && (candidate === preferred || free(candidate, row, row, node.chainId)),
    )
    taken.add(`${column}:${row}`)
    cell.set(id, column)
  }

  const columns = [...cell.values()]
  const leftmost = columns.length > 0 ? Math.min(...columns) : 0
  const columnCount = columns.length > 0 ? Math.max(...columns) - leftmost + 1 : 0
  const rowCount = rows.size > 0 ? Math.max(...rows.values()) + 1 : 0

  const placed: PlacedNode[] = []
  const byId = new Map<NodeId, PlacedNode>()
  for (const id of nodeIds) {
    const node = nodes[id]
    if (!node) continue
    const column = (cell.get(id) ?? 0) - leftmost
    const row = rowOf(id)
    const entry: PlacedNode = {
      node,
      column,
      row,
      x: MAP.paddingX + column * MAP.columnWidth + MAP.columnWidth / 2,
      y: MAP.paddingTop + row * MAP.rowHeight + MAP.radius,
    }
    placed.push(entry)
    byId.set(id, entry)
  }

  // ── edges: exactly the projected parents ──
  const edges: PlacedEdge[] = []
  for (const child of placed) {
    const exact = child.node.kind === 'join-back' ? true : child.node.parentsExact
    for (const parentId of child.node.parents) {
      const parent = byId.get(parentId)
      if (!parent) continue
      // An edge leaves from under its parent's label block, never through the label.
      const startY = parent.y + MAP.radius + (hasSecondLine(parent.node) ? MAP.label.endTwo : MAP.label.endOne)
      const endY = child.y - MAP.radius - 5
      const bend = Math.max(12, (endY - startY) * 0.5)
      edges.push({
        key: `${parentId}>${child.node.id}`,
        from: parentId,
        to: child.node.id,
        chainId: child.node.chainId,
        exact,
        path:
          parent.x === child.x
            ? `M ${parent.x} ${startY} L ${child.x} ${endY}`
            : `M ${parent.x} ${startY} C ${parent.x} ${startY + bend}, ${child.x} ${endY - bend}, ${child.x} ${endY}`,
        tip: { x: child.x, y: endY },
      })
    }
  }

  // ── sibling groups: one oval around every node that has been a member ──
  const ovals: PlacedGroup[] = []
  for (const group of Object.values(groups)) {
    const members = group.memberNodeIds.map((id) => byId.get(id)).filter((member): member is PlacedNode => !!member)
    if (members.length === 0) continue
    const left = Math.min(...members.map((member) => member.x)) - MAP.ovalReach.x
    const right = Math.max(...members.map((member) => member.x)) + MAP.ovalReach.x
    const top = Math.min(...members.map((member) => member.y)) - MAP.radius - MAP.ovalReach.top
    const bottom = Math.max(...members.map((member) => member.y)) + MAP.radius + MAP.ovalReach.bottom
    ovals.push({ id: group.id, x: left, y: top, width: right - left, height: bottom - top })
  }

  // ── planned edges: from the oval of each open group a not-started node is planned on ──
  const plannedEdges: PlannedEdge[] = []
  for (const child of placed) {
    for (const groupId of plannedGroupsOf(child.node)) {
      const oval = ovals.find((entry) => entry.id === groupId)
      if (!oval) continue
      // Once the join-back is a parent, the edge from it says the same thing: never both.
      const joinBack = groups[groupId]?.joinBackNodeId
      if (joinBack && child.node.parents.includes(joinBack)) continue
      // Leave from the flat part of the oval's bottom, as near above the child as it reaches.
      const corner = Math.min(oval.height, oval.width) / 2
      const startX = Math.min(Math.max(child.x, oval.x + corner), oval.x + oval.width - corner)
      const startY = oval.y + oval.height
      const endY = child.y - MAP.radius - 5
      const bend = Math.max(12, (endY - startY) * 0.5)
      plannedEdges.push({
        key: `${groupId}>${child.node.id}`,
        groupId,
        to: child.node.id,
        chainId: child.node.chainId,
        path:
          startX === child.x
            ? `M ${startX} ${startY} L ${child.x} ${endY}`
            : `M ${startX} ${startY} C ${startX} ${startY + bend}, ${child.x} ${endY - bend}, ${child.x} ${endY}`,
        tip: { x: child.x, y: endY },
      })
    }
  }

  return {
    nodes: placed,
    byId,
    edges,
    plannedEdges,
    groups: ovals,
    width: MAP.paddingX * 2 + Math.max(1, columnCount) * MAP.columnWidth,
    height: MAP.paddingTop + Math.max(1, rowCount) * MAP.rowHeight - (MAP.rowHeight - MAP.radius * 2) + MAP.paddingBottom,
  }
}

/** The first free column at or to the right of `preferred`. */
function nearestRight(preferred: number, accept: (column: number) => boolean): number {
  for (let column = preferred; column < preferred + 200; column += 1) {
    if (accept(column)) return column
  }
  return preferred
}

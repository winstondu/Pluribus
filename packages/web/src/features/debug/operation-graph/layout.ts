import type { OperationGraphProjection, OperationId } from '@committee/protocol'

/**
 * Where the operation graph draws live work (09 §4): an activity-on-node
 * network flowing left to right. A column is a dependency depth, as the
 * projection gives it, never elapsed time; rows keep scheduling order.
 */

export const CARD = { width: 180, height: 54, gapX: 56, gapY: 10, padding: 14 } as const

export interface Point {
  readonly x: number
  readonly y: number
}

export interface GraphEdge {
  readonly key: string
  /** The operation whose result is needed (or, for a barrier, awaited). */
  readonly from: OperationId
  /** The operation that waits. */
  readonly to: OperationId
  /**
   * `needs`: a result dependency (`dependsOn`). `barrier`: a hold by the
   * whole-request barrier (`barrierWaitingFor`): the waiting operation does
   * not need that result itself. The two are never merged.
   */
  readonly kind: 'needs' | 'barrier'
  /** For `needs`: the result is still missing. */
  readonly unsatisfied: boolean
}

export interface GraphLayout {
  readonly positions: ReadonlyMap<OperationId, Point>
  readonly edges: readonly GraphEdge[]
  readonly width: number
  readonly height: number
}

export function layoutOperations(graph: OperationGraphProjection): GraphLayout {
  const positions = new Map<OperationId, Point>()
  const rowsUsed = new Map<number, number>()
  let columns = 0
  let rows = 0
  for (const id of graph.active) {
    const operation = graph.operations[id]
    if (!operation) continue
    const column = Math.max(0, operation.depth)
    const row = rowsUsed.get(column) ?? 0
    rowsUsed.set(column, row + 1)
    positions.set(id, {
      x: CARD.padding + column * (CARD.width + CARD.gapX),
      y: CARD.padding + row * (CARD.height + CARD.gapY),
    })
    columns = Math.max(columns, column + 1)
    rows = Math.max(rows, row + 1)
  }

  const edges: GraphEdge[] = []
  for (const id of graph.active) {
    const operation = graph.operations[id]
    if (!operation) continue
    for (const dependency of operation.dependsOn) {
      if (!positions.has(dependency)) continue
      edges.push({
        key: `needs:${dependency}>${id}`,
        from: dependency,
        to: id,
        kind: 'needs',
        unsatisfied: operation.waitingFor.includes(dependency),
      })
    }
    for (const awaited of operation.barrierWaitingFor) {
      if (!positions.has(awaited)) continue
      edges.push({ key: `barrier:${awaited}>${id}`, from: awaited, to: id, kind: 'barrier', unsatisfied: true })
    }
  }

  return {
    positions,
    edges,
    width: CARD.padding * 2 + Math.max(1, columns) * CARD.width + Math.max(0, columns - 1) * CARD.gapX,
    height: CARD.padding * 2 + Math.max(1, rows) * CARD.height + Math.max(0, rows - 1) * CARD.gapY,
  }
}

/**
 * The connector between two cards, ending at the one that waits. A result
 * dependency always runs left to right, because depth is the column. A
 * barrier hold can point at any card, so the path leaves and arrives on
 * whichever sides face each other.
 */
export function edgePath(from: Point, to: Point): string {
  const middleY = (point: Point) => point.y + CARD.height / 2
  const middleX = (point: Point) => point.x + CARD.width / 2
  if (to.x > from.x) {
    const startX = from.x + CARD.width
    const endX = to.x - 4
    const bend = Math.max(18, (endX - startX) / 2)
    return `M ${startX} ${middleY(from)} C ${startX + bend} ${middleY(from)}, ${endX - bend} ${middleY(to)}, ${endX} ${middleY(to)}`
  }
  if (to.x < from.x) {
    const startX = from.x
    const endX = to.x + CARD.width + 4
    const bend = Math.max(18, (startX - endX) / 2)
    return `M ${startX} ${middleY(from)} C ${startX - bend} ${middleY(from)}, ${endX + bend} ${middleY(to)}, ${endX} ${middleY(to)}`
  }
  // Same depth: straight between the facing edges.
  return to.y > from.y
    ? `M ${middleX(from)} ${from.y + CARD.height} L ${middleX(to)} ${to.y - 4}`
    : `M ${middleX(from)} ${from.y} L ${middleX(to)} ${to.y + CARD.height + 4}`
}

/** A cubic-bezier easing as a function, so the reflow uses the same curve token as CSS motion. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const sample = (a: number, b: number, t: number) => 3 * a * (1 - t) * (1 - t) * t + 3 * b * (1 - t) * t * t + t * t * t
  return (x) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let low = 0
    let high = 1
    for (let i = 0; i < 24; i += 1) {
      const middle = (low + high) / 2
      if (sample(x1, x2, middle) < x) low = middle
      else high = middle
    }
    return sample(y1, y2, (low + high) / 2)
  }
}

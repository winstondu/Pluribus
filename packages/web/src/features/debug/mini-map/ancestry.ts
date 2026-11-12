import type { ChainId, GenealogyProjection, NodeId } from '@pluribus/protocol'

/**
 * Reading the genealogy projection for the mini-map: the nodes one node's
 * run could read, by following `parents` and nothing else.
 *
 * This is deliberately not "everything on the chains it touches". A join
 * chain's parents are the exact leaves it was created from, so a node added
 * to a source chain afterwards is not reached (Q5, Q86); a fork's parent is
 * the group's starting context, so its siblings are not reached (C3).
 */
export function ancestorsOf(genealogy: GenealogyProjection, nodeId: NodeId): NodeId[] {
  const seen = new Set<NodeId>()
  const walk = (id: NodeId): void => {
    for (const parent of genealogy.nodes[id]?.parents ?? []) {
      if (seen.has(parent) || !genealogy.nodes[parent]) continue
      seen.add(parent)
      walk(parent)
    }
  }
  walk(nodeId)
  // Root first, in the order the nodes were created.
  return genealogy.nodeIds.filter((id) => seen.has(id))
}

/** What Focus on a chain brings forward in the map: the chain's own nodes and everything any of them could read. */
export function chainRelations(
  genealogy: GenealogyProjection,
  chainId: ChainId,
): { own: Set<NodeId>; ancestors: Set<NodeId> } {
  const own = new Set<NodeId>(genealogy.chains[chainId]?.nodeIds ?? [])
  const ancestors = new Set<NodeId>()
  for (const id of own) {
    for (const ancestor of ancestorsOf(genealogy, id)) {
      if (!own.has(ancestor)) ancestors.add(ancestor)
    }
  }
  return { own, ancestors }
}

/**
 * Nodes that sit after `nodeId`'s parents on the chains it read from, which
 * its run did not read: later continuations of source chains.
 */
export function laterOnSourceChains(genealogy: GenealogyProjection, nodeId: NodeId): NodeId[] {
  const node = genealogy.nodes[nodeId]
  if (!node) return []
  const read = new Set<NodeId>(ancestorsOf(genealogy, nodeId))
  const sourceChains = new Set<ChainId>()
  for (const id of read) {
    const ancestor = genealogy.nodes[id]
    if (ancestor && ancestor.chainId !== node.chainId) sourceChains.add(ancestor.chainId)
  }
  const descendants = descendantsOf(genealogy, nodeId)
  return genealogy.nodeIds.filter((id) => {
    const other = genealogy.nodes[id]
    return (
      other !== undefined &&
      id !== nodeId &&
      sourceChains.has(other.chainId) &&
      !read.has(id) &&
      !descendants.has(id)
    )
  })
}

function descendantsOf(genealogy: GenealogyProjection, nodeId: NodeId): Set<NodeId> {
  const found = new Set<NodeId>()
  let grew = true
  while (grew) {
    grew = false
    for (const id of genealogy.nodeIds) {
      if (found.has(id) || id === nodeId) continue
      const parents = genealogy.nodes[id]?.parents ?? []
      if (parents.some((parent) => parent === nodeId || found.has(parent))) {
        found.add(id)
        grew = true
      }
    }
  }
  return found
}

import type { Probe, ReferentOperations } from '../../ports'
import { probe, strategyFromPolicy, type ReferentPolicy, type SearchInput } from './search'

/**
 * One pass: every candidate is asked about in the request the pipeline
 * sends anyway. A Point per listed answer section, a Group per sibling
 * group as a whole (its join-back), and Several. No round of its own: its
 * size is bounded by the routing request's window of sections.
 */
export const onePassPolicy: ReferentPolicy = {
  name: 'one-pass',
  opening: (input, ops) => onePassProbes(input, ops),
  search: async () => ({ ok: true }),
}

/** A probe for everything the routing request lists, per unit: Several first, then every node by itself. */
export function onePassProbes(input: Pick<SearchInput, 'tree' | 'units'>, ops: Pick<ReferentOperations, 'rides'>): Probe[] {
  const out: Probe[] = []
  for (const unit of input.units) {
    const listed = input.tree.nodes.map((node) => probe.of(unit, node)).filter((p) => ops.rides(p))
    if (listed.filter((p) => p.kind === 'point').length >= 2) out.push(probe.several(unit))
    out.push(...listed)
  }
  return out
}

export const onePassStrategy = strategyFromPolicy(onePassPolicy)

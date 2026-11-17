import type { Probe, ReferentOperations, ReferentUnit } from '../../../src/ports'
import type { ReferentTree, TreeNode } from '../../../src/routing/referents/tree'

/**
 * The operations over a labelled set of relevant nodes: a test double of
 * `ReferentOperations` with no decision provider behind it. A Point or a
 * Group is answered yes when its node is labelled, a Segment when one of
 * its sections is, Several when two or more nodes are. Every probe costs
 * one.
 */
export interface OracleOptions {
  readonly tree: ReferentTree
  /** The relevant nodes of a unit: sections, and sibling groups as a whole. */
  relevant(unit: ReferentUnit): ReadonlySet<TreeNode>
  /** Which probes the routing request carries: answered before the search starts. None unless given. */
  readonly riding?: (probe: Probe) => boolean
  /** An answer that differs from the labels, for a decision model that is wrong about a probe. Undefined: as labelled. */
  readonly answer?: (probe: Probe) => number | undefined
  /** Probability of a yes and of a no. */
  readonly yes?: number
  readonly no?: number
}

export interface OracleOperations extends ReferentOperations {
  /** Every round that was answered, in order. */
  readonly rounds: readonly (readonly Probe[])[]
  /** Probes answered in all rounds. */
  probes(): number
  /** Whether the node was asked about by itself: the only thing that can make it a referent. */
  confirmed(unit: ReferentUnit, node: TreeNode): boolean
}

export function createOracleOperations(options: OracleOptions): OracleOperations {
  const yes = options.yes ?? 0.95
  const no = options.no ?? 0.05
  const answers = new Map<string, number>()
  const rounds: (readonly Probe[])[] = []
  const byItself = new Set<string>()
  let probes = 0
  const keyOf = (probe: Probe): string =>
    probe.kind === 'point' || probe.kind === 'group'
      ? `${probe.unit.key}|${probe.node.key}`
      : probe.kind === 'segment'
        ? `${probe.unit.key}|part|${probe.nodes.map((node) => node.key).join(',')}`
        : `${probe.unit.key}|several`
  const truth = (probe: Probe): boolean => {
    const relevant = options.relevant(probe.unit)
    if (probe.kind === 'point' || probe.kind === 'group') return relevant.has(probe.node)
    if (probe.kind === 'segment') return probe.nodes.some((node) => relevant.has(node))
    return relevant.size >= 2
  }
  const answerTo = (probe: Probe): number => options.answer?.(probe) ?? (truth(probe) ? yes : no)
  return {
    rounds,
    probes: () => probes,
    confirmed: (unit, node) => byItself.has(`${unit.key}|${node.key}`) || (options.riding?.(node.kind === 'section' ? { kind: 'point', unit, node } : { kind: 'group', unit, node }) ?? false),
    known: (probe) => answers.get(keyOf(probe)) ?? (options.riding?.(probe) ? answerTo(probe) : null),
    rides: (probe) => options.riding?.(probe) ?? false,
    estimate: () => null,
    describe: (node) => node.key,
    size: () => 1,
    async ask(round) {
      if (round.length === 0) return { kind: 'answered' }
      rounds.push(round)
      probes += round.length
      for (const probe of round) {
        answers.set(keyOf(probe), answerTo(probe))
        if (probe.kind === 'point' || probe.kind === 'group') byItself.add(keyOf(probe))
      }
      return { kind: 'answered' }
    },
  }
}

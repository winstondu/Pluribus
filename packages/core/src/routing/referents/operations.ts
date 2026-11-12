import type { Probe, ReferentGate, ReferentOperations, ReferentQuestions, ReferentRequest } from '../../ports'
import { groupQuestion, ownQuestion, questionId, severalQuestion } from './shared'
import type { ReferentTree } from './tree'

/**
 * The operations over the decision provider: the
 * default implementation of `ReferentOperations`.
 *
 * - Point, Group and Several are yes/no questions.
 */
export interface DecisionOperations extends ReferentOperations {
  /** The questions that carry the probes in the routing request, by question ID. */
  questions(probes: readonly Probe[]): ReferentQuestions
}

export interface OperationsContext {
  readonly request: ReferentRequest
  readonly tree: ReferentTree
  /** The answers of the routing request; null while that request is being put together. */
  readonly gate: Pick<ReferentGate, 'probability'> | null
}

export type OperationsFactory = (context: OperationsContext) => DecisionOperations

export const createDecisionOperations: OperationsFactory = ({ gate }) => {
  const idOf = (probe: Probe): string =>
    probe.kind === 'point'
      ? questionId.own(probe.unit, probe.node)
      : probe.kind === 'group'
        ? questionId.group(probe.unit, probe.node)
        : questionId.several(probe.unit)
  const questionOf = (probe: Probe): ReferentQuestions[string] =>
    probe.kind === 'point'
      ? ownQuestion(probe.unit, probe.node)
      : probe.kind === 'group'
        ? groupQuestion(probe.unit, probe.node)
        : severalQuestion(probe.unit)

  const questions = (probes: readonly Probe[]): ReferentQuestions => {
    const out: { [id: string]: ReferentQuestions[string] } = {}
    for (const probe of probes) out[idOf(probe)] = questionOf(probe)
    return out
  }

  return {
    questions,
    known: (probe) => {
      const id = idOf(probe)
      return gate?.probability(id) ?? null
    },
    rides: (probe) =>
      probe.kind === 'point'
        ? probe.node.entry.listed
        : probe.kind === 'group'
          ? probe.node.members.every((m) => m.entry.listed)
          : true,
  }
}

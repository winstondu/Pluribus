import { describe, expectTypeOf, test } from 'vitest'
import type { NodeId } from '@committee/protocol'
import type {
  CandidateChain,
  PlannedClarification,
  PlannedRevision,
  PlannedSessionRequirement,
  PlannedUnit,
  RoutingInput,
  RoutingPlan,
} from '../../src/ports/router'

/** The router seam as settled by the first review of the contracts. */
describe('routing plan', () => {
  test('a chain offers its settled head separately from its tip, and the head may be absent', () => {
    expectTypeOf<CandidateChain['headNodeId']>().toEqualTypeOf<NodeId | null>()
    expectTypeOf<CandidateChain['tipNodeId']>().toEqualTypeOf<NodeId>()
  })

  test('one question can block several units: clarifications are on the plan, not on the unit', () => {
    expectTypeOf<PlannedUnit>().not.toHaveProperty('clarification')
    expectTypeOf<RoutingPlan['clarifications']>().toEqualTypeOf<readonly PlannedClarification[]>()
    expectTypeOf<PlannedClarification['blockedDirectiveIds']>().items.not.toBeNullable()
  })

  test('a message can hold several revisions, each optionally one fragment of a composite', () => {
    expectTypeOf<RoutingPlan['revisions']>().toEqualTypeOf<readonly PlannedRevision[]>()
    expectTypeOf<RoutingPlan>().not.toHaveProperty('revision')
    expectTypeOf<PlannedRevision['fragment']>().toBeNullable()
  })

  test('a session-wide requirement can be replaced or withdrawn by a plan', () => {
    expectTypeOf<RoutingPlan['sessionRequirements']>().toEqualTypeOf<readonly PlannedSessionRequirement[]>()
    expectTypeOf<PlannedSessionRequirement['replacesRequirementId']>().toBeNullable()
    expectTypeOf<RoutingPlan>().toHaveProperty('withdrawnSessionRequirementIds')
    expectTypeOf<PlannedRevision>().toHaveProperty('targetRequirementIds')
  })

  test('Undo split can ask for an atomic routing of the original message', () => {
    expectTypeOf<RoutingInput['forcedComposition']>().toEqualTypeOf<'atomic' | null>()
  })
})

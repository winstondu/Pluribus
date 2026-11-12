/**
 * The routing slice of core: the routing pipeline behind `Router`
 * (11 · "Routing"), the referent strategies it takes its reply targets from,
 * validation, the clarification and target-ambiguity
 * elicitations, Undo split, and the labelled routing corpus with its
 * evaluator. Importing this registers `routingModule` with the engine's
 * defaults.
 */
import { registerCoreModule } from '../engine'
import { routingModule } from './module'

export { createRouter } from './pipeline'
export { validatePlan, topological, resolveUnitTargets, derivePlacement, AMBIGUITY_FLOOR, type Validation, type TargetResolution } from './derive'
export { routingModule, clarificationInstruction, answerClarification } from './module'
export { MAX_SECTIONS, MAX_DEPENDENCIES, MAX_CHAINS } from './supply'
export { REFERENT_STRATEGIES, referentStrategyFor, onePassStrategy, treeWalkStrategy, estimateDecisionTokens, estimateRequestTokens, decisionAllowance } from './referents'
export {
  createDecisionOperations,
  createOracleOperations,
  onePassPolicy,
  reduceToNonAncestors,
  startSet,
  strategyFromPolicy,
  treeWalkPolicy,
  type DecisionOperations,
  type OperationsContext,
  type OperationsFactory,
  type OracleOperations,
  type OracleOptions,
  type ReferentPolicy,
  type SearchInput,
  type SearchOutcome,
  type StartSet,
} from './referents'
export {
  COST_GRID_MESSAGE,
  COST_GRID_ROWS_PER_SIZE,
  COST_GRID_SEEDED_MESSAGE,
  COST_GRID_SIZES,
  costGridRows,
  formatCostGrid,
  decisionDollars,
  worstCaseCandidateSource,
  type CostGridChannel,
  type CostGridOptions,
  type CostGridRow,
  type DecisionCost,
} from './referents/cost-grid'
export * from './candidates'
export {
  applyChoice,
  chooseByRules,
  configuredChoice,
  createDecisionSelector,
  describeShape,
  genealogyShape,
  rulesSelector,
  selectStrategy,
  shapeSignature,
  strategySelectorFor,
} from './selection'
export * from './corpus'

registerCoreModule(routingModule)

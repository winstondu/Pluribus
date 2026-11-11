import type {
  ChainId,
  ChainKind,
  ConversationId,
  DirectiveId,
  DirectiveState,
  ElicitationId,
  FragmentId,
  IdFactory,
  MessageId,
  NodeId,
  Placement,
  PrerequisiteRef,
  ProviderError,
  ReplyRelation,
  Requirement,
  RoutingDecision,
  SectionId,
  SectionState,
  Settings,
  SiblingGroupId,
  TargetRedirect,
  TextSpan,
  WholeRequestBarrier,
} from '@committee/protocol'
import type { CancelSignal } from './cancel'

/**
 * The seam between the engine and the routing pipeline (11 · "Routing").
 *
 * The engine calls the router once per submitted message and carries out the
 * plan it returns: it creates the directives, nodes, chains, sibling groups,
 * dependencies and queue items. The router decides; it changes nothing.
 *
 * Until milestone 4 the router is supplied by tests (a scripted router that
 * returns the outcome the test wants). From milestone 4 the default router
 * is the pipeline: decision gate, generative decomposition, deterministic
 * validation. Either way the engine sees only this interface.
 */
export interface Router {
  /**
   * Decides how one message is routed. Never rejects: provider failures are
   * a `failed` outcome. Must not mint IDs except through `input.ids`, and
   * must not read the clock, so that it stays deterministic under test.
   */
  route(input: RoutingInput, signal: CancelSignal): Promise<RoutingOutcome>
}

export interface RoutingInput {
  readonly conversationId: ConversationId
  readonly messageId: MessageId
  /** The original message, exactly as typed. */
  readonly text: string
  /**
   * Explicit reply targets, already resolved by the engine: a target on a
   * superseded section points at its current replacement and the redirect
   * is listed (Q43). Empty for an untargeted message.
   */
  readonly explicitTargets: readonly SectionId[]
  readonly redirects: readonly TargetRedirect[]
  /**
   * Set when the user answered a target-ambiguity elicitation for this
   * message: the chosen sections. The router uses them as the targets and
   * must not return `target-ambiguity` again.
   */
  readonly chosenTargets: readonly SectionId[] | null
  /** What the message could refer to, build on, wait for or revise. */
  readonly candidates: RoutingCandidates
  /** Requirements already session-wide in this conversation (Q17). */
  readonly sessionRequirements: readonly Requirement[]
  readonly settings: Pick<Settings, 'models' | 'thresholds'>
  /** Mints the IDs the plan needs: directives, fragments, requirements. */
  readonly ids: IdFactory
}

/**
 * The supplied candidates (invariant 9). The decision model only ever
 * selects among these; nothing it returns may name anything else.
 */
export interface RoutingCandidates {
  /** Current answer sections, most recent last. Superseded and dropped sections are never candidates (Q43). */
  readonly sections: readonly CandidateSection[]
  /** Every chain, with its head. */
  readonly chains: readonly CandidateChain[]
  /** Every directive that is not superseded or cancelled: existing results and work in flight. */
  readonly work: readonly CandidateWork[]
  /** Sibling groups, open and closed. */
  readonly groups: readonly CandidateGroup[]
}

export interface CandidateSection {
  readonly sectionId: SectionId
  readonly directiveId: DirectiveId
  readonly messageId: MessageId
  readonly title: string
  /** The request this section answers. */
  readonly request: string
  /** Opening of the answer text so far; empty while pending. */
  readonly excerpt: string
  readonly state: SectionState
  readonly chainId: ChainId
  readonly nodeId: NodeId
  /** Set when the section is a clarification question still awaiting its answer (Q98). */
  readonly asksElicitationId: ElicitationId | null
}

export interface CandidateChain {
  readonly chainId: ChainId
  readonly kind: ChainKind
  readonly label: string
  /** The chain's last node: where work that continues the chain builds on. A leaf for join-chain purposes (Q86). */
  readonly headNodeId: NodeId
  /** True while any work on the chain is in flight. */
  readonly busy: boolean
}

export interface CandidateWork {
  readonly directiveId: DirectiveId
  readonly label: string
  readonly instruction: string
  readonly state: DirectiveState
  /** Its current section, if one is open. */
  readonly sectionId: SectionId | null
  readonly nodeId: NodeId
  readonly chainId: ChainId
  /** The node it builds on: its starting context. Null for a root. */
  readonly startNodeId: NodeId | null
  /** The sibling group it is a member of. */
  readonly groupId: SiblingGroupId | null
  /**
   * Directives whose results its latest attempt consumed, from the recorded
   * context: the candidates for "affected work" when one of them is revised
   * (Q44). Empty until it has started.
   */
  readonly consumed: readonly DirectiveId[]
}

export interface CandidateGroup {
  readonly groupId: SiblingGroupId
  readonly open: boolean
  readonly baseChainId: ChainId
  readonly startNodeId: NodeId
  /** In submission order. */
  readonly memberDirectiveIds: readonly DirectiveId[]
  /** "neighborhoods + activities". */
  readonly label: string
}

export type RoutingOutcome =
  /** Routing is settled; the engine carries the plan out. */
  | { readonly kind: 'plan'; readonly plan: RoutingPlan }
  /**
   * The target is genuinely ambiguous: the best candidate is below the
   * target-choice threshold (Q20, Q74). The engine raises a target-ambiguity
   * elicitation, does not act on the message, and calls the router again
   * with `chosenTargets` once the user has chosen. Never guessed silently.
   */
  | {
      readonly kind: 'target-ambiguity'
      /** Existing sections only. */
      readonly candidates: readonly { readonly sectionId: SectionId; readonly confidence: number }[]
    }
  /** The decision provider or the decomposer failed. The engine records `routing-failed`; Retry routes again. */
  | { readonly kind: 'failed'; readonly error: ProviderError }


/** One directive the plan creates. */
export interface PlannedUnit {
  /** Minted with `input.ids`. */
  readonly directiveId: DirectiveId
  /** Set for a fragment of a composite, with what decomposition recorded for it (Q59). */
  readonly fragment: {
    readonly fragmentId: FragmentId
    readonly sourceSpans: readonly TextSpan[]
    readonly rewrittenText: string
  } | null
  /** The instruction the run is given: the message text, or the fragment's rewrite. */
  readonly instruction: string
  /** Short noun phrase naming the work. */
  readonly label: string
  /** Requirements that apply to this unit, shared ones included (Q4). Local unless explicitly session-wide (Q17). */
  readonly requirements: readonly Requirement[]
  /** Never `revision`: a revision creates no directive and is described by `RoutingPlan.revision`. */
  readonly relation: Exclude<ReplyRelation, 'revision'>
  /** Resolved reply targets among the supplied sections. */
  readonly targets: readonly SectionId[]
  /** Context ancestry. May reference another unit of this plan by its `directiveId`. */
  readonly placement: Placement
  /**
   * Result dependencies. May reference another unit of this plan. Must be
   * acyclic, and must name a whole sibling group rather than two or more of
   * its members (Q30): the plan is rejected by validation otherwise.
   */
  readonly prerequisites: readonly PrerequisiteRef[]
  /**
   * Set when the unit cannot proceed without asking the user (Q23, Q34).
   * The engine raises a clarification elicitation, creates the question as
   * its own directive, and holds this unit until it is answered.
   */
  readonly clarification: {
    readonly reason: 'missing-information' | 'incompatible-requirements'
    /** What is missing or in conflict, for the question's instruction. Not shown to the user as is. */
    readonly about: string
  } | null
}

/** A revision concluded from corrective wording (Q37, Q79). */
export interface PlannedRevision {
  /**
   * - `work`: corrects the targeted work only (Q17).
   * - `shared-requirement`: changes a brief several requests consumed; the
   *   engine raises a choice with default over `affected` (Q42, Q44).
   */
  readonly scope: 'work' | 'shared-requirement'
  /** The user's correction as later context will read it (Q39). */
  readonly correction: string
  /** The directives whose work is corrected. For a shared requirement: the directive that established the brief. */
  readonly targetDirectiveIds: readonly DirectiveId[]
  /**
   * For a shared requirement: every consumer of the brief that may need
   * redoing, with the pre-selection of what is judged actually affected
   * (Q44). Empty for `work`.
   */
  readonly affected: readonly { readonly directiveId: DirectiveId; readonly preselected: boolean }[]
}

/**
 * Everything the engine needs to act on one message. Deterministic
 * validation has already passed: dependencies are acyclic, no subset
 * bypasses a full join-back, and `units` of a sequential composite are in
 * topological order with ties in original textual order (Q53).
 */
export interface RoutingPlan {
  /** The record for the `routing-decided` event and the run inspector. */
  readonly decision: RoutingDecision
  /**
   * - `atomic`: one unit, or none when the message only revises or only
   *   answers a clarification.
   * - `independent-composite`: one user message, one reply group (Q9, Q18).
   * - `sequential-composite`: shown as split messages, one per unit, in the
   *   order of `units` (Q53).
   */
  readonly composition: 'atomic' | 'independent-composite' | 'sequential-composite'
  readonly units: readonly PlannedUnit[]
  /** Whole-request barrier: if any unit is blocked, every unit waits (Q19, Q25). Clarification questions are never held by it (Q26). */
  readonly barrier: WholeRequestBarrier | null
  /** Directive IDs in the explicit output order the user asked for, which overrides first-output order in the group (Q18). */
  readonly outputOrder: readonly DirectiveId[] | null
  /** Requirements the user made session-wide in this message (Q17). */
  readonly sessionRequirements: readonly Requirement[]
  /** Set when the message revises earlier work. */
  readonly revision: PlannedRevision | null
  /**
   * Set when the message is the answer to a pending clarification, whether
   * it was targeted at the question or recognised as the answer (Q98). The
   * engine resolves the elicitation and releases the directives it blocked.
   */
  readonly answersElicitationId: ElicitationId | null
  /** The decomposition model, when decomposition ran. */
  readonly decompositionModel: string | null
}

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
  RequirementId,
  RoutingDecision,
  SectionId,
  SectionState,
  Settings,
  SiblingGroupId,
  TargetRedirect,
  TextSpan,
  WholeRequestBarrier,
} from '@pluribus/protocol'
import type { CancelSignal } from './cancel'

/**
 * The seam between the engine and the routing pipeline (11 · "Routing").
 *
 * The engine calls the router for each submitted message and carries out
 * the plan it returns: it creates the directives, nodes, chains, sibling
 * groups, dependencies and queue items. The router decides; it changes
 * nothing. A message is routed again, with the same message ID, after the
 * user chose among ambiguous targets, after Undo split, after a routing
 * failure the user retried, and on start when its first routing was lost
 * with the executor.
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
   * Explicit reply targets, already resolved by the engine (core-engine's
   * job, in every milestone): a target on a superseded section points at
   * its current replacement and the redirect is listed (Q43). Empty for an
   * untargeted message.
   */
  readonly explicitTargets: readonly SectionId[]
  readonly redirects: readonly TargetRedirect[]
  /**
   * Set when the user answered a target-ambiguity elicitation for this
   * message: the chosen sections. The router uses them as the targets and
   * must not return `target-ambiguity` again.
   */
  readonly chosenTargets: readonly SectionId[] | null
  /**
   * `atomic` when the message is routed again after Undo split (Q53, Q85):
   * the router must return a plan whose composition is `atomic` and must
   * not call the decomposer. Null otherwise.
   */
  readonly forcedComposition: 'atomic' | null
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
  /** Sibling groups, open and closed. Dissolved groups are never candidates. */
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
  /**
   * Where work that continues the chain without waiting builds on: the
   * chain's last node whose own work is not in flight (a completed or
   * ended exchange, or a join-back). Nodes of a late-retry tail are never
   * the head. Null while every node of the chain is in flight: nothing on
   * it can be read yet.
   *
   * With only A running on the trip chain this is the brief, not A, so
   * work sent meanwhile becomes a fork beside A (01, C1).
   */
  readonly headNodeId: NodeId | null
  /**
   * The chain's last node, in flight or not. A leaf for join-chain
   * purposes (Q86), and what result-dependent work builds on when it needs
   * the result still being produced: such a unit must carry a `directive`
   * prerequisite on that node's directive.
   */
  readonly tipNodeId: NodeId
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
  /**
   * The session-wide requirements its latest attempt read: the candidates
   * for "affected work" when one of them is replaced or withdrawn (06,
   * Q44). Empty until it has started.
   */
  readonly consumedRequirements: readonly RequirementId[]
}

export interface CandidateGroup {
  readonly groupId: SiblingGroupId
  readonly open: boolean
  readonly baseChainId: ChainId
  readonly startNodeId: NodeId
  /** In submission order. Members withdrawn by Undo split are not listed. */
  readonly memberDirectiveIds: readonly DirectiveId[]
  /**
   * The node of its current join-back, once it has closed: what work that
   * continues from the group as a whole builds on (`CandidateWork.startNodeId`
   * of that work). Null while the group is open.
   */
  readonly joinBackNodeId: NodeId | null
  /** "neighborhoods + activities". */
  readonly label: string
}

export type RoutingOutcome =
  /** Routing is settled; the plan is carried out. */
  | { readonly kind: 'plan'; readonly plan: RoutingPlan }
  /**
   * The target is genuinely ambiguous: the best candidate is below the
   * target-choice threshold (Q20, Q74). The message is not acted on: a
   * target-ambiguity elicitation is raised, and the router is called again
   * with `chosenTargets` once the user has chosen. Never guessed silently.
   * The routing slice handles this outcome (its `outcomeHandlers` entry);
   * the engine only offers the hook and the way to route again.
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
  /**
   * True when `label` is only the request's first words (`provisionalLabel`),
   * as for an atomic message, which has no decomposition to name it. The
   * engine then asks `Decomposer.label` in the background, when the
   * decomposer has one, and records `directive-labeled` if it answers.
   */
  readonly labelIsProvisional: boolean
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
}

/**
 * One question to the user that blocks one or more units of the plan (Q23,
 * Q34). An ambiguous shared requirement blocks every fragment it applies
 * to and is still asked once (07 · "Clarification"), which is why this is
 * stated on the plan and not on each unit.
 *
 * Carrying it out (the routing slice's plan applier): one clarification
 * elicitation, the question as a directive of its own that is never held
 * by the whole-request barrier (E1), and every blocked unit held until the
 * answer arrives.
 */
export interface PlannedClarification {
  /** The directive that writes the question. Minted with `input.ids`. */
  readonly questionDirectiveId: DirectiveId
  readonly reason: 'missing-information' | 'incompatible-requirements'
  /** What is missing or in conflict, for the question's instruction. Not shown to the user as is. */
  readonly about: string
  /** Units of this plan that cannot proceed without the answer. At least one; a unit is named by at most one clarification. */
  readonly blockedDirectiveIds: readonly DirectiveId[]
}

/**
 * A revision concluded from corrective wording (Q37, Q79). A message may
 * hold several, and may hold new work beside them: each corrective
 * fragment of a composite is its own revision.
 */
export interface PlannedRevision {
  /**
   * - `work`: corrects the targeted work only (Q17).
   * - `shared-requirement`: changes a brief several requests consumed, or
   *   a session-wide requirement; a choice with default is raised over
   *   `affected` when it is not empty (Q42, Q44).
   */
  readonly scope: 'work' | 'shared-requirement'
  /** The user's correction as later context will read it (Q39). For a fragment, its rewritten text. */
  readonly correction: string
  /** Set when the correction is one fragment of a composite, with what decomposition recorded for it (Q59). Null when the whole message is the correction. */
  readonly fragment: {
    readonly fragmentId: FragmentId
    readonly sourceSpans: readonly TextSpan[]
    readonly rewrittenText: string
  } | null
  /**
   * The directives whose work is corrected. For a shared requirement: the
   * directive that established the brief. May be empty only when
   * `targetRequirementIds` is not.
   */
  readonly targetDirectiveIds: readonly DirectiveId[]
  /**
   * Session-wide requirements this correction replaces or withdraws (Q17),
   * among `RoutingInput.sessionRequirements`. Each must be named by an
   * entry of the plan's `sessionRequirements` (as `replacesRequirementId`)
   * or by `withdrawnSessionRequirementIds`. Empty for a correction to work.
   */
  readonly targetRequirementIds: readonly RequirementId[]
  /**
   * For a shared requirement: every consumer of the brief that may need
   * redoing, with the pre-selection of what is judged actually affected
   * (Q44). Empty for `work`.
   */
  readonly affected: readonly { readonly directiveId: DirectiveId; readonly preselected: boolean }[]
}

/** A requirement the user made session-wide in this message (Q17). */
export interface PlannedSessionRequirement {
  readonly requirement: Requirement
  /** The session-wide requirement it takes the place of, among `RoutingInput.sessionRequirements`. Null for a new one. */
  readonly replacesRequirementId: RequirementId | null
}

/**
 * Everything the engine needs to act on one message. Deterministic
 * validation has already passed: dependencies are acyclic, no subset
 * bypasses a full join-back, and `units` of a sequential composite are in
 * topological order with ties in original textual order (Q53).
 *
 * Validation repairs what has one correct reading and refuses the rest:
 * - two or more members of a sibling group become the whole group (Q30);
 * - a join-chain parent that is not a leaf becomes its chain's current
 *   leaf, whose ancestry already includes it (Q86, Q97);
 * - `continue` on a node whose own directive is in flight, in a unit with
 *   no `directive` prerequisite on that directive, becomes `continue` on
 *   the nearest ancestor that is not in flight (the node's starting
 *   context), so the unit is a fork beside the running work (01, C1). When
 *   there is no such ancestor the unit becomes `new-chain`, or, for the
 *   first node of a join chain, a join chain with the same parents;
 * - a `sibling-group` point on an open group gains the `sibling-group`
 *   prerequisite on that group when the unit lacks it (C9, C15);
 * - a reference to something that was not a supplied candidate, or a
 *   dependency cycle, makes the outcome `failed` with code
 *   `malformed-response`.
 * The engine checks the same rules again before acting, applies the same
 * repairs to a supplied plan, and refuses a plan that still breaks them.
 */
export interface RoutingPlan {
  /** The record for the `routing-decided` event and the run inspector. */
  readonly decision: RoutingDecision
  /**
   * - `atomic`: one unit, or none when the message only revises or only
   *   answers a clarification. Required when `forcedComposition` is set.
   * - `independent-composite`: one user message, one reply group (Q9, Q18).
   *   With a single unit beside its revisions, the reply is not grouped.
   * - `sequential-composite`: shown as split messages, one per unit, in the
   *   order of `units` (Q53).
   */
  readonly composition: 'atomic' | 'independent-composite' | 'sequential-composite'
  readonly units: readonly PlannedUnit[]
  /** Whole-request barrier: if any unit is blocked, every unit waits (Q19, Q25). Clarification questions are never held by it (Q26). */
  readonly barrier: WholeRequestBarrier | null
  /** Directive IDs in the explicit output order the user asked for, which overrides first-output order in the group (Q18). */
  readonly outputOrder: readonly DirectiveId[] | null
  /** Requirements the user made session-wide in this message (Q17), new or replacing an earlier one. */
  readonly sessionRequirements: readonly PlannedSessionRequirement[]
  /** Session-wide requirements the message takes back without replacing them. */
  readonly withdrawnSessionRequirementIds: readonly RequirementId[]
  /** Questions that must be answered before some units can run. Empty when nothing is blocked on the user. */
  readonly clarifications: readonly PlannedClarification[]
  /** The corrections the message makes to earlier work. Empty when it revises nothing. */
  readonly revisions: readonly PlannedRevision[]
  /**
   * Set when the message is the answer to a pending clarification, whether
   * it was targeted at the question or recognised as the answer (Q98). The
   * routing slice's plan applier resolves the elicitation and releases the
   * directives it blocked.
   */
  readonly answersElicitationId: ElicitationId | null
  /** The decomposition model, when decomposition ran. */
  readonly decompositionModel: string | null
}

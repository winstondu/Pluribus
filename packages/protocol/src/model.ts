import type {
  AttemptId,
  ChainId,
  DirectiveId,
  ElicitationId,
  FragmentId,
  JoinBackId,
  MessageId,
  NodeId,
  RequirementId,
  SectionId,
  SiblingGroupId,
} from './ids'

/**
 * Domain value types shared by events, commands, projections and core's ports.
 * Everything here is plain JSON data: no classes, no `undefined` holes, no
 * functions, so it survives `structuredClone`, IndexedDB and a network hop.
 *
 * Convention: a field that may be absent is `T | null`, never optional, so a
 * stored record always has the same keys.
 */

// ───────────────────────────── text ─────────────────────────────

/** Half-open UTF-16 range `[start, end)` into an original message's exact text (Q3, Q59). */
export interface TextSpan {
  readonly start: number
  readonly end: number
}

// ───────────────────────── work and its states ─────────────────────────

/**
 * What a directive produces.
 * - `answer`: an ordinary answer section.
 * - `clarification-question`: the question text of a clarification elicitation.
 *   It is its own directive so that it is never held by the whole-request
 *   barrier (Q26, E1) and carries a reply affordance like any section (Q98).
 */
export type DirectiveKind = 'answer' | 'clarification-question'

/**
 * The situation of a directive (01 · "The unit of work"). The first ten are
 * the specification's table; the last three are build refinements that the
 * table folds into its neighbours and that must never be shown under another
 * state's wording.
 */
export type DirectiveState =
  /** Waiting for a result it needs. Released only by success, never by streaming text (Q33). */
  | 'dependency-queued'
  /** The result it needs failed, was stopped, or was interrupted; waiting for the recovery choice (Q48). No default. */
  | 'paused'
  /** Ready, held back by a provider's rate limit (429). Never shown as a dependency wait (Q47, Q60). */
  | 'waiting-for-capacity'
  /** An attempt is in flight: status only, or streaming answer text. */
  | 'running'
  /** Finished successfully. Only this releases dependents (invariant 4). */
  | 'completed'
  /** Ended in an error after any automatic retries. Local to the directive (invariant 5). */
  | 'failed'
  /** An attempt the user ended deliberately. An attempt Committee ends to replace it is superseded, not stopped. */
  | 'stopped'
  /** Cancelled by the user before it started (Q91): queued work inside a stopped request, or a paused request the user cancelled. */
  | 'cancelled'
  /** Lost because whatever was executing it stopped unexpectedly (Q52). */
  | 'interrupted'
  /**
   * Replaced as a whole and kept as history. A directive itself reaches this
   * only through Undo split (its work was restarted as one atomic request).
   * A revision supersedes a *section* of the directive, and the directive
   * carries on in the replacement section.
   */
  | 'superseded'
  /**
   * Build refinement. Every prerequisite is satisfied and no rate limit
   * applies; the directive is held only by the concurrency limit (Q60).
   * Shown as "Waiting for a free slot", never as dependency-queued (P6).
   */
  | 'ready'
  /**
   * Build refinement. Between automatic retries: the last attempt failed
   * with a transient error or was interrupted, and the next attempt is
   * scheduled after a backoff. Status text "Retrying…". A member in this
   * state keeps its sibling group open (Q92).
   */
  | 'retrying'
  /**
   * Build refinement. Cannot start until the user answers an elicitation: a
   * clarification that blocks it (Q23, Q26), or a choice with default that
   * decides whether and how it is redone (Q44). Not a result dependency: it
   * has no queue item.
   */
  | 'awaiting-elicitation'

/** States in which a directive counts as not yet started (a revision edits it in place, Q41). */
export const NOT_STARTED_STATES: readonly DirectiveState[] = [
  'dependency-queued',
  'paused',
  'ready',
  'awaiting-elicitation',
]

/**
 * States in which a directive is still going to produce, or may still
 * produce, a result without user action. A sibling-group member in one of
 * these keeps its group open (Q49, Q92).
 */
export const IN_FLIGHT_STATES: readonly DirectiveState[] = [
  'dependency-queued',
  'ready',
  'waiting-for-capacity',
  'running',
  'retrying',
  'awaiting-elicitation',
]

/**
 * How one attempt ended, or that it is still going. Terminal states never
 * change afterwards (invariant 3).
 */
export type AttemptState =
  /** In flight, no answer text yet (status only). */
  | 'running'
  /** In flight with answer text visible. */
  | 'streaming'
  | 'completed'
  /** Execution error. `AttemptFailed.retry` says whether another attempt follows automatically. */
  | 'failed'
  /** Ended by the user. Visible text stays as partial (Q22). */
  | 'stopped'
  /** Lost with its executor (Q52). */
  | 'interrupted'
  /** Ended by Committee in order to replace it (Q38). Its dependents follow the replacement and are not paused. */
  | 'superseded'

export type TerminalAttemptState = Exclude<AttemptState, 'running' | 'streaming'>

/**
 * Run inspector item 6: whether an attempt's result is the one in force.
 * `superseded` also covers a completed attempt whose section was later
 * replaced by a revision.
 */
export type AttemptResultStatus = 'in-flight' | 'current' | 'superseded' | 'failed' | 'stopped' | 'interrupted'

/** Why an attempt exists. */
export type AttemptOrigin =
  | 'initial'
  /** Standard or Persistent policy after a transient failure (Q47). */
  | 'automatic-retry'
  /** Standard or Persistent policy after an interruption, counted against the same limit (Q54). */
  | 'interruption-recovery'
  /** The Retry control. */
  | 'user-retry'
  /** Replacement started by a revision of this directive (Q35, Q38). */
  | 'revision'
  /** Restart of a dependent whose prerequisite was revised while it ran (Q36). */
  | 'prerequisite-revised'
  /** The Regenerate control (Q40). */
  | 'regenerate'
  /** Redo selected, or defaulted, in a choice with default (Q44, Q45). */
  | 'redo'

/** The states a section can show (10 · "States a section can show"). */
export type SectionState =
  /** No answer text yet: a responding bubble or pending section. */
  | 'pending'
  | 'streaming'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'interrupted'
  | 'cancelled'
  | 'superseded'

/** Model roles with their own model setting (Q65, Q90). */
export type ModelRole =
  /** Answer runs, including work continuing from a join-back (Q90) and clarification questions. */
  | 'answer'
  | 'decomposition'
  /** Answer runs on a join chain only (Q65, Q90). */
  | 'synthesis'
  | 'decision'

export interface TokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
}

// ───────────────────────────── failures ─────────────────────────────

/**
 * Typed provider failure, mapped from OpenRouter per 11 · "OpenRouter error
 * mapping". The class decides whether the retry setting applies.
 */
export type ProviderErrorCode =
  // transient: retried automatically under Standard and Persistent
  /** HTTP 408. */
  | 'timeout'
  /** HTTP 429. Honors Retry-After; shown as "Waiting for capacity". */
  | 'rate-limited'
  /** HTTP 502. */
  | 'bad-gateway'
  /** HTTP 503. Honors Retry-After. */
  | 'service-unavailable'
  /** Any other 5xx. */
  | 'provider-error'
  /** HTTP 200 with no content. */
  | 'empty-response'
  /** The request or the stream broke at the network level. */
  | 'network'
  /** An SSE chunk with `finish_reason: "error"` under HTTP 200. */
  | 'mid-stream-error'
  // non-retryable: straight to failed
  /** HTTP 402. Message is exactly "Out of OpenRouter credits". */
  | 'out-of-credits'
  /** HTTP 403, with the provider's reason. */
  | 'moderation'
  /** The model declined to answer. */
  | 'refusal'
  /** HTTP 400 and any other 4xx, with the provider's message. */
  | 'invalid-request'
  /** HTTP 401, with the provider's message. */
  | 'unauthorized'
  /** No OpenRouter key is configured. */
  | 'no-key'
  /** Provider error code `context_length_exceeded`, or the pre-run token count is over the limit (Q67, Q82). */
  | 'context-length-exceeded'
  /** The response could not be parsed into the expected shape (decisions, decomposition). */
  | 'malformed-response'

export type ProviderErrorClass = 'transient' | 'non-retryable'

/** The class of every code. The single source of truth: never classify by hand. */
export const PROVIDER_ERROR_CLASS: { readonly [C in ProviderErrorCode]: ProviderErrorClass } = {
  timeout: 'transient',
  'rate-limited': 'transient',
  'bad-gateway': 'transient',
  'service-unavailable': 'transient',
  'provider-error': 'transient',
  'empty-response': 'transient',
  network: 'transient',
  'mid-stream-error': 'transient',
  'out-of-credits': 'non-retryable',
  moderation: 'non-retryable',
  refusal: 'non-retryable',
  'invalid-request': 'non-retryable',
  unauthorized: 'non-retryable',
  'no-key': 'non-retryable',
  'context-length-exceeded': 'non-retryable',
  'malformed-response': 'non-retryable',
}

export interface ProviderError {
  readonly code: ProviderErrorCode
  /** Always `PROVIDER_ERROR_CLASS[code]`; stored so a record reads on its own. */
  readonly class: ProviderErrorClass
  /** Text for the user. For `out-of-credits` exactly "Out of OpenRouter credits". Never contains the key. */
  readonly message: string
  readonly httpStatus: number | null
  /** From `Retry-After` on 429 and 503, in milliseconds. */
  readonly retryAfterMs: number | null
}

/** Builds a {@link ProviderError} with the class filled in from the code. */
export function providerError(
  code: ProviderErrorCode,
  message: string,
  details: { httpStatus?: number | null; retryAfterMs?: number | null } = {},
): ProviderError {
  return {
    code,
    class: PROVIDER_ERROR_CLASS[code],
    message,
    httpStatus: details.httpStatus ?? null,
    retryAfterMs: details.retryAfterMs ?? null,
  }
}

/**
 * Maps an HTTP status to a code per 11 · "OpenRouter error mapping". The
 * caller still has to recognise `context_length_exceeded` in the body, an
 * empty 200, and mid-stream error chunks.
 */
export function providerErrorCodeForStatus(status: number): ProviderErrorCode {
  switch (status) {
    case 408:
      return 'timeout'
    case 429:
      return 'rate-limited'
    case 502:
      return 'bad-gateway'
    case 503:
      return 'service-unavailable'
    case 402:
      return 'out-of-credits'
    case 403:
      return 'moderation'
    case 401:
      return 'unauthorized'
    default:
      return status >= 500 ? 'provider-error' : 'invalid-request'
  }
}

/** What follows a failed or interrupted attempt. */
export type RetryPlan =
  | {
      readonly kind: 'none'
      /**
       * - `non-retryable`: the error class forbids it.
       * - `manual-policy`: the retry setting is Manual (Q47, Q54).
       * - `exhausted`: the automatic retry limit was reached.
       */
      readonly reason: 'non-retryable' | 'manual-policy' | 'exhausted'
    }
  | {
      readonly kind: 'scheduled'
      /** Clock time (ms) at which the next attempt may start. */
      readonly at: number
      /** `rate-limit` puts the directive in waiting-for-capacity; `backoff` in retrying. */
      readonly wait: 'backoff' | 'rate-limit'
      /** 1-based count of automatic retries used by this directive's section, including this one. */
      readonly retryNumber: number
    }

// ─────────────────────────── requirements ───────────────────────────

/**
 * How far a requirement reaches. Local is the default; session-wide only when
 * the user says so explicitly ("from now on", "in this chat") and then applies
 * across all chains of this conversation, never across conversations (Q17, Q70).
 */
export type RequirementScope = 'local' | 'session-wide'

export interface Requirement {
  readonly id: RequirementId
  /** The requirement as it is given to the run. */
  readonly text: string
  readonly scope: RequirementScope
  /** True when it applies to more than one fragment of its message (Q4). */
  readonly shared: boolean
  /** Where it came from, so a lost requirement can be traced to decomposition (Q59). */
  readonly provenance: {
    readonly messageId: MessageId
    /** Span in the original message's text, when the requirement is a quotable part of it. */
    readonly span: TextSpan | null
  }
}

// ─────────────────────── routing: relation and placement ───────────────────────

/** 05 · "What kind of work it is": the relation of a follow-up to existing work. */
export type ReplyRelation =
  /** No relation to existing work. */
  | 'new'
  /** Builds on existing context without needing an unfinished result. */
  | 'addition'
  /** Needs a result that is not available yet. */
  | 'result-dependent'
  /** Corrective or replacing wording (Q37). Below the "clearly corrective" threshold it is `addition` (Q74). */
  | 'revision'

/** A point in the genealogy that new work builds on. */
export type PointRef =
  /** An existing node. Exact. */
  | { readonly kind: 'node'; readonly nodeId: NodeId }
  /**
   * A sibling group as a whole: its join-back, whether already formed or
   * not. Resolved to the join-back node when the attempt starts. Work that
   * needs more than one member must use this, never a subset (Q30).
   */
  | { readonly kind: 'sibling-group'; readonly groupId: SiblingGroupId }
  /** A directive created by the same routing plan (an earlier sequential part). Resolved when that directive's node exists. */
  | { readonly kind: 'directive'; readonly directiveId: DirectiveId }

/**
 * The only placement choices for new work (Q76). Placement is context
 * ancestry only: whether the work must *wait* is a separate result dependency
 * ({@link PrerequisiteRef}) and neither is derived from the other.
 */
export type Placement =
  /** Unrelated work: a new root. */
  | { readonly kind: 'new-chain' }
  /**
   * Builds on a chain's context: a child of `buildsOn`. The engine decides
   * mechanically whether that is the same chain continuing, a fork beside
   * in-flight work from the same starting context, or a new branch from one
   * sibling (01 · "Where new work goes", Q78, Q89).
   */
  | { readonly kind: 'continue'; readonly buildsOn: PointRef }
  /**
   * Needs lines that have diverged: a new chain whose parents are two or
   * more nodes, each the leaf of its chain when the join chain is created
   * (Q86, Q88). Never used for siblings of one group (Q30).
   */
  | { readonly kind: 'join-chain'; readonly parents: readonly PointRef[] }

/**
 * A result a directive needs before it can start. Dependencies are a DAG and
 * release only on success (invariant 4).
 */
export type PrerequisiteRef =
  /**
   * The result of one directive: its current section's successful attempt.
   * Follows replacements, so a dependent of A waits for A′ after a revision
   * (Q36). Needs only that section, not the rest of its reply group (Q33).
   */
  | { readonly kind: 'directive'; readonly directiveId: DirectiveId }
  /**
   * The full join-back of a sibling group: satisfied once the group has
   * closed, its join-back has formed, and every member has completed or has
   * been waived by "Continue without". A sibling admitted while the group is
   * open extends the wait (Q33, C16).
   */
  | { readonly kind: 'sibling-group'; readonly groupId: SiblingGroupId }

/**
 * Whole-request barrier (Q19, Q25): the message relates its outputs to one
 * another, so if any part is blocked every part waits. A requirement that
 * applies to each part separately creates no barrier.
 */
export interface WholeRequestBarrier {
  readonly reason: 'explicit-order' | 'combined-limit' | 'integrated-presentation'
  /** The qualifier in the user's words, for the queue item and the inspector. */
  readonly qualifier: string
}

// ───────────────────────── routing decision record ─────────────────────────

/** A decision with the decision model's confidence, where one exists. */
export interface Decided<T> {
  readonly value: T
  /** 0–1. Null when the value was supplied, explicit, or follows deterministically. */
  readonly confidence: number | null
}

/** One bounded question put to the decision model and its answer, kept for the run inspector. */
export interface DecisionQuestionRecord {
  readonly id: string
  readonly type: 'noul' | 'choice' | 'score'
  readonly instructions: string
  /** The supplied candidates: option → description for `choice`, criteria for `score`, empty for `noul`. */
  readonly candidates: { readonly [option: string]: string }
  /** `noul`: probability of yes. `choice`: the chosen option. `score`: the score. */
  readonly answer: number | string
  readonly confidence: number | null
  readonly probabilities: { readonly [option: string]: number } | null
}

/** A reply to a superseded section resolves to its current replacement (Q43, T3). */
export interface TargetRedirect {
  readonly from: SectionId
  readonly to: SectionId
}

/** The routing of one unit of a message: the whole message when atomic, one fragment when composite. */
export interface UnitRoutingDecision {
  /** Stable within the decision: `"message"` for an atomic message, the fragment's key otherwise. */
  readonly key: string
  readonly fragmentId: FragmentId | null
  readonly relation: Decided<ReplyRelation>
  /**
   * Confidence that the wording is clearly corrective. Below
   * `thresholds.clearlyCorrective` the relation recorded above is `addition`
   * and nothing is superseded (Q37, Q74).
   */
  readonly correctiveConfidence: number | null
  readonly targets: {
    /** Resolved targets after any redirect. Existing sections only: inference never invents one (Q20). */
    readonly sectionIds: readonly SectionId[]
    /**
     * - `explicit`: the user used a section's reply affordance.
     * - `inferred`: selected by the decision model above the threshold.
     * - `elicited`: the user chose in a target-ambiguity elicitation.
     * - `none`: the message addresses no existing section.
     */
    readonly mode: 'explicit' | 'inferred' | 'elicited' | 'none'
    /** Every candidate that was scored, with its confidence. */
    readonly candidates: readonly { readonly sectionId: SectionId; readonly confidence: number }[]
    readonly redirected: readonly TargetRedirect[]
  }
  readonly placement: Decided<Placement>
  readonly prerequisites: Decided<readonly PrerequisiteRef[]>
  /** Probability that the unit cannot proceed without asking the user (Q23, Q34). Null when not asked. */
  readonly needsClarification: number | null
  /** One or two plain sentences. States what was decided, not that it was right (run inspector item 5). */
  readonly explanation: string
}

/**
 * The recorded outcome of the routing pipeline for one submitted message
 * (run inspector item 5). The decision model only selects among supplied
 * candidates; any rewritten text comes from decomposition (invariant 9).
 */
export interface RoutingDecision {
  /**
   * - `decision-model`: produced by the routing pipeline.
   * - `supplied`: handed in by a test or a scripted router (milestones 1–3).
   */
  readonly source: 'decision-model' | 'supplied'
  /** The pinned decision model that answered (Q74), as returned by the provider. Null when supplied. */
  readonly model: string | null
  readonly composition: Decided<'atomic' | 'composite'>
  readonly units: readonly UnitRoutingDecision[]
  /** The thresholds in force when the decision was made (Q74). */
  readonly thresholds: { readonly [name: string]: number }
  readonly explanation: string
  readonly questions: readonly DecisionQuestionRecord[]
}

// ─────────────────────────── decomposition ───────────────────────────

/** One fragment as recorded: both the source span and any rewrite are kept (Q59). */
export interface FragmentRecord {
  readonly fragmentId: FragmentId
  /** Position in the original text order, 0-based. */
  readonly index: number
  /** Exact spans of the original message this fragment was taken from. */
  readonly sourceSpans: readonly TextSpan[]
  /** The atomic instruction given to the run. Written by generative decomposition, never by the decision model. */
  readonly rewrittenText: string
  /** Short noun phrase naming the work, used in queue items and notes ("neighborhoods"). */
  readonly label: string
  /** Requirements that apply to this fragment, shared ones included (Q4). */
  readonly requirements: readonly Requirement[]
  readonly directiveId: DirectiveId
}

/** One split message of a sequential composite, in display (topological) order (Q53). */
export interface SplitMessageRecord {
  readonly messageId: MessageId
  readonly fragmentId: FragmentId
  /** The text shown in the bubble: the fragment's source text. */
  readonly text: string
}

// ───────────────────────── consumed context ─────────────────────────

/** Where one message of a run's input came from. */
export type ContextOrigin =
  /** Committee's own fixed instructions to the model. */
  | { readonly kind: 'preamble' }
  /** A requirement the user explicitly made session-wide (Q17). */
  | { readonly kind: 'session-requirement'; readonly requirementId: RequirementId }
  /** The request of an ancestor exchange. */
  | {
      readonly kind: 'ancestor-request'
      readonly nodeId: NodeId
      readonly directiveId: DirectiveId
      readonly messageId: MessageId
      /** Set when the exchange was read through a join-back record. */
      readonly joinBackId: JoinBackId | null
    }
  /** The answer of an ancestor exchange, from the exact attempt that produced it. */
  | {
      readonly kind: 'ancestor-answer'
      readonly nodeId: NodeId
      readonly directiveId: DirectiveId
      readonly attemptId: AttemptId
      readonly sectionId: SectionId
      readonly joinBackId: JoinBackId | null
    }
  /**
   * A join-back member that failed, was stopped, or was interrupted: its
   * request and a marker, never its partial text (Q49, Q92).
   */
  | {
      readonly kind: 'member-marker'
      readonly nodeId: NodeId
      readonly directiveId: DirectiveId
      readonly joinBackId: JoinBackId
      readonly outcome: 'failed' | 'stopped' | 'interrupted'
    }
  /**
   * The user's correction, standing with the replacement in place of a
   * superseded body (Q39).
   */
  | {
      readonly kind: 'correction'
      readonly revisionMessageId: MessageId
      readonly directiveId: DirectiveId
    }
  /** This run's own instruction: the last message of the input. */
  | {
      readonly kind: 'request'
      readonly directiveId: DirectiveId
      readonly messageId: MessageId
      readonly fragmentId: FragmentId | null
    }

export interface ConsumedMessage {
  readonly role: 'system' | 'user' | 'assistant'
  /** Exactly the text sent to the model. */
  readonly content: string
  readonly origin: ContextOrigin
}

/**
 * Exactly what one attempt received (invariant 2). Written once on
 * `attempt-started` and never changed: later join-backs, revisions, retries
 * and source continuations do not touch it (Q29, Q31, Q39). The run inspector
 * shows this record, never a recomputation.
 */
export interface ConsumedContext {
  /** The model input, in order. A replacement or retry never contains an earlier attempt's partial text (invariant 7). */
  readonly messages: readonly ConsumedMessage[]
  /**
   * Every genealogy node whose content is in `messages`, root first. This is
   * the context ancestry the run consumed; Focus is computed from it.
   */
  readonly nodeIds: readonly NodeId[]
  /**
   * The result each consumed directive contributed: the attempt read, or a
   * marker when a join-back member did not complete. Comparing these with
   * the directives' current results is how a superseded input is detected
   * (Q40).
   */
  readonly inputs: readonly ConsumedInput[]
  /** Tokens counted before the run (Q67). */
  readonly inputTokens: number
  /** The model's context limit, when the provider knows it. */
  readonly tokenLimit: number | null
}

export interface ConsumedInput {
  readonly directiveId: DirectiveId
  /** The completed attempt whose answer was read, or null when only a marker was read. */
  readonly attemptId: AttemptId | null
  readonly marker: 'failed' | 'stopped' | 'interrupted' | null
}

// ───────────────────────── sibling groups and join-backs ─────────────────────────

export interface SiblingMember {
  readonly directiveId: DirectiveId
  readonly nodeId: NodeId
  /** The member's own fork chain (Q89). */
  readonly chainId: ChainId
}

/** One member in a join-back record, in submission order whatever order the answers arrived in (Q28, C4). */
export interface JoinBackMember {
  readonly directiveId: DirectiveId
  readonly nodeId: NodeId
  /**
   * `completed` members contribute their exchange. The others contribute
   * their request and a marker, without partial text (Q49, Q92).
   */
  readonly outcome: 'completed' | 'failed' | 'stopped' | 'interrupted'
  /** The attempt whose answer the record holds; null unless completed. */
  readonly attemptId: AttemptId | null
}

// ─────────────────────────── elicitation ───────────────────────────

export type ElicitationKind = 'target-ambiguity' | 'clarification' | 'choice-with-default' | 'recovery-choice'

/** What a paused directive's prerequisite did (Q48). */
export interface PauseCause {
  /** The directive that did not finish. */
  readonly directiveId: DirectiveId
  readonly label: string
  readonly outcome: 'failed' | 'stopped' | 'interrupted'
}

/** One piece of work offered in a choice with default (Q44). */
export interface RedoOption {
  readonly directiveId: DirectiveId
  readonly label: string
  /**
   * - `finished`: the user's choice applies.
   * - `running`: stopped at once for the wait and always redone; cannot be deselected (Q84, E4).
   * - `queued`: always picks up the change; listed for information, cannot be deselected.
   */
  readonly state: 'finished' | 'running' | 'queued'
  /** True for `running` and `queued`. */
  readonly locked: boolean
  /** The work Committee judges actually affected (Q44). Always true when locked. */
  readonly preselected: boolean
}

export type ElicitationRecord =
  | {
      readonly kind: 'target-ambiguity'
      readonly elicitationId: ElicitationId
      /** The untargeted reply that is not acted on until the user chooses (Q10, Q20). */
      readonly messageId: MessageId
      /** Existing sections only, with the confidence that fell below the threshold (Q74). */
      readonly candidates: readonly { readonly sectionId: SectionId; readonly confidence: number }[]
    }
  | {
      readonly kind: 'clarification'
      readonly elicitationId: ElicitationId
      /** The directive that writes the question, shown as an additional response (Q23). */
      readonly questionDirectiveId: DirectiveId
      /** Every directive that cannot proceed without the answer. A shared requirement blocks each fragment it applies to. */
      readonly blockedDirectiveIds: readonly DirectiveId[]
      readonly reason: 'missing-information' | 'incompatible-requirements'
    }
  | {
      readonly kind: 'choice-with-default'
      readonly elicitationId: ElicitationId
      /** The message that revised a shared requirement (Q42). */
      readonly revisionMessageId: MessageId
      readonly options: readonly RedoOption[]
      /** Clock time (ms) at which the current selection is carried out (Q45). */
      readonly deadlineAt: number
    }
  | {
      readonly kind: 'recovery-choice'
      readonly elicitationId: ElicitationId
      readonly pausedDirectiveId: DirectiveId
      readonly cause: PauseCause
    }

/**
 * The user's choice, carried by the Answer elicitation command.
 *
 * A clarification is answered by a submitted message (targeted at the
 * question, or recognised as the answer, Q98), and a recovery choice by the
 * Retry, Continue without and Cancel commands; neither uses this type.
 */
export type ElicitationAnswer =
  | {
      readonly kind: 'target-ambiguity'
      /** One or more of the offered candidate sections. */
      readonly sectionIds: readonly SectionId[]
    }
  | {
      readonly kind: 'choice-with-default'
      /** The finished work to redo. Locked options are always redone whatever is sent here (Q84). */
      readonly redo: readonly DirectiveId[]
      /**
       * `false` edits the selection and keeps waiting: the edited selection is
       * what runs when the wait elapses (Q45). `true` carries it out now.
       */
      readonly confirm: boolean
    }

/** Why a section was replaced. */
export type SupersessionCause =
  /** A revision aimed at this directive (Q35). */
  | { readonly kind: 'revision'; readonly revisionMessageId: MessageId }
  /** A prerequisite was revised while this ran, so it restarts from the replacement (Q36). */
  | { readonly kind: 'prerequisite-revised'; readonly revisionMessageId: MessageId }
  /** Regenerate (Q40). */
  | { readonly kind: 'regenerate' }
  /** Redo from a choice with default; `byDefault` when the wait elapsed or another message was sent (Q45). */
  | { readonly kind: 'redo'; readonly elicitationId: ElicitationId; readonly byDefault: boolean }
  /** Undo split restarted the work as one atomic request (Q53, Q85). */
  | { readonly kind: 'undo-split' }

/** An input of completed work that has since been replaced (Q40). */
export interface SupersededInput {
  readonly directiveId: DirectiveId
  /** Label of the replaced input, for "Based on superseded {label}". */
  readonly label: string
  /** What the work actually read: an attempt, or only a member's marker (Q92). */
  readonly consumedAttemptId: AttemptId | null
}

import type { RequirementScope, WholeRequestBarrier } from '@committee/protocol'
import type { Scene } from './scene'

/**
 * The labelled routing corpus (12 · "Verification": "labelled examples for
 * targets, chain placement, revision versus addition, splits, and
 * dependencies"). Each example is a conversation as the router sees it, a
 * new message, and what routing should conclude. It evaluates the decision
 * model (and optionally the decomposer) offline, and is what the
 * thresholds are tuned on (Q74).
 */

export type CorpusTopic = 'targets' | 'placement' | 'revision' | 'splits' | 'dependencies' | 'clarification' | 'requirements'

/** A point by handle: a node or section handle (`A`), a group (`group:G`), or a part of this message (`part:1`). */
export type Handle = string

export type PlacementExpectation = 'new-chain' | { readonly continue: Handle } | { readonly join: readonly Handle[] }

export interface UnitExpectation {
  readonly kind: 'unit'
  readonly relation?: 'new' | 'addition' | 'result-dependent'
  /** Section handles; empty for none. */
  readonly targets?: readonly Handle[]
  readonly placement?: PlacementExpectation
  /** Directive handles, `group:G`, or `part:i`. */
  readonly prerequisites?: readonly Handle[]
  /** The line of work it is handled on when nothing it refers to places it (for the oracle). */
  readonly chain?: Handle
  readonly clarification?: false | 'missing-information' | 'incompatible-requirements'
  /** Indexes of earlier parts whose result it needs. */
  readonly after?: readonly number[]
}

export interface RevisionExpectation {
  readonly kind: 'revision'
  readonly scope: 'work' | 'shared-requirement'
  /** Section handles of the corrected work. */
  readonly targets: readonly Handle[]
  /** Conversation-wide requirements it replaces or withdraws, by handle. */
  readonly requirements?: readonly Handle[]
  /** Directive handles pre-selected as actually affected (Q44). */
  readonly affected?: readonly Handle[]
}

export type PartExpectation = UnitExpectation | RevisionExpectation

export interface CorpusExpectation {
  /** Default `plan`. */
  readonly outcome?: 'plan' | 'target-ambiguity'
  /** For `target-ambiguity`: the section handles offered. */
  readonly ambiguous?: readonly Handle[]
  readonly composition?: 'atomic' | 'independent-composite' | 'sequential-composite'
  /** The message answers this open clarification question (handle). */
  readonly answers?: Handle
  /** Parts in original text order: one for an atomic message. */
  readonly parts?: readonly PartExpectation[]
  /** Order of the units in the plan, by part index (topological, Q53). */
  readonly order?: readonly number[]
  readonly barrier?: boolean
  /** A shared requirement is asked about once for the parts it applies to. */
  readonly sharedClarification?: boolean
  /** The message makes a requirement conversation-wide (Q17). */
  readonly sessionWide?: boolean
}

/** A reference decomposition, so the decision model can be evaluated on its own. Parts are quoted from the message. */
export interface ReferenceDecomposition {
  readonly fragments: readonly {
    readonly part: string | readonly string[]
    readonly instruction: string
    readonly label: string
    readonly requirements?: readonly { readonly text: string; readonly part?: string; readonly scope?: RequirementScope }[]
    /** Indexes of fragments it needs, as the decomposer proposes them. */
    readonly after?: readonly number[]
  }[]
  readonly barrier?: WholeRequestBarrier
  /** Fragment indexes in the output order the user asked for. */
  readonly outputOrder?: readonly number[]
}

export interface CorpusExample {
  readonly id: string
  readonly covers: readonly CorpusTopic[]
  /** Why the label is what it is, with the spec reference. */
  readonly note: string
  readonly scene: Scene
  readonly text: string
  /** Section handles the user replied to with "Reply to this". */
  readonly replyTo?: readonly Handle[]
  readonly decomposition?: ReferenceDecomposition
  /**
   * The work the message refers to is older than the pipeline's window of
   * listed sections (`MAX_SECTIONS`): only a referent strategy that reaches
   * beyond the window can route it as labelled. The label is still what
   * routing should conclude.
   */
  readonly beyondWindow?: true
  readonly expect: CorpusExpectation
}

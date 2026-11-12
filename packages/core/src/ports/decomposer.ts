import type { ProviderError, RequirementScope, TextSpan, WholeRequestBarrier } from '@committee/protocol'
import type { CancelSignal } from './cancel'

/**
 * Generative decomposition (Q59): the only place rewritten fragment text
 * comes from. Called only when the decision gate judges a message composite.
 * Its output is a proposal: core validates it deterministically before
 * anything is created.
 */

/** Existing or pending work a fragment might need the result of, supplied by core. */
export interface DecompositionCandidate {
  /** Opaque to the decomposer; echoed back in `dependsOnCandidates`. */
  readonly id: string
  readonly label: string
  /** What the work is, in a sentence. */
  readonly description: string
}

export interface DecomposeRequest {
  /** The decomposition model, from settings (Q65). */
  readonly model: string
  /** The original message, exactly as typed. Spans index into this string. */
  readonly text: string
  readonly candidates: readonly DecompositionCandidate[]
}

export interface DecomposedRequirement {
  /** The requirement as it should be given to a run. */
  readonly text: string
  /** Where it is stated in the original message, when it is quotable. */
  readonly span: TextSpan | null
  /** `session-wide` only when the user says so explicitly ("from now on", "in this chat") (Q17). */
  readonly scope: RequirementScope
}

export interface DecomposedFragment {
  /** Unique within the result, for cross-references. */
  readonly key: string
  /** Exact, non-empty, in-bounds spans of the original text this fragment was taken from. */
  readonly sourceSpans: readonly TextSpan[]
  /** The fragment as one self-contained atomic instruction. */
  readonly instruction: string
  /** Short noun phrase naming the work ("neighborhoods", "menu translation"). */
  readonly label: string
  /** Every requirement that applies to this fragment. A shared requirement appears on each fragment it applies to (Q4). */
  readonly requirements: readonly DecomposedRequirement[]
  /** Keys of other fragments whose result this one needs. Any entry makes the message sequential (Q53). */
  readonly dependsOnFragments: readonly string[]
  /** IDs of supplied candidates whose result this one needs. */
  readonly dependsOnCandidates: readonly string[]
}

export interface Decomposition {
  /**
   * In original textual order. Fewer than two means the message is atomic
   * after all, and core treats it so: splitting is conservative (Q4).
   */
  readonly fragments: readonly DecomposedFragment[]
  /**
   * Set when the message relates its outputs to one another (an explicit
   * order, an integrated presentation). A requirement that applies to each
   * part separately is not a barrier (Q25).
   */
  readonly barrier: WholeRequestBarrier | null
  /**
   * The phrase, in the user's words, when the message sets one total output
   * limit across its parts ("under 100 words total"); otherwise null. Such a
   * message is atomic (Q102): the decision gate keeps it so before the
   * decomposer is asked, and core routes it atomic when only the decomposer
   * saw the limit. A limit for each part ("each under 100 words") is not one.
   */
  readonly combinedLimit: string | null
  /** Fragment keys in the output order the user asked for, when the barrier is an explicit order (Q18). */
  readonly outputOrder: readonly string[] | null
}

export type DecomposeResult =
  | { readonly ok: true; readonly decomposition: Decomposition }
  | { readonly ok: false; readonly error: ProviderError }

export type LabelResult = { readonly ok: true; readonly label: string } | { readonly ok: false; readonly error: ProviderError }

export interface Decomposer {
  /**
   * Proposes fragments for a composite message. Never rejects. Output that
   * does not parse into this shape is `malformed-response`. It does not
   * retry.
   */
  decompose(request: DecomposeRequest, signal: CancelSignal): Promise<DecomposeResult>

  /**
   * Optional: a short noun-phrase label for an atomic request, to replace
   * core's provisional one (the request's first words). When absent, or
   * when it fails, the provisional label stays.
   */
  label?(request: { readonly model: string; readonly text: string }, signal: CancelSignal): Promise<LabelResult>
}

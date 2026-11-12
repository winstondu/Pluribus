import type { ProviderError, SectionId } from '@pluribus/protocol'
import type { NoulQuestion } from './decision-provider'
import type { CandidateSection, RoutingCandidates } from './router'

/**
 * How routing decides which earlier work a message refers to, and through
 * that what it reads and waits for: the referent strategy of dependency
 * attachment (11 · "Dependency attachment").
 *
 * A strategy scores the answer sections a unit may refer to. Everything
 * after it is the same whichever strategy ran: thresholds turn the scores
 * into targets or a question to the user, placement and dependencies follow
 * from the targets, and validation repairs or refuses the plan (acyclic, no
 * subset of a sibling group, leaves for join chains). The pipeline never
 * asks which strategy it was given.
 *
 * A strategy is deterministic and has no I/O of its own: it states yes/no
 * questions and reads probabilities. Its questions ride in the request the
 * pipeline sends anyway (`questions`).
 *
 * The strategy that ships is a policy over `ReferentOperations`
 * (`./referent-operations`): the search is written against Point, Group
 * and Several probes and the structure of the tree, and the
 * decision provider and the wording sit behind the operations.
 */
export interface ReferentStrategy {
  readonly name: string
  /**
   * Yes/no questions to add to the pipeline's own decision request, whose
   * state text lists every section with `listed: true` as `S<n>`. Keyed by
   * question ID; IDs start with the unit's key (`m_…`, `f0_…`).
   */
  questions(request: ReferentRequest): ReferentQuestions
  /** The referents of every unit of the request. Never rejects. */
  resolve(request: ReferentRequest, gate: ReferentGate): Promise<ReferentResult>
}

export type ReferentQuestions = { readonly [id: string]: NoulQuestion }

/** One answer section that can be referred to. */
export interface ReferentSection {
  /** Its number in every state text of this routing: `S<n>`. */
  readonly n: number
  readonly section: CandidateSection
  /** Whether the pipeline's own request lists it. Sections beyond the pipeline's window are not listed. */
  readonly listed: boolean
}

/** What is being placed: the whole message, or one part of a composite. */
export interface ReferentUnit {
  /** `m` for the message, `f<i>` for part i. Prefix of its question IDs. */
  readonly key: string
  /** How questions name it: "the new message", "part F2". */
  readonly name: string
}

export interface ReferentRequest {
  readonly units: readonly ReferentUnit[]
  /** Answer sections, oldest first. Open clarification questions are not among them. */
  readonly sections: readonly ReferentSection[]
  /** The context tree is read from these: starting contexts, sibling groups and their join-backs. */
  readonly candidates: RoutingCandidates
  readonly relevance: {
    /** At or above this a section is relevant: the target-choice threshold (Q74). */
    readonly clear: number
    /** At or above this a section is still plausible: worth descending into, and worth asking the user about. */
    readonly floor: number
  }
}

/** The answers to the questions that rode in the pipeline's request. */
export interface ReferentGate {
  /** Probability of yes; null when the question was not asked. */
  probability(id: string): number | null
  /**
   * Keys of the units that correct earlier work. A correction may name the
   * brief its descendants consumed, so for these units a relevant ancestor
   * is kept beside its relevant descendants.
   */
  readonly corrective: ReadonlySet<string>
}

export interface ScoredSection {
  readonly sectionId: SectionId
  /** Probability that the unit refers to the section. */
  readonly confidence: number
}

export interface UnitReferents {
  /**
   * Every section the strategy scored and kept, each asked about by itself
   * (or as a member of a sibling group asked about as a whole). A section left out is not a referent: it
   * was never scored, or a relevant descendant stands for it.
   */
  readonly sections: readonly ScoredSection[]
  /** Probability that the unit refers to several sections at once; null when not asked. */
  readonly several: number | null
}

export type ReferentResult =
  | {
      readonly ok: true
      /** By unit key. */
      readonly units: { readonly [key: string]: UnitReferents }
    }
  | { readonly ok: false; readonly error: ProviderError }

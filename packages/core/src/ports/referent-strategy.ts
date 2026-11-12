import type { DecisionBudget, ProviderError, ReferentStrategyName, SectionId, TreeWalkSettings } from '@pluribus/protocol'
import type { DecisionContext } from './context-summary'
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
 * pipeline sends anyway (`questions`); any further request goes through
 * `ask`, which counts it against the routing's `DecisionBudget` and refuses
 * what would exceed it.
 *
 * The two strategies that ship are policies over `ReferentOperations`
 * (`./referent-operations`): the search is written against Point, Group,
 * Segment and Several probes and the structure of the tree, and the
 * decision provider, the wording and the budget sit behind the operations.
 */
export interface ReferentStrategy {
  readonly name: ReferentStrategyName | (string & {})
  /**
   * Yes/no questions to add to the pipeline's own decision request, whose
   * state text lists every section with `listed: true` as `S<n>`. Keyed by
   * question ID; IDs start with the unit's key (`m_…`, `f0_…`).
   */
  questions(request: ReferentRequest): ReferentQuestions
  /** The referents of every unit of the request. Never rejects. */
  resolve(request: ReferentRequest, gate: ReferentGate, ask: ReferentAsk): Promise<ReferentResult>
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
  /** The state text of the pipeline's own request, for a strategy that has to ask its ride-along questions again. */
  readonly stateText: string
  /** The end of every state text: the new message, and its parts when it is composite. */
  readonly subject: string
  readonly relevance: {
    /** At or above this a section is relevant: the target-choice threshold (Q74). */
    readonly clear: number
    /** At or above this a section is still plausible: worth descending into, and worth asking the user about. */
    readonly floor: number
  }
  /** `settings.routing.useSummaryIfAvailable`. */
  readonly useSummaryIfAvailable: boolean
  /**
   * The summary to show for a section in place of its usual line, or null:
   * the setting is off, or no summary is available for it. The pipeline's
   * own state text already shows it for the sections it lists; a strategy
   * that writes state texts of its own passes it to the same line.
   */
  decisionContext(section: CandidateSection): DecisionContext | null
  /** `settings.routing.treeWalk`: how a walk treats runs of only children. A strategy that does not walk ignores it. */
  readonly treeWalk: TreeWalkSettings
  /**
   * Whether a run that continues from the section would fit what a run may
   * read. Read by the tree walk with hop between branch points on, which
   * takes the deepest section of an unbranched run that does. Left out:
   * every section fits. The first version leaves it out: what a run may
   * read is the answer model's context limit, which is counted when the
   * run starts and is not known to routing (11 · "Context growth", Q67).
   * It must not turn from false to true down a line: context only grows.
   */
  runContextFits?(section: CandidateSection): boolean
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

export type ReferentAskResult =
  | { readonly kind: 'answered'; probability(id: string): number | null }
  /** The request would exceed the budget. Nothing was sent. */
  | { readonly kind: 'refused'; readonly limit: keyof DecisionBudget }
  | { readonly kind: 'failed'; readonly error: ProviderError }

/** A further decision request, counted against the routing's budget. */
export interface ReferentAsk {
  (stateText: string, questions: ReferentQuestions): Promise<ReferentAskResult>
  /** What the budget still allows. */
  remaining(): DecisionBudget
  /** The input tokens a request is counted as. Deterministic: an estimate from its size, not the provider's usage. */
  estimate(stateText: string, questions: ReferentQuestions): number
}

export interface ScoredSection {
  readonly sectionId: SectionId
  /** Probability that the unit refers to the section. */
  readonly confidence: number
}

/**
 * The best node found so far, for a unit whose strategy was stopped by the
 * decision budget (11 · "Decision budget"): of the nodes that were asked
 * about by themselves and are at least plausible, the one preferred by
 * `bestNodeFound`. A sibling group asked about as a whole resolves to every
 * member. A section that was only named in a question about several
 * sections is never among them.
 */
export interface BestNodeFound {
  readonly sectionIds: readonly SectionId[]
  /** The score of the node: of the section, or of the group as a whole. */
  readonly confidence: number
}

/**
 * A referent that hop between branch points placed on the last section of
 * an unbranched run without a search inside the run (11 · "Referent
 * strategies", DA3). The section was not asked about by itself; it carries
 * the highest score among the questions about the run.
 */
export interface RunEndTaken {
  /** The section taken: the run's last, or the deepest one a run's context allows. */
  readonly sectionId: SectionId
  readonly confidence: number
  /** The unbranched run: its first and last answer section, and how many it has. */
  readonly run: { readonly firstSectionId: SectionId; readonly lastSectionId: SectionId; readonly sections: number }
  /** The question with that score: about one section (first and last the same) or about a part of the run. */
  readonly evidence: { readonly firstSectionId: SectionId; readonly lastSectionId: SectionId; readonly sections: number }
  /** True when the run's last section does not fit a run's context and a section above it was taken. */
  readonly limitedByContext: boolean
}

export interface UnitReferents {
  /**
   * Every section the strategy scored and kept, each asked about by itself
   * (or as a member of a sibling group asked about as a whole), or, with
   * hop between branch points on, taken as the last section of a run the
   * unit refers to (`runEnds`). A section left out is not a referent: it
   * was never scored, or a relevant descendant stands for it.
   */
  readonly sections: readonly ScoredSection[]
  /** The sections of `sections` that hop between branch points took without asking about them by themselves. Left out when none. */
  readonly runEnds?: readonly RunEndTaken[]
  /** Probability that the unit refers to several sections at once; null when not asked. */
  readonly several: number | null
  /**
   * Set when the decision budget stopped the strategy: the best node found
   * so far, or null when nothing asked about by itself is plausible. Where
   * the pipeline's rules would ask the user which section is meant, it takes
   * this node instead and does not ask. A strategy that leaves it out has
   * the highest-scoring section of `sections` taken in its place.
   */
  readonly best?: BestNodeFound | null
}

export type ReferentResult =
  | {
      readonly ok: true
      /** By unit key. */
      readonly units: { readonly [key: string]: UnitReferents }
      /**
       * Set when the strategy did not finish as designed because the
       * decision budget would have been exceeded: the limit, and what it
       * did instead.
       * - `one-pass`: asked the one-pass questions it had not asked yet in one request, which still fitted;
       * - `partial`: kept what it had scored, because not even that request fitted.
       * The budget is a hard stop: nothing more is asked, of the decision model or of the user. Each unit
       * reports the best node found so far (`UnitReferents.best`).
       */
      readonly fallback: { readonly limit: keyof DecisionBudget; readonly to: 'one-pass' | 'partial' } | null
    }
  | { readonly ok: false; readonly error: ProviderError }

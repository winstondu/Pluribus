import type { ProviderError, StrategyChoice, StrategySelectionRecord } from '@pluribus/protocol'
import type { ChoiceQuestion, NoulQuestion } from './decision-provider'

/**
 * Strategy selection: an optional layer in front of the referent strategy
 * (11 · "Strategy selection"; the user's
 * working name for it is "decision-inception"). A selector chooses, for
 * one routing, which referent strategy runs and how the tree walk treats
 * runs, from the shape of the conversation's genealogy.
 *
 * The pipeline and the strategies do not know how the choice was made: the
 * pipeline is handed a strategy and tree-walk settings, as it would be
 * from the settings alone, and records what the selector reports.
 *
 * A selector has no I/O of its own. A request to the decision model goes
 * through `ask`, which counts it against the routing's token budget and
 * refuses what the budget does not allow.
 */
export interface StrategySelector {
  readonly name: string
  /**
   * Whether a choice may stand for a later routing of the same shape: true
   * when it depends on the shape alone and costs a request to make.
   */
  readonly reusable: boolean
  /** The choice for one routing. Never rejects. */
  select(request: StrategySelectionRequest, ask: SelectorAsk): Promise<StrategySelection>
}

/** A run of only children: the answers of one line of work between two places where it splits. */
export interface RunShape {
  /** Answer sections in the run. */
  readonly sections: number
  /** Of those, listed in the pipeline's request, the run's last one not counted: what "start at the trunk base" would skip there. */
  readonly listedBeforeEnd: number
  /** Of those, older than the pipeline's window. */
  readonly unlisted: number
  /** Tokens of the run's requests and answers. */
  readonly tokens: number
  /** Whether the run ends where the line splits; otherwise it ends in a leaf. */
  readonly endsInSplit: boolean
}

/**
 * The shape of a conversation's genealogy: counts and structure only. No
 * request, answer or title is in it.
 */
export interface GenealogyShape {
  /** Answer sections that can be referred to. */
  readonly sections: number
  /** Of those, older than the pipeline's window of listed sections. */
  readonly beyondWindow: number
  /** Lines of work that start from nothing. */
  readonly roots: number
  /** Of those, single answers older than the window that nothing was built on. */
  readonly oldSingleRoots: number
  /** Places where a line splits: a node with two or more continuations, a sibling group's join-back among them. */
  readonly branchPoints: number
  /** The most splits on one path from a root, plus one: the levels a walk can descend. */
  readonly depth: number
  readonly siblingGroups: { readonly open: number; readonly closed: number }
  /** Tokens of every section's request and answer. */
  readonly tokens: number
  /** Runs from a root to its first split, or to its tip. */
  readonly trunks: number
  readonly longestTrunk: RunShape | null
  /** Runs below a split. */
  readonly branchRuns: number
  readonly longestBranchRun: RunShape | null
}

export interface StrategySelectionRequest {
  readonly shape: GenealogyShape
  /** The shape in words, as a decision model is shown it. Deterministic; counts only. */
  readonly description: string
  /** What the settings name: the choice with no selector. */
  readonly configured: StrategyChoice
  /**
   * Decision input tokens this routing may use in all, the pipeline's own
   * request included: the smaller of the token budget and the price guard's
   * allowance. With too few for a further request, a walk cannot descend.
   */
  readonly tokenBudget: number
  /** The message being routed. A selector that decides from the shape alone must not read it. */
  readonly message: string
  /** The decision model's confidence at or above which its choice stands (the target-choice threshold). */
  readonly confidence: number
}

/** What a selector reports: the record of the routing decision, without the parts the layer adds. */
export type StrategySelection = Pick<StrategySelectionRecord, 'selector' | 'choice' | 'reason' | 'scores' | 'fallback'>

export type SelectorQuestions = { readonly [id: string]: NoulQuestion | ChoiceQuestion }

export type SelectorAskResult =
  | {
      readonly kind: 'answered'
      /** Probability of yes; null when the question was not asked or is not yes/no. */
      noul(id: string): number | null
      choice(id: string): { readonly choice: string; readonly confidence: number } | null
    }
  /** The request does not fit the routing's token budget. Nothing was sent. */
  | { readonly kind: 'refused' }
  | { readonly kind: 'failed'; readonly error: ProviderError }

/** One decision request of a selector, counted against the routing's token budget. */
export interface SelectorAsk {
  (stateText: string, questions: SelectorQuestions): Promise<SelectorAskResult>
}

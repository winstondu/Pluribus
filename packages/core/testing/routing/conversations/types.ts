import type { CorpusExample } from '../corpus/types'

/**
 * The conversation corpus: labelled conversation prompts, each a
 * conversation as the router sees it, the next message the user types, and
 * the behavior Pluribus should show (docs/spec/02 to 07). It is held apart
 * from the routing corpus (`../corpus/`), which the decision thresholds were
 * tuned on (PLAN §7): nothing here was used to choose a threshold.
 *
 * A case is a `CorpusExample`, so the corpus evaluator, the oracle and the
 * live smoke run score it unchanged. What it adds is where the case sits on
 * each split axis, so a result can be read per behavior, per way of
 * referring, per register and per role, instead of as one number.
 */

/**
 * Split 1, the label class: what routing should conclude. The primary
 * stratum: every other split is read within it.
 */
export const BEHAVIORS = [
  /** Unrelated new work: a new chain, at once (05). */
  'new-chain',
  /** Builds on the latest answer of a line: continues it (01). */
  'continue',
  /** Builds on an answer that already has work built on it, or on one sibling alone: branches from it (04, C8). */
  'branch',
  /** Related work sent while its line is busy: a fork beside the work in flight, which it does not wait for (04, C1, C11). */
  'fork',
  /** Needs one result that is not available yet: dependency-queued behind it (05, C2). */
  'wait',
  /** Needs two or more members of an open sibling group: waits for the whole group, never a subset (Q30, C9, C15). */
  'wait-group',
  /** Needs two or more members of a closed sibling group: continues from their join-back (C19). */
  'join-back',
  /** Names sections on lines that have diverged: a join chain over them (05, C18, C20). */
  'join-chain',
  /** Brings several lines together and names none clearly: the lines are joined, the user is not asked (T4). */
  'join-lines',
  /** Could mean one of several sections: the user picks, Pluribus never guesses (05, Q10, Q20). */
  'ask-target',
  /** Corrective wording about one piece of work: supersedes it (06, T2). */
  'revise-work',
  /** Corrects a brief several requests relied on, or a conversation-wide requirement (06, Q17, Q42). */
  'revise-shared',
  /** Answers an open clarification question (Q98). */
  'answer-question',
  /** Cannot be answered well without asking: missing information or incompatible requirements (E2). */
  'clarify',
  /** Independent intents in one message: one directive each, none waiting for another (02, Q4). */
  'split-independent',
  /** A later part needs an earlier part's result: split messages in dependency order (Q53). */
  'split-sequential',
  /** Looks separable and is one request: a contrast, one integrated output, a combined total limit (Q4, Q102). */
  'keep-atomic',
  /** Makes a requirement conversation-wide, or pointedly does not (Q17, D1). */
  'session-requirement',
] as const
export type Behavior = (typeof BEHAVIORS)[number]

/** Split 2: how the prompt points at what it is about. */
export const REFERENCES = [
  /** Refers to nothing in the conversation. */
  'none',
  /** Names the subject of the work it means ("the pytest test"). */
  'named',
  /** A pronoun or demonstrative only ("that", "those", "it"). */
  'deictic',
  /** By position in the conversation ("your last answer", "the very first draft"). */
  'positional',
  /** By a detail found in the answer's text, not in its request or title. */
  'content',
  /** The user pressed "Reply to this" on a section. */
  'explicit',
] as const
export type Reference = (typeof REFERENCES)[number]

/** Split 3: how the prompt is written. */
export const REGISTERS = [
  'plain',
  /** A few lowercase words, no punctuation. */
  'terse',
  /** Backstory and asides around the request. */
  'wordy',
  /** Softened and indirect ("could you maybe"). */
  'hedged',
  /** Not in English. */
  'non-english',
  /** Typos, texting shorthand. */
  'noisy',
] as const
export type Register = (typeof REGISTERS)[number]

/** Split 4: why the case is in the corpus. */
export const ROLES = [
  /** The plain form of its behavior. */
  'canonical',
  /** One of a family of near-identical prompts whose behaviors differ: read together, they show which cue decides. */
  'contrast',
  /** A surface cue points at another behavior (`trap` says which). */
  'trap',
] as const
export type Role = (typeof ROLES)[number]

/** Split 5: the subject matter of the conversation, so that no result rests on one running example. */
export const DOMAINS = ['none', 'code', 'writing', 'data', 'cooking', 'study', 'shopping', 'money', 'work', 'events', 'teaching'] as const
export type Domain = (typeof DOMAINS)[number]

/**
 * Split 6, read from the scene, never written by hand (`shapeOf`): what the
 * conversation looks like when the message arrives.
 */
export const SHAPES = [
  /** No message yet. */
  'empty',
  /** One line of work, everything on it finished. */
  'single-line',
  /** Several unrelated lines, everything finished, no forks. */
  'parallel-lines',
  /** A tree: a closed sibling group or a branch, everything finished. */
  'branched',
  /** Work in flight, no sibling group. */
  'in-flight',
  /** An open sibling group: forks in flight. */
  'open-group',
  /** A clarification question is waiting for its answer. */
  'open-question',
] as const
export type Shape = (typeof SHAPES)[number]

/** Split 7: which side of the tuning boundary a case is on (`partitionOf`). */
export const PARTITIONS = ['tune', 'held-out'] as const
export type Partition = (typeof PARTITIONS)[number]

export interface ConversationCase extends CorpusExample {
  readonly behavior: Behavior
  readonly reference: Reference
  readonly register: Register
  readonly role: Role
  /** The surface cue that points the wrong way, and where it points. Set exactly for a `trap`. */
  readonly trap?: string
  /**
   * Cases that share a family are variants of one another (a contrast set,
   * or one prompt in two registers). A family is never divided between the
   * partitions: scoring a variant of a prompt a threshold was tuned on is
   * not a held-out result. Default: the case's own ID.
   */
  readonly family: string
  readonly domain: Domain
}

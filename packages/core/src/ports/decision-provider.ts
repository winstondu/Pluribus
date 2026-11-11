import type { ProviderError, TokenUsage } from '@committee/protocol'
import type { CancelSignal } from './cancel'

/**
 * Bounded routing questions (Q68, invariant 9). The decision model selects
 * among candidates Committee supplies: it answers yes or no, picks one of
 * the named options, or scores. It never writes text; anything rewritten
 * comes from the decomposer.
 *
 * The shapes follow OpenRouter Decisions as verified on 2026-11-11 (see
 * CLAUDE.md): `questions` is a record keyed by question ID; every question
 * has `instructions`; `choice` takes its options as a record of option →
 * description; `score` takes its criteria as an array.
 */

/** Yes or no, answered as the probability of yes. */
export interface NoulQuestion {
  readonly type: 'noul'
  readonly instructions: string
}

/** One of 1–255 named options. The option keys are the supplied candidates, for example section IDs. */
export interface ChoiceQuestion<Option extends string = string> {
  readonly type: 'choice'
  readonly instructions: string
  /** Option → description of what choosing it means. */
  readonly options: { readonly [O in Option]: string }
}

/** A score in [0, 1] against ordered criteria. */
export interface ScoreQuestion {
  readonly type: 'score'
  readonly instructions: string
  readonly criteria: readonly string[]
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion

/** Questions keyed by an ID of the caller's choosing. */
export type DecisionQuestions = { readonly [id: string]: DecisionQuestion }

export interface NoulAnswer {
  readonly type: 'noul'
  /** Probability of yes, 0–1 (the API's `noul` field). */
  readonly probability: number
}

export interface ChoiceAnswer<Option extends string = string> {
  readonly type: 'choice'
  /** Always one of the supplied options. A provider that receives anything else reports `malformed-response`. */
  readonly choice: Option
  /** Confidence in `choice`, 0–1. */
  readonly confidence: number
  readonly probabilities: { readonly [O in Option]: number }
}

export interface ScoreAnswer {
  readonly type: 'score'
  readonly score: number
  readonly confidence: number
}

export type DecisionAnswerFor<Q extends DecisionQuestion> = Q extends NoulQuestion
  ? NoulAnswer
  : Q extends ChoiceQuestion<infer Option>
    ? ChoiceAnswer<Option>
    : ScoreAnswer

export interface DecisionRequest<Q extends DecisionQuestions> {
  /** The pinned, versioned decision model (Q74), from settings. Never a moving alias. */
  readonly model: string
  /** The text every question is asked about. */
  readonly state: string
  /**
   * Questions in one request are independent over the same state and cannot
   * refer to each other's answers. Batch everything that can be asked at
   * once: one request is far faster than several.
   */
  readonly questions: Q
}

export type DecisionResult<Q extends DecisionQuestions> =
  | {
      readonly ok: true
      /** The model that answered, as the provider reports it (a dated version of the pinned model). */
      readonly model: string
      readonly answers: { readonly [K in keyof Q]: DecisionAnswerFor<Q[K]> }
      readonly usage: TokenUsage | null
    }
  | { readonly ok: false; readonly error: ProviderError }

/**
 * There is no fallback implementation; this interface exists so one can be
 * added if the alpha API changes (Q77).
 */
export interface DecisionProvider {
  /**
   * Answers every question in one call. Never rejects: failures are
   * `{ ok: false }` with the same error mapping as the model provider, and
   * an answer that is missing or of the wrong type is `malformed-response`.
   * It does not retry.
   */
  decide<Q extends DecisionQuestions>(request: DecisionRequest<Q>, signal: CancelSignal): Promise<DecisionResult<Q>>
}

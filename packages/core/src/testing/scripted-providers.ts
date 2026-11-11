import type {
  CancelSignal,
  DecisionProvider,
  DecisionQuestions,
  DecisionRequest,
  DecisionResult,
  DecomposeRequest,
  DecomposeResult,
  Decomposer,
  LabelResult,
} from '../ports'

type Answer<Req, Res> = Res | ((request: Req) => Res | Promise<Res>)

/**
 * A decision provider that answers from a queue, or from a function when
 * the queue is empty. Records every request. With nothing to answer it
 * reports `malformed-response`, never a guess.
 */
export class ScriptedDecisionProvider implements DecisionProvider {
  readonly requests: DecisionRequest<DecisionQuestions>[] = []
  private readonly queue: Answer<DecisionRequest<DecisionQuestions>, DecisionResult<DecisionQuestions>>[] = []
  private fallback: ((request: DecisionRequest<DecisionQuestions>) => DecisionResult<DecisionQuestions> | Promise<DecisionResult<DecisionQuestions>>) | null = null

  push(answer: Answer<DecisionRequest<DecisionQuestions>, DecisionResult<DecisionQuestions>>): this {
    this.queue.push(answer)
    return this
  }

  answerWith(
    fallback: (request: DecisionRequest<DecisionQuestions>) => DecisionResult<DecisionQuestions> | Promise<DecisionResult<DecisionQuestions>>,
  ): this {
    this.fallback = fallback
    return this
  }

  async decide<Q extends DecisionQuestions>(request: DecisionRequest<Q>, signal: CancelSignal): Promise<DecisionResult<Q>> {
    void signal
    this.requests.push(request)
    const next = this.queue.shift()
    const answer = next ?? this.fallback
    if (!answer) {
      return {
        ok: false,
        error: { code: 'malformed-response', class: 'non-retryable', message: 'No scripted decision', httpStatus: null, retryAfterMs: null },
      }
    }
    const result = typeof answer === 'function' ? await answer(request) : answer
    return result as DecisionResult<Q>
  }
}

/** A decomposer that answers from a queue or a function, and labels from a function when given one. Records requests. */
export class ScriptedDecomposer implements Decomposer {
  readonly requests: DecomposeRequest[] = []
  readonly labelRequests: { readonly model: string; readonly text: string }[] = []
  private readonly queue: Answer<DecomposeRequest, DecomposeResult>[] = []
  private fallback: ((request: DecomposeRequest) => DecomposeResult | Promise<DecomposeResult>) | null = null
  private labeler: ((text: string) => LabelResult | Promise<LabelResult>) | null = null

  push(answer: Answer<DecomposeRequest, DecomposeResult>): this {
    this.queue.push(answer)
    return this
  }

  answerWith(fallback: (request: DecomposeRequest) => DecomposeResult | Promise<DecomposeResult>): this {
    this.fallback = fallback
    return this
  }

  /** Enables `label`; without this the decomposer has no labels, as the port allows. */
  labelWith(labeler: (text: string) => LabelResult | Promise<LabelResult>): this {
    this.labeler = labeler
    return this
  }

  async decompose(request: DecomposeRequest, signal: CancelSignal): Promise<DecomposeResult> {
    void signal
    this.requests.push(request)
    const next = this.queue.shift()
    const answer = next ?? this.fallback
    if (!answer) {
      return {
        ok: false,
        error: { code: 'malformed-response', class: 'non-retryable', message: 'No scripted decomposition', httpStatus: null, retryAfterMs: null },
      }
    }
    return typeof answer === 'function' ? answer(request) : answer
  }

  label = async (request: { readonly model: string; readonly text: string }, signal: CancelSignal): Promise<LabelResult> => {
    void signal
    this.labelRequests.push(request)
    if (!this.labeler) {
      return {
        ok: false,
        error: { code: 'malformed-response', class: 'non-retryable', message: 'No scripted label', httpStatus: null, retryAfterMs: null },
      }
    }
    return this.labeler(request.text)
  }
}

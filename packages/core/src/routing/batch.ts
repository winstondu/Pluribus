import { providerError, type DecisionQuestionRecord, type ProviderError } from '@pluribus/protocol'
import type {
  CancelSignal,
  ChoiceAnswer,
  DecisionProvider,
  DecisionQuestion,
  DecisionQuestions,
  NoulAnswer,
  ScoreAnswer,
} from '../ports'

/**
 * One batched call to the decision model (Q68, invariant 9). Questions are
 * bounded: yes or no (`noul`), or one of the supplied options (`choice`).
 * Every question and its answer is kept for the routing decision record
 * (run inspector item 5).
 */
export class Batch {
  readonly questions: { [id: string]: DecisionQuestion } = {}

  get size(): number {
    return Object.keys(this.questions).length
  }

  noul(id: string, instructions: string): void {
    this.questions[id] = { type: 'noul', instructions }
  }

  choice(id: string, instructions: string, options: { readonly [option: string]: string }): void {
    this.questions[id] = { type: 'choice', instructions, options }
  }

  has(id: string): boolean {
    return id in this.questions
  }
}

type AnyAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer

/** The answers of one call, read back by question ID. Absent questions read as null. */
export class Answers {
  readonly model: string
  private readonly batch: Batch
  private readonly answers: { readonly [id: string]: AnyAnswer }

  constructor(model: string, batch: Batch, answers: { readonly [id: string]: AnyAnswer }) {
    this.model = model
    this.batch = batch
    this.answers = answers
  }

  /** Probability of yes, or null when the question was not asked. */
  noul(id: string): number | null {
    if (!this.batch.has(id)) return null
    const a = this.answers[id]
    return a?.type === 'noul' ? clamp(a.probability) : null
  }

  choice(id: string): { readonly choice: string; readonly confidence: number; readonly probabilities: { readonly [o: string]: number } } | null {
    if (!this.batch.has(id)) return null
    const a = this.answers[id]
    return a?.type === 'choice' ? { choice: a.choice, confidence: clamp(a.confidence), probabilities: a.probabilities } : null
  }

  records(): DecisionQuestionRecord[] {
    const out: DecisionQuestionRecord[] = []
    for (const [id, q] of Object.entries(this.batch.questions)) {
      const a = this.answers[id]
      if (!a) continue
      const candidates: { [option: string]: string } = {}
      if (q.type === 'choice') Object.assign(candidates, q.options)
      if (q.type === 'score') q.criteria.forEach((c, i) => (candidates[String(i)] = c))
      out.push({
        id,
        type: q.type,
        instructions: q.instructions,
        candidates,
        answer: a.type === 'noul' ? clamp(a.probability) : a.type === 'choice' ? a.choice : a.score,
        confidence: a.type === 'noul' ? null : clamp(a.confidence),
        probabilities: a.type === 'choice' ? { ...a.probabilities } : null,
      })
    }
    return out
  }
}

function clamp(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
}

/**
 * Asks every question of the batch in one call. A missing answer, or one of
 * the wrong type, is `malformed-response`: nothing is ever guessed.
 */
export async function ask(
  provider: DecisionProvider,
  model: string,
  state: string,
  batch: Batch,
  signal: CancelSignal,
): Promise<{ readonly ok: true; readonly answers: Answers } | { readonly ok: false; readonly error: ProviderError }> {
  if (batch.size === 0) return { ok: true, answers: new Answers(model, batch, {}) }
  const result = await provider.decide({ model, state, questions: batch.questions as DecisionQuestions }, signal)
  if (!result.ok) return result
  const answers = result.answers as { readonly [id: string]: AnyAnswer | undefined }
  const clean: { [id: string]: AnyAnswer } = {}
  for (const [id, question] of Object.entries(batch.questions)) {
    const answer = answers[id]
    if (!answer || answer.type !== question.type) {
      return { ok: false, error: providerError('malformed-response', `The decision model did not answer "${id}"`) }
    }
    if (answer.type === 'choice' && question.type === 'choice' && !(answer.choice in question.options)) {
      return { ok: false, error: providerError('malformed-response', `The decision model chose an option that was not offered for "${id}"`) }
    }
    clean[id] = answer
  }
  return { ok: true, answers: new Answers(result.model, batch, clean) }
}

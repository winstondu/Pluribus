import type { ClarificationReason } from '@committee/protocol'
import type { CancelSignal, ModelMessage, PreparationRequest, PreparationResult, Preparer } from '../src/ports'

type Answer = PreparationResult | ((request: PreparationRequest) => PreparationResult | Promise<PreparationResult>)

interface Script {
  readonly match: (request: PreparationRequest) => boolean
  readonly answer: Answer
  readonly repeat: boolean
  used: boolean
}

const MODEL = 'scripted/preparer'

/** The typed result "ready". */
export const readyToAnswer = (): PreparationResult => ({ ok: true, readiness: { kind: 'ready' }, model: MODEL, usage: null })

/** The typed result "clarification needed", with the question as it will be shown. */
export const needsClarification = (question: string, reason: ClarificationReason = 'missing-information'): PreparationResult => ({
  ok: true,
  readiness: { kind: 'clarification-needed', reason, question },
  model: MODEL,
  usage: null,
})

/** The run's own request: the last user message that is not a correction. */
function requestTextOf(messages: readonly ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message && message.role === 'user' && !message.content.startsWith('Correction: ')) return message.content
  }
  return ''
}

/**
 * A preparation step driven by scripts. For each request it uses the first
 * unused script whose match accepts it (a string matches when any message
 * of the input contains it), else it answers `ready`. Every request is
 * recorded, so a test can assert that the step ran, or that it did not.
 */
export class ScriptedPreparer implements Preparer {
  readonly requests: PreparationRequest[] = []
  private readonly scripts: Script[] = []

  /** Adds an answer for the next request that matches. With `repeat`, it answers every match. */
  script(match: string | ((request: PreparationRequest) => boolean), answer: Answer, options: { readonly repeat?: boolean } = {}): this {
    const accepts = typeof match === 'function' ? match : (request: PreparationRequest) => request.messages.some((m) => m.content.includes(match))
    this.scripts.push({ match: accepts, answer, repeat: options.repeat ?? false, used: false })
    return this
  }

  /** Requests whose own request text includes `text`. */
  requestsFor(text: string): PreparationRequest[] {
    return this.requests.filter((r) => requestTextOf(r.messages).includes(text))
  }

  async prepare(request: PreparationRequest, signal: CancelSignal): Promise<PreparationResult> {
    void signal
    this.requests.push(request)
    const script = this.scripts.find((s) => (s.repeat || !s.used) && s.match(request))
    if (!script) return readyToAnswer()
    if (!script.repeat) script.used = true
    return typeof script.answer === 'function' ? await script.answer(request) : script.answer
  }
}

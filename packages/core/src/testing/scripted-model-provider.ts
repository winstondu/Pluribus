import { providerError, type ProviderErrorCode, type TokenUsage } from '@committee/protocol'
import type { CancelSignal, ModelProvider, ModelRequest, ModelStreamEvent, TokenCount } from '../ports'
import type { FakeClock } from './fake-clock'

/** One step of a script: `event` is yielded `afterMs` milliseconds after the stream started, on the fake clock. */
export interface ScriptStep {
  readonly afterMs: number
  readonly event: ModelStreamEvent
}

export type RequestMatch = string | ((request: ModelRequest) => boolean)

interface Script {
  readonly match: (request: ModelRequest) => boolean
  readonly steps: readonly ScriptStep[]
  readonly repeat: boolean
  used: boolean
}

/** The text of the run's own request: the last user message that is not a correction. */
export function requestTextOf(request: ModelRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const message = request.messages[i]
    if (message && message.role === 'user' && !message.content.startsWith('Correction: ')) return message.content
  }
  return ''
}

function matcher(match: RequestMatch): (request: ModelRequest) => boolean {
  if (typeof match === 'function') return match
  return (request) => requestTextOf(request).includes(match)
}

/** Script builders. */
export const say = (afterMs: number, text: string): ScriptStep => ({ afterMs, event: { type: 'text', text } })
export const done = (afterMs: number, usage: TokenUsage | null = null): ScriptStep => ({
  afterMs,
  event: { type: 'completed', finishReason: 'stop', usage },
})
export const fail = (afterMs: number, code: ProviderErrorCode, message = `Provider error: ${code}`): ScriptStep => ({
  afterMs,
  event: { type: 'failed', error: providerError(code, message) },
})
/** The run stops to ask the user `question` (the typed late-clarification signal, Q106). */
export const askUser = (
  afterMs: number,
  question: string,
  reason: 'missing-information' | 'incompatible-requirements' = 'missing-information',
): ScriptStep => ({ afterMs, event: { type: 'clarification-needed', reason, question, usage: null } })
/** A complete answer: `text` at `textAt`, completion at `doneAt`. */
export const answer = (text: string, textAt: number, doneAt: number): ScriptStep[] => [say(textAt, text), done(doneAt)]

/**
 * A model provider driven by scripts on the fake clock. For each request it
 * uses the first unused script whose match accepts it (a string matches the
 * run's own request text), else the default script. A script without a
 * terminal step hangs until cancelled. Every request is recorded.
 */
export class ScriptedModelProvider implements ModelProvider {
  readonly requests: ModelRequest[] = []
  private readonly scripts: Script[] = []
  private defaultSteps: readonly ScriptStep[] = answer('OK', 10, 20)
  private tokens: (request: ModelRequest) => TokenCount = (request) => ({
    inputTokens: request.messages.reduce((n, m) => n + Math.ceil(m.content.length / 4), 0),
    contextLimit: null,
    exact: false,
  })

  private readonly clock: FakeClock

  constructor(clock: FakeClock) {
    this.clock = clock
  }

  /** Adds a script for the next request that matches. With `repeat`, it answers every match. */
  script(match: RequestMatch, steps: readonly ScriptStep[], options: { readonly repeat?: boolean } = {}): this {
    this.scripts.push({ match: matcher(match), steps, repeat: options.repeat ?? false, used: false })
    return this
  }

  /** Adds a script for the next request, whatever it is: scripts added this way answer in call order. */
  next(steps: readonly ScriptStep[]): this {
    return this.script(() => true, steps)
  }

  /** The script used when nothing matches. */
  setDefault(steps: readonly ScriptStep[]): this {
    this.defaultSteps = steps
    return this
  }

  /** How `countTokens` answers. */
  setTokenCount(count: (request: ModelRequest) => TokenCount): this {
    this.tokens = count
    return this
  }

  /** Requests whose own request text includes `text`. */
  requestsFor(text: string): ModelRequest[] {
    return this.requests.filter((r) => requestTextOf(r).includes(text))
  }

  countTokens(request: ModelRequest): Promise<TokenCount> {
    return Promise.resolve(this.tokens(request))
  }

  stream(request: ModelRequest, signal: CancelSignal): AsyncIterable<ModelStreamEvent> {
    this.requests.push(request)
    const script = this.scripts.find((s) => (s.repeat || !s.used) && s.match(request))
    if (script && !script.repeat) script.used = true
    const steps = script ? script.steps : this.defaultSteps
    const clock = this.clock
    const queue: ModelStreamEvent[] = []
    let wake: (() => void) | null = null
    let ended = false
    const push = (event: ModelStreamEvent): void => {
      if (ended) return
      queue.push(event)
      if (event.type !== 'text') ended = true
      const w = wake
      wake = null
      w?.()
    }
    const cancels: (() => void)[] = []
    for (const step of steps) {
      cancels.push(clock.setTimeout(() => push(step.event), step.afterMs))
    }
    signal.onCancel(() => {
      for (const cancel of cancels) cancel()
      queue.length = 0
      push({ type: 'cancelled' })
    })
    return {
      [Symbol.asyncIterator](): AsyncIterator<ModelStreamEvent> {
        let finished = false
        return {
          async next(): Promise<IteratorResult<ModelStreamEvent>> {
            if (finished) return { done: true, value: undefined }
            while (queue.length === 0) {
              await new Promise<void>((resolve) => {
                wake = resolve
              })
            }
            const event = queue.shift() as ModelStreamEvent
            if (event.type !== 'text') finished = true
            return { done: false, value: event }
          },
          async return(): Promise<IteratorResult<ModelStreamEvent>> {
            finished = true
            return { done: true, value: undefined }
          },
        }
      },
    }
  }
}

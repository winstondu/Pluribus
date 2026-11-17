import { compatibleModel, providerError, type ClarificationReason, type ProviderError, type TokenUsage } from '@pluribus/protocol'
import type {
  CancelSignal,
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
  ModelStreamTerminal,
  TokenCount,
} from '@pluribus/core/ports'
import { createParser } from 'eventsource-parser'
import {
  NO_KEY_ERROR,
  abortControllerFor,
  errorForInBandBody,
  errorForStatus,
  errorFromResponse,
  isRecord,
  jsonHeaders,
  networkError,
  readErrorBody,
  readKey,
  resolveOptions,
  type OpenRouterOptions,
  type ResolvedOptions,
} from './http'
import { createModelCatalog, estimateTokens, type ModelCatalog } from './models'

/**
 * Answer runs over `POST /api/v1/chat/completions` with SSE streaming.
 *
 * The request carries `transforms: []` so that OpenRouter never compresses
 * ("middle-out") an input that is over the limit: context is never silently
 * truncated (Q67, Q82).
 */
export function createOpenRouterModelProvider(options: OpenRouterOptions): ModelProvider {
  const resolved = resolveOptions(options)
  const catalog = createModelCatalog(resolved)
  return {
    stream: (request, signal) => streamCompletion(resolved, request, signal),
    countTokens: (request) => countTokens(catalog, request),
  }
}

async function countTokens(catalog: ModelCatalog, request: ModelRequest): Promise<TokenCount> {
  const inputTokens = estimateTokens(request.messages)
  let contextLimit: number | null = null
  try {
    contextLimit = await catalog.contextLimit(request.model)
  } catch {
    contextLimit = null
  }
  return { inputTokens, contextLimit, exact: false }
}

/**
 * The streamed clarification signal (Q106). An answer run on a model the
 * compatibility list marks for it carries one function tool; a call to it
 * is the run saying that it cannot go on without the user. The call arrives
 * as typed `tool_calls` deltas, apart from the answer text, so nothing is
 * classified after streaming. The tool is the wire form of the port's
 * `clarificationSignal`: core never sees tools.
 */
export const CLARIFICATION_TOOL_NAME = 'ask_user_for_clarification'

export const CLARIFICATION_TOOL = {
  type: 'function',
  function: {
    name: CLARIFICATION_TOOL_NAME,
    description:
      'Stop and ask the user one question. Call this only when you find that a correct answer needs a fact or a preference that only the user can supply, that is nowhere in the conversation, and that a reasonable assumption would get materially wrong; or when the user\'s own requirements contradict each other. Never call it for something you can reasonably assume, say as an assumption, or work out from the conversation: then just answer. After calling it, write nothing more.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['question', 'reason'],
      properties: {
        question: { type: 'string', description: 'One short, specific question for the user that can be read on its own' },
        reason: { type: 'string', enum: ['missing-information', 'incompatible-requirements'] },
      },
    },
  },
} as const

/** True when the run is to carry the signal: core asked for it and the model is tested for it (Q107). */
export function carriesClarificationSignal(request: ModelRequest): boolean {
  return request.clarificationSignal === true && compatibleModel(request.model)?.streamedClarificationSignal === true
}

/** A piece of a streamed tool call: its position, and whatever of its name and arguments this chunk carried. */
interface ToolCallPiece {
  readonly index: number
  readonly name: string
  readonly arguments: string
}

/** Collects tool-call pieces by position, as the stream delivers them. */
class ToolCalls {
  private readonly calls = new Map<number, { name: string; arguments: string }>()

  add(piece: ToolCallPiece): void {
    const call = this.calls.get(piece.index) ?? { name: '', arguments: '' }
    call.name += piece.name
    call.arguments += piece.arguments
    this.calls.set(piece.index, call)
  }

  get any(): boolean {
    return this.calls.size > 0
  }

  /** The clarification the run asked for, `malformed` when a call cannot be read as one, or null when there was no call. */
  clarification(): { readonly reason: ClarificationReason; readonly question: string } | 'malformed' | null {
    if (this.calls.size === 0) return null
    const call = [...this.calls.values()].find((c) => c.name === CLARIFICATION_TOOL_NAME)
    if (!call) return 'malformed'
    let value: unknown
    try {
      value = JSON.parse(call.arguments)
    } catch {
      return 'malformed'
    }
    if (!isRecord(value) || typeof value['question'] !== 'string' || value['question'].trim() === '') return 'malformed'
    const reason: ClarificationReason = value['reason'] === 'incompatible-requirements' ? 'incompatible-requirements' : 'missing-information'
    return { reason, question: value['question'].trim() }
  }
}

const MALFORMED_SIGNAL = providerError('malformed-response', 'The model asked for clarification without a readable question', { httpStatus: 200 })

function readToolCallPieces(value: unknown): ToolCallPiece[] {
  if (!Array.isArray(value)) return []
  const pieces: ToolCallPiece[] = []
  value.forEach((entry: unknown, position) => {
    if (!isRecord(entry)) return
    const fn = entry['function']
    pieces.push({
      index: typeof entry['index'] === 'number' ? entry['index'] : position,
      name: isRecord(fn) && typeof fn['name'] === 'string' ? fn['name'] : '',
      arguments: isRecord(fn) && typeof fn['arguments'] === 'string' ? fn['arguments'] : '',
    })
  })
  return pieces
}

/** What one parsed SSE `data:` payload means for the run. */
type ChunkOutcome =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'tool-call'; readonly piece: ToolCallPiece }
  | { readonly kind: 'finish'; readonly reason: 'stop' | 'length' }
  | { readonly kind: 'usage'; readonly usage: TokenUsage }
  | { readonly kind: 'failed'; readonly error: ProviderError }
  | { readonly kind: 'done' }

/**
 * Interprets one SSE `data:` payload. A payload may carry text, a finish
 * reason and usage at once, so it returns a list in that order.
 */
export function interpretChunk(data: string, key: string | null): ChunkOutcome[] {
  const trimmed = data.trim()
  if (trimmed === '[DONE]') return [{ kind: 'done' }]
  if (trimmed === '') return []
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return [{ kind: 'failed', error: providerError('mid-stream-error', 'OpenRouter sent a stream chunk that is not JSON', { httpStatus: 200 }) }]
  }
  if (!isRecord(value)) return []
  const outcomes: ChunkOutcome[] = []
  const inBandError = readErrorBody(value)
  const choices = Array.isArray(value['choices']) ? value['choices'] : []
  const choice: unknown = choices[0]
  if (isRecord(choice)) {
    const delta = choice['delta']
    if (isRecord(delta) && typeof delta['content'] === 'string' && delta['content'] !== '') {
      outcomes.push({ kind: 'text', text: delta['content'] })
    }
    if (isRecord(delta)) for (const piece of readToolCallPieces(delta['tool_calls'])) outcomes.push({ kind: 'tool-call', piece })
    const finish = choice['finish_reason']
    if (finish === 'error') {
      outcomes.push({
        kind: 'failed',
        error:
          inBandError !== null
            ? errorForInBandBody(inBandError, key)
            : providerError('mid-stream-error', 'The provider reported an error mid-stream', { httpStatus: 200 }),
      })
      return outcomes
    }
    if (finish === 'content_filter') {
      outcomes.push({ kind: 'failed', error: providerError('refusal', 'The model declined to answer', { httpStatus: 200 }) })
      return outcomes
    }
    if (finish === 'length') outcomes.push({ kind: 'finish', reason: 'length' })
    else if (typeof finish === 'string' && finish !== '') outcomes.push({ kind: 'finish', reason: 'stop' })
  }
  if (inBandError !== null) {
    // An error object without finish_reason "error" still ends the run.
    outcomes.push({ kind: 'failed', error: errorForInBandBody(inBandError, key) })
    return outcomes
  }
  const usage = readUsage(value['usage'])
  if (usage !== null) outcomes.push({ kind: 'usage', usage })
  return outcomes
}

function readUsage(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null
  const input = value['prompt_tokens']
  const output = value['completion_tokens']
  if (typeof input !== 'number' || typeof output !== 'number') return null
  return { inputTokens: input, outputTokens: output }
}

const EMPTY_RESPONSE = providerError('empty-response', 'OpenRouter returned an empty response', { httpStatus: 200 })
const CANCELLED: ModelStreamTerminal = { type: 'cancelled' }

async function* streamCompletion(
  options: ResolvedOptions,
  request: ModelRequest,
  signal: CancelSignal,
): AsyncGenerator<ModelStreamEvent, void, undefined> {
  if (signal.cancelled) {
    yield CANCELLED
    return
  }
  const key = await readKey(options)
  if (key === null) {
    yield { type: 'failed', error: NO_KEY_ERROR }
    return
  }
  if (signal.cancelled) {
    yield CANCELLED
    return
  }
  const { controller, release } = abortControllerFor(signal)
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  try {
    let response: Response
    try {
      response = await options.fetch(`${options.baseUrl}/api/v1/chat/completions`, {
        method: 'POST',
        headers: { ...jsonHeaders(key), Accept: 'text/event-stream' },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
          stream: true,
          stream_options: { include_usage: true },
          transforms: [],
          ...(carriesClarificationSignal(request) ? { tools: [CLARIFICATION_TOOL], tool_choice: 'auto', parallel_tool_calls: false } : {}),
        }),
        signal: controller.signal,
      })
    } catch (error) {
      yield signal.cancelled ? CANCELLED : { type: 'failed', error: networkError(error, key) }
      return
    }

    if (!response.ok) {
      const error = await errorFromResponse(response, key, options.now())
      yield signal.cancelled ? CANCELLED : { type: 'failed', error }
      return
    }

    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.includes('text/event-stream') && contentType.includes('json')) {
      // Not a stream: an in-band error, or a provider that ignored `stream`.
      yield* readJsonCompletion(response, key, signal, options)
      return
    }
    if (response.body === null) {
      yield { type: 'failed', error: EMPTY_RESPONSE }
      return
    }

    const pending: ChunkOutcome[] = []
    const parser = createParser({
      onEvent: (event) => {
        pending.push(...interpretChunk(event.data, key))
      },
      // Comment lines (": OPENROUTER PROCESSING") are keep-alives, never text.
      onComment: () => {},
    })
    const decoder = new TextDecoder()
    reader = response.body.getReader()
    let sawText = false
    const toolCalls = new ToolCalls()
    let finish: 'stop' | 'length' | null = null
    let usage: TokenUsage | null = null
    let done = false
    let sawDone = false

    while (!done) {
      if (signal.cancelled) {
        yield CANCELLED
        return
      }
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } catch (error) {
        yield signal.cancelled ? CANCELLED : { type: 'failed', error: networkError(error, key) }
        return
      }
      if (chunk.done) {
        parser.feed(decoder.decode())
        parser.feed('\n\n')
        done = true
      } else {
        parser.feed(decoder.decode(chunk.value, { stream: true }))
      }
      while (pending.length > 0) {
        const outcome = pending.shift()
        if (outcome === undefined) break
        if (signal.cancelled) {
          yield CANCELLED
          return
        }
        switch (outcome.kind) {
          case 'text':
            sawText = true
            yield { type: 'text', text: outcome.text }
            break
          case 'tool-call':
            toolCalls.add(outcome.piece)
            break
          case 'finish':
            finish = outcome.reason
            break
          case 'usage':
            usage = outcome.usage
            break
          case 'failed':
            yield { type: 'failed', error: outcome.error }
            return
          case 'done':
            done = true
            sawDone = true
            break
        }
      }
    }

    if (signal.cancelled) {
      yield CANCELLED
      return
    }
    if (toolCalls.any && (finish !== null || sawDone)) {
      // The run stopped to ask (Q106). Text it wrote before stands as partial output.
      const asked = toolCalls.clarification()
      if (asked === 'malformed' || asked === null) yield { type: 'failed', error: MALFORMED_SIGNAL }
      else yield { type: 'clarification-needed', reason: asked.reason, question: asked.question, usage }
      return
    }
    if (!sawText) {
      yield { type: 'failed', error: EMPTY_RESPONSE }
      return
    }
    if (finish === null && !sawDone) {
      // `[DONE]` without a finish reason is a normal end; a stream that just stops is not.
      yield {
        type: 'failed',
        error: providerError('network', 'The stream ended before the answer finished', { httpStatus: 200 }),
      }
      return
    }
    yield { type: 'completed', finishReason: finish ?? 'stop', usage }
  } finally {
    release()
    if (reader !== null) {
      reader.cancel().catch(() => {})
    }
    // Ends the HTTP request whether the run finished, failed, was cancelled, or the consumer stopped reading.
    controller.abort()
  }
}

async function* readJsonCompletion(
  response: Response,
  key: string,
  signal: CancelSignal,
  options: ResolvedOptions,
): AsyncGenerator<ModelStreamEvent, void, undefined> {
  let text: string
  try {
    text = await response.text()
  } catch (error) {
    yield signal.cancelled ? CANCELLED : { type: 'failed', error: networkError(error, key) }
    return
  }
  if (text.trim() === '') {
    yield { type: 'failed', error: EMPTY_RESPONSE }
    return
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    yield { type: 'failed', error: providerError('mid-stream-error', 'OpenRouter returned a body that is not JSON', { httpStatus: 200 }) }
    return
  }
  const inBand = readErrorBody(body)
  if (inBand !== null) {
    const status = typeof inBand.code === 'number' && inBand.code >= 400 ? inBand.code : null
    yield {
      type: 'failed',
      error: status !== null ? errorForStatus(status, inBand, null, key, options.now()) : errorForInBandBody(inBand, key),
    }
    return
  }
  const choices = isRecord(body) && Array.isArray(body['choices']) ? body['choices'] : []
  const choice: unknown = choices[0]
  const message = isRecord(choice) ? choice['message'] : null
  const content = isRecord(message) && typeof message['content'] === 'string' ? message['content'] : ''
  const toolCalls = new ToolCalls()
  for (const piece of readToolCallPieces(isRecord(message) ? message['tool_calls'] : null)) toolCalls.add(piece)
  if (content === '' && !toolCalls.any) {
    yield { type: 'failed', error: EMPTY_RESPONSE }
    return
  }
  if (signal.cancelled) {
    yield CANCELLED
    return
  }
  if (content !== '') yield { type: 'text', text: content }
  if (toolCalls.any) {
    const asked = toolCalls.clarification()
    if (asked === 'malformed' || asked === null) yield { type: 'failed', error: MALFORMED_SIGNAL }
    else yield { type: 'clarification-needed', reason: asked.reason, question: asked.question, usage: isRecord(body) ? readUsage(body['usage']) : null }
    return
  }
  const finish = isRecord(choice) ? choice['finish_reason'] : null
  if (finish === 'content_filter') {
    yield { type: 'failed', error: providerError('refusal', 'The model declined to answer', { httpStatus: 200 }) }
    return
  }
  yield {
    type: 'completed',
    finishReason: finish === 'length' ? 'length' : 'stop',
    usage: isRecord(body) ? readUsage(body['usage']) : null,
  }
}

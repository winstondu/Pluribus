import type Anthropic from '@anthropic-ai/sdk'
import { compatibleModel, providerError, type ClarificationReason, type TokenUsage } from '@committee/protocol'
import type { CancelSignal, ModelProvider, ModelRequest, ModelStreamEvent, ModelStreamTerminal, TokenCount } from '@committee/core/ports'
import { abortControllerFor } from '../openrouter/http'
import { CLARIFICATION_TOOL, CLARIFICATION_TOOL_NAME } from '../openrouter/model-provider'
import { estimateTokens } from '../openrouter/models'
import {
  NO_ANTHROPIC_KEY_ERROR,
  createClient,
  inputTokensOf,
  mapAnthropicError,
  readAnthropicKey,
  resolveAnthropicOptions,
  splitSystem,
  type AnthropicOptions,
  type ResolvedAnthropicOptions,
} from './client'
import { createAnthropicModelCatalog, type AnthropicModelCatalog } from './models'

/**
 * Answer and synthesis runs over the Claude API's Messages API
 * (`POST /v1/messages`), streamed as server-sent events.
 *
 * - The run's `system` messages become the request's `system`; the turns
 *   are sent as they are. Nothing is truncated: an input over the context
 *   limit fails as `context-length-exceeded` (Q67, Q82).
 * - Thinking is left to the model's default (adaptive on current models).
 *   Thinking is not answer text and is never yielded.
 * - No server-side refusal fallback is requested: a run records the one
 *   model that answered it, so a refusal is a typed `refusal` failure.
 * - `max_tokens` is the model's own output cap when the catalog knows it,
 *   and at most {@link MAX_OUTPUT_TOKENS}.
 */
export function createAnthropicModelProvider(options: AnthropicOptions): ModelProvider {
  const resolved = resolveAnthropicOptions(options)
  const catalog = createAnthropicModelCatalog(resolved)
  return {
    stream: (request, signal) => streamMessage(resolved, catalog, request, signal),
    countTokens: (request) => countTokens(resolved, catalog, request),
  }
}

/** Room for a long answer; a streamed request has no HTTP timeout to fit inside. */
export const MAX_OUTPUT_TOKENS = 64_000

/**
 * The streamed clarification signal (Q106) in the Messages API's tool form:
 * the same tool, name and wording as the OpenRouter provider's. Its input is
 * streamed as it is written, so the API does not validate it; it is
 * validated here before it is used.
 */
export const ANTHROPIC_CLARIFICATION_TOOL: Anthropic.Tool = {
  name: CLARIFICATION_TOOL_NAME,
  description: CLARIFICATION_TOOL.function.description,
  eager_input_streaming: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['question', 'reason'],
    properties: {
      question: { type: 'string', description: 'One short, specific question for the user that can be read on its own' },
      reason: { type: 'string', enum: ['missing-information', 'incompatible-requirements'] },
    },
  },
}

/** True when the run is to carry the signal: core asked for it and the model is tested for it on the Claude API (Q107). */
export function carriesAnthropicClarificationSignal(request: ModelRequest): boolean {
  return request.clarificationSignal === true && compatibleModel(request.model, 'anthropic')?.streamedClarificationSignal === true
}

/**
 * An exact count from `POST /v1/messages/count_tokens` and the context
 * window from the model catalog. Without a key, or when either request
 * fails, the count is the same estimate the OpenRouter provider uses.
 */
async function countTokens(options: ResolvedAnthropicOptions, catalog: AnthropicModelCatalog, request: ModelRequest): Promise<TokenCount> {
  const estimate = estimateTokens(request.messages)
  if (request.model === '') return { inputTokens: estimate, contextLimit: null, exact: false }
  let contextLimit: number | null = null
  try {
    contextLimit = (await catalog.limits(request.model))?.contextLimit ?? null
  } catch {
    contextLimit = null
  }
  try {
    const key = await readAnthropicKey(options)
    const { system, turns } = splitSystem(request.messages)
    if (key === null || turns.length === 0) return { inputTokens: estimate, contextLimit, exact: false }
    const counted = await createClient(options, key).messages.countTokens({
      model: request.model,
      messages: turns,
      ...(system === '' ? {} : { system }),
      ...(carriesAnthropicClarificationSignal(request) ? { tools: [ANTHROPIC_CLARIFICATION_TOOL] } : {}),
    })
    return { inputTokens: counted.input_tokens, contextLimit, exact: true }
  } catch {
    return { inputTokens: estimate, contextLimit, exact: false }
  }
}

const EMPTY_RESPONSE = providerError('empty-response', 'Anthropic returned an empty response', { httpStatus: 200 })
const MALFORMED_SIGNAL = providerError('malformed-response', 'The model asked for clarification without a readable question', { httpStatus: 200 })
const CANCELLED: ModelStreamTerminal = { type: 'cancelled' }

/** The clarification a tool call asks for, or null when its input cannot be read as one. */
function readClarification(input: unknown): { readonly reason: ClarificationReason; readonly question: string } | null {
  if (typeof input !== 'object' || input === null) return null
  const { question, reason } = input as { readonly question?: unknown; readonly reason?: unknown }
  if (typeof question !== 'string' || question.trim() === '') return null
  return { reason: reason === 'incompatible-requirements' ? 'incompatible-requirements' : 'missing-information', question: question.trim() }
}

async function* streamMessage(
  options: ResolvedAnthropicOptions,
  catalog: AnthropicModelCatalog,
  request: ModelRequest,
  signal: CancelSignal,
): AsyncGenerator<ModelStreamEvent, void, undefined> {
  if (signal.cancelled) {
    yield CANCELLED
    return
  }
  const key = await readAnthropicKey(options)
  if (key === null) {
    yield { type: 'failed', error: NO_ANTHROPIC_KEY_ERROR }
    return
  }
  const limits = await catalog.limits(request.model)
  if (signal.cancelled) {
    yield CANCELLED
    return
  }
  const { controller, release } = abortControllerFor(signal)
  const { system, turns } = splitSystem(request.messages)
  const stream = createClient(options, key).messages.stream(
    {
      model: request.model,
      max_tokens: Math.min(MAX_OUTPUT_TOKENS, limits?.maxOutputTokens ?? MAX_OUTPUT_TOKENS),
      messages: turns,
      ...(system === '' ? {} : { system }),
      ...(carriesAnthropicClarificationSignal(request)
        ? { tools: [ANTHROPIC_CLARIFICATION_TOOL], tool_choice: { type: 'auto' as const, disable_parallel_tool_use: true } }
        : {}),
    },
    { signal: controller.signal },
  )
  try {
    let sawText = false
    for await (const event of stream) {
      if (signal.cancelled) {
        yield CANCELLED
        return
      }
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta' && event.delta.text !== '') {
        sawText = true
        yield { type: 'text', text: event.delta.text }
      }
    }
    const message = await stream.finalMessage()
    if (signal.cancelled) {
      yield CANCELLED
      return
    }
    const usage: TokenUsage = { inputTokens: inputTokensOf(message.usage), outputTokens: message.usage.output_tokens }
    if (message.stop_reason === 'refusal') {
      const why = message.stop_details?.explanation
      yield { type: 'failed', error: providerError('refusal', typeof why === 'string' && why !== '' ? why : 'The model declined to answer', { httpStatus: 200 }) }
      return
    }
    const calls = message.content.filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
    if (calls.length > 0) {
      // The run stopped to ask (Q106). Text it wrote before stands as partial output.
      const call = calls.find((block) => block.name === CLARIFICATION_TOOL_NAME)
      const asked = call && message.stop_reason !== 'max_tokens' ? readClarification(call.input) : null
      if (asked === null) yield { type: 'failed', error: MALFORMED_SIGNAL }
      else yield { type: 'clarification-needed', reason: asked.reason, question: asked.question, usage }
      return
    }
    if (!sawText) {
      yield { type: 'failed', error: EMPTY_RESPONSE }
      return
    }
    const cutOff = message.stop_reason === 'max_tokens' || message.stop_reason === 'model_context_window_exceeded'
    yield { type: 'completed', finishReason: cutOff ? 'length' : 'stop', usage }
  } catch (error) {
    yield signal.cancelled ? CANCELLED : { type: 'failed', error: mapAnthropicError(error, key, options.now()) }
  } finally {
    release()
    // Ends the HTTP request whether the run finished, failed, was cancelled, or the consumer stopped reading.
    controller.abort()
  }
}

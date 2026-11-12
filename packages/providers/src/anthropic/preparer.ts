import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { providerError } from '@pluribus/protocol'
import type { CancelSignal, PreparationRequest, PreparationResult, Preparer } from '@pluribus/core/ports'
import { PREPARATION_PROMPT, parseReadiness, readinessResultSchema, transcriptOf } from '../openrouter/preparer'
import { callAnthropic, inputTokensOf, resolveAnthropicOptions, textOf, type AnthropicOptions, type ResolvedAnthropicOptions } from './client'

/**
 * The schema as the API takes it. The answer is read and checked here, so a
 * body that is not the schema's JSON is a typed result, never a throw.
 */
const OUTPUT_FORMAT = (() => {
  const { type, schema } = zodOutputFormat(readinessResultSchema)
  return { type, schema }
})()

/**
 * The preparation step (Q103) over the Claude API: one non-streaming
 * Messages request whose answer is constrained to the readiness schema by
 * structured outputs. Prompt, schema and parsing are the OpenRouter
 * preparer's; it writes no answer text.
 */
export function createAnthropicPreparer(options: AnthropicOptions): Preparer {
  const resolved = resolveAnthropicOptions(options)
  return { prepare: (request, signal) => prepare(resolved, request, signal) }
}

/** Thinking is on by default on current models and shares this cap with the small result. */
const PREPARATION_MAX_TOKENS = 4_000

async function prepare(options: ResolvedAnthropicOptions, request: PreparationRequest, signal: CancelSignal): Promise<PreparationResult> {
  const result = await callAnthropic(options, signal, (client, call) =>
    client.messages.create(
      {
        model: request.model,
        max_tokens: PREPARATION_MAX_TOKENS,
        system: PREPARATION_PROMPT,
        messages: [{ role: 'user', content: transcriptOf(request.messages) }],
        output_config: { format: OUTPUT_FORMAT },
      },
      call,
    ),
  )
  if (!result.ok) return result
  const message = result.value
  if (message.stop_reason === 'refusal') return { ok: false, error: providerError('refusal', 'The model declined to answer', { httpStatus: 200 }) }
  const content = textOf(message)
  if (content.trim() === '') return { ok: false, error: providerError('empty-response', 'Anthropic returned an empty response', { httpStatus: 200 }) }
  const readiness = parseReadiness(content)
  if (readiness === null) {
    return { ok: false, error: providerError('malformed-response', 'The preparation step did not return a readiness result', { httpStatus: 200 }) }
  }
  return {
    ok: true,
    readiness,
    model: message.model,
    usage: { inputTokens: inputTokensOf(message.usage), outputTokens: message.usage.output_tokens },
  }
}

import { providerError, type ClarificationReason, type TokenUsage } from '@pluribus/protocol'
import type { CancelSignal, ModelMessage, PreparationRequest, PreparationResult, PreparedReadiness, Preparer } from '@pluribus/core/ports'
import { z } from 'zod'
import { isRecord, postJson, resolveOptions, type OpenRouterOptions, type ResolvedOptions } from './http'

/**
 * The preparation step (Q103) over `POST /api/v1/chat/completions` with a
 * `response_format` JSON schema: one structured, non-streaming call that
 * reads the exact input of an answer run and returns the typed readiness
 * result, `ready` or `clarification-needed` with the question. It writes no
 * answer text.
 *
 * The run's input is handed over as one quoted transcript, not as chat
 * turns, so the model judges the request instead of answering it.
 */
export function createOpenRouterPreparer(options: OpenRouterOptions): Preparer {
  const resolved = resolveOptions(options)
  return { prepare: (request, signal) => prepare(resolved, request, signal) }
}

const REASONS = ['missing-information', 'incompatible-requirements'] as const satisfies readonly ClarificationReason[]

/** The JSON schema sent as `response_format`. Strict: every property required, no extras. */
export const READINESS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['readiness', 'reason', 'question'],
  properties: {
    readiness: { type: 'string', enum: ['ready', 'clarification-needed'] },
    reason: {
      anyOf: [{ type: 'string', enum: [...REASONS] }, { type: 'null' }],
      description: 'Why the user must be asked; null when ready',
    },
    question: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: 'One short, specific, self-contained question for the user; null when ready',
    },
  },
} as const

export const readinessResultSchema = z.object({
  readiness: z.enum(['ready', 'clarification-needed']),
  reason: z.enum(REASONS).nullable(),
  question: z.string().nullable(),
})

export const PREPARATION_PROMPT = `You are the preparation step of an assistant. You are given the exact input another model is about to answer: the conversation so far, ending with the request to answer now. Do not answer the request. Decide only whether it can be answered now.

Answer "clarification-needed" only when one of these holds:
- missing-information: a correct answer needs a fact or a preference that only the user can supply, it is nowhere in the input, and a reasonable assumption would risk a materially wrong answer.
- incompatible-requirements: the user's own requirements contradict each other, so no answer can satisfy them all.

Otherwise answer "ready". Ordinary vagueness, matters of taste the answer can settle by stating an assumption, differences between earlier results that the answer can weigh, and anything the conversation already settles are all "ready". When in doubt, answer "ready".

For "clarification-needed", give the reason and one short, specific question addressed to the user that can be read on its own. For "ready", reason and question are null.`

/** The run's input as one quoted transcript. */
export function transcriptOf(messages: readonly ModelMessage[]): string {
  const turns = messages.map((message) => `<${message.role}>\n${message.content}\n</${message.role}>`)
  return `The input of the run to prepare, in order. The last user turn is the request to answer now.\n\n${turns.join('\n\n')}`
}

const PREPARATION_MAX_TOKENS = 400

async function prepare(options: ResolvedOptions, request: PreparationRequest, signal: CancelSignal): Promise<PreparationResult> {
  const result = await postJson(
    options,
    '/api/v1/chat/completions',
    {
      model: request.model,
      messages: [
        { role: 'system', content: PREPARATION_PROMPT },
        { role: 'user', content: transcriptOf(request.messages) },
      ],
      max_tokens: PREPARATION_MAX_TOKENS,
      response_format: { type: 'json_schema', json_schema: { name: 'readiness', strict: true, schema: READINESS_JSON_SCHEMA } },
      provider: { require_parameters: true },
      stream: false,
      transforms: [],
    },
    signal,
  )
  if (!result.ok) return result
  const body = result.body
  const choices = isRecord(body) && Array.isArray(body['choices']) ? body['choices'] : []
  const choice: unknown = choices[0]
  if (isRecord(choice) && choice['finish_reason'] === 'content_filter') {
    return { ok: false, error: providerError('refusal', 'The model declined to answer', { httpStatus: 200 }) }
  }
  const message = isRecord(choice) ? choice['message'] : null
  const content = isRecord(message) && typeof message['content'] === 'string' ? message['content'] : ''
  if (content.trim() === '') {
    return { ok: false, error: providerError('empty-response', 'OpenRouter returned an empty response', { httpStatus: 200 }) }
  }
  const readiness = parseReadiness(content)
  if (readiness === null) {
    return { ok: false, error: providerError('malformed-response', 'The preparation step did not return a readiness result', { httpStatus: 200 }) }
  }
  return {
    ok: true,
    readiness,
    model: isRecord(body) && typeof body['model'] === 'string' ? body['model'] : request.model,
    usage: readUsage(isRecord(body) ? body['usage'] : null),
  }
}

/** The typed result, or null when the content is not one. A question is required with `clarification-needed`. */
export function parseReadiness(content: string): PreparedReadiness | null {
  let value: unknown
  try {
    value = JSON.parse(stripFence(content))
  } catch {
    return null
  }
  const parsed = readinessResultSchema.safeParse(value)
  if (!parsed.success) return null
  if (parsed.data.readiness === 'ready') return { kind: 'ready' }
  const question = parsed.data.question?.trim() ?? ''
  if (question === '') return null
  return { kind: 'clarification-needed', reason: parsed.data.reason ?? 'missing-information', question }
}

/** Some providers wrap the object in a Markdown code fence despite the schema. */
function stripFence(content: string): string {
  const match = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(content)
  return match?.[1] ?? content
}

function readUsage(value: unknown): TokenUsage | null {
  if (!isRecord(value)) return null
  const input = value['prompt_tokens']
  const output = value['completion_tokens']
  if (typeof input !== 'number' || typeof output !== 'number') return null
  return { inputTokens: input, outputTokens: output }
}

import type Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { providerError } from '@pluribus/protocol'
import type { CancelSignal, DecomposeRequest, DecomposeResult, Decomposer, LabelRequest, LabelResult } from '@pluribus/core/ports'
import {
  DECOMPOSITION_SYSTEM_PROMPT,
  LABEL_PROMPT,
  checkProposal,
  cleanLabel,
  decompositionUserPrompt,
  parseProposal,
  proposalSchema,
} from '../openrouter/decomposer'
import { callAnthropic, resolveAnthropicOptions, textOf, type AnthropicOptions, type ResolvedAnthropicOptions } from './client'

/**
 * The schema as the API takes it. The answer is read and checked here, so a
 * body that is not the schema's JSON is a typed result, never a throw.
 */
const OUTPUT_FORMAT = (() => {
  const { type, schema } = zodOutputFormat(proposalSchema)
  return { type, schema }
})()

/**
 * Generative decomposition (Q59) over the Claude API: a non-streaming
 * Messages request whose answer is constrained to the proposal schema by
 * structured outputs (`output_config.format`), and short labels for atomic
 * requests.
 *
 * The prompts, the schema and the deterministic check of a proposal are the
 * OpenRouter decomposer's: only the transport differs. As there, a proposal
 * that fails the check is asked for once more with the problems listed, a
 * second rejection is `malformed-response`, and a transport error is
 * returned as it is, without that retry.
 */
export function createAnthropicDecomposer(options: AnthropicOptions): Decomposer {
  const resolved = resolveAnthropicOptions(options)
  return {
    decompose: (request, signal) => decompose(resolved, request, signal),
    label: (request, signal) => label(resolved, request, signal),
  }
}

/** Thinking is on by default on current models and shares this cap with the answer. */
const DECOMPOSITION_MAX_TOKENS = 16_000
const LABEL_MAX_TOKENS = 2_000

const REFUSED = providerError('refusal', 'The model declined to answer', { httpStatus: 200 })
const EMPTY = providerError('empty-response', 'Anthropic returned an empty response', { httpStatus: 200 })

async function decompose(options: ResolvedAnthropicOptions, request: DecomposeRequest, signal: CancelSignal): Promise<DecomposeResult> {
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: decompositionUserPrompt(request) }]
  let lastProblems: readonly string[] = []
  for (let round = 0; round < 2; round += 1) {
    const result = await callAnthropic(options, signal, (client, call) =>
      client.messages.create(
        {
          model: request.model,
          max_tokens: DECOMPOSITION_MAX_TOKENS,
          system: DECOMPOSITION_SYSTEM_PROMPT,
          messages,
          output_config: { format: OUTPUT_FORMAT },
        },
        call,
      ),
    )
    if (!result.ok) return result
    const message = result.value
    if (message.stop_reason === 'refusal') return { ok: false, error: REFUSED }
    const content = textOf(message)
    if (content.trim() === '') return { ok: false, error: EMPTY }
    const parsed = parseProposal(content)
    const checked = parsed.ok ? checkProposal(parsed.proposal, request) : parsed
    if (checked.ok) return { ok: true, decomposition: checked.decomposition }
    lastProblems = message.stop_reason === 'max_tokens' ? ['The answer was cut off at the token limit.', ...checked.problems] : checked.problems
    messages.push(
      { role: 'assistant', content },
      {
        role: 'user',
        content: `That answer was rejected:\n${lastProblems.map((p) => `- ${p}`).join('\n')}\nAnswer again with the corrected JSON object. Every quote must be copied exactly from the original message.`,
      },
    )
  }
  return {
    ok: false,
    error: providerError('malformed-response', `The decomposition was rejected twice: ${lastProblems.join(' ')}`, { httpStatus: 200 }),
  }
}

async function label(options: ResolvedAnthropicOptions, request: LabelRequest, signal: CancelSignal): Promise<LabelResult> {
  const result = await callAnthropic(options, signal, (client, call) =>
    client.messages.create(
      { model: request.model, max_tokens: LABEL_MAX_TOKENS, system: LABEL_PROMPT, messages: [{ role: 'user', content: request.text }] },
      call,
    ),
  )
  if (!result.ok) return result
  if (result.value.stop_reason === 'refusal') return { ok: false, error: REFUSED }
  const content = textOf(result.value)
  if (content.trim() === '') return { ok: false, error: EMPTY }
  const cleaned = cleanLabel(content)
  if (cleaned === '') return { ok: false, error: providerError('malformed-response', 'The label was empty', { httpStatus: 200 }) }
  return { ok: true, label: cleaned }
}

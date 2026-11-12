import { providerError, type ProviderError, type TextSpan } from '@pluribus/protocol'
import type {
  CancelSignal,
  DecomposeRequest,
  DecomposeResult,
  DecomposedFragment,
  DecomposedRequirement,
  Decomposer,
  Decomposition,
  LabelRequest,
  LabelResult,
} from '@pluribus/core/ports'
import { z } from 'zod'
import { isRecord, postJson, resolveOptions, type OpenRouterOptions, type ResolvedOptions } from './http'

/**
 * Generative decomposition (Q59) over `POST /api/v1/chat/completions` with a
 * `response_format` JSON schema, and short labels for atomic requests.
 *
 * The model quotes its source text instead of counting characters; the
 * provider locates every quote in the original message and turns it into an
 * exact span. A proposal whose quotes are not substrings of the original, or
 * whose cross-references do not resolve, is rejected and asked for once
 * more with the problems listed. A second rejection is `malformed-response`.
 * Transport errors are returned as they are, without that retry.
 */
export function createOpenRouterDecomposer(options: OpenRouterOptions): Decomposer {
  const resolved = resolveOptions(options)
  return {
    decompose: (request, signal) => decompose(resolved, request, signal),
    label: (request, signal) => label(resolved, request, signal),
  }
}

// ───────────────────────────── schema ─────────────────────────────

const BARRIER_REASONS = ['explicit-order', 'combined-limit', 'integrated-presentation'] as const

/** The JSON schema sent as `response_format`. Strict: every property required, no extras. */
export const DECOMPOSITION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['fragments', 'barrier', 'outputOrder'],
  properties: {
    fragments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'sourceQuotes', 'instruction', 'label', 'requirements', 'dependsOnFragments', 'dependsOnCandidates'],
        properties: {
          key: { type: 'string', description: 'Short unique key for this fragment, such as "f1"' },
          sourceQuotes: {
            type: 'array',
            items: { type: 'string' },
            description: 'Exact, verbatim, contiguous substrings of the original message that this fragment comes from',
          },
          instruction: { type: 'string', description: 'The fragment rewritten as one self-contained instruction' },
          label: { type: 'string', description: 'A short noun phrase naming the work, 1 to 4 words' },
          requirements: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['text', 'sourceQuote', 'scope'],
              properties: {
                text: { type: 'string' },
                sourceQuote: { type: ['string', 'null'] },
                scope: { type: 'string', enum: ['local', 'session-wide'] },
              },
            },
          },
          dependsOnFragments: { type: 'array', items: { type: 'string' } },
          dependsOnCandidates: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    barrier: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['reason', 'qualifier'],
          properties: {
            reason: { type: 'string', enum: [...BARRIER_REASONS] },
            qualifier: { type: 'string' },
          },
        },
        { type: 'null' },
      ],
    },
    outputOrder: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
  },
} as const

export const proposalSchema = z.object({
  fragments: z.array(
    z.object({
      key: z.string(),
      sourceQuotes: z.array(z.string()),
      instruction: z.string(),
      label: z.string(),
      requirements: z.array(
        z.object({
          text: z.string(),
          sourceQuote: z.string().nullable(),
          scope: z.enum(['local', 'session-wide']),
        }),
      ),
      dependsOnFragments: z.array(z.string()),
      dependsOnCandidates: z.array(z.string()),
    }),
  ),
  barrier: z.object({ reason: z.enum(BARRIER_REASONS), qualifier: z.string() }).nullable(),
  outputOrder: z.array(z.string()).nullable(),
})

type Proposal = z.infer<typeof proposalSchema>

// ───────────────────────────── prompt ─────────────────────────────

export const DECOMPOSITION_SYSTEM_PROMPT = `You split a chat message into fragments for Pluribus, an assistant that answers independent parts of a message in parallel.

The message has already been judged composite. Split conservatively anyway:
- A fragment is one independent intent that can be answered on its own.
- Several topics are not evidence of several intents. Tightly related topics, a requested contrast or comparison, and one integrated output stay ONE fragment.
- If the message is really one request, return exactly one fragment.

For each fragment:
- "key": a short unique key ("f1", "f2", ...).
- "sourceQuotes": one or more exact, verbatim, contiguous substrings of the original message that the fragment comes from. Copy them character for character, including punctuation and capitalisation. Never paraphrase a quote.
- "instruction": the fragment as one self-contained instruction, resolving pronouns so it reads on its own. Include every requirement that applies to it.
- "label": a short noun phrase naming the work, 1 to 4 words, lower case unless a proper noun ("sky color", "menu translation").
- "requirements": every requirement that applies to this fragment (length, audience, format, tone, language). A requirement shared by several fragments appears on each one it applies to. "sourceQuote" is the exact substring stating it, or null. "scope" is "session-wide" ONLY when the user explicitly extends it to the rest of the conversation ("from now on", "in this chat", "for all answers"); otherwise "local".
- "dependsOnFragments": keys of other fragments whose RESULT this one needs as input (for example "then summarise that"). Empty when the fragment can be answered without them.
- "dependsOnCandidates": ids of supplied existing work whose result this fragment needs. Use only ids from the supplied list.

"barrier": set it only when the message relates its outputs to one another: an explicit order of presentation ("put the translation first"), a combined limit ("under 100 words total"), or one integrated presentation. "qualifier" is that phrase in the user's words. A requirement that applies to each part separately ("each answer under 100 words") is NOT a barrier. Otherwise null.

"outputOrder": fragment keys in the order the user asked the outputs to be presented, only when the barrier is an explicit order; otherwise null.

List fragments in the order they appear in the message. Answer with the JSON object only.`

export function decompositionUserPrompt(request: DecomposeRequest): string {
  const candidates =
    request.candidates.length === 0
      ? 'None.'
      : request.candidates.map((c) => `- id ${JSON.stringify(c.id)}: ${c.label}. ${c.description}`).join('\n')
  return `Existing work this message might need the result of:\n${candidates}\n\nOriginal message, between the markers:\n<<<\n${request.text}\n>>>`
}

// ───────────────────────────── validation ─────────────────────────────

/**
 * Finds `quote` in `text` and returns its span. Prefers the first occurrence
 * at or after `from`, then any occurrence that is not already taken.
 * Surrounding whitespace on the quote is ignored; nothing else is.
 */
export function locateQuote(text: string, quote: string, from: number, taken: readonly TextSpan[]): TextSpan | null {
  const needle = quote.trim()
  if (needle === '') return null
  const occurrences: number[] = []
  for (let index = text.indexOf(needle); index !== -1; index = text.indexOf(needle, index + 1)) occurrences.push(index)
  if (occurrences.length === 0) return null
  const free = (start: number): boolean => !taken.some((span) => start < span.end && start + needle.length > span.start)
  const start =
    occurrences.find((o) => o >= from && free(o)) ?? occurrences.find(free) ?? occurrences.find((o) => o >= from) ?? occurrences[0]
  if (start === undefined) return null
  return { start, end: start + needle.length }
}

export type ProposalCheck = { readonly ok: true; readonly decomposition: Decomposition } | { readonly ok: false; readonly problems: readonly string[] }

/** Deterministically checks a parsed proposal against the original text and the supplied candidates. Exported for tests. */
export function checkProposal(proposal: Proposal, request: DecomposeRequest): ProposalCheck {
  const problems: string[] = []
  const text = request.text
  const keys = new Set<string>()
  for (const fragment of proposal.fragments) {
    const key = fragment.key.trim()
    if (key === '') problems.push('A fragment has an empty key.')
    else if (keys.has(key)) problems.push(`Fragment key "${key}" is used twice.`)
    keys.add(key)
  }
  if (proposal.fragments.length === 0) problems.push('There are no fragments.')
  const candidateIds = new Set(request.candidates.map((c) => c.id))

  const taken: TextSpan[] = []
  let cursor = 0
  const fragments: DecomposedFragment[] = []
  for (const fragment of proposal.fragments) {
    const key = fragment.key.trim()
    const spans: TextSpan[] = []
    if (fragment.sourceQuotes.length === 0) problems.push(`Fragment "${key}" has no source quotes.`)
    for (const quote of fragment.sourceQuotes) {
      const span = locateQuote(text, quote, cursor, taken)
      if (span === null) {
        problems.push(`Fragment "${key}" quotes ${JSON.stringify(quote)}, which is not an exact substring of the original message.`)
        continue
      }
      spans.push(span)
    }
    taken.push(...spans)
    const first = spans[0]
    if (first !== undefined) cursor = first.end

    const requirements: DecomposedRequirement[] = []
    for (const requirement of fragment.requirements) {
      if (requirement.text.trim() === '') {
        problems.push(`Fragment "${key}" has an empty requirement.`)
        continue
      }
      let span: TextSpan | null = null
      if (requirement.sourceQuote !== null && requirement.sourceQuote.trim() !== '') {
        span = locateQuote(text, requirement.sourceQuote, 0, [])
        if (span === null) {
          problems.push(
            `A requirement of fragment "${key}" quotes ${JSON.stringify(requirement.sourceQuote)}, which is not an exact substring of the original message. Use null when it cannot be quoted.`,
          )
        }
      }
      requirements.push({ text: requirement.text.trim(), span, scope: requirement.scope })
    }
    if (fragment.instruction.trim() === '') problems.push(`Fragment "${key}" has an empty instruction.`)
    if (fragment.label.trim() === '') problems.push(`Fragment "${key}" has an empty label.`)
    for (const dependency of fragment.dependsOnFragments) {
      if (dependency === key) problems.push(`Fragment "${key}" depends on itself.`)
      else if (!keys.has(dependency)) problems.push(`Fragment "${key}" depends on unknown fragment "${dependency}".`)
    }
    for (const candidate of fragment.dependsOnCandidates) {
      if (!candidateIds.has(candidate)) problems.push(`Fragment "${key}" depends on "${candidate}", which is not a supplied id.`)
    }
    fragments.push({
      key,
      sourceSpans: [...spans].sort((a, b) => a.start - b.start),
      instruction: fragment.instruction.trim(),
      label: cleanLabel(fragment.label),
      requirements,
      dependsOnFragments: unique(fragment.dependsOnFragments),
      dependsOnCandidates: unique(fragment.dependsOnCandidates),
    })
  }

  let outputOrder: string[] | null = null
  if (proposal.outputOrder !== null) {
    outputOrder = unique(proposal.outputOrder)
    for (const key of outputOrder) if (!keys.has(key)) problems.push(`outputOrder names unknown fragment "${key}".`)
    if (outputOrder.length !== proposal.outputOrder.length) problems.push('outputOrder repeats a fragment.')
  }
  const barrier =
    proposal.barrier === null ? null : { reason: proposal.barrier.reason, qualifier: proposal.barrier.qualifier.trim() }
  if (barrier !== null && barrier.qualifier === '') problems.push('The barrier has an empty qualifier.')

  if (problems.length > 0) return { ok: false, problems }
  const ordered = fragments
    .map((fragment, index) => ({ fragment, index }))
    .sort((a, b) => (a.fragment.sourceSpans[0]?.start ?? 0) - (b.fragment.sourceSpans[0]?.start ?? 0) || a.index - b.index)
    .map((entry) => entry.fragment)
  return {
    ok: true,
    decomposition: {
      fragments: ordered,
      barrier,
      // Only an explicit order has an output order (Q18).
      outputOrder: barrier?.reason === 'explicit-order' ? outputOrder : null,
    },
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

/** Parses the model's message content: JSON, possibly inside a code fence. */
export function parseProposal(content: string): { readonly ok: true; readonly proposal: Proposal } | { readonly ok: false; readonly problems: readonly string[] } {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(content)
  const json = (fenced?.[1] ?? content).trim()
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return { ok: false, problems: ['The answer is not valid JSON.'] }
  }
  const parsed = proposalSchema.safeParse(value)
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.slice(0, 10).map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`),
    }
  }
  return { ok: true, proposal: parsed.data }
}

// ───────────────────────────── calls ─────────────────────────────

interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: string
}

type ContentResult =
  | { readonly ok: true; readonly content: string; readonly finishReason: string | null }
  | { readonly ok: false; readonly error: ProviderError }

/** A non-streaming chat completion; returns the first choice's message content. */
async function complete(
  options: ResolvedOptions,
  body: Record<string, unknown>,
  signal: CancelSignal,
): Promise<ContentResult> {
  const result = await postJson(options, '/api/v1/chat/completions', { ...body, stream: false, transforms: [] }, signal)
  if (!result.ok) return result
  const choices = isRecord(result.body) && Array.isArray(result.body['choices']) ? result.body['choices'] : []
  const choice: unknown = choices[0]
  const message = isRecord(choice) ? choice['message'] : null
  const finishReason = isRecord(choice) && typeof choice['finish_reason'] === 'string' ? choice['finish_reason'] : null
  if (finishReason === 'content_filter') {
    return { ok: false, error: providerError('refusal', 'The model declined to answer', { httpStatus: 200 }) }
  }
  const content = isRecord(message) && typeof message['content'] === 'string' ? message['content'] : ''
  if (content.trim() === '') {
    return { ok: false, error: providerError('empty-response', 'OpenRouter returned an empty response', { httpStatus: 200 }) }
  }
  return { ok: true, content, finishReason }
}

/**
 * No `temperature`: with `require_parameters` it would exclude models that do
 * not take it (the default decomposition model does not).
 */
const DECOMPOSITION_MAX_TOKENS = 4096

async function decompose(options: ResolvedOptions, request: DecomposeRequest, signal: CancelSignal): Promise<DecomposeResult> {
  const messages: ChatMessage[] = [
    { role: 'system', content: DECOMPOSITION_SYSTEM_PROMPT },
    { role: 'user', content: decompositionUserPrompt(request) },
  ]
  let lastProblems: readonly string[] = []
  for (let round = 0; round < 2; round += 1) {
    const result = await complete(
      options,
      {
        model: request.model,
        messages,
        max_tokens: DECOMPOSITION_MAX_TOKENS,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'decomposition', strict: true, schema: DECOMPOSITION_JSON_SCHEMA },
        },
        provider: { require_parameters: true },
      },
      signal,
    )
    if (!result.ok) return result
    const parsed = parseProposal(result.content)
    const checked = parsed.ok ? checkProposal(parsed.proposal, request) : parsed
    if (checked.ok) return { ok: true, decomposition: checked.decomposition }
    lastProblems =
      result.finishReason === 'length' ? ['The answer was cut off at the token limit.', ...checked.problems] : checked.problems
    messages.push(
      { role: 'assistant', content: result.content },
      {
        role: 'user',
        content: `That answer was rejected:\n${lastProblems.map((p) => `- ${p}`).join('\n')}\nAnswer again with the corrected JSON object. Every quote must be copied exactly from the original message.`,
      },
    )
  }
  return {
    ok: false,
    error: providerError('malformed-response', `The decomposition was rejected twice: ${lastProblems.join(' ')}`, {
      httpStatus: 200,
    }),
  }
}

export const LABEL_PROMPT = `Name the request below with a short noun phrase of 1 to 4 words, lower case unless a proper noun, with no punctuation at the end. Examples: "neighborhoods", "menu translation", "sky color". Answer with the phrase only.`

const LABEL_MAX_LENGTH = 48

/** Strips quotes, a trailing period and extra whitespace; keeps the first line. */
export function cleanLabel(raw: string): string {
  const firstLine = raw.trim().split(/\r?\n/)[0] ?? ''
  let label = firstLine
    .replace(/^(?:label|answer)\s*:\s*/i, '')
    .replace(/^["'“‘`*]+|["'”’`*]+$/g, '')
    .replace(/[.!?;:,]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (label.length > LABEL_MAX_LENGTH) label = label.slice(0, LABEL_MAX_LENGTH).replace(/\s+\S*$/, '').trim()
  return label
}

async function label(
  options: ResolvedOptions,
  request: LabelRequest,
  signal: CancelSignal,
): Promise<LabelResult> {
  const result = await complete(
    options,
    {
      model: request.model,
      messages: [
        { role: 'system', content: LABEL_PROMPT },
        { role: 'user', content: request.text },
      ],
      max_tokens: 24,
    },
    signal,
  )
  if (!result.ok) return result
  const cleaned = cleanLabel(result.content)
  if (cleaned === '') {
    return { ok: false, error: providerError('malformed-response', 'The label was empty', { httpStatus: 200 }) }
  }
  return { ok: true, label: cleaned }
}

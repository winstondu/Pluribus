import { describe, expect, it } from 'vitest'
import { NEVER_CANCELLED } from '@committee/core/ports'
import { PREPARATION_PROMPT, READINESS_JSON_SCHEMA, createOpenRouterPreparer, parseReadiness, transcriptOf } from './preparer'
import { TEST_KEY, jsonResponse, mockFetch, withKey, withoutKey, type Responder } from './test-support/fetch-mock'

const REQUEST = {
  model: 'anthropic/claude-haiku-5.5',
  messages: [
    { role: 'system' as const, content: 'You are one of several model runs.' },
    { role: 'user' as const, content: 'Suggest neighborhoods' },
    { role: 'assistant' as const, content: 'Gion or Arashiyama.' },
    { role: 'user' as const, content: 'Book a hotel there' },
  ],
}

function completion(content: string, extra: Record<string, unknown> = {}): Response {
  return jsonResponse({
    id: 'gen-1',
    model: 'anthropic/claude-haiku-5.5-20261001',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 210, completion_tokens: 18, total_tokens: 228 },
    ...extra,
  })
}

function preparer(...responders: Responder[]) {
  const mock = mockFetch(...responders)
  return { mock, preparer: createOpenRouterPreparer({ getKey: withKey, fetch: mock.fetch, now: () => Date.parse('2026-11-12T00:00:00Z') }) }
}

describe('OpenRouter preparer', () => {
  it('asks for the typed readiness result under a strict schema, over the run input as one quoted transcript', async () => {
    const { mock, preparer: p } = preparer(() => completion('{"readiness":"ready","reason":null,"question":null}'))
    const result = await p.prepare(REQUEST, NEVER_CANCELLED)
    expect(result).toEqual({
      ok: true,
      readiness: { kind: 'ready' },
      model: 'anthropic/claude-haiku-5.5-20261001',
      usage: { inputTokens: 210, outputTokens: 18 },
    })
    const request = mock.requests[0]
    expect(request?.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(request?.headers['authorization']).toBe(`Bearer ${TEST_KEY}`)
    expect(request?.body).toMatchObject({
      model: 'anthropic/claude-haiku-5.5',
      stream: false,
      transforms: [],
      response_format: { type: 'json_schema', json_schema: { name: 'readiness', strict: true, schema: READINESS_JSON_SCHEMA } },
      provider: { require_parameters: true },
    })
    const messages = (request?.body as { messages: { role: string; content: string }[] }).messages
    expect(messages.map((m) => m.role)).toEqual(['system', 'user'])
    expect(messages[0]?.content).toBe(PREPARATION_PROMPT)
    // The run's turns are quoted, in order, so the model judges the request and does not answer it.
    expect(messages[1]?.content).toBe(transcriptOf(REQUEST.messages))
    expect(messages[1]?.content.indexOf('Gion or Arashiyama.')).toBeLessThan(messages[1]?.content.indexOf('Book a hotel there') ?? -1)
  })

  it('returns the question and its reason when clarification is needed', async () => {
    const { preparer: p } = preparer(() =>
      completion('```json\n{"readiness":"clarification-needed","reason":"missing-information","question":" Gion or Arashiyama? "}\n```'),
    )
    expect(await p.prepare(REQUEST, NEVER_CANCELLED)).toMatchObject({
      ok: true,
      readiness: { kind: 'clarification-needed', reason: 'missing-information', question: 'Gion or Arashiyama?' },
    })
  })

  it('never guesses: anything that is not the typed result is malformed-response', async () => {
    expect(parseReadiness('Sure! Here is a hotel.')).toBeNull()
    expect(parseReadiness('{"readiness":"maybe","reason":null,"question":null}')).toBeNull()
    // A question is required with clarification-needed.
    expect(parseReadiness('{"readiness":"clarification-needed","reason":"missing-information","question":"  "}')).toBeNull()
    expect(parseReadiness('{"readiness":"clarification-needed","reason":"incompatible-requirements","question":"Which one?"}')).toEqual({
      kind: 'clarification-needed',
      reason: 'incompatible-requirements',
      question: 'Which one?',
    })
    const { preparer: p } = preparer(() => completion('I think it is ready.'))
    const result = await p.prepare(REQUEST, NEVER_CANCELLED)
    expect(result).toMatchObject({ ok: false, error: { code: 'malformed-response', class: 'non-retryable' } })
  })

  it('maps provider failures like any other call and never sends without a key', async () => {
    const limited = preparer(() => jsonResponse({ error: { message: 'Rate limited', code: 429 } }, { status: 429, headers: { 'retry-after': '3' } }))
    expect(await limited.preparer.prepare(REQUEST, NEVER_CANCELLED)).toMatchObject({ ok: false, error: { code: 'rate-limited', class: 'transient', retryAfterMs: 3_000 } })
    const mock = mockFetch(() => completion('{}'))
    const keyless = createOpenRouterPreparer({ getKey: withoutKey, fetch: mock.fetch })
    expect(await keyless.prepare(REQUEST, NEVER_CANCELLED)).toMatchObject({ ok: false, error: { code: 'no-key' } })
    expect(mock.requests).toHaveLength(0)
    const empty = preparer(() => completion(''))
    expect(await empty.preparer.prepare(REQUEST, NEVER_CANCELLED)).toMatchObject({ ok: false, error: { code: 'empty-response' } })
  })
})

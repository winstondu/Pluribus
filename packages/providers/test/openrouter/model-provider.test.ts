import { describe, expect, it } from 'vitest'
import { PROVIDER_ERROR_CLASS, WORDING } from '@pluribus/protocol'
import { NEVER_CANCELLED, createCancelSource, type ModelStreamEvent } from '@pluribus/core/ports'
import { CLARIFICATION_TOOL, CLARIFICATION_TOOL_NAME, carriesClarificationSignal, createOpenRouterModelProvider } from '../../src/openrouter/model-provider'
import { estimateTokens } from '../../src/openrouter/models'
import {
  DONE,
  TEST_KEY,
  delta,
  hangingSseResponse,
  jsonResponse,
  mockFetch,
  sseResponse,
  usageChunk,
  withKey,
  withoutKey,
  type Responder,
} from '../../testing/fetch-mock'

const REQUEST = { model: 'anthropic/claude-haiku-5.5', messages: [{ role: 'user' as const, content: 'Hello' }] }

async function collect(iterable: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = []
  for await (const event of iterable) events.push(event)
  return events
}

function provider(...responders: Responder[]) {
  const mock = mockFetch(...responders)
  return { mock, provider: createOpenRouterModelProvider({ getKey: withKey, fetch: mock.fetch, now: () => Date.parse('2026-11-11T00:00:00Z') }) }
}

async function run(...responders: Responder[]) {
  const { mock, provider: p } = provider(...responders)
  const events = await collect(p.stream(REQUEST, NEVER_CANCELLED))
  return { events, mock }
}

function terminal(events: ModelStreamEvent[]): ModelStreamEvent | undefined {
  return events[events.length - 1]
}

function texts(events: ModelStreamEvent[]): string[] {
  return events.flatMap((e) => (e.type === 'text' ? [e.text] : []))
}

describe('OpenRouter model provider · streaming', () => {
  it('streams text, then completes with usage, from a request that carries the exact input', async () => {
    const { events, mock } = await run(() => sseResponse([delta('Hello'), delta(' there'), delta('', 'stop'), usageChunk(16, 10), DONE]))
    expect(events).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ' there' },
      { type: 'completed', finishReason: 'stop', usage: { inputTokens: 16, outputTokens: 10 } },
    ])
    expect(mock.requests).toHaveLength(1)
    const request = mock.requests[0]
    expect(request?.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(request?.method).toBe('POST')
    expect(request?.headers['authorization']).toBe(`Bearer ${TEST_KEY}`)
    expect(request?.body).toEqual({
      model: REQUEST.model,
      messages: REQUEST.messages,
      stream: true,
      stream_options: { include_usage: true },
      transforms: [],
    })
  })

  it('skips SSE comment lines such as ": OPENROUTER PROCESSING"', async () => {
    const { events } = await run(() =>
      sseResponse([': OPENROUTER PROCESSING\n\n', delta('A'), ': OPENROUTER PROCESSING\n\n', delta('', 'stop'), DONE]),
    )
    expect(texts(events)).toEqual(['A'])
    expect(terminal(events)).toEqual({ type: 'completed', finishReason: 'stop', usage: null })
  })

  it('reassembles events split across reads, including a multi-byte character split between bytes', async () => {
    const whole = delta('café ☕') + delta('', 'stop') + DONE
    const bytes = new TextEncoder().encode(whole)
    const pieces: Uint8Array[] = []
    for (let i = 0; i < bytes.length; i += 3) pieces.push(bytes.slice(i, i + 3))
    const { events } = await run(() => sseResponse(pieces))
    expect(texts(events).join('')).toBe('café ☕')
    expect(terminal(events)?.type).toBe('completed')
  })

  it('accepts CRLF line endings', async () => {
    const crlf = (s: string) => s.replace(/\n/g, '\r\n')
    const { events } = await run(() => sseResponse([crlf(delta('x')), crlf(delta('', 'stop')), crlf(DONE)]))
    expect(texts(events)).toEqual(['x'])
    expect(terminal(events)?.type).toBe('completed')
  })

  it('never yields empty text for role-only or empty deltas', async () => {
    const { events } = await run(() => sseResponse([delta(''), delta('a'), delta(''), delta('', 'stop'), DONE]))
    expect(events.filter((e) => e.type === 'text')).toEqual([{ type: 'text', text: 'a' }])
  })

  it('reports finish_reason "length" as a completed run cut at the length limit', async () => {
    const { events } = await run(() => sseResponse([delta('abc'), delta('', 'length'), DONE]))
    expect(terminal(events)).toEqual({ type: 'completed', finishReason: 'length', usage: null })
  })

  it('treats [DONE] after text with no finish reason as a normal end', async () => {
    const { events } = await run(() => sseResponse([delta('abc'), DONE]))
    expect(terminal(events)).toEqual({ type: 'completed', finishReason: 'stop', usage: null })
  })

  it('fails a stream that stops after text without a finish reason or [DONE] as a transient network error', async () => {
    const { events } = await run(() => sseResponse([delta('partial')]))
    expect(texts(events)).toEqual(['partial'])
    const last = terminal(events)
    expect(last?.type === 'failed' && last.error.code).toBe('network')
  })

  it('maps finish_reason "content_filter" to a non-retryable refusal', async () => {
    const { events } = await run(() => sseResponse([delta('I'), delta('', 'content_filter'), DONE]))
    const last = terminal(events)
    expect(last?.type === 'failed' && [last.error.code, last.error.class]).toEqual(['refusal', 'non-retryable'])
  })

  it('fails on a chunk that is not JSON', async () => {
    const { events } = await run(() => sseResponse([delta('a'), 'data: {not json\n\n', DONE]))
    const last = terminal(events)
    expect(last?.type === 'failed' && last.error.code).toBe('mid-stream-error')
  })
})

describe('OpenRouter model provider · mid-stream errors and empty 200', () => {
  it('a mid-stream error chunk (finish_reason "error" under HTTP 200) keeps the partial text and fails transiently', async () => {
    const errorChunk = `data: ${JSON.stringify({
      id: 'gen-1',
      error: { code: 'server_error', message: 'Provider disconnected' },
      choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }],
    })}\n\n`
    const { events } = await run(() => sseResponse([delta('Part'), errorChunk, DONE]))
    expect(events).toEqual([
      { type: 'text', text: 'Part' },
      {
        type: 'failed',
        error: { code: 'mid-stream-error', class: 'transient', message: 'Provider disconnected', httpStatus: 200, retryAfterMs: null },
      },
    ])
  })

  it('a mid-stream error chunk without an error object still fails transiently', async () => {
    const { events } = await run(() => sseResponse([delta('Part'), delta('', 'error')]))
    const last = terminal(events)
    expect(last?.type === 'failed' && [last.error.code, last.error.class]).toEqual(['mid-stream-error', 'transient'])
  })

  it('a mid-stream context_length_exceeded is non-retryable', async () => {
    const chunk = `data: ${JSON.stringify({
      error: { code: 'context_length_exceeded', message: 'Too long' },
      choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }],
    })}\n\n`
    const { events } = await run(() => sseResponse([chunk]))
    const last = terminal(events)
    expect(last?.type === 'failed' && [last.error.code, last.error.class]).toEqual(['context-length-exceeded', 'non-retryable'])
  })

  it.each([
    ['no body bytes at all', () => sseResponse([])],
    ['only [DONE]', () => sseResponse([DONE])],
    ['only keep-alive comments', () => sseResponse([': OPENROUTER PROCESSING\n\n'])],
    ['a finish reason with no text', () => sseResponse([delta('', 'stop'), usageChunk(5, 0), DONE])],
    ['an empty JSON body', () => new Response('', { status: 200, headers: { 'content-type': 'application/json' } })],
    ['a null body', () => new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream' } })],
  ])('an empty 200 (%s) is a transient empty-response', async (_name, responder) => {
    const { events } = await run(responder)
    expect(events).toHaveLength(1)
    const last = terminal(events)
    expect(last?.type === 'failed' && [last.error.code, last.error.class]).toEqual(['empty-response', 'transient'])
  })

  it('an error object in a JSON 200 is mapped by its code', async () => {
    const { events } = await run(() => jsonResponse({ error: { code: 402, message: 'Insufficient credits' } }))
    const last = terminal(events)
    expect(last?.type === 'failed' && [last.error.code, last.error.message]).toEqual(['out-of-credits', WORDING.outOfCredits])
  })

  it('a non-streamed JSON completion is still read', async () => {
    const { events } = await run(() =>
      jsonResponse({ choices: [{ message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
    )
    expect(events).toEqual([
      { type: 'text', text: 'Hi' },
      { type: 'completed', finishReason: 'stop', usage: { inputTokens: 3, outputTokens: 1 } },
    ])
  })
})

/** 11 · "OpenRouter error mapping", one row per case. */
describe('OpenRouter model provider · error mapping table', () => {
  const cases: {
    name: string
    status: number
    body: unknown
    headers?: Record<string, string>
    code: string
    message?: string
    retryAfterMs?: number | null
  }[] = [
    { name: '408 is a transient timeout', status: 408, body: { error: { code: 408, message: 'Timed out' } }, code: 'timeout' },
    {
      name: '429 is transient, honouring Retry-After seconds',
      status: 429,
      body: { error: { code: 429, message: 'Rate limited' } },
      headers: { 'retry-after': '7' },
      code: 'rate-limited',
      retryAfterMs: 7000,
    },
    {
      name: '429 honours an HTTP-date Retry-After',
      status: 429,
      body: { error: { code: 429, message: 'Rate limited' } },
      headers: { 'retry-after': 'Wed, 11 Nov 2026 00:00:30 GMT' },
      code: 'rate-limited',
      retryAfterMs: 30_000,
    },
    { name: '429 without Retry-After', status: 429, body: { error: { code: 429, message: 'Rate limited' } }, code: 'rate-limited', retryAfterMs: null },
    { name: '502 is a transient bad gateway', status: 502, body: { error: { code: 502, message: 'Bad gateway' } }, code: 'bad-gateway' },
    {
      name: '503 is transient, honouring Retry-After',
      status: 503,
      body: { error: { code: 503, message: 'No providers available' } },
      headers: { 'retry-after': '2' },
      code: 'service-unavailable',
      retryAfterMs: 2000,
    },
    { name: '500 is a transient provider error', status: 500, body: { error: { code: 500, message: 'Internal' } }, code: 'provider-error' },
    { name: '504 is a transient provider error', status: 504, body: 'gateway timeout', code: 'provider-error' },
    {
      name: '402 is non-retryable "Out of OpenRouter credits"',
      status: 402,
      body: { error: { code: 402, message: 'This request requires more credits' } },
      code: 'out-of-credits',
      message: WORDING.outOfCredits,
    },
    {
      name: '403 is non-retryable moderation, with the reason',
      status: 403,
      body: { error: { code: 403, message: 'Input was flagged', metadata: { reasons: ['harassment'], flagged_input: 'x' } } },
      code: 'moderation',
      message: 'Input was flagged: harassment',
    },
    {
      name: '400 is non-retryable, with the message',
      status: 400,
      body: { error: { code: 400, message: 'nope/nope is not a valid model ID' } },
      code: 'invalid-request',
      message: 'nope/nope is not a valid model ID',
    },
    {
      name: '401 is non-retryable, with the message',
      status: 401,
      body: { error: { code: 401, message: 'User not found.' } },
      code: 'unauthorized',
      message: 'User not found.',
    },
    {
      name: 'context_length_exceeded as a code is non-retryable',
      status: 400,
      body: { error: { code: 'context_length_exceeded', message: 'Input too long' } },
      code: 'context-length-exceeded',
    },
    {
      name: 'context_length_exceeded in the message is non-retryable',
      status: 400,
      body: { error: { code: 400, message: "This endpoint's maximum context length is 8192 tokens. However, you requested about 9000 tokens" } },
      code: 'context-length-exceeded',
    },
    {
      name: 'context_length_exceeded inside provider metadata is non-retryable',
      status: 400,
      body: { error: { code: 400, message: 'Provider returned error', metadata: { raw: '{"error":{"code":"context_length_exceeded"}}' } } },
      code: 'context-length-exceeded',
    },
    { name: 'another 4xx is non-retryable invalid-request', status: 404, body: { error: { code: 404, message: 'Not found' } }, code: 'invalid-request' },
    { name: 'Retry-After is ignored on 502', status: 502, body: '', headers: { 'retry-after': '9' }, code: 'bad-gateway', retryAfterMs: null },
  ]

  it.each(cases)('$name', async (row) => {
    const { events } = await run(() =>
      typeof row.body === 'string'
        ? new Response(row.body, { status: row.status, headers: row.headers ?? {} })
        : jsonResponse(row.body, { status: row.status, ...(row.headers === undefined ? {} : { headers: row.headers }) }),
    )
    expect(events).toHaveLength(1)
    const event = events[0]
    if (event?.type !== 'failed') throw new Error(`expected failed, got ${event?.type}`)
    expect(event.error.code).toBe(row.code)
    expect(event.error.class).toBe(PROVIDER_ERROR_CLASS[event.error.code])
    expect(event.error.httpStatus).toBe(row.status)
    if (row.message !== undefined) expect(event.error.message).toBe(row.message)
    if (row.retryAfterMs !== undefined) expect(event.error.retryAfterMs).toBe(row.retryAfterMs)
  })

  it('the classes match the table: 408, 429, 502, 503 transient; 400, 401, 402, 403 non-retryable', async () => {
    const classes: Record<number, string> = {}
    for (const status of [408, 429, 502, 503, 400, 401, 402, 403]) {
      const { events } = await run(() => jsonResponse({ error: { code: status, message: 'x' } }, { status }))
      const e = events[0]
      classes[status] = e?.type === 'failed' ? e.error.class : 'none'
    }
    expect(classes).toEqual({
      408: 'transient',
      429: 'transient',
      502: 'transient',
      503: 'transient',
      400: 'non-retryable',
      401: 'non-retryable',
      402: 'non-retryable',
      403: 'non-retryable',
    })
  })

  it('a network failure is transient', async () => {
    const { events } = await run(() => {
      throw new TypeError('fetch failed')
    })
    expect(events).toEqual([
      { type: 'failed', error: expect.objectContaining({ code: 'network', class: 'transient', httpStatus: null }) },
    ])
  })

  it('a body that breaks mid-read is a transient network failure, keeping the text before it', async () => {
    const { events } = await run(() => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(delta('Some')))
          setTimeout(() => controller.error(new TypeError('terminated')), 0)
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    expect(texts(events)).toEqual(['Some'])
    const last = terminal(events)
    expect(last?.type === 'failed' && last.error.code).toBe('network')
  })

  it('never puts the key in an error message', async () => {
    const { events } = await run(() => jsonResponse({ error: { code: 401, message: `Invalid key ${TEST_KEY}` } }, { status: 401 }))
    const e = events[0]
    expect(e?.type === 'failed' && e.error.message).toBe('Invalid key [redacted]')
    expect(JSON.stringify(events)).not.toContain(TEST_KEY)
  })
})

describe('OpenRouter model provider · key and cancellation', () => {
  it('with no key it fails with no-key and makes no request', async () => {
    const mock = mockFetch(() => sseResponse([delta('x'), DONE]))
    const p = createOpenRouterModelProvider({ getKey: withoutKey, fetch: mock.fetch })
    expect(await collect(p.stream(REQUEST, NEVER_CANCELLED))).toEqual([
      { type: 'failed', error: expect.objectContaining({ code: 'no-key', class: 'non-retryable' }) },
    ])
    expect(mock.requests).toHaveLength(0)
  })

  it('a secrets store that throws counts as no key', async () => {
    const mock = mockFetch(() => sseResponse([delta('x'), DONE]))
    const p = createOpenRouterModelProvider({ getKey: () => Promise.reject(new Error('locked')), fetch: mock.fetch })
    const events = await collect(p.stream(REQUEST, NEVER_CANCELLED))
    expect(events[0]?.type === 'failed' && events[0].error.code).toBe('no-key')
  })

  it('an already cancelled signal yields cancelled without a request', async () => {
    const { mock, provider: p } = provider(() => sseResponse([delta('x'), DONE]))
    const source = createCancelSource()
    source.cancel()
    expect(await collect(p.stream(REQUEST, source.signal))).toEqual([{ type: 'cancelled' }])
    expect(mock.requests).toHaveLength(0)
  })

  it('cancelling mid-stream aborts the HTTP request and yields cancelled with no further text', async () => {
    const { mock, provider: p } = provider((request) => hangingSseResponse(request, [delta('First')]))
    const source = createCancelSource()
    const events: ModelStreamEvent[] = []
    for await (const event of p.stream(REQUEST, source.signal)) {
      events.push(event)
      if (event.type === 'text') source.cancel()
    }
    expect(events).toEqual([{ type: 'text', text: 'First' }, { type: 'cancelled' }])
    expect(mock.requests[0]?.signal?.aborted).toBe(true)
  })

  it('cancelling while the request is still connecting yields cancelled', async () => {
    const source = createCancelSource()
    const { provider: p } = provider(
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
          source.cancel()
        }),
    )
    expect(await collect(p.stream(REQUEST, source.signal))).toEqual([{ type: 'cancelled' }])
  })

  it('a consumer that stops reading aborts the HTTP request', async () => {
    const { mock, provider: p } = provider((request) => hangingSseResponse(request, [delta('First')]))
    for await (const event of p.stream(REQUEST, NEVER_CANCELLED)) {
      if (event.type === 'text') break
    }
    expect(mock.requests[0]?.signal?.aborted).toBe(true)
  })
})

describe('OpenRouter model provider · countTokens', () => {
  const models = {
    data: [
      { id: 'anthropic/claude-haiku-5.5', context_length: 1_000_000, top_provider: { context_length: 1_000_000 } },
      { id: 'small/model', context_length: null, top_provider: { context_length: 8192 } },
    ],
  }

  it('reports an estimate with the context limit from /api/v1/models, reading the catalog once', async () => {
    const { mock, provider: p } = provider(() => jsonResponse(models))
    const first = await p.countTokens(REQUEST)
    const second = await p.countTokens({ ...REQUEST, model: 'small/model' })
    expect(first).toEqual({ inputTokens: estimateTokens(REQUEST.messages), contextLimit: 1_000_000, exact: false })
    expect(second.contextLimit).toBe(8192)
    expect(mock.requests.map((r) => r.url)).toEqual(['https://openrouter.ai/api/v1/models'])
  })

  it('an unknown model has a null limit', async () => {
    const { provider: p } = provider(() => jsonResponse(models))
    expect((await p.countTokens({ ...REQUEST, model: 'unknown/x' })).contextLimit).toBeNull()
  })

  it('never rejects: a failed catalog read gives a null limit and is retried on the next call', async () => {
    let calls = 0
    const { provider: p } = provider(() => {
      calls += 1
      if (calls === 1) throw new TypeError('offline')
      return jsonResponse(models)
    })
    expect((await p.countTokens(REQUEST)).contextLimit).toBeNull()
    expect((await p.countTokens(REQUEST)).contextLimit).toBe(1_000_000)
  })

  it('the estimate grows with the input and leans high for English text', () => {
    const english = 'The quick brown fox jumps over the lazy dog. '.repeat(100)
    const tokens = estimateTokens([{ role: 'user', content: english }])
    // A real tokenizer gives about 10 tokens per sentence here (1000 total).
    expect(tokens).toBeGreaterThan(1000)
    expect(tokens).toBeLessThan(1500)
    expect(estimateTokens([{ role: 'user', content: '你好世界' }])).toBeGreaterThanOrEqual(4)
  })

  it('the estimate does not count Cyrillic or accented text at a token per character', () => {
    // About 1 token per 3 to 4 characters with a real tokenizer.
    const russian = 'Быстрая коричневая лиса прыгает через ленивую собаку. '.repeat(100)
    const tokens = estimateTokens([{ role: 'user', content: russian }])
    expect(tokens).toBeLessThan(russian.length / 2)
    expect(tokens).toBeGreaterThan(russian.length / 5)
  })
})

/** One SSE `data:` event carrying a piece of a tool call. */
function toolDelta(piece: { name?: string; arguments?: string }, finishReason: string | null = null, index = 0): string {
  const fn = { ...(piece.name !== undefined ? { name: piece.name } : {}), ...(piece.arguments !== undefined ? { arguments: piece.arguments } : {}) }
  return `data: ${JSON.stringify({ id: 'gen-1', choices: [{ index: 0, delta: { tool_calls: [{ index, id: 'call_1', type: 'function', function: fn }] }, finish_reason: finishReason }] })}\n\n`
}

describe('OpenRouter model provider · the streamed clarification signal', () => {
  const SIGNALLED = { ...REQUEST, clarificationSignal: true }

  it('carries the signal as one function tool, only when core asks for it and the model is tested for it', async () => {
    const asked = provider(() => sseResponse([delta('Hi'), delta('', 'stop'), DONE]))
    await collect(asked.provider.stream(SIGNALLED, NEVER_CANCELLED))
    expect(asked.mock.requests[0]?.body).toMatchObject({ tools: [CLARIFICATION_TOOL], tool_choice: 'auto', parallel_tool_calls: false })
    expect(carriesClarificationSignal(SIGNALLED)).toBe(true)
    // A clarification question's own run does not carry it, and neither does a model off the compatibility list.
    expect(carriesClarificationSignal(REQUEST)).toBe(false)
    const unlisted = provider(() => sseResponse([delta('Hi'), delta('', 'stop'), DONE]))
    await collect(unlisted.provider.stream({ ...SIGNALLED, model: 'example/untested-model' }, NEVER_CANCELLED))
    expect(unlisted.mock.requests[0]?.body).not.toHaveProperty('tools')
  })

  it('reports a tool call as the typed terminal event; text before it stands as partial output and the question is never text', async () => {
    const { provider: p } = provider(() =>
      sseResponse([
        delta('Gion is'),
        toolDelta({ name: CLARIFICATION_TOOL_NAME, arguments: '' }),
        toolDelta({ arguments: '{"question":"Should the summary ' }),
        toolDelta({ arguments: 'include prices?","reason":"missing-information"}' }),
        delta('', 'tool_calls'),
        usageChunk(40, 22),
        DONE,
      ]),
    )
    const events = await collect(p.stream(SIGNALLED, NEVER_CANCELLED))
    expect(events).toEqual([
      { type: 'text', text: 'Gion is' },
      {
        type: 'clarification-needed',
        reason: 'missing-information',
        question: 'Should the summary include prices?',
        usage: { inputTokens: 40, outputTokens: 22 },
      },
    ])
  })

  it('a run that asks before writing anything is a clarification, not an empty response', async () => {
    const { provider: p } = provider(() =>
      sseResponse([
        toolDelta({ name: CLARIFICATION_TOOL_NAME, arguments: '{"question":"Which city?","reason":"incompatible-requirements"}' }, 'tool_calls'),
        DONE,
      ]),
    )
    expect(await collect(p.stream(SIGNALLED, NEVER_CANCELLED))).toEqual([
      { type: 'clarification-needed', reason: 'incompatible-requirements', question: 'Which city?', usage: null },
    ])
  })

  it('a call that cannot be read as a question fails the run as malformed-response', async () => {
    const pieces = [
      { name: CLARIFICATION_TOOL_NAME, arguments: '{"question":' },
      { name: CLARIFICATION_TOOL_NAME, arguments: '{"question":"  "}' },
      { name: 'something_else', arguments: '{}' },
    ]
    for (const piece of pieces) {
      const { provider: p } = provider(() => sseResponse([delta('Text'), toolDelta(piece, 'tool_calls'), DONE]))
      const events = await collect(p.stream(SIGNALLED, NEVER_CANCELLED))
      expect(terminal(events)).toMatchObject({ type: 'failed', error: { code: 'malformed-response' } })
    }
  })

  it('reads the signal from a non-streamed JSON body too', async () => {
    const { provider: p } = provider(() =>
      jsonResponse({
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'Gion is',
              tool_calls: [
                { id: 'call_1', type: 'function', function: { name: CLARIFICATION_TOOL_NAME, arguments: '{"question":"Which season?","reason":"missing-information"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 7 },
      }),
    )
    expect(await collect(p.stream(SIGNALLED, NEVER_CANCELLED))).toEqual([
      { type: 'text', text: 'Gion is' },
      { type: 'clarification-needed', reason: 'missing-information', question: 'Which season?', usage: { inputTokens: 5, outputTokens: 7 } },
    ])
  })
})

import { describe, expect, it } from 'vitest'
import { PROVIDER_ERROR_CLASS, WORDING, type ProviderErrorCode } from '@pluribus/protocol'
import { NEVER_CANCELLED, createCancelSource, type ModelStreamEvent } from '@pluribus/core/ports'
import { hangingSseResponse, jsonResponse, mockFetch, sseResponse, type RecordedRequest, type Responder } from '../../testing/fetch-mock'
import { CLARIFICATION_TOOL_NAME } from '../../src/openrouter/model-provider'
import { createAnthropicDecomposer } from '../../src/anthropic/decomposer'
import { checkAnthropicKey } from '../../src/anthropic/key-check'
import { ANTHROPIC_CLARIFICATION_TOOL, MAX_OUTPUT_TOKENS, createAnthropicModelProvider } from '../../src/anthropic/model-provider'
import { createAnthropicPreparer } from '../../src/anthropic/preparer'

const KEY = 'sk-ant-api03-test-key-0000'
const withKey = async (): Promise<string | null> => KEY
const NOW = (): number => Date.parse('2026-11-11T00:00:00Z')
const MODEL = 'claude-haiku-5-5'
const REQUEST = {
  model: MODEL,
  provider: 'anthropic' as const,
  messages: [
    { role: 'system' as const, content: 'Preamble' },
    { role: 'system' as const, content: 'Answer in French' },
    { role: 'user' as const, content: 'Hello' },
  ],
}

// ───────────────────────────── a scripted Claude API ─────────────────────────────

const MODELS = { data: [{ id: MODEL, type: 'model', display_name: 'Claude Haiku 5.5', created_at: '2026-01-01T00:00:00Z', max_input_tokens: 1_000_000, max_tokens: 32_000 }], has_more: false, first_id: MODEL, last_id: MODEL }

function event(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
}

const START = event('message_start', {
  type: 'message_start',
  message: { id: 'msg_1', type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1 } },
})

function textBlock(index: number, pieces: readonly string[]): string {
  return (
    event('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }) +
    pieces.map((text) => event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text } })).join('') +
    event('content_block_stop', { type: 'content_block_stop', index })
  )
}

function thinkingBlock(index: number): string {
  return (
    event('content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } }) +
    event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: 'private reasoning' } }) +
    event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'sig' } }) +
    event('content_block_stop', { type: 'content_block_stop', index })
  )
}

function toolBlock(index: number, name: string, json: string): string {
  return (
    event('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: 'toolu_1', name, input: {} } }) +
    event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json } }) +
    event('content_block_stop', { type: 'content_block_stop', index })
  )
}

function end(stopReason: string, outputTokens = 7, extra: Record<string, unknown> = {}): string {
  return (
    event('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null, ...extra }, usage: { output_tokens: outputTokens } }) +
    event('message_stop', { type: 'message_stop' })
  )
}

function apiError(status: number, type: string, message: string, init: { headers?: Record<string, string>; details?: Record<string, unknown> } = {}): Response {
  return jsonResponse(
    { type: 'error', error: { type, message, ...(init.details ? { details: init.details } : {}) }, request_id: 'req_1' },
    { status, ...(init.headers ? { headers: init.headers } : {}) },
  )
}

function message(text: string, stopReason = 'end_turn'): Response {
  return jsonResponse({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: `${MODEL}-served`,
    content: text === '' ? [] : [{ type: 'text', text }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 40, output_tokens: 9 },
  })
}

/** Routes by path: the model catalog, token counting, and Messages (the `messages` responders, in order). */
function api(...messages: Responder[]) {
  let call = 0
  return mockFetch((request) => {
    const path = new URL(request.url).pathname
    if (path === '/v1/models') return jsonResponse(MODELS)
    if (path === '/v1/messages/count_tokens') return jsonResponse({ input_tokens: 321 })
    const responder = messages[Math.min(call, messages.length - 1)]
    call += 1
    if (!responder) throw new Error('no responder')
    return responder(request)
  })
}

const posts = (mock: { requests: RecordedRequest[] }): RecordedRequest[] => mock.requests.filter((request) => new URL(request.url).pathname === '/v1/messages')

async function collect(iterable: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = []
  for await (const item of iterable) events.push(item)
  return events
}

async function run(responder: Responder, request: Parameters<ReturnType<typeof createAnthropicModelProvider>['stream']>[0] = REQUEST) {
  const mock = api(responder)
  const provider = createAnthropicModelProvider({ getKey: withKey, fetch: mock.fetch, now: NOW })
  const events = await collect(provider.stream(request, NEVER_CANCELLED))
  return { events, mock, provider }
}

const terminal = (events: ModelStreamEvent[]): ModelStreamEvent | undefined => events[events.length - 1]

// ───────────────────────────── streaming ─────────────────────────────

describe('Claude API model provider · streaming', () => {
  it('streams text, then completes with usage, from a Messages request that carries the exact input and the browser opt-in', async () => {
    const { events, mock } = await run(() => sseResponse([START, thinkingBlock(0), textBlock(1, ['Bon', 'jour']), end('end_turn')]))
    expect(events).toEqual([
      { type: 'text', text: 'Bon' },
      { type: 'text', text: 'jour' },
      { type: 'completed', finishReason: 'stop', usage: { inputTokens: 12, outputTokens: 7 } },
    ])
    const [request] = posts(mock)
    expect(request?.url).toBe('https://api.anthropic.com/v1/messages')
    expect(request?.method).toBe('POST')
    // The key travels as the bearer token, and only to Anthropic.
    expect(request?.headers['authorization']).toBe(`Bearer ${KEY}`)
    expect(mock.requests.every((r) => new URL(r.url).host === 'api.anthropic.com')).toBe(true)
    // Direct browser access is an explicit opt-in the API requires of a cross-origin request.
    expect(request?.headers['anthropic-dangerous-direct-browser-access']).toBe('true')
    expect(request?.headers['anthropic-version']).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(request?.body).toEqual({
      model: MODEL,
      // The model's own output cap from the catalog, not more.
      max_tokens: 32_000,
      system: 'Preamble\n\nAnswer in French',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
    })
  })

  it('thinking is never answer text, and a stop at the token limit is finish reason length', async () => {
    const { events } = await run(() => sseResponse([START, thinkingBlock(0), textBlock(1, ['Partial']), end('max_tokens')]))
    expect(events).toEqual([
      { type: 'text', text: 'Partial' },
      { type: 'completed', finishReason: 'length', usage: { inputTokens: 12, outputTokens: 7 } },
    ])
  })

  it('uses the default output cap when the catalog does not know the model', async () => {
    const { mock } = await run(() => sseResponse([START, textBlock(0, ['Hi']), end('end_turn')]), { ...REQUEST, model: 'claude-unknown' })
    expect((posts(mock)[0]?.body as { max_tokens: number }).max_tokens).toBe(MAX_OUTPUT_TOKENS)
  })

  it('a 200 with no text is an empty response, transient', async () => {
    const { events } = await run(() => sseResponse([START, thinkingBlock(0), end('end_turn')]))
    expect(events).toEqual([{ type: 'failed', error: expect.objectContaining({ code: 'empty-response', class: 'transient', httpStatus: 200 }) }])
  })

  it('a refusal is a typed failure; text before it stands as partial output', async () => {
    const { events } = await run(() => sseResponse([START, textBlock(0, ['I ']), end('refusal', 3, { stop_details: { type: 'refusal', category: 'cyber', explanation: 'Declined by a safety classifier' } })]))
    expect(events[0]).toEqual({ type: 'text', text: 'I ' })
    expect(terminal(events)).toEqual({ type: 'failed', error: expect.objectContaining({ code: 'refusal', class: 'non-retryable', message: 'Declined by a safety classifier' }) })
  })

  it('an error event after the stream began is a mid-stream error, transient; earlier text stands', async () => {
    const { events } = await run(() =>
      sseResponse([START, textBlock(0, ['Half']), event('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })]),
    )
    expect(events[0]).toEqual({ type: 'text', text: 'Half' })
    expect(terminal(events)).toEqual({ type: 'failed', error: { code: 'mid-stream-error', class: 'transient', message: 'Overloaded', httpStatus: 200, retryAfterMs: null } })
  })

  it('a connection that fails is a network error, and the key never appears in the message', async () => {
    const { events } = await run(() => {
      throw new TypeError(`fetch failed for ${KEY}`)
    })
    const last = terminal(events)
    expect(last?.type === 'failed' && last.error.code).toBe('network')
    expect(JSON.stringify(events)).not.toContain(KEY)
  })

  it('with no key it fails as no-key without a request', async () => {
    const mock = api(() => message('unused'))
    const provider = createAnthropicModelProvider({ getKey: async () => null, fetch: mock.fetch })
    expect(await collect(provider.stream(REQUEST, NEVER_CANCELLED))).toEqual([
      { type: 'failed', error: { code: 'no-key', class: 'non-retryable', message: 'No Anthropic key is configured', httpStatus: null, retryAfterMs: null } },
    ])
    expect(mock.requests).toHaveLength(0)
  })

  it('cancelling aborts the request and ends with cancelled, without further text', async () => {
    const source = createCancelSource()
    const mock = api((request) => hangingSseResponse(request, [START, textBlock(0, ['One'])]))
    const provider = createAnthropicModelProvider({ getKey: withKey, fetch: mock.fetch })
    const events: ModelStreamEvent[] = []
    for await (const item of provider.stream(REQUEST, source.signal)) {
      events.push(item)
      if (item.type === 'text') source.cancel()
    }
    expect(events).toEqual([{ type: 'text', text: 'One' }, { type: 'cancelled' }])
    expect(posts(mock)[0]?.signal?.aborted).toBe(true)
  })
})

describe('Claude API model provider · error mapping', () => {
  const cases: readonly [string, () => Response, ProviderErrorCode, Partial<{ message: string; retryAfterMs: number | null; httpStatus: number }>][] = [
    ['401 authentication_error', () => apiError(401, 'authentication_error', 'invalid x-api-key'), 'unauthorized', { message: 'invalid x-api-key', httpStatus: 401 }],
    [
      '401 for an organization that may not call from a browser keeps the provider\'s words',
      () => apiError(401, 'authentication_error', 'CORS requests are not allowed for this Organization because of its settings'),
      'unauthorized',
      { message: 'CORS requests are not allowed for this Organization because of its settings' },
    ],
    ['402 billing_error', () => apiError(402, 'billing_error', 'Your credit balance is too low'), 'out-of-credits', { message: WORDING.outOfAnthropicCredits, httpStatus: 402 }],
    [
      '429 at the monthly spend cap is out of credits, not a rate limit to wait out',
      () => apiError(429, 'rate_limit_error', 'You have reached your API usage limits', { details: { error_code: 'enforced_spend_limit_reached' } }),
      'out-of-credits',
      { message: WORDING.outOfAnthropicCredits, httpStatus: 429 },
    ],
    ['403 permission_error', () => apiError(403, 'permission_error', 'Not allowed for this workspace'), 'unauthorized', { message: 'Not allowed for this workspace' }],
    ['429 rate_limit_error with retry-after', () => apiError(429, 'rate_limit_error', 'Rate limited', { headers: { 'retry-after': '7' } }), 'rate-limited', { retryAfterMs: 7000 }],
    ['529 overloaded_error with retry-after', () => apiError(529, 'overloaded_error', 'Overloaded', { headers: { 'retry-after': '2' } }), 'service-unavailable', { retryAfterMs: 2000 }],
    ['503', () => apiError(503, 'api_error', 'Unavailable'), 'service-unavailable', { retryAfterMs: null }],
    ['500 api_error', () => apiError(500, 'api_error', 'Internal error'), 'provider-error', { httpStatus: 500 }],
    ['502', () => apiError(502, 'api_error', 'Bad gateway'), 'bad-gateway', {}],
    ['504 timeout_error', () => apiError(504, 'timeout_error', 'Timed out'), 'timeout', {}],
    ['500 timeout_error', () => apiError(500, 'timeout_error', 'Timed out before the response started'), 'timeout', {}],
    ['400 over the context window', () => apiError(400, 'invalid_request_error', 'prompt is too long: 1200000 tokens > 1000000 maximum'), 'context-length-exceeded', { httpStatus: 400 }],
    ['413 request_too_large', () => apiError(413, 'request_too_large', 'Request exceeds the maximum size'), 'context-length-exceeded', {}],
    ['400 invalid_request_error', () => apiError(400, 'invalid_request_error', 'messages: at least one message is required'), 'invalid-request', { message: 'messages: at least one message is required' }],
    ['404 not_found_error for a model the key cannot use', () => apiError(404, 'not_found_error', 'model: claude-nope'), 'invalid-request', { message: 'model: claude-nope' }],
  ]
  for (const [name, respond, code, details] of cases) {
    it(`${name} → ${code}`, async () => {
      const { events, mock } = await run(respond)
      expect(events).toHaveLength(1)
      const last = terminal(events)
      expect(last?.type).toBe('failed')
      if (last?.type !== 'failed') return
      expect(last.error.code).toBe(code)
      expect(last.error.class).toBe(PROVIDER_ERROR_CLASS[code])
      expect(last.error).toMatchObject(details)
      // It does not retry: core applies the retry setting.
      expect(posts(mock)).toHaveLength(1)
    })
  }
})

describe('Claude API model provider · clarification signal and token count', () => {
  const signalled = { ...REQUEST, model: 'claude-sonnet-5-5', clarificationSignal: true }

  it('a tested model carries the signal as a tool; a call to it ends the run with the question', async () => {
    const { events, mock } = await run(
      () => sseResponse([START, textBlock(0, ['Before I go on']), toolBlock(1, CLARIFICATION_TOOL_NAME, '{"question":" Which city? ","reason":"missing-information"}'), end('tool_use')]),
      signalled,
    )
    expect(events).toEqual([
      { type: 'text', text: 'Before I go on' },
      { type: 'clarification-needed', reason: 'missing-information', question: 'Which city?', usage: { inputTokens: 12, outputTokens: 7 } },
    ])
    const body = posts(mock)[0]?.body as { tools?: unknown; tool_choice?: unknown }
    expect(body.tools).toEqual([ANTHROPIC_CLARIFICATION_TOOL])
    // Never a forced call: current models reject it. One call at most.
    expect(body.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true })
  })

  it('a call that cannot be read as a question is a malformed response', async () => {
    const { events } = await run(() => sseResponse([START, toolBlock(0, CLARIFICATION_TOOL_NAME, '{"question":"  "}'), end('tool_use')]), signalled)
    expect(events).toEqual([{ type: 'failed', error: expect.objectContaining({ code: 'malformed-response', class: 'non-retryable' }) }])
  })

  it('no tool is sent when core did not ask for the signal, or the model is not tested for it', async () => {
    const plain = await run(() => sseResponse([START, textBlock(0, ['Hi']), end('end_turn')]), { ...signalled, clarificationSignal: false })
    expect(posts(plain.mock)[0]?.body).not.toHaveProperty('tools')
    const untested = await run(() => sseResponse([START, textBlock(0, ['Hi']), end('end_turn')]), { ...signalled, model: 'claude-opus-5-5' })
    expect(posts(untested.mock)[0]?.body).not.toHaveProperty('tools')
  })

  it('counts tokens exactly through the API and reads the context window from the catalog; without a key it estimates', async () => {
    const mock = api(() => message('unused'))
    const provider = createAnthropicModelProvider({ getKey: withKey, fetch: mock.fetch })
    expect(await provider.countTokens(REQUEST)).toEqual({ inputTokens: 321, contextLimit: 1_000_000, exact: true })
    const counted = mock.requests.find((request) => new URL(request.url).pathname === '/v1/messages/count_tokens')
    expect(counted?.body).toEqual({ model: MODEL, system: 'Preamble\n\nAnswer in French', messages: [{ role: 'user', content: 'Hello' }] })
    const keyless = createAnthropicModelProvider({ getKey: async () => null, fetch: mock.fetch })
    const estimate = await keyless.countTokens(REQUEST)
    expect(estimate.exact).toBe(false)
    expect(estimate.inputTokens).toBeGreaterThan(0)
  })
})

// ───────────────────────────── decomposition and preparation ─────────────────────────────

const TEXT = 'Why is the sky blue? Also translate "hello" into French.'
const PROPOSAL = {
  fragments: [
    { key: 'f1', sourceQuotes: ['Why is the sky blue?'], instruction: 'Explain why the sky is blue.', label: 'sky color', requirements: [], dependsOnFragments: [], dependsOnCandidates: [] },
    { key: 'f2', sourceQuotes: ['translate "hello" into French'], instruction: 'Translate "hello" into French.', label: 'translation', requirements: [], dependsOnFragments: [], dependsOnCandidates: [] },
  ],
  barrier: null,
  outputOrder: null,
  combinedLimit: null,
}

describe('Claude API decomposer', () => {
  const decomposer = (mock: ReturnType<typeof api>) => createAnthropicDecomposer({ getKey: withKey, fetch: mock.fetch, now: NOW })
  const request = { model: MODEL, provider: 'anthropic' as const, text: TEXT, candidates: [] }

  it('asks for the proposal as structured output and returns exact spans', async () => {
    const mock = api(() => message(JSON.stringify(PROPOSAL)))
    const result = await decomposer(mock).decompose(request, NEVER_CANCELLED)
    expect(result.ok && result.decomposition.fragments.map((f) => [f.label, TEXT.slice(f.sourceSpans[0]?.start, f.sourceSpans[0]?.end)])).toEqual([
      ['sky color', 'Why is the sky blue?'],
      ['translation', 'translate "hello" into French'],
    ])
    const body = posts(mock)[0]?.body as { model: string; system: string; output_config: { format: { type: string; schema: { properties: Record<string, unknown> } } }; messages: { role: string }[] }
    expect(body.model).toBe(MODEL)
    expect(body.system).toContain('You split a chat message into fragments')
    expect(body.output_config.format.type).toBe('json_schema')
    expect(Object.keys(body.output_config.format.schema.properties).sort()).toEqual(['barrier', 'combinedLimit', 'fragments', 'outputOrder'])
    expect(body.messages.map((m) => m.role)).toEqual(['user'])
    expect(body).not.toHaveProperty('stream')
  })

  it('a proposal that fails the check is asked for once more with the problems; twice rejected is malformed', async () => {
    const bad = { ...PROPOSAL, fragments: [{ ...PROPOSAL.fragments[0], sourceQuotes: ['Why is the sky green?'] }] }
    const fixed = api(() => message(JSON.stringify(bad)), () => message(JSON.stringify(PROPOSAL)))
    expect((await decomposer(fixed).decompose(request, NEVER_CANCELLED)).ok).toBe(true)
    const second = posts(fixed)[1]?.body as { messages: { role: string; content: string }[] }
    expect(second.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(second.messages[2]?.content).toContain('not an exact substring')

    const never = api(() => message(JSON.stringify(bad)))
    const result = await decomposer(never).decompose(request, NEVER_CANCELLED)
    expect(!result.ok && result.error.code).toBe('malformed-response')
    expect(posts(never)).toHaveLength(2)
  })

  it('a transport error is returned as it is, without the second round; a refusal and an empty answer are typed', async () => {
    const limited = api(() => apiError(429, 'rate_limit_error', 'Rate limited', { headers: { 'retry-after': '3' } }))
    const result = await decomposer(limited).decompose(request, NEVER_CANCELLED)
    expect(!result.ok && [result.error.code, result.error.retryAfterMs]).toEqual(['rate-limited', 3000])
    expect(posts(limited)).toHaveLength(1)
    const refused = await decomposer(api(() => message('', 'refusal'))).decompose(request, NEVER_CANCELLED)
    expect(!refused.ok && refused.error.code).toBe('refusal')
    const empty = await decomposer(api(() => message(''))).decompose(request, NEVER_CANCELLED)
    expect(!empty.ok && empty.error.code).toBe('empty-response')
  })

  it('labels an atomic request', async () => {
    const mock = api(() => message('"Sky color."\n'))
    const result = await decomposer(mock).label?.({ model: MODEL, provider: 'anthropic', text: 'Why is the sky blue?' }, NEVER_CANCELLED)
    expect(result).toEqual({ ok: true, label: 'Sky color' })
  })
})

describe('Claude API preparer', () => {
  const preparer = (mock: ReturnType<typeof api>) => createAnthropicPreparer({ getKey: withKey, fetch: mock.fetch, now: NOW })
  const request = { model: MODEL, provider: 'anthropic' as const, messages: [{ role: 'user' as const, content: 'Book it' }] }

  it('returns the typed readiness result from a structured, non-streaming request', async () => {
    const ready = api(() => message(JSON.stringify({ readiness: 'ready', reason: null, question: null })))
    expect(await preparer(ready).prepare(request, NEVER_CANCELLED)).toEqual({
      ok: true,
      readiness: { kind: 'ready' },
      model: `${MODEL}-served`,
      usage: { inputTokens: 40, outputTokens: 9 },
    })
    const body = posts(ready)[0]?.body as { output_config: { format: { type: string } }; messages: { content: string }[] }
    expect(body.output_config.format.type).toBe('json_schema')
    expect(body.messages[0]?.content).toContain('<user>\nBook it\n</user>')

    const ask = api(() => message(JSON.stringify({ readiness: 'clarification-needed', reason: 'missing-information', question: 'Which flight?' })))
    const asked = await preparer(ask).prepare(request, NEVER_CANCELLED)
    expect(asked.ok && asked.readiness).toEqual({ kind: 'clarification-needed', reason: 'missing-information', question: 'Which flight?' })
  })

  it('anything that is not the typed result is malformed; a provider failure is typed', async () => {
    const odd = await preparer(api(() => message('Sure, here you go'))).prepare(request, NEVER_CANCELLED)
    expect(!odd.ok && odd.error.code).toBe('malformed-response')
    const broke = await preparer(api(() => apiError(402, 'billing_error', 'no credit'))).prepare(request, NEVER_CANCELLED)
    expect(!broke.ok && [broke.error.code, broke.error.message]).toEqual(['out-of-credits', WORDING.outOfAnthropicCredits])
  })
})

// ───────────────────────────── the key check ─────────────────────────────

describe('Anthropic key check', () => {
  /** The check makes two requests: the model list, then the one-token probe. */
  function check(models: Responder, probe: Responder = () => message('H', 'max_tokens')) {
    const mock = mockFetch((request) => (new URL(request.url).pathname === '/v1/models' ? models(request) : probe(request)))
    return { mock, result: checkAnthropicKey(` ${KEY}\n`, new AbortController().signal, { fetch: mock.fetch }) }
  }
  const listed: Responder = () => jsonResponse(MODELS)

  it('valid, with credit: the key is recognized and a one-token request was accepted', async () => {
    const { mock, result } = check(listed)
    expect(await result).toEqual({ status: 'valid', label: null, credit: { kind: 'available' } })
    expect(mock.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual(['GET /v1/models', 'POST /v1/messages'])
    // The probe is as small as a request can be, on the cheapest model.
    expect(mock.requests[1]?.body).toEqual({ model: 'claude-haiku-5-5', max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] })
    expect(mock.requests.every((r) => r.headers['authorization'] === `Bearer ${KEY}` && r.headers['anthropic-dangerous-direct-browser-access'] === 'true')).toBe(true)
  })

  it('invalid: the key is not recognized, and no paid request is made', async () => {
    const { mock, result } = check(() => apiError(401, 'authentication_error', 'invalid x-api-key'))
    expect(await result).toEqual({ status: 'invalid' })
    expect(mock.requests).toHaveLength(1)
  })

  it('valid but out of credit: a billing error, the spend cap, or a spend limit the organization set', async () => {
    const exhausted = { status: 'valid', label: null, credit: { kind: 'exhausted' } }
    expect(await check(listed, () => apiError(402, 'billing_error', 'Your credit balance is too low')).result).toEqual(exhausted)
    expect(await check(listed, () => apiError(429, 'rate_limit_error', 'usage limits', { details: { error_code: 'enforced_spend_limit_reached' } })).result).toEqual(exhausted)
    expect(await check(listed, () => apiError(400, 'invalid_request_error', 'You have reached your specified API usage limits. You will regain access on 2026-12-01.')).result).toEqual(exhausted)
  })

  it('valid, credit undeterminable: the probe was rate limited, overloaded, or the model is not available to the key', async () => {
    const unknown = { status: 'valid', label: null, credit: { kind: 'unknown' } }
    expect(await check(listed, () => apiError(429, 'rate_limit_error', 'Rate limited')).result).toEqual(unknown)
    expect(await check(listed, () => apiError(529, 'overloaded_error', 'Overloaded')).result).toEqual(unknown)
    expect(await check(listed, () => apiError(404, 'not_found_error', 'model: claude-haiku-5-5')).result).toEqual(unknown)
  })

  it('an organization that may not call from a browser, an unreachable API, and a non-verdict are each said as such', async () => {
    expect(await check(() => apiError(401, 'authentication_error', 'CORS requests are not allowed for this Organization because of custom retention settings')).result).toEqual({
      status: 'blocked',
      reason: 'This Anthropic organization does not allow requests from a browser.',
    })
    expect(
      await check(() => {
        throw new TypeError('Failed to fetch')
      }).result,
    ).toEqual({ status: 'offline' })
    expect(await check(() => apiError(503, 'api_error', 'Unavailable')).result).toEqual({ status: 'unverified', httpStatus: 503 })
  })

  it('never puts the key in a result', async () => {
    for (const models of [listed, () => apiError(401, 'authentication_error', `bad key ${KEY}`)] as Responder[]) {
      expect(JSON.stringify(await check(models, () => apiError(402, 'billing_error', `no credit for ${KEY}`)).result)).not.toContain(KEY)
    }
  })
})

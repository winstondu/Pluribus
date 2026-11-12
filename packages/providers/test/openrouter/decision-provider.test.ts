import { describe, expect, it } from 'vitest'
import { WORDING } from '@committee/protocol'
import { NEVER_CANCELLED, createCancelSource } from '@committee/core/ports'
import { createOpenRouterDecisionProvider } from '../../src/openrouter/decision-provider'
import { TEST_KEY, jsonResponse, mockFetch, withKey, withoutKey, type Responder } from '../../testing/fetch-mock'

const QUESTIONS = {
  isGreeting: { type: 'noul', instructions: 'Is this message a greeting?' },
  kind: { type: 'choice', instructions: 'What kind of message is it?', options: { greet: 'a greeting', ask: 'a question' } },
  tone: { type: 'score', instructions: 'How polite is it?', criteria: ['polite', 'warm'] },
} as const

const REQUEST = { model: 'typesafe/jev-1.13', state: 'Hi there!', questions: QUESTIONS }

/** The live response recorded in CLAUDE.md. */
const LIVE_RESPONSE = {
  model: 'typesafe/jev-1.13-20260917',
  answers: {
    isGreeting: { type: 'noul', noul: 0.99 },
    kind: { type: 'choice', choice: 'greet', probabilities: { greet: 1, ask: 0 }, confidence: 1 },
    tone: { type: 'score', score: 0.28, legend: { '0': 'polite', '1': 'warm' }, probabilities: { '0': 0.72, '1': 0.28 }, confidence: 0.44 },
  },
  usage: { input_tokens: 358, output_tokens: 65, cost: 0.000015 },
}

function setup(...responders: Responder[]) {
  const mock = mockFetch(...responders)
  return { mock, provider: createOpenRouterDecisionProvider({ getKey: withKey, fetch: mock.fetch }) }
}

describe('OpenRouter decision provider', () => {
  it('sends every question in one call, in the live Decisions shape', async () => {
    const { mock, provider } = setup(() => jsonResponse(LIVE_RESPONSE))
    await provider.decide(REQUEST, NEVER_CANCELLED)
    expect(mock.requests).toHaveLength(1)
    const request = mock.requests[0]
    expect(request?.url).toBe('https://openrouter.ai/api/alpha/decisions')
    expect(request?.method).toBe('POST')
    expect(request?.headers['authorization']).toBe(`Bearer ${TEST_KEY}`)
    expect(request?.body).toEqual({
      model: 'typesafe/jev-1.13',
      state: 'Hi there!',
      questions: {
        isGreeting: { type: 'noul', instructions: 'Is this message a greeting?' },
        kind: { type: 'choice', instructions: 'What kind of message is it?', criteria: { greet: 'a greeting', ask: 'a question' } },
        tone: { type: 'score', instructions: 'How polite is it?', criteria: ['polite', 'warm'] },
      },
    })
  })

  it('parses the live response: noul → probability, choice with probabilities, score, usage and the dated model', async () => {
    const { provider } = setup(() => jsonResponse(LIVE_RESPONSE))
    const result = await provider.decide(REQUEST, NEVER_CANCELLED)
    expect(result).toEqual({
      ok: true,
      model: 'typesafe/jev-1.13-20260917',
      answers: {
        isGreeting: { type: 'noul', probability: 0.99 },
        kind: { type: 'choice', choice: 'greet', confidence: 1, probabilities: { greet: 1, ask: 0 } },
        tone: { type: 'score', score: 0.28, confidence: 0.44 },
      },
      usage: { inputTokens: 358, outputTokens: 65 },
    })
    if (result.ok) {
      // The answer types follow the question types.
      const choice: 'greet' | 'ask' = result.answers.kind.choice
      const probability: number = result.answers.isGreeting.probability
      expect([choice, probability]).toEqual(['greet', 0.99])
    }
  })

  it('a choice outside the supplied options is malformed-response', async () => {
    const { provider } = setup(() =>
      jsonResponse({ ...LIVE_RESPONSE, answers: { ...LIVE_RESPONSE.answers, kind: { type: 'choice', choice: 'farewell', confidence: 0.9, probabilities: {} } } }),
    )
    const result = await provider.decide(REQUEST, NEVER_CANCELLED)
    expect(result.ok === false && [result.error.code, result.error.class]).toEqual(['malformed-response', 'non-retryable'])
  })

  it('a missing answer is malformed-response', async () => {
    const { isGreeting: _omitted, ...rest } = LIVE_RESPONSE.answers
    const { provider } = setup(() => jsonResponse({ ...LIVE_RESPONSE, answers: rest }))
    const result = await provider.decide(REQUEST, NEVER_CANCELLED)
    expect(result.ok === false && result.error.code).toBe('malformed-response')
  })

  it('an answer of the wrong type is malformed-response', async () => {
    const { provider } = setup(() => jsonResponse({ ...LIVE_RESPONSE, answers: { ...LIVE_RESPONSE.answers, isGreeting: { type: 'score', score: 1 } } }))
    const result = await provider.decide(REQUEST, NEVER_CANCELLED)
    expect(result.ok === false && result.error.code).toBe('malformed-response')
  })

  it('a probability outside [0, 1] is malformed-response', async () => {
    const { provider } = setup(() => jsonResponse({ ...LIVE_RESPONSE, answers: { ...LIVE_RESPONSE.answers, isGreeting: { type: 'noul', noul: 1.5 } } }))
    const result = await provider.decide(REQUEST, NEVER_CANCELLED)
    expect(result.ok === false && result.error.code).toBe('malformed-response')
  })

  it('a choice without confidence takes the chosen option’s probability', async () => {
    const { provider } = setup(() =>
      jsonResponse({ ...LIVE_RESPONSE, answers: { ...LIVE_RESPONSE.answers, kind: { type: 'choice', choice: 'ask', probabilities: { greet: 0.2, ask: 0.8 } } } }),
    )
    const result = await provider.decide(REQUEST, NEVER_CANCELLED)
    expect(result.ok && result.answers.kind).toEqual({ type: 'choice', choice: 'ask', confidence: 0.8, probabilities: { greet: 0.2, ask: 0.8 } })
  })

  it('a body that is not JSON, or has no answers, is malformed-response', async () => {
    for (const responder of [() => new Response('<html>', { status: 200 }), () => jsonResponse({ model: 'x' })]) {
      const { provider } = setup(responder)
      const result = await provider.decide(REQUEST, NEVER_CANCELLED)
      expect(result.ok === false && result.error.code).toBe('malformed-response')
    }
  })

  it('an empty 200 is a transient empty-response', async () => {
    const { provider } = setup(() => new Response('', { status: 200 }))
    const result = await provider.decide(REQUEST, NEVER_CANCELLED)
    expect(result.ok === false && [result.error.code, result.error.class]).toEqual(['empty-response', 'transient'])
  })

  it.each([
    [400, { error: { message: 'Invalid discriminator value', code: 400 } }, 'invalid-request', 'Invalid discriminator value'],
    [401, { error: { message: 'User not found.', code: 401 } }, 'unauthorized', 'User not found.'],
    [402, { error: { message: 'More credits needed', code: 402 } }, 'out-of-credits', WORDING.outOfCredits],
    [429, { error: { message: 'Slow down', code: 429 } }, 'rate-limited', 'Slow down'],
    [529, { error: { message: 'Overloaded', code: 529 } }, 'provider-error', 'Overloaded'],
  ])('HTTP %i maps like the model provider', async (status, body, code, message) => {
    const { provider } = setup(() => jsonResponse(body, { status, headers: { 'retry-after': '3' } }))
    const result = await provider.decide(REQUEST, NEVER_CANCELLED)
    expect(result.ok === false && [result.error.code, result.error.message, result.error.httpStatus]).toEqual([code, message, status])
    if (status === 429) expect(result.ok === false && result.error.retryAfterMs).toBe(3000)
  })

  it('an error object under HTTP 200 is mapped by its code', async () => {
    const { provider } = setup(() => jsonResponse({ error: { message: 'User not found.', code: 401 } }))
    const result = await provider.decide(REQUEST, NEVER_CANCELLED)
    expect(result.ok === false && result.error.code).toBe('unauthorized')
  })

  it('a network failure is transient', async () => {
    const { provider } = setup(() => {
      throw new TypeError('fetch failed')
    })
    const result = await provider.decide(REQUEST, NEVER_CANCELLED)
    expect(result.ok === false && [result.error.code, result.error.class]).toEqual(['network', 'transient'])
  })

  it('with no key it fails with no-key and makes no request', async () => {
    const mock = mockFetch(() => jsonResponse(LIVE_RESPONSE))
    const provider = createOpenRouterDecisionProvider({ getKey: withoutKey, fetch: mock.fetch })
    const result = await provider.decide(REQUEST, NEVER_CANCELLED)
    expect(result.ok === false && result.error.code).toBe('no-key')
    expect(mock.requests).toHaveLength(0)
  })

  it('rejects a choice with no options, or with more than 255, before calling', async () => {
    const { mock, provider } = setup(() => jsonResponse(LIVE_RESPONSE))
    const none = await provider.decide({ ...REQUEST, questions: { q: { type: 'choice', instructions: 'x', options: {} } } }, NEVER_CANCELLED)
    const many = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, `option ${i}`]))
    const tooMany = await provider.decide({ ...REQUEST, questions: { q: { type: 'choice', instructions: 'x', options: many } } }, NEVER_CANCELLED)
    expect([none.ok === false && none.error.code, tooMany.ok === false && tooMany.error.code]).toEqual(['invalid-request', 'invalid-request'])
    expect(mock.requests).toHaveLength(0)
  })

  it('a cancelled signal makes no request and aborts one in flight', async () => {
    const cancelledBefore = createCancelSource()
    cancelledBefore.cancel()
    const { mock, provider } = setup(() => jsonResponse(LIVE_RESPONSE))
    expect((await provider.decide(REQUEST, cancelledBefore.signal)).ok).toBe(false)
    expect(mock.requests).toHaveLength(0)

    const during = createCancelSource()
    const hanging = setup(
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
          during.cancel()
        }),
    )
    const result = await hanging.provider.decide(REQUEST, during.signal)
    expect(result.ok).toBe(false)
    expect(hanging.mock.requests[0]?.signal?.aborted).toBe(true)
  })
})

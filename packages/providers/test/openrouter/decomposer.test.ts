import { describe, expect, it } from 'vitest'
import { NEVER_CANCELLED } from '@committee/core/ports'
import { cleanLabel, createOpenRouterDecomposer, locateQuote } from '../../src/openrouter/decomposer'
import { jsonResponse, mockFetch, withKey, type Responder } from '../../testing/fetch-mock'

const TEXT =
  'Explain why the sky is blue, and separately translate this menu into French. Keep both accessible to a beginner.'

const REQUEST = {
  model: 'anthropic/claude-haiku-5.5',
  text: TEXT,
  candidates: [{ id: 'cand-a', label: 'recommendation', description: 'A restaurant recommendation in progress' }],
}

function completion(content: string, finishReason = 'stop'): Response {
  return jsonResponse({ choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }] })
}

const SHARED = { text: 'Keep it accessible to a beginner', sourceQuote: 'Keep both accessible to a beginner', scope: 'local' }

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    fragments: [
      {
        key: 'f2',
        sourceQuotes: ['translate this menu into French'],
        instruction: 'Translate this menu into French, accessible to a beginner.',
        label: 'Menu translation.',
        requirements: [SHARED],
        dependsOnFragments: [] as string[],
        dependsOnCandidates: [] as string[],
      },
      {
        key: 'f1',
        sourceQuotes: ['Explain why the sky is blue'],
        instruction: 'Explain why the sky is blue, accessible to a beginner.',
        label: 'sky color',
        requirements: [SHARED],
        dependsOnFragments: [] as string[],
        dependsOnCandidates: [] as string[],
      },
    ],
    barrier: null,
    outputOrder: null,
    combinedLimit: null as string | null,
    ...overrides,
  }
}

function setup(...responders: Responder[]) {
  const mock = mockFetch(...responders)
  return { mock, decomposer: createOpenRouterDecomposer({ getKey: withKey, fetch: mock.fetch }) }
}

describe('OpenRouter decomposer · decompose', () => {
  it('asks with a strict response_format JSON schema on the decomposition model', async () => {
    const { mock, decomposer } = setup(() => completion(JSON.stringify(proposal())))
    await decomposer.decompose(REQUEST, NEVER_CANCELLED)
    const body = mock.requests[0]?.body as Record<string, unknown>
    expect(mock.requests[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(body['model']).toBe('anthropic/claude-haiku-5.5')
    expect(body['stream']).toBe(false)
    expect(body['provider']).toEqual({ require_parameters: true })
    expect(body['response_format']).toMatchObject({ type: 'json_schema', json_schema: { name: 'decomposition', strict: true } })
    const messages = body['messages'] as { role: string; content: string }[]
    expect(messages[1]?.content).toContain(TEXT)
    expect(messages[1]?.content).toContain('cand-a')
  })

  it('turns quotes into exact spans, keeps shared requirements on each fragment, and orders fragments by the text', async () => {
    const { decomposer } = setup(() => completion(JSON.stringify(proposal())))
    const result = await decomposer.decompose(REQUEST, NEVER_CANCELLED)
    if (!result.ok) throw new Error(result.error.message)
    const { fragments, barrier, outputOrder } = result.decomposition
    expect(fragments.map((f) => f.key)).toEqual(['f1', 'f2'])
    for (const fragment of fragments) {
      for (const span of fragment.sourceSpans) expect(span.end).toBeGreaterThan(span.start)
    }
    expect(fragments.map((f) => f.sourceSpans.map((s) => TEXT.slice(s.start, s.end)))).toEqual([
      ['Explain why the sky is blue'],
      ['translate this menu into French'],
    ])
    const sharedSpan = { start: TEXT.indexOf('Keep both'), end: TEXT.indexOf('Keep both') + SHARED.sourceQuote.length }
    expect(fragments.map((f) => f.requirements)).toEqual([
      [{ text: SHARED.text, span: sharedSpan, scope: 'local' }],
      [{ text: SHARED.text, span: sharedSpan, scope: 'local' }],
    ])
    expect(fragments[1]?.label).toBe('Menu translation')
    expect([barrier, outputOrder]).toEqual([null, null])
  })

  it('keeps a barrier with its output order only for an explicit order', async () => {
    const ordered = proposal({ barrier: { reason: 'explicit-order', qualifier: 'put the translation first' }, outputOrder: ['f2', 'f1'] })
    const integrated = proposal({ barrier: { reason: 'integrated-presentation', qualifier: 'as one table' }, outputOrder: ['f2', 'f1'] })
    const a = await setup(() => completion(JSON.stringify(ordered))).decomposer.decompose(REQUEST, NEVER_CANCELLED)
    const b = await setup(() => completion(JSON.stringify(integrated))).decomposer.decompose(REQUEST, NEVER_CANCELLED)
    expect(a.ok && [a.decomposition.barrier, a.decomposition.outputOrder]).toEqual([
      { reason: 'explicit-order', qualifier: 'put the translation first' },
      ['f2', 'f1'],
    ])
    expect(b.ok && [b.decomposition.barrier?.reason, b.decomposition.outputOrder]).toEqual(['integrated-presentation', null])
  })

  it('reports a combined total output limit apart from the barrier, which no longer has that reason (Q102)', async () => {
    const combined = proposal({ combinedLimit: ' under 100 words total ' })
    const result = await setup(() => completion(JSON.stringify(combined))).decomposer.decompose(REQUEST, NEVER_CANCELLED)
    expect(result.ok && [result.decomposition.combinedLimit, result.decomposition.barrier]).toEqual(['under 100 words total', null])
    const legacy = proposal({ barrier: { reason: 'combined-limit', qualifier: 'under 100 words total' } })
    const again = await setup(
      () => completion(JSON.stringify(legacy)),
      () => completion(JSON.stringify(legacy)),
    ).decomposer.decompose(REQUEST, NEVER_CANCELLED)
    expect(again.ok).toBe(false)
  })

  it('passes dependencies on fragments and supplied candidates through', async () => {
    const dependent = proposal()
    dependent.fragments[0] = { ...dependent.fragments[0]!, dependsOnFragments: ['f1'], dependsOnCandidates: ['cand-a'] }
    const result = await setup(() => completion(JSON.stringify(dependent))).decomposer.decompose(REQUEST, NEVER_CANCELLED)
    expect(result.ok && result.decomposition.fragments[1]).toMatchObject({ key: 'f2', dependsOnFragments: ['f1'], dependsOnCandidates: ['cand-a'] })
  })

  it('reads JSON inside a code fence', async () => {
    const result = await setup(() => completion('```json\n' + JSON.stringify(proposal()) + '\n```')).decomposer.decompose(REQUEST, NEVER_CANCELLED)
    expect(result.ok).toBe(true)
  })

  it('rejects a quote that is not a substring of the original and asks once more, listing the problem', async () => {
    const bad = proposal()
    bad.fragments[1] = { ...bad.fragments[1]!, sourceQuotes: ['Explain why the sky looks blue'] }
    const { mock, decomposer } = setup(
      () => completion(JSON.stringify(bad)),
      () => completion(JSON.stringify(proposal())),
    )
    const result = await decomposer.decompose(REQUEST, NEVER_CANCELLED)
    expect(result.ok).toBe(true)
    expect(mock.requests).toHaveLength(2)
    const retry = (mock.requests[1]?.body as { messages: { role: string; content: string }[] }).messages
    expect(retry.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(retry[2]?.content).toBe(JSON.stringify(bad))
    expect(retry[3]?.content).toContain('"Explain why the sky looks blue", which is not an exact substring')
  })

  it('a second rejection is malformed-response', async () => {
    const bad = proposal()
    bad.fragments[0] = { ...bad.fragments[0]!, sourceQuotes: ['traduire ce menu'] }
    const { mock, decomposer } = setup(() => completion(JSON.stringify(bad)))
    const result = await decomposer.decompose(REQUEST, NEVER_CANCELLED)
    expect(result.ok === false && [result.error.code, result.error.class]).toEqual(['malformed-response', 'non-retryable'])
    expect(mock.requests).toHaveLength(2)
  })

  it.each([
    ['an unknown candidate', (p: ReturnType<typeof proposal>) => (p.fragments[0] = { ...p.fragments[0]!, dependsOnCandidates: ['cand-z'] })],
    ['an unknown fragment dependency', (p: ReturnType<typeof proposal>) => (p.fragments[0] = { ...p.fragments[0]!, dependsOnFragments: ['f9'] })],
    ['a self-dependency', (p: ReturnType<typeof proposal>) => (p.fragments[0] = { ...p.fragments[0]!, dependsOnFragments: ['f2'] })],
    ['a duplicate key', (p: ReturnType<typeof proposal>) => (p.fragments[0] = { ...p.fragments[0]!, key: 'f1' })],
    ['no source quotes', (p: ReturnType<typeof proposal>) => (p.fragments[0] = { ...p.fragments[0]!, sourceQuotes: [] })],
    ['an empty quote', (p: ReturnType<typeof proposal>) => (p.fragments[0] = { ...p.fragments[0]!, sourceQuotes: ['  '] })],
    ['an empty instruction', (p: ReturnType<typeof proposal>) => (p.fragments[0] = { ...p.fragments[0]!, instruction: ' ' })],
    [
      'a requirement quote that is not in the text',
      (p: ReturnType<typeof proposal>) => (p.fragments[0] = { ...p.fragments[0]!, requirements: [{ ...SHARED, sourceQuote: 'Keep it short' }] }),
    ],
    ['an outputOrder naming an unknown fragment', (p: ReturnType<typeof proposal>) => Object.assign(p, { outputOrder: ['f1', 'f7'] })],
    ['no fragments', (p: ReturnType<typeof proposal>) => Object.assign(p, { fragments: [] })],
  ])('rejects %s and retries once', async (_name, spoil) => {
    const bad = proposal()
    spoil(bad)
    const { mock, decomposer } = setup(
      () => completion(JSON.stringify(bad)),
      () => completion(JSON.stringify(proposal())),
    )
    const result = await decomposer.decompose(REQUEST, NEVER_CANCELLED)
    expect(result.ok).toBe(true)
    expect(mock.requests).toHaveLength(2)
  })

  it.each([
    ['content that is not JSON', 'Sure! Here are the fragments: f1, f2'],
    ['JSON of the wrong shape', JSON.stringify({ fragments: [{ key: 'f1' }] })],
    ['an unknown requirement scope', JSON.stringify(proposal({ fragments: [{ ...proposal().fragments[0], requirements: [{ ...SHARED, scope: 'global' }] }] }))],
  ])('rejects %s and retries once', async (_name, content) => {
    const { mock, decomposer } = setup(
      () => completion(content),
      () => completion(JSON.stringify(proposal())),
    )
    expect((await decomposer.decompose(REQUEST, NEVER_CANCELLED)).ok).toBe(true)
    expect(mock.requests).toHaveLength(2)
  })

  it('returns a transport error at once, without the validation retry', async () => {
    const { mock, decomposer } = setup(() => jsonResponse({ error: { code: 502, message: 'Bad gateway' } }, { status: 502 }))
    const result = await decomposer.decompose(REQUEST, NEVER_CANCELLED)
    expect(result.ok === false && [result.error.code, result.error.class]).toEqual(['bad-gateway', 'transient'])
    expect(mock.requests).toHaveLength(1)
  })

  it('an empty completion is a transient empty-response', async () => {
    const result = await setup(() => completion('')).decomposer.decompose(REQUEST, NEVER_CANCELLED)
    expect(result.ok === false && result.error.code).toBe('empty-response')
  })

  it('a session-wide requirement stays session-wide only when the model marks it so', async () => {
    const text = 'From now on answer in French. Explain tides and separately list three tide pools.'
    const p = {
      fragments: [
        {
          key: 'a',
          sourceQuotes: ['Explain tides'],
          instruction: 'Explain tides, in French.',
          label: 'tides',
          requirements: [{ text: 'Answer in French', sourceQuote: 'From now on answer in French', scope: 'session-wide' }],
          dependsOnFragments: [],
          dependsOnCandidates: [],
        },
        {
          key: 'b',
          sourceQuotes: ['list three tide pools'],
          instruction: 'List three tide pools, in French.',
          label: 'tide pools',
          requirements: [{ text: 'Answer in French', sourceQuote: 'From now on answer in French', scope: 'session-wide' }],
          dependsOnFragments: [],
          dependsOnCandidates: [],
        },
      ],
      barrier: null,
      outputOrder: null,
      combinedLimit: null,
    }
    const result = await setup(() => completion(JSON.stringify(p))).decomposer.decompose({ ...REQUEST, text, candidates: [] }, NEVER_CANCELLED)
    expect(result.ok && result.decomposition.fragments.map((f) => f.requirements[0]?.scope)).toEqual(['session-wide', 'session-wide'])
  })
})

describe('locateQuote', () => {
  it('assigns repeated quotes to distinct occurrences in order', () => {
    const text = 'Summarize it. Then summarize it.'
    const first = locateQuote(text, 'summarize it', 0, [])
    expect(first).toEqual({ start: 19, end: 31 })
    const caseExact = locateQuote(text, 'Summarize it', 0, [])
    expect(caseExact).toEqual({ start: 0, end: 12 })
    const again = locateQuote('ab ab', 'ab', 0, [{ start: 0, end: 2 }])
    expect(again).toEqual({ start: 3, end: 5 })
  })

  it('ignores surrounding whitespace on the quote but nothing else', () => {
    expect(locateQuote('Hello world', '  world ', 0, [])).toEqual({ start: 6, end: 11 })
    expect(locateQuote('Hello world', 'World', 0, [])).toBeNull()
  })
})

describe('OpenRouter decomposer · label', () => {
  it('returns a cleaned short noun phrase', async () => {
    const { mock, decomposer } = setup(() => completion('"Menu translation."\n'))
    const result = await decomposer.label?.({ model: 'anthropic/claude-haiku-5.5', text: 'Translate this menu into French' }, NEVER_CANCELLED)
    expect(result).toEqual({ ok: true, label: 'Menu translation' })
    expect((mock.requests[0]?.body as Record<string, unknown>)['model']).toBe('anthropic/claude-haiku-5.5')
  })

  it('an empty label is malformed-response; transport errors pass through', async () => {
    const empty = await setup(() => completion('""')).decomposer.label?.({ model: 'm', text: 'x' }, NEVER_CANCELLED)
    expect(empty?.ok === false && empty.error.code).toBe('malformed-response')
    const failed = await setup(() => jsonResponse({ error: { code: 401, message: 'User not found.' } }, { status: 401 })).decomposer.label?.(
      { model: 'm', text: 'x' },
      NEVER_CANCELLED,
    )
    expect(failed?.ok === false && failed.error.code).toBe('unauthorized')
  })

  it('cleanLabel keeps the first line, strips quotes and a prefix, and caps the length', () => {
    expect(cleanLabel('Label: “sky color”')).toBe('sky color')
    expect(cleanLabel('neighborhoods\nBecause the user asked about areas')).toBe('neighborhoods')
    expect(cleanLabel('a '.repeat(40)).length).toBeLessThanOrEqual(48)
  })
})

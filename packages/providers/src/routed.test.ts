import { describe, expect, it } from 'vitest'
import type { ModelProviderName } from '@committee/protocol'
import { NEVER_CANCELLED, type Decomposer, type ModelProvider, type ModelStreamEvent, type Preparer } from '@committee/core/ports'
import { checkOpenRouterKey } from './openrouter/key-check'
import { createRoutedDecomposer, createRoutedModelProvider, createRoutedPreparer } from './routed'

/** Adapters that only say who they are. */
function model(name: ModelProviderName, seen: string[]): ModelProvider {
  return {
    async *stream(request) {
      seen.push(`${name}:stream:${request.model}`)
      yield { type: 'text', text: name }
      yield { type: 'completed', finishReason: 'stop', usage: null }
    },
    async countTokens(request) {
      seen.push(`${name}:count:${request.model}`)
      return { inputTokens: name === 'anthropic' ? 2 : 1, contextLimit: null, exact: false }
    },
  }
}

function decomposer(name: ModelProviderName, seen: string[]): Decomposer {
  return {
    async decompose(request) {
      seen.push(`${name}:decompose:${request.model}`)
      return { ok: true, decomposition: { fragments: [], barrier: null, combinedLimit: null, outputOrder: null } }
    },
    async label(request) {
      seen.push(`${name}:label:${request.model}`)
      return { ok: true, label: name }
    },
  }
}

function preparer(name: ModelProviderName, seen: string[]): Preparer {
  return {
    async prepare(request) {
      seen.push(`${name}:prepare:${request.model}`)
      return { ok: true, readiness: { kind: 'ready' }, model: request.model, usage: null }
    },
  }
}

async function texts(stream: AsyncIterable<ModelStreamEvent>): Promise<string[]> {
  const out: string[] = []
  for await (const event of stream) if (event.type === 'text') out.push(event.text)
  return out
}

describe('per-role provider routing', () => {
  it('hands each request to the adapter of the provider it names, so one conversation can use both', async () => {
    const seen: string[] = []
    const models = createRoutedModelProvider({ openrouter: model('openrouter', seen), anthropic: model('anthropic', seen) })
    const decompose = createRoutedDecomposer({ openrouter: decomposer('openrouter', seen), anthropic: decomposer('anthropic', seen) })
    const prepare = createRoutedPreparer({ openrouter: preparer('openrouter', seen), anthropic: preparer('anthropic', seen) })
    const messages = [{ role: 'user' as const, content: 'Hi' }]

    // Answers on the Claude API, decomposition through OpenRouter.
    expect(await texts(models.stream({ model: 'claude-sonnet-5-5', provider: 'anthropic', messages }, NEVER_CANCELLED))).toEqual(['anthropic'])
    expect((await models.countTokens({ model: 'claude-sonnet-5-5', provider: 'anthropic', messages })).inputTokens).toBe(2)
    await decompose.decompose({ model: 'anthropic/claude-haiku-5.5', provider: 'openrouter', text: 'a and b', candidates: [] }, NEVER_CANCELLED)
    await decompose.label?.({ model: 'claude-haiku-5-5', provider: 'anthropic', text: 'a' }, NEVER_CANCELLED)
    await prepare.prepare({ model: 'claude-haiku-5-5', provider: 'anthropic', messages }, NEVER_CANCELLED)
    await prepare.prepare({ model: 'anthropic/claude-haiku-5.5', provider: 'openrouter', messages }, NEVER_CANCELLED)
    expect(seen).toEqual([
      'anthropic:stream:claude-sonnet-5-5',
      'anthropic:count:claude-sonnet-5-5',
      'openrouter:decompose:anthropic/claude-haiku-5.5',
      'anthropic:label:claude-haiku-5-5',
      'anthropic:prepare:claude-haiku-5-5',
      'openrouter:prepare:anthropic/claude-haiku-5.5',
    ])
  })

  it('a request without a provider goes to OpenRouter, as before providers were a setting', async () => {
    const seen: string[] = []
    const models = createRoutedModelProvider({ openrouter: model('openrouter', seen), anthropic: model('anthropic', seen) })
    expect(await texts(models.stream({ model: 'anthropic/claude-sonnet-5.5', messages: [] }, NEVER_CANCELLED))).toEqual(['openrouter'])
  })
})

describe('OpenRouter key check', () => {
  const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef'

  it('maps OpenRouter answers and sends the key only as a bearer header', async () => {
    const calls: { url: string; auth: string | null }[] = []
    const answer = (status: number, body: unknown) =>
      checkOpenRouterKey(KEY, new AbortController().signal, {
        fetch: async (input, init) => {
          calls.push({ url: input, auth: new Headers(init.headers).get('Authorization') })
          return new Response(JSON.stringify(body), { status })
        },
      })
    expect(await answer(200, { data: { label: 'k', limit_remaining: 3.5 } })).toEqual({ status: 'valid', label: 'k', credit: { kind: 'remaining', dollars: 3.5 } })
    expect(await answer(200, { data: { label: 'k', limit_remaining: null } })).toEqual({ status: 'valid', label: 'k', credit: { kind: 'unlimited' } })
    expect(await answer(401, { error: { message: 'User not found.' } })).toEqual({ status: 'invalid' })
    expect(await answer(503, {})).toEqual({ status: 'unverified', httpStatus: 503 })
    const offline = await checkOpenRouterKey(KEY, new AbortController().signal, {
      fetch: async () => {
        throw new TypeError('Failed to fetch')
      },
    })
    expect(offline).toEqual({ status: 'offline' })
    expect(calls[0]).toEqual({ url: 'https://openrouter.ai/api/v1/key', auth: `Bearer ${KEY}` })
  })
})

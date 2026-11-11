import { describe, expect, it } from 'vitest'
import { NEVER_CANCELLED, createCancelSource, type ModelStreamEvent } from '@committee/core/ports'
import { createOpenRouterDecisionProvider, createOpenRouterDecomposer, createOpenRouterModelProvider } from './index'

/**
 * Live smoke suite: real OpenRouter calls, kept few and cheap. Run with
 * `pnpm smoke`; skipped when OPENROUTER_KEY is absent. The key is read here
 * and handed to the providers through `getKey` only; it is never printed.
 */

const key = process.env['OPENROUTER_KEY'] ?? ''
const getKey = async () => (key === '' ? null : key)
const MODEL = 'anthropic/claude-haiku-5.5'
const DECISION_MODEL = 'typesafe/jev-1.13'

describe.skipIf(key === '')('OpenRouter live smoke', () => {
  it('streams one answer to completion', async () => {
    const provider = createOpenRouterModelProvider({ getKey })
    const events: ModelStreamEvent[] = []
    for await (const event of provider.stream(
      { model: MODEL, messages: [{ role: 'user', content: 'Name three primary colors, comma separated, nothing else.' }] },
      NEVER_CANCELLED,
    )) {
      events.push(event)
    }
    const text = events.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join('')
    const last = events[events.length - 1]
    expect(last?.type, JSON.stringify(last)).toBe('completed')
    expect(text.toLowerCase()).toMatch(/red|blue|yellow/)
    if (last?.type === 'completed') expect(last.usage?.inputTokens ?? 0).toBeGreaterThan(0)
    const count = await provider.countTokens({ model: MODEL, messages: [{ role: 'user', content: 'hello' }] })
    expect(count.contextLimit).toBeGreaterThan(0)
  })

  it('aborts a stream when cancelled', async () => {
    const provider = createOpenRouterModelProvider({ getKey })
    const source = createCancelSource()
    const events: ModelStreamEvent[] = []
    const started = Date.now()
    for await (const event of provider.stream(
      { model: MODEL, messages: [{ role: 'user', content: 'Count from 1 to 400, one number per line.' }] },
      source.signal,
    )) {
      events.push(event)
      if (event.type === 'text') source.cancel()
    }
    expect(events.filter((e) => e.type === 'text')).toHaveLength(1)
    expect(events[events.length - 1]).toEqual({ type: 'cancelled' })
    expect(Date.now() - started).toBeLessThan(30_000)
  })

  it('answers a noul and a choice question in one decisions call', async () => {
    const provider = createOpenRouterDecisionProvider({ getKey })
    const result = await provider.decide(
      {
        model: DECISION_MODEL,
        state: 'Hello! How are you today?',
        questions: {
          isGreeting: { type: 'noul', instructions: 'Is this message a greeting?' },
          kind: { type: 'choice', instructions: 'What kind of message is it?', options: { greet: 'a greeting', translate: 'a translation request' } },
        },
      },
      NEVER_CANCELLED,
    )
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    expect(result.model).toMatch(/^typesafe\/jev-1\.13/)
    expect(result.answers.isGreeting.probability).toBeGreaterThan(0.5)
    expect(result.answers.kind.choice).toBe('greet')
    expect(result.answers.kind.confidence).toBeGreaterThan(0)
  })

  it('decomposes a two-intent message into two fragments with exact spans', async () => {
    const decomposer = createOpenRouterDecomposer({ getKey })
    const text = 'Explain why the sky is blue, and separately translate "bonjour" into Spanish. Keep both answers under 50 words each.'
    const result = await decomposer.decompose({ model: MODEL, text, candidates: [] }, NEVER_CANCELLED)
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    const { fragments, barrier } = result.decomposition
    expect(fragments).toHaveLength(2)
    for (const fragment of fragments) {
      expect(fragment.sourceSpans.length).toBeGreaterThan(0)
      for (const span of fragment.sourceSpans) expect(text.slice(span.start, span.end).length).toBeGreaterThan(0)
      expect(fragment.requirements.every((r) => r.scope === 'local')).toBe(true)
      expect(fragment.dependsOnFragments).toEqual([])
    }
    expect(fragments[0]?.instruction.toLowerCase()).toContain('sky')
    expect(fragments[1]?.instruction.toLowerCase()).toContain('bonjour')
    // "under 50 words each" applies to each part separately: no barrier (Q25).
    expect(barrier).toBeNull()
    const label = await decomposer.label?.({ model: MODEL, text: 'Translate this menu into French' }, NEVER_CANCELLED)
    expect(label?.ok, JSON.stringify(label)).toBe(true)
  })
})

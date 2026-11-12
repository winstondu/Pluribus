import { describe, expect, it } from 'vitest'
import { compatibleModels } from '@committee/protocol'
import { NEVER_CANCELLED, type ModelMessage, type ModelStreamEvent } from '@committee/core/ports'
import { ANTHROPIC_PROBE_MODEL, checkAnthropicKey, createAnthropicDecomposer, createAnthropicModelProvider, createAnthropicPreparer } from './index'

/**
 * Live check of the Claude API adapters: one cheap streamed answer, one
 * decomposition, the key check, and what the compatibility list claims of
 * each Claude API entry (Q107): the typed readiness result of the
 * preparation step (Q103) and the streamed clarification signal (Q106).
 *
 * Run with `pnpm smoke`; skipped when ANTHROPIC_API_KEY is absent. The key
 * is handed to the providers through `getKey` only and is never printed.
 * When this has passed, set `testedOn` on the Claude API entries of
 * `MODEL_COMPATIBILITY` to the date of the run.
 */

const key = process.env['ANTHROPIC_API_KEY'] ?? ''
const getKey = async () => (key === '' ? null : key)
/** The cheapest current Claude model. */
const CHEAP = ANTHROPIC_PROBE_MODEL

const SYSTEM: ModelMessage = { role: 'system', content: 'You are one of several model runs working on parts of a conversation. Reply in plain text.' }
const NEEDS_NOTHING: readonly ModelMessage[] = [SYSTEM, { role: 'user', content: 'Name three primary colors, comma separated, nothing else.' }]
/** Needs two facts only the user has, after a part that needs none. */
const NEEDS_THE_USER: readonly ModelMessage[] = [
  SYSTEM,
  {
    role: 'user',
    content:
      'First write one general tip for giving a farewell toast. Then write the two-sentence toast itself for my colleague who is leaving: it must use her real first name and name the exact project she led. Do not use placeholders and do not invent either.',
  },
]

async function run(model: string, messages: readonly ModelMessage[], clarificationSignal = false): Promise<{ text: string; last: ModelStreamEvent | undefined }> {
  const provider = createAnthropicModelProvider({ getKey })
  const events: ModelStreamEvent[] = []
  for await (const event of provider.stream({ model, provider: 'anthropic', messages, clarificationSignal }, NEVER_CANCELLED)) events.push(event)
  return { text: events.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join(''), last: events[events.length - 1] }
}

describe.skipIf(key === '')('Claude API live smoke', () => {
  it('the key check recognizes the key and reports whether a one-token request was paid for', async () => {
    const check = await checkAnthropicKey(key, new AbortController().signal)
    expect(check.status).toBe('valid')
    expect(check.status === 'valid' && ['available', 'exhausted', 'unknown']).toContain(check.status === 'valid' ? check.credit.kind : '')
    expect(JSON.stringify(check)).not.toContain(key)
    const wrong = await checkAnthropicKey('sk-ant-api03-not-a-real-key-0000000000000000', new AbortController().signal)
    expect(wrong).toEqual({ status: 'invalid' })
  }, 60_000)

  it('streams one cheap answer and counts its input exactly', async () => {
    const { text, last } = await run(CHEAP, NEEDS_NOTHING)
    expect(last?.type).toBe('completed')
    expect(text.toLowerCase()).toMatch(/red|blue|yellow|green/)
    const count = await createAnthropicModelProvider({ getKey }).countTokens({ model: CHEAP, provider: 'anthropic', messages: NEEDS_NOTHING })
    expect(count.exact).toBe(true)
    expect(count.contextLimit ?? 0).toBeGreaterThan(0)
  }, 120_000)

  it('decomposes a composite message into fragments with exact spans', async () => {
    const text = 'Why is the sky blue? Also, translate "good morning" into French.'
    const result = await createAnthropicDecomposer({ getKey }).decompose({ model: CHEAP, provider: 'anthropic', text, candidates: [] }, NEVER_CANCELLED)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.decomposition.fragments.length).toBe(2)
    for (const fragment of result.decomposition.fragments) {
      for (const span of fragment.sourceSpans) expect(text.slice(span.start, span.end).trim()).not.toBe('')
    }
  }, 120_000)

  for (const model of compatibleModels('decomposition', 'anthropic')) {
    it(`${model.id} returns the typed readiness result of the preparation step`, async () => {
      const preparer = createAnthropicPreparer({ getKey })
      const ready = await preparer.prepare({ model: model.id, provider: 'anthropic', messages: NEEDS_NOTHING }, NEVER_CANCELLED)
      expect(ready.ok && ready.readiness.kind).toBe('ready')
      const asks = await preparer.prepare({ model: model.id, provider: 'anthropic', messages: NEEDS_THE_USER }, NEVER_CANCELLED)
      expect(asks.ok && asks.readiness.kind).toBe('clarification-needed')
    }, 180_000)
  }

  for (const model of compatibleModels('answer', 'anthropic')) {
    it(`${model.id} stops a streamed answer with the typed clarification signal, and only when it must`, async () => {
      const plain = await run(model.id, NEEDS_NOTHING, true)
      expect(plain.last?.type).toBe('completed')
      const asks = await run(model.id, NEEDS_THE_USER, true)
      expect(asks.last?.type).toBe('clarification-needed')
      expect(asks.last?.type === 'clarification-needed' && asks.last.question.length).toBeGreaterThan(0)
    }, 180_000)
  }
})

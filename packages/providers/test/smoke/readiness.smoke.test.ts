import { describe, expect, it } from 'vitest'
import { MODEL_COMPATIBILITY } from '@pluribus/protocol'
import { NEVER_CANCELLED, type ModelMessage, type ModelStreamEvent } from '@pluribus/core/ports'
import { createOpenRouterModelProvider, createOpenRouterPreparer } from '@pluribus/providers'

/**
 * Live check of what the compatibility list claims (Q107): every listed
 * model returns the typed readiness result of the preparation step (Q103),
 * and stops a streamed answer with the typed clarification signal on a
 * prompt that needs it (Q106). Run with `pnpm smoke`; skipped when
 * OPENROUTER_KEY is absent. The key is handed to the providers through
 * `getKey` only and is never printed.
 */

const key = process.env['OPENROUTER_KEY'] ?? ''
const getKey = async () => (key === '' ? null : key)
const CHEAP = 'anthropic/claude-haiku-5.5'

const SYSTEM: ModelMessage = { role: 'system', content: 'You are one of several model runs working on parts of a conversation. Reply in plain text.' }

/** Needs two facts only the user has, after a part that needs none. */
const NEEDS_THE_USER: readonly ModelMessage[] = [
  SYSTEM,
  {
    role: 'user',
    content:
      'First write one general tip for giving a farewell toast. Then write the two-sentence toast itself for my colleague who is leaving: it must use her real first name and name the exact project she led. Do not use placeholders and do not invent either.',
  },
]

const NEEDS_NOTHING: readonly ModelMessage[] = [SYSTEM, { role: 'user', content: 'Name three primary colors, comma separated, nothing else.' }]

async function run(model: string, messages: readonly ModelMessage[]): Promise<{ text: string; last: ModelStreamEvent | undefined }> {
  const provider = createOpenRouterModelProvider({ getKey })
  const events: ModelStreamEvent[] = []
  for await (const event of provider.stream({ model, messages, clarificationSignal: true }, NEVER_CANCELLED)) events.push(event)
  return { text: events.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join(''), last: events[events.length - 1] }
}

describe.skipIf(key === '')('readiness live smoke', () => {
  for (const model of MODEL_COMPATIBILITY.filter((m) => m.structuredPreparation)) {
    it(`${model.id} · the preparation step returns a typed readiness result`, async () => {
      const preparer = createOpenRouterPreparer({ getKey })
      const ready = await preparer.prepare({ model: model.id, messages: NEEDS_NOTHING }, NEVER_CANCELLED)
      if (!ready.ok) throw new Error(`${ready.error.code}: ${ready.error.message}`)
      expect(ready.readiness).toEqual({ kind: 'ready' })
      expect(ready.usage?.inputTokens ?? 0).toBeGreaterThan(0)

      const blocked = await preparer.prepare({ model: model.id, messages: NEEDS_THE_USER }, NEVER_CANCELLED)
      if (!blocked.ok) throw new Error(`${blocked.error.code}: ${blocked.error.message}`)
      expect(blocked.readiness.kind).toBe('clarification-needed')
      if (blocked.readiness.kind === 'clarification-needed') {
        expect(blocked.readiness.reason).toBe('missing-information')
        expect(blocked.readiness.question.length).toBeGreaterThan(5)
        console.info(`[readiness smoke] ${model.id} preparation asked: ${blocked.readiness.question}`)
      }
    })
  }

  for (const model of MODEL_COMPATIBILITY.filter((m) => m.streamedClarificationSignal)) {
    it(`${model.id} · a streamed answer stops with the typed clarification signal when it needs the user`, async () => {
      const { text, last } = await run(model.id, NEEDS_THE_USER)
      expect(last?.type, JSON.stringify(last)).toBe('clarification-needed')
      if (last?.type === 'clarification-needed') {
        expect(last.question.length).toBeGreaterThan(5)
        // The question travels in the signal, never in the answer text.
        expect(text).not.toContain(last.question)
        console.info(`[readiness smoke] ${model.id} signalled after ${text.length} characters of partial text: ${last.question}`)
      }
    })
  }

  it('an answer that needs nothing from the user completes without the signal', async () => {
    const { text, last } = await run(CHEAP, NEEDS_NOTHING)
    expect(last?.type, JSON.stringify(last)).toBe('completed')
    expect(text.toLowerCase()).toMatch(/red|blue|yellow/)
  })
})

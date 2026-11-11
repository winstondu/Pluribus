import { expect, test } from 'vitest'
import { answer, createTestBackend } from '../testing'

test('smoke: one atomic message streams, completes and is placed', async () => {
  const t = await createTestBackend({ options: { outputChunk: { maxChars: 4, maxDelayMs: 80 } } })
  const c = await t.createConversation()
  t.model.script('Hello', [{ afterMs: 100, event: { type: 'text', text: 'Hi ' } }, { afterMs: 150, event: { type: 'text', text: 'there friend' } }, { afterMs: 200, event: { type: 'completed', finishReason: 'stop', usage: null } }])
  const m = await t.submit(c, 'Hello')
  let snap = await t.snapshot(c)
  expect(snap.transcript.order.map((r) => r.kind)).toEqual(['message', 'response'])
  await t.advance(300)
  snap = await t.snapshot(c)
  const response = Object.values(snap.transcript.responses)[0]
  expect(response?.placement).toBe('fixed')
  const section = snap.transcript.sections[response?.sectionIds[0] ?? '']
  expect(section?.state).toBe('completed')
  const attempt = snap.transcript.attempts[section?.attemptIds[0] ?? '']
  expect(attempt?.text).toBe('Hi there friend')
  void m
  void answer
})

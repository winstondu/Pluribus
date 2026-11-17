import { describe, expect, test } from 'vitest'
import { DEFAULT_SETTINGS, providerError } from '@pluribus/protocol'
import { NEVER_CANCELLED } from '../../../src/ports'
import { createRouter } from '../../../src/routing/pipeline'
import { ROUTING_CORPUS, corpusInput, oracleDecisionProvider, referenceDecomposer } from '../../../testing/routing/corpus'
import { answer } from '../../../testing'
import { routingScenario } from '../../../testing/acceptance/routing'

/** Invariant 9 (11 · "Invariants"): the decision model is bounded. */

describe('invariants', () => {
  test('I9 · the decision model only selects among supplied candidates and never writes text', async () => {
    const s = await routingScenario()
    s.t.model.script('Why is the sky blue?', answer('Scattering.', 10, 20))
    await s.send('Why is the sky blue?')
    await s.t.advance(50)
    const text = 'Explain tides, and separately translate this menu into French: soup, bread'
    await s.send(text, { composite: 0.9, parts: [{ relation: 'new' }, { relation: 'new' }] }, {
      decompose: [
        { part: 'Explain tides', instruction: 'Explain how tides work.', label: 'tides' },
        { part: 'translate this menu into French: soup, bread', instruction: 'Translate this menu into French: soup, bread.', label: 'menu' },
      ],
    })
    // Every question is a yes/no or a choice among supplied options, asked of the pinned model.
    for (const request of s.t.decisions.requests) {
      expect(request.model).toBe(DEFAULT_SETTINGS.models.decision)
      expect(request.model).not.toContain('latest')
      for (const [id, q] of Object.entries(request.questions)) {
        expect(['noul', 'choice']).toContain(q.type)
        if (q.type !== 'choice') continue
        const options = Object.keys(q.options)
        if (id.endsWith('_chain')) for (const o of options) expect(o).toMatch(/^L\d+$/)
        else if (id.endsWith('_relation')) expect(options).toEqual(['new', 'addition', 'dependent'])
        else if (id.endsWith('_why')) expect(options).toEqual(['missing', 'conflict'])
        else throw new Error(`Unexpected choice question ${id}`)
      }
    }
    // Rewritten text comes from decomposition only; the decision record keeps the model's answers, not text.
    const tides = s.d('tides')
    expect(tides.instruction).toBe('Explain how tides work.')
    const decision = s.state().messages[tides.messageId]?.decision
    expect(decision?.source).toBe('decision-model')
    expect(decision?.model).toBe('typesafe/jev-1.13-20260917')
    for (const q of decision?.questions ?? []) expect(typeof q.answer === 'number' || ['new', 'addition', 'dependent', 'missing', 'conflict'].includes(q.answer) || /^L\d+$/.test(q.answer)).toBe(true)
    expect(decision?.units.every((u) => u.explanation.length > 0)).toBe(true)
    // The record carries the confidences the decision rested on (run inspector item 5).
    expect(decision?.composition.confidence).toBeCloseTo(0.9)
    expect(decision?.thresholds['targetChoice']).toBe(DEFAULT_SETTINGS.thresholds.targetChoice)
  })

  test('I9 · an answer outside the supplied options, or a missing answer, fails routing with malformed-response', async () => {
    const example = ROUTING_CORPUS.find((e) => e.id === 'placement-continue-chain')
    if (!example) throw new Error('missing example')
    const input = corpusInput(example)
    const oracle = oracleDecisionProvider(example, input)
    const outside = createRouter({
      decisionProvider: {
        async decide(request) {
          const result = await oracle.decide(request, NEVER_CANCELLED)
          if (!result.ok) return result
          const answers = { ...(result.answers as Record<string, unknown>), m_chain: { type: 'choice', choice: 'L99', confidence: 1, probabilities: {} } }
          return { ...result, answers: answers as never }
        },
      },
      decomposer: referenceDecomposer(example),
    })
    const a = await outside.route(input, NEVER_CANCELLED)
    expect(a.kind === 'failed' && a.error.code).toBe('malformed-response')
    const missing = createRouter({
      decisionProvider: {
        async decide(request) {
          const result = await oracle.decide(request, NEVER_CANCELLED)
          if (!result.ok) return result
          const answers = { ...(result.answers as Record<string, unknown>) }
          delete answers['m_relation']
          return { ...result, answers: answers as never }
        },
      },
      decomposer: referenceDecomposer(example),
    })
    const b = await missing.route(input, NEVER_CANCELLED)
    expect(b.kind === 'failed' && b.error.code).toBe('malformed-response')
    const down = createRouter({ decisionProvider: { decide: async () => ({ ok: false, error: providerError('rate-limited', 'Slow down') }) }, decomposer: referenceDecomposer(example) })
    const c = await down.route(input, NEVER_CANCELLED)
    expect(c.kind === 'failed' && c.error.code).toBe('rate-limited')
  })
})

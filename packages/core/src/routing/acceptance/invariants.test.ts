import { describe, expect, test } from 'vitest'
import { DEFAULT_SETTINGS, REFERENT_STRATEGY_NAMES, STRATEGY_SELECTION_MODES, providerError, type AttemptStarted } from '@committee/protocol'
import { NEVER_CANCELLED, type ContextSummaryProvider, type DecisionProvider, type DecisionQuestions, type DecisionRequest } from '../../ports'
import { createRouter } from '../pipeline'
import { estimateRequestTokens } from '../referents'
import { ROUTING_CORPUS, corpusInput, oracleDecisionProvider, referenceDecomposer } from '../corpus'
import { answer } from '../../testing'
import { routingScenario } from './helpers'

/** Invariants 9, 11 and 12 (11 · "Invariants"): the decision model is bounded, routing cost is bounded, summaries are not context. */

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

  test('I11 · routing cost is bounded: no decision request takes a routing past its decision budget, and reaching it stops the search without a question to the user', async () => {
    // A reply to the third answer of a 200-answer chain: finding it takes a search the budget below cannot pay for.
    const example = ROUTING_CORPUS.find((e) => e.id === 'long-chain-old-section')
    if (!example) throw new Error('missing example')
    const budget = 6_000
    for (const referentStrategy of REFERENT_STRATEGY_NAMES) {
      for (const strategySelection of STRATEGY_SELECTION_MODES) {
        const name = `${referentStrategy}, selection ${strategySelection}`
        const route = async () => {
          const input = corpusInput(example, { ...DEFAULT_SETTINGS, routing: { ...DEFAULT_SETTINGS.routing, referentStrategy, strategySelection, tokenBudget: { mode: 'absolute', inputTokens: budget } } })
          const oracle = oracleDecisionProvider(example, input)
          const requests: DecisionRequest<DecisionQuestions>[] = []
          const provider: DecisionProvider = {
            decide: async (request, signal) => {
              requests.push(request)
              return oracle.decide(request, signal)
            },
          }
          const outcome = await createRouter({ decisionProvider: provider, decomposer: referenceDecomposer(example) }).route(input, NEVER_CANCELLED)
          return { outcome, requests }
        }
        const { outcome, requests } = await route()
        // Every request was sized before it was sent, and together they stay within the budget.
        expect(requests.reduce((sum, r) => sum + estimateRequestTokens(r.state, r.questions), 0), name).toBeLessThanOrEqual(budget)
        // The budget is a hard stop: the user is not asked which section is meant.
        expect(outcome.kind, name).toBe('plan')
        // Deterministic: the same conversation and message give the same requests and the same routing.
        const again = await route()
        expect(again.requests, name).toEqual(requests)
        expect(again.outcome, name).toEqual(outcome)
      }
    }
  })

  test('I12 · summaries are not context: no run\'s input, and no record of one, contains a context summary', async () => {
    const SUMMARY = 'SUMMARY: the sky was explained.'
    const provider: ContextSummaryProvider = {
      contextFor(request) {
        const chain = request.chain()
        const anchor = chain.nodeIds[0]
        if (!anchor) return null
        return { kind: 'summary', nodeId: request.nodeId, summary: { anchorNodeId: anchor, text: SUMMARY, tokens: 8, provenance: { summaryId: 'sum_test', model: 'scripted', coveredNodeIds: [anchor], recordedSeq: 0 } }, own: [] }
      },
    }
    const s = await routingScenario({ contextSummaryProvider: provider, settings: { routing: { useSummaryIfAvailable: true, backgroundSummaries: true } } })
    s.t.model.script('Why is the sky blue?', answer('Rayleigh scattering.', 10, 20))
    await s.send('Why is the sky blue?')
    await s.t.advance(50)
    const sky = s.state().sections[s.d('Why is the sky blue').sectionId ?? '']?.title ?? ''
    s.t.model.script('Make that shorter', answer('Scattering.', 10, 20))
    await s.send('Make that shorter', { message: { relation: 'addition', targets: { [sky]: 0.9 } } })
    await s.t.advance(50)
    // The summary was in use: the decision model was shown it.
    expect(s.t.decisions.requests.some((r) => r.state.includes(SUMMARY))).toBe(true)
    // The run that continued from the summarised answer read the recorded exchange.
    const started = (await s.events()).filter((e): e is AttemptStarted => e.type === 'attempt-started')
    expect(started).toHaveLength(2)
    expect(started[1]?.context.messages.map((m) => m.content)).toEqual(expect.arrayContaining(['Why is the sky blue?', 'Rayleigh scattering.', 'Make that shorter']))
    // No input, no attempt in state and no event of the log holds the summary.
    for (const e of started) expect(e.context.messages.some((m) => m.content.includes('SUMMARY'))).toBe(false)
    expect(JSON.stringify(Object.values(s.state().attempts).map((a) => a.context))).not.toContain('SUMMARY')
    expect(JSON.stringify(await s.events())).not.toContain('SUMMARY')
  })
})

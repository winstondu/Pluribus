import { describe, expect, test } from 'vitest'
import { WORDING, providerError } from '@pluribus/protocol'
import { answer, createTestBackend } from '../../../testing'
import { engineModule } from '../../../src/engine'
import { routingModule } from '../../../src/routing/module'
import { decomposition, routingScenario as baseScenario } from '../../../testing/acceptance/routing'

/**
 * Findings of the second review (routing, revisions of requirements, the
 * barrier), adopted from the reviewer's tests and titled with the condition
 * each one breaks. They run on all three slices, as the app does.
 */

const routingScenario = () => baseScenario({ modules: [engineModule, routingModule] })

describe('second review: barrier, Undo split, targets', () => {
  test('D3 (review) · a whole-request barrier on a sequential composite does not make its first part wait for itself', async () => {
    const s = await routingScenario()
    const text = 'Find three good neighborhoods in Kyoto, then make a two-day plan around the best one, under 200 words in total'
    s.t.model.script('Find three good neighborhoods in Kyoto', answer('Gion, Higashiyama, Arashiyama.', 10, 50))
    s.t.model.script('make a two-day plan', answer('Day one…', 10, 50))
    await s.send(text, { composite: 0.9, barrier: 0.9, parts: [{ relation: 'new' }, { relation: 'dependent', after: { 1: 0.9 } }] }, {
      decompose: [
        { part: 'Find three good neighborhoods in Kyoto', label: 'neighborhoods' },
        { part: 'make a two-day plan around the best one', label: 'two-day plan', after: [0] },
      ],
      extra: { barrier: { reason: 'combined-limit', qualifier: 'under 200 words in total' } },
    })
    expect(s.state().decompositions[Object.keys(s.state().decompositions)[0] ?? '']?.barrier).not.toBeNull()
    await s.t.advance(5_000)
    expect(s.d('neighborhoods').state).toBe('completed')
    expect(s.d('two-day plan').state).toBe('completed')
  })

  test('E1 (review) · a part held by the barrier behind a clarification names the part it waits on', async () => {
    const s = await routingScenario()
    const text = 'Translate this menu into French: soup, bread, and explain what happened yesterday, translation first'
    s.t.model.script('Ask the user one short', answer('Which event yesterday?', 10, 20))
    await s.send(text, { composite: 0.9, barrier: 0.9, parts: [{ relation: 'new' }, { relation: 'new', clarify: 0.9, why: 'missing' }] }, {
      decompose: [{ part: 'Translate this menu into French: soup, bread', label: 'menu translation' }, { part: 'explain what happened yesterday', label: 'yesterday' }],
      extra: { barrier: { reason: 'explicit-order', qualifier: 'translation first' }, outputOrder: [0, 1] },
    })
    await s.t.advance(50)
    const snap = await s.t.snapshot(s.c)
    expect(snap.queue.items.map((i) => ({ label: i.label, text: i.text, heldByBarrier: i.heldByBarrier }))).toEqual([
      { label: 'menu translation', text: 'Waiting for yesterday', heldByBarrier: true },
    ])
    // The question itself is never held (E1).
    expect(s.d('question about yesterday').state).toBe('completed')
  })

  test("D4 (review) · answering a split message's clarification question ends Undo split", async () => {
    const s = await routingScenario()
    const text = 'Find three good neighborhoods in Kyoto, then make a plan around the best one for my dates'
    s.t.model.script('Find three good neighborhoods in Kyoto', answer('Gion, Higashiyama.', 5_000, 6_000))
    s.t.model.script('Ask the user one short', answer('What are your dates?', 10, 20))
    const original = await s.send(text, { composite: 0.9, parts: [{ relation: 'new' }, { relation: 'dependent', after: { 1: 0.9 }, clarify: 0.9, why: 'missing' }] }, {
      decompose: [
        { part: 'Find three good neighborhoods in Kyoto', label: 'neighborhoods' },
        { part: 'make a plan around the best one for my dates', label: 'plan', after: [0] },
      ],
    })
    await s.t.advance(100)
    expect((await s.t.snapshot(s.c)).transcript.splits[original]?.undoAvailable).toBe(true)
    await s.send('November 3 to 7', {}, { replyTo: ['question about plan'] })
    expect((await s.t.snapshot(s.c)).transcript.splits[original]?.undoAvailable).toBe(false)
  })

  test('T1 (review) · a reply whose one plausible section is below the target-choice threshold is elicited, never placed by guess', async () => {
    const s = await routingScenario()
    s.t.model.script('Recommend a laptop', answer('Get a ThinkPad, because...', 10, 20))
    await s.send('Recommend a laptop for programming')
    await s.t.advance(50)
    await s.send('Make that shorter', { message: { relation: 'addition', targets: { 'Recommend a laptop for programming': 0.5 } } })
    const raised = (await s.events()).filter((e) => e.type === 'elicitation-raised')
    expect(raised).toHaveLength(1)
    const first = raised[0]
    expect(first?.type === 'elicitation-raised' && first.elicitation.kind).toBe('target-ambiguity')
    expect(s.state().directiveOrder).toHaveLength(1)
  })

  test("T1 (review) · after a composite's target-ambiguity choice, the other part keeps its clear target", async () => {
    const s = await routingScenario()
    s.t.model.script('Explain tides', answer('The moon pulls.', 10, 20))
    s.t.model.script('Explain eclipses', answer('Shadows.', 10, 20))
    s.t.model.script('Recommend a hotel in Kyoto', answer('Hotel Kanra.', 10, 20))
    await s.send('Explain tides')
    await s.t.advance(50)
    await s.send('Explain eclipses')
    await s.t.advance(50)
    await s.send('Recommend a hotel in Kyoto')
    await s.t.advance(50)
    const text = 'Make that one shorter, and add prices to the hotel answer'
    const frags = [{ part: 'Make that one shorter', label: 'shorter' }, { part: 'add prices to the hotel answer', label: 'prices' }]
    await s.send(
      text,
      {
        composite: 0.9,
        parts: [
          { relation: 'addition', targets: { 'Explain tides': 0.5, 'Explain eclipses': 0.5 } },
          { relation: 'addition', targets: { 'Recommend a hotel in Kyoto': 0.95 } },
        ],
      },
      { decompose: frags },
    )
    const raised = (await s.events()).find((e) => e.type === 'elicitation-raised')
    if (!raised || raised.type !== 'elicitation-raised' || raised.elicitation.kind !== 'target-ambiguity') throw new Error('no ambiguity raised')
    s.t.decomposer.push(decomposition(text, frags))
    s.t.model.script('Make that one shorter', answer('Moon.', 10, 20))
    s.t.model.script('add prices', answer('Kanra: 300 USD.', 10, 20))
    const tides = s.d('Explain tides').sectionId
    if (!tides) throw new Error('no section')
    await s.t.send({ type: 'answer-elicitation', conversationId: s.c, elicitationId: raised.elicitation.elicitationId, answer: { kind: 'target-ambiguity', sectionIds: [tides] } })
    await s.t.advance(50)
    expect(s.d('shorter').targets).toEqual([tides])
    const hotel = s.d('Recommend a hotel in Kyoto')
    expect(s.d('prices').targets).toEqual([hotel.sectionId])
    expect(s.d('prices').chainId).toBe(hotel.chainId)
    const run = s.state().attempts[s.d('prices').attemptIds[0] ?? '']
    expect(run?.context.messages.some((m) => m.content.includes('Hotel Kanra'))).toBe(true)
  })
})

describe('second review: session-wide requirements', () => {
  test('T2 (requirement) · without corrective wording a new session-wide requirement is added beside the ones in force, replacing nothing', async () => {
    const s = await routingScenario()
    s.t.model.script('Why is the sky blue', answer('Diffusion de Rayleigh.', 10, 20))
    await s.send('From now on, answer in French. Why is the sky blue?', { sessionwide: 0.95 }, {
      decompose: [{ part: 'Why is the sky blue?', label: 'sky', requirements: [{ text: 'Answer in French', part: 'answer in French', scope: 'session-wide' }] }],
    })
    await s.t.advance(50)
    await s.send('From now on, also end every answer with a one-line summary', { sessionwide: 0.95, message: { corrective: 0.05, relation: 'addition', requirements: { 1: 0.85 } } }, {
      decompose: [{ part: 'end every answer with a one-line summary', label: 'summary rule', requirements: [{ text: 'End every answer with a one-line summary', part: 'end every answer with a one-line summary', scope: 'session-wide' }] }],
    })
    const events = await s.events()
    const recorded = events.filter((e) => e.type === 'session-requirement-recorded')
    expect(recorded.map((e) => e.type === 'session-requirement-recorded' && e.replacesRequirementId)).toEqual([null, null])
    expect(events.some((e) => e.type === 'revision-recorded' || e.type === 'superseded-input-noted')).toBe(false)
    const inForce = Object.values(s.state().sessionRequirements).filter((r) => r.replacedBy === null && r.withdrawnByMessageId === null)
    expect(inForce.map((r) => r.requirement.text)).toEqual(['Answer in French', 'End every answer with a one-line summary'])
  })
})

describe('second review: routing failures', () => {
  test('F3 (routing) · under Manual a transient routing failure goes straight to Retry', async () => {
    const t = await createTestBackend({ modules: [engineModule, routingModule], useScriptedRouter: false, settings: { retryPolicy: 'manual' } })
    t.decisions.answerWith(() => ({ ok: false, error: providerError('rate-limited', 'Too many requests', { httpStatus: 429, retryAfterMs: 1_000 }) }))
    const c = await t.createConversation()
    await t.submit(c, 'Why is the sky blue?')
    await t.advance(10_000)
    expect(t.decisions.requests).toHaveLength(1)
    expect(Object.values(t.state(c).messages)[0]?.routing).toBe('failed')
    expect(WORDING.routingFailed).toBeTruthy()
  })
})

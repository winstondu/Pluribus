import { describe, expect, test } from 'vitest'
import type { AttemptStarted } from '@pluribus/protocol'
import { answer } from '../../../testing'
import { routingScenario } from '../../../testing/acceptance/routing'

/** D1–D4 (02 · "Messages and decomposition"), through the real routing pipeline over scripted decisions. */

const REC = 'Recommend a laptop for programming, with reasons'

describe('messages and decomposition', () => {
  test('D1 · a local brevity instruction does not silently become a session-wide preference', async () => {
    const s = await routingScenario()
    s.t.model.script('Explain rainbows briefly', answer('Light refracts in drops.', 10, 20))
    await s.send('Explain rainbows briefly', { sessionwide: 0.1 })
    // A composite whose decomposer calls a local requirement session-wide is still local: only explicit wording counts (Q17).
    const text = 'Explain tides and explain eclipses, keep it short'
    await s.send(
      text,
      { composite: 0.9, sessionwide: 0.2 },
      {
        decompose: [
          { part: 'Explain tides', label: 'tides', requirements: [{ text: 'Keep it short', part: 'keep it short', scope: 'session-wide' }] },
          { part: 'explain eclipses', label: 'eclipses', requirements: [{ text: 'Keep it short', part: 'keep it short', scope: 'session-wide' }] },
        ],
      },
    )
    await s.t.advance(50)
    expect(Object.keys(s.state().sessionRequirements)).toHaveLength(0)
    expect(s.d('tides').requirements.map((r) => r.scope)).toEqual(['local'])
    expect(s.d('tides').requirements[0]?.shared).toBe(true)
    // A later, unrelated run receives no conversation-wide requirement.
    s.t.model.script('What is a haiku?', answer('A short poem.', 10, 20))
    await s.send('What is a haiku?')
    await s.t.advance(50)
    const haiku = s.state().attempts[s.d('What is a haiku').attemptIds[0] ?? '']
    expect(haiku?.context.sessionRequirementIds).toEqual([])
    expect(haiku?.context.messages.some((m) => m.content.toLowerCase().includes('short'))).toBe(false)

    // Explicit "from now on" wording does make it conversation-wide.
    const explicit = 'From now on, keep every answer under 100 words. Why is the sky blue?'
    await s.send(explicit, { sessionwide: 0.95 }, {
      decompose: [{ part: 'Why is the sky blue?', label: 'sky', requirements: [{ text: 'Keep every answer under 100 words', part: 'keep every answer under 100 words', scope: 'session-wide' }] }],
    })
    await s.t.advance(50)
    const recorded = Object.values(s.state().sessionRequirements)
    expect(recorded.map((r) => r.requirement.text)).toEqual(['Keep every answer under 100 words'])
    const sky = s.state().attempts[s.d('From now on, keep every answer…').attemptIds[0] ?? '']
    expect(sky?.context.sessionRequirementIds).toEqual([recorded[0]?.requirement.id])
  })

  test('D2 · with a recommendation A in flight, an unrelated translation requested alongside a summary of A can run before A completes', async () => {
    const s = await routingScenario()
    s.t.model.script(REC, answer('Get a ThinkPad.', 100, 3_000))
    await s.send(REC)
    const text = 'Summarize that recommendation and separately translate this menu: soup, bread'
    s.t.model.script('Translate this menu', answer('Soupe, pain.', 10, 50))
    await s.send(
      text,
      {
        composite: 0.9,
        parts: [
          { relation: 'dependent', targets: { 'Recommend a laptop for programming, with…': 0.9 }, needs: { 'Recommend a laptop for programming, with…': 0.9 } },
          { relation: 'new' },
        ],
      },
      {
        decompose: [
          { part: 'Summarize that recommendation', instruction: 'Summarize the laptop recommendation.', label: 'summary' },
          { part: 'translate this menu: soup, bread', instruction: 'Translate this menu: soup, bread.', label: 'menu translation' },
        ],
      },
    )
    expect(s.d('summary').state).toBe('dependency-queued')
    expect(s.d('summary').prerequisites).toEqual([{ kind: 'directive', directiveId: s.d('Recommend a laptop for programming, with…').id }])
    expect(s.state().messages[s.d('summary').messageId]?.text).toBe(text)
    await s.t.advance(200)
    expect(s.d('menu translation').state).toBe('completed')
    expect(s.d('Recommend a laptop for programming, with…').state).toBe('running')
    expect(s.d('summary').attemptIds).toHaveLength(0)
    await s.t.advance(3_000)
    expect(s.d('summary').state).toBe('completed')
    // One user message, one reply group.
    const snap = await s.t.snapshot(s.c)
    const response = snap.transcript.responses[s.state().messages[s.d('summary').messageId]?.initialResponseId ?? '']
    expect(response?.grouped).toBe(true)
  })

  test('D3 · with an output-order qualifier on that request, the translation does not start before A completes', async () => {
    const s = await routingScenario()
    s.t.model.script(REC, answer('Get a ThinkPad.', 100, 3_000))
    await s.send(REC)
    const text = 'Summarize that recommendation and separately translate this menu: soup, bread, but put the translation first'
    await s.send(
      text,
      {
        composite: 0.9,
        barrier: 0.9,
        parts: [
          { relation: 'dependent', targets: { 'Recommend a laptop for programming, with…': 0.9 }, needs: { 'Recommend a laptop for programming, with…': 0.9 } },
          { relation: 'new' },
        ],
      },
      {
        decompose: [
          { part: 'Summarize that recommendation', instruction: 'Summarize the laptop recommendation.', label: 'summary' },
          { part: 'translate this menu: soup, bread', instruction: 'Translate this menu: soup, bread.', label: 'menu translation' },
        ],
        extra: { barrier: { reason: 'explicit-order', qualifier: 'put the translation first' }, outputOrder: [1, 0] },
      },
    )
    expect(s.d('menu translation').state).toBe('dependency-queued')
    expect(s.d('menu translation').heldByBarrier).toBe(true)
    await s.t.advance(2_000)
    expect(s.d('menu translation').attemptIds).toHaveLength(0)
    await s.t.advance(1_100)
    const events = await s.events()
    const recDone = events.find((e) => e.type === 'attempt-completed' && e.attemptId === s.d('Recommend a laptop for programming, with…').resultAttemptId)?.seq ?? 0
    const translationStart = events.find((e): e is AttemptStarted => e.type === 'attempt-started' && e.directiveId === s.d('menu translation').id)?.seq ?? 0
    expect(translationStart).toBeGreaterThan(recDone)
    // The explicit output order is honored in the group.
    const snap = await s.t.snapshot(s.c)
    const response = snap.transcript.responses[s.state().messages[s.d('summary').messageId]?.initialResponseId ?? '']
    expect(response?.sectionIds).toEqual([s.d('menu translation').sectionId, s.d('summary').sectionId])
  })

  test('D4 · undo split is unavailable once any split message shows answer text or has a reply; before that, it stops running attempts and restarts one atomic request', async () => {
    const s = await routingScenario()
    const text = 'Find three good neighborhoods in Kyoto, then make a two-day plan around the best one'
    const parts = [
      { part: 'Find three good neighborhoods in Kyoto', label: 'neighborhoods' },
      { part: 'make a two-day plan around the best one', label: 'two-day plan', after: [0] },
    ]
    const rules = { composite: 0.9, parts: [{ relation: 'new' as const }, { relation: 'dependent' as const, after: { 1: 0.9 } }] }
    s.t.model.script('Find three good neighborhoods in Kyoto', answer('Gion, Higashiyama, Arashiyama.', 500, 1_000))
    const original = await s.send(text, rules, { decompose: parts })
    const split = s.state().messages[original]
    expect(s.state().decompositions[original]?.presentation).toBe('split-messages')
    expect(split?.splitActive).toBe(true)
    const neighborhoods = s.d('neighborhoods')
    expect(neighborhoods.state).toBe('running')
    expect(s.d('two-day plan').state).toBe('dependency-queued')
    let snap = await s.t.snapshot(s.c)
    expect(snap.transcript.splits[original]?.undoAvailable).toBe(true)

    // Before any text: stops the running attempt, drops its bubble, restarts one atomic request.
    s.t.model.script(text, answer('Stay in Gion; day one…', 10, 30))
    const undone = await s.t.send({ type: 'undo-split', conversationId: s.c, originalMessageId: original })
    expect(undone.ok).toBe(true)
    expect(s.state().attempts[neighborhoods.attemptIds[0] ?? '']?.state).toBe('superseded')
    expect(s.directive(neighborhoods.id).state).toBe('superseded')
    expect(s.directive(s.d('two-day plan').id).state).toBe('superseded')
    expect(s.state().messages[original]?.splitActive).toBe(false)
    const atomic = s.state().messages[original]?.directiveIds.map((id) => s.directive(id)).find((d) => d.state !== 'superseded')
    expect(atomic?.instruction).toBe(text)
    expect(s.state().messages[original]?.decision?.composition.value).toBe('atomic')
    await s.t.advance(50)
    expect(atomic && s.directive(atomic.id).state).toBe('completed')
    snap = await s.t.snapshot(s.c)
    expect(snap.transcript.order.some((r) => r.kind === 'message' && r.id === original)).toBe(true)
    expect(snap.transcript.sections[neighborhoods.sectionId ?? '']).toBeUndefined()

    // Once a split message shows answer text, Undo split is refused.
    const second = 'List three museums in Kyoto, then pick the best one for a rainy day'
    s.t.model.script('List three museums in Kyoto', answer('National Museum, MOMAK, Manga Museum.', 10, 2_000))
    const original2 = await s.send(second, rules, {
      decompose: [
        { part: 'List three museums in Kyoto', label: 'museums' },
        { part: 'pick the best one for a rainy day', label: 'best museum', after: [0] },
      ],
    })
    await s.t.advance(50)
    snap = await s.t.snapshot(s.c)
    expect(snap.transcript.splits[original2]?.undoAvailable).toBe(false)
    const refused = await s.t.send({ type: 'undo-split', conversationId: s.c, originalMessageId: original2 })
    expect(refused.ok).toBe(false)
    expect(!refused.ok && refused.error.code).toBe('not-allowed')

    // A reply to a split message also ends it.
    const third = 'Name three temples, then rank them by crowds'
    s.t.model.script('Name three temples', answer('Kinkaku-ji…', 3_000, 4_000))
    const original3 = await s.send(third, rules, {
      decompose: [
        { part: 'Name three temples', label: 'temples' },
        { part: 'rank them by crowds', label: 'ranking', after: [0] },
      ],
    })
    await s.send('Include one in Nara', { message: { relation: 'addition' } }, { replyTo: ['temples'] })
    const replied = await s.t.send({ type: 'undo-split', conversationId: s.c, originalMessageId: original3 })
    expect(!replied.ok && replied.error.code).toBe('not-allowed')
  })
})

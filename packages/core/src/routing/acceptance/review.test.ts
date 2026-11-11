import { describe, expect, test } from 'vitest'
import { answer, done, say } from '../../testing'
import { routingScenario } from './helpers'

/**
 * Findings of the review of the routing slice, as the reviewer wrote them,
 * kept in the suite so the defects stay fixed. Each is titled with the
 * acceptance condition it breaks.
 */

const REC = 'Recommend a laptop for programming, with reasons'
const TRIP = 'Plan a five-day Kyoto trip in November'
const LINE = 'Plan a five-day Kyoto trip in…'

describe('routing review findings', () => {
  test('D4 (review) · undo split is not offered once a later message waits for a sibling group that a split directive belongs to', async () => {
    const s = await routingScenario()
    s.t.model.script('Plan a five-day Kyoto trip', answer('Brief: Kyoto, five days.', 10, 20))
    await s.send(TRIP)
    await s.t.advance(50)
    s.t.model.script('Suggest neighborhoods', answer('Gion.', 4_000, 9_000))
    await s.send('Suggest neighborhoods to stay in', { message: { relation: 'addition', chain: LINE } })
    s.t.model.script('Suggest rainy-day activities', answer('Museums.', 4_000, 9_000))
    const original = await s.send(
      'Suggest rainy-day activities, then pick the best one',
      { composite: 0.9, parts: [{ relation: 'addition', chain: LINE }, { relation: 'dependent', after: { 1: 0.9 } }] },
      {
        decompose: [
          { part: 'Suggest rainy-day activities', label: 'activities' },
          { part: 'pick the best one', label: 'best activity', after: [0] },
        ],
      },
    )
    const group = Object.values(s.state().groups)[0]
    await s.send('Compare the neighborhoods with the activities', {
      message: { relation: 'dependent', needs: { 'Suggest neighborhoods to stay in': 0.9, activities: 0.9 } },
    })
    expect(s.d('Compare the neighborhoods with the activities').prerequisites).toEqual([{ kind: 'sibling-group', groupId: group?.id }])
    const snap = await s.t.snapshot(s.c)
    expect(snap.transcript.splits[original]?.undoAvailable).toBe(false)
    expect((await s.t.send({ type: 'undo-split', conversationId: s.c, originalMessageId: original })).ok).toBe(false)
  })

  test('C9 (review) · work needing A and (through its branch) B, with D still open, waits for the full join-back', async () => {
    const s = await routingScenario()
    s.t.model.script('Plan a five-day', answer('Brief.', 10, 20))
    await s.send(TRIP)
    await s.t.advance(50)
    s.t.model.script('Suggest neighborhoods', answer('Gion.', 5_000, 9_000))
    await s.send('Suggest neighborhoods to stay in', { message: { relation: 'addition', chain: LINE } })
    s.t.model.script('Suggest rainy-day activities', answer('Museums.', 10, 20))
    await s.send('Suggest rainy-day activities', { message: { relation: 'addition', chain: LINE } })
    s.t.model.script('Suggest food', answer('Nishiki.', 5_000, 12_000))
    await s.send('Suggest food markets', { message: { relation: 'addition', chain: LINE } })
    await s.t.advance(50)
    s.t.model.script('Give me three cheaper', answer('Free temples.', 10, 20))
    await s.send('Give me three cheaper alternatives', { message: { relation: 'addition', targets: { 'Suggest rainy-day activities': 0.95 } } })
    await s.t.advance(50)
    await s.send('Compare the neighborhoods with the cheaper alternatives', {
      message: { relation: 'dependent', targets: { 'Give me three cheaper alternatives': 0.95 }, needs: { 'Suggest neighborhoods to stay in': 0.9 } },
    })
    const compare = s.d('Compare the neighborhoods with the cheaper…')
    await s.t.advance(9_500)
    expect(s.d('Suggest food markets').state).toBe('running')
    expect(s.directive(compare.id).attemptIds).toHaveLength(0)
    await s.t.advance(5_000)
    expect(s.directive(compare.id).attemptIds).toHaveLength(1)
  })

  test('T1 (review) · an explicit section reply target is never dropped on a composite reply', async () => {
    const s = await routingScenario()
    s.t.model.script('Explain why the sky is blue', answer('Blue light scatters most.', 10, 20))
    s.t.model.script('Translate this menu', answer('Soupe, pain.', 10, 20))
    await s.send('Explain why the sky is blue, and separately translate this menu into French: soup, bread', { composite: 0.9 }, {
      decompose: [
        { part: 'Explain why the sky is blue', label: 'sky' },
        { part: 'translate this menu into French: soup, bread', instruction: 'Translate this menu into French: soup, bread', label: 'menu' },
      ],
    })
    await s.t.advance(50)
    const menu = s.d('menu')
    await s.send(
      'Use formal French, and also explain tides',
      { composite: 0.9, parts: [{ relation: 'addition' }, { relation: 'new' }] },
      { replyTo: ['menu'], decompose: [{ part: 'Use formal French', label: 'formal' }, { part: 'also explain tides', label: 'tides' }] },
    )
    const targeted = Object.values(s.state().directives)
      .filter((d) => d.label === 'formal' || d.label === 'tides')
      .flatMap((d) => d.targets)
    expect(targeted).toContain(menu.sectionId)
    // The handling-chain guess at low confidence did not decide where "formal" goes.
    expect(s.d('formal').chainId).not.toBe(s.d('sky').chainId)
  })

  test('D1 (review) · a local brevity instruction beside an explicit "from now on" requirement stays local', async () => {
    const s = await routingScenario()
    // The gate confirms explicit wording; each requirement the decomposer calls session-wide is then asked about on its own.
    await s.send('From now on, use metric units. Explain tides briefly.', { sessionwide: 0.95, sessionwideRequirements: { 'Be brief': 0.1 } }, {
      decompose: [
        {
          part: 'Explain tides briefly.',
          label: 'tides',
          requirements: [
            { text: 'Use metric units', part: 'use metric units', scope: 'session-wide' },
            { text: 'Be brief', part: 'briefly', scope: 'session-wide' },
          ],
        },
      ],
    })
    await s.t.advance(50)
    expect(Object.values(s.state().sessionRequirements).map((r) => r.requirement.text)).toEqual(['Use metric units'])
  })

  test('C2 (review) · relation=dependent on in-flight work is not run before the result', async () => {
    const s = await routingScenario()
    s.t.model.script(REC, answer('Get a ThinkPad.', 3_000, 6_000))
    await s.send(REC)
    await s.send('Expand the recommendation you are preparing', {
      message: { relation: 'dependent', targets: { 'Recommend a laptop for programming, with…': 0.95 }, needs: { 'Recommend a laptop for programming, with…': 0.55 } },
    })
    await s.t.advance(100)
    const expand = s.d('Expand the recommendation you are preparing')
    expect(expand.relation).toBe('result-dependent')
    expect(expand.attemptIds).toHaveLength(0)
  })

  test('C3 (review) · a clarification question does not record the unfinished prerequisite as an input', async () => {
    const s = await routingScenario()
    s.t.model.script(REC, [say(100, 'PARTIAL'), say(5_000, ' more'), done(6_000)])
    await s.send(REC)
    await s.t.advance(200)
    s.t.model.script('Ask the user one short', answer('For whom?', 10, 20))
    await s.send('Summarize that recommendation for my manager', {
      message: { relation: 'dependent', needs: { 'Recommend a laptop for programming, with…': 0.9 }, clarify: 0.9, why: 'missing' },
    })
    await s.t.advance(50)
    const run = s.state().attempts[s.d('question about Summarize that recommendation for my manager').attemptIds[0] ?? '']
    expect(run?.context.messages.map((m) => m.content).join()).not.toContain('PARTIAL')
    expect(run?.context.inputs.map((i) => i.directiveId)).not.toContain(s.d('Recommend a laptop for programming, with…').id)
  })
})

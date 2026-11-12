import { describe, expect, test } from 'vitest'
import { answer } from '../../../testing'
import { routingScenario } from '../../../testing/acceptance/routing'

/**
 * Finding of the fourth review that reaches routing: a reply target scored
 * below `targetChoice` is added without asking only when it changes neither
 * the handling chain nor the placement (11 · "Below the target-choice
 * confidence threshold, Committee elicits the target"; 05 "It never guesses
 * silently"; C19).
 */

const BRIEF = 'Trip brief: Kyoto, five days, November'
const A = 'Suggest neighborhoods to stay in'
const B = 'Suggest rainy-day activities'
const C = 'Which work indoors at night'
const J = 'Make an itinerary from those'

async function kyoto() {
  const s = await routingScenario()
  s.t.model.script(BRIEF, answer('Noted.', 10, 20))
  await s.send(BRIEF)
  await s.t.advance(50)
  s.t.model.script(A, answer('Gion and Higashiyama.', 100, 300))
  s.t.model.script(B, answer('Museums and tea houses.', 100, 300))
  await s.send(A, { message: { relation: 'addition' } }, { replyTo: [BRIEF] })
  await s.send(B, { message: { relation: 'addition' } }, { replyTo: [BRIEF] })
  await s.t.advance(1_000)
  // A branch from B: an evening question about the activities only.
  s.t.model.script(C, answer('The tea houses.', 10, 20))
  await s.send(C, { message: { relation: 'addition' } }, { replyTo: [B] })
  await s.t.advance(100)
  return s
}

const title = (s: Awaited<ReturnType<typeof kyoto>>, label: string): string => s.state().sections[s.d(label).sectionId ?? '']?.title ?? ''

describe('fourth review: a weak reply target is asked about when it would change the placement', () => {
  test('C19 · J refers clearly to A, weakly to its sibling B and to the branch C: the user is asked, no join chain is guessed', async () => {
    const s = await kyoto()
    const group = Object.values(s.state().groups)[0]
    expect(group?.members.map((m) => m.directiveId)).toEqual([s.d(A).id, s.d(B).id])
    const before = s.state().directiveOrder.length
    const messageId = await s.send(J, {
      message: { relation: 'addition', several: 0.9, targets: { [title(s, A)]: 0.84, [title(s, B)]: 0.63, [title(s, C)]: 0.4 } },
    })
    const message = s.state().messages[messageId]
    expect(message?.routing).toBe('awaiting-target')
    expect(s.state().directiveOrder).toHaveLength(before)
    const elicitation = Object.values(s.state().elicitations).at(-1)
    expect(elicitation?.record.kind).toBe('target-ambiguity')
    if (elicitation?.record.kind !== 'target-ambiguity') return
    expect(elicitation.record.candidates.map((c) => c.sectionId)).toEqual([s.d(A).sectionId, s.d(B).sectionId, s.d(C).sectionId])
  })

  test('C19 · J refers clearly to A and weakly to its sibling B only: B is added without asking and J continues the join-back on the base chain', async () => {
    const s = await kyoto()
    s.t.model.script(J, answer('Day 1: Gion.', 10, 20))
    const messageId = await s.send(J, {
      message: { relation: 'addition', several: 0.9, targets: { [title(s, A)]: 0.84, [title(s, B)]: 0.63, [title(s, C)]: 0.1 } },
    })
    await s.t.advance(100)
    expect(s.state().messages[messageId]?.routing).toBe('routed')
    const j = s.d(J)
    expect(new Set(j.targets)).toEqual(new Set([s.d(A).sectionId, s.d(B).sectionId]))
    const chain = s.state().chains[j.chainId]
    expect(chain?.kind).not.toBe('join')
    expect(j.chainId).toBe(s.d(BRIEF).chainId)
    const node = s.state().nodes[j.nodeId]
    expect(node?.plannedParents).toHaveLength(1)
    const run = s.state().attempts[j.attemptIds[0] ?? '']
    expect(run?.modelRole).toBe('answer')
    expect(run?.context.messages.some((m) => m.content.includes('The tea houses.'))).toBe(false)
  })
})

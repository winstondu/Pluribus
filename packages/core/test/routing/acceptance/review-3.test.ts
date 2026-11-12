import { describe, expect, test } from 'vitest'
import { answer } from '../../../testing'
import { engineModule } from '../../../src/engine'
import { routingModule } from '../../../src/routing/module'
import { answerFrom, routingScenario as baseScenario, type MessageRules, type RoutingScenario } from '../../../testing/acceptance/routing'

/**
 * Findings of the third review (messages routed while an earlier message is
 * still being routed; replies to work that starts its line), adopted from
 * the reviewer's tests and titled with the condition each one breaks.
 */

const routingScenario = () => baseScenario({ modules: [engineModule, routingModule] })

const REC = 'Recommend a laptop for coding'
const SUM = 'Summarize that recommendation'
const needsRec: MessageRules = { message: { relation: 'dependent', targets: { [REC]: 0.95 }, needs: { [REC]: 0.95 } } }

function inputText(s: RoutingScenario, label: string, attempt = 0): string {
  const st = s.state()
  const a = st.attempts[s.d(label).attemptIds.at(attempt) ?? '']
  return (a?.context.messages ?? []).map((m) => m.content).join('\n')
}

function gate(s: RoutingScenario): () => void {
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  const normal = answerFrom(s.rules)
  s.t.decisions.answerWith(async (req) => {
    await held
    return normal(req)
  })
  return () => {
    release()
    s.t.decisions.answerWith(normal)
  }
}

async function submitHeld(s: RoutingScenario, text: string, rules: MessageRules, targets: readonly string[] = []): Promise<void> {
  s.rules[text] = rules
  await s.t.backend.send({ type: 'submit-message', conversationId: s.c, text, ...(targets.length > 0 ? { targets: targets as never } : {}) })
  await s.t.flush()
}

describe('third review: routing in submission order', () => {
  test("C2 · two messages sent back to back while the first one's Decisions call is still in flight: the second waits for the first's result", async () => {
    const s = await routingScenario()
    s.t.model.script('Name a prime', answer('Seven.', 10, 20))
    await s.send('Name a prime')
    await s.t.advance(50)
    const release = gate(s)
    s.t.model.script(REC, answer('ThinkPad.', 10, 3_000))
    s.t.model.script(SUM, answer('Summary.', 10, 20))
    await submitHeld(s, REC, {})
    await submitHeld(s, SUM, needsRec)
    release()
    await s.t.settle()
    await s.t.advance(100)
    expect(s.d(SUM).attemptIds).toHaveLength(0)
    expect(s.d(SUM).state).toBe('dependency-queued')
    await s.t.advance(4_000)
    expect(s.d(SUM).state).toBe('completed')
    expect(inputText(s, SUM)).toContain('ThinkPad.')
  })
})

describe('third review: replies to work that starts its line', () => {
  test("T1 · 05 · 'Also give me luxury options' replying to a running answer that starts its chain reads what it refers to", async () => {
    const s = await routingScenario()
    const H = 'Suggest hotels in Lisbon'
    s.t.model.script(H, answer('Hotel A, Hotel B.', 10, 1_000))
    await s.send(H)
    await s.t.advance(20)
    s.t.model.script('Also give me luxury options', answer('Hotel C.', 10, 20))
    await s.send('Also give me luxury options', { message: { relation: 'addition' } }, { replyTo: [H] })
    await s.t.advance(50)
    const d = s.d('Also give me luxury options')
    expect(d.targets).toEqual([s.d(H).sectionId])
    // Nothing settled to fork from: it continues the hotels chain once that answer has finished.
    expect(d.chainId).toBe(s.d(H).chainId)
    expect(d.attemptIds).toHaveLength(0)
    await s.t.advance(1_100)
    expect(s.d('Also give me luxury options').state).toBe('completed')
    const input = inputText(s, 'Also give me luxury options')
    expect(input).toContain('Lisbon')
    expect(input).toContain('Hotel A, Hotel B.')
  })
})

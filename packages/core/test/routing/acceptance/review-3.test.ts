import { describe, expect, test } from 'vitest'
import { WORDING, providerError } from '@pluribus/protocol'
import { answer } from '../../../testing'
import { engineModule } from '../../../src/engine'
import { recoveryModule } from '../../../src/recovery/module'
import { routingModule } from '../../../src/routing/module'
import { answerFrom, routingScenario as baseScenario, type MessageRules, type RoutingScenario } from '../../../testing/acceptance/routing'

/**
 * Findings of the third review (messages routed while an earlier message is
 * still being routed; replies to work that starts its line), adopted from
 * the reviewer's tests and titled with the condition each one breaks.
 */

const routingScenario = () => baseScenario({ modules: [engineModule, routingModule, recoveryModule] })

const REC = 'Recommend a laptop for coding'
const SUM = 'Summarize that recommendation'
const needsRec: MessageRules = { message: { relation: 'dependent', targets: { [REC]: 0.95 }, needs: { [REC]: 0.95 } } }

function inputText(s: RoutingScenario, label: string, attempt = 0): string {
  const st = s.state()
  const a = st.attempts[s.d(label).attemptIds.at(attempt) ?? '']
  return (a?.context.messages ?? []).map((m) => m.content).join('\n')
}

function hasDirective(s: RoutingScenario, label: string): boolean {
  const st = s.state()
  return st.directiveOrder.some((id) => st.directives[id]?.label === label)
}

/** Holds every decision call until released. */
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
  test("C2 · REC's Decisions call is rate-limited once; SUM (needs REC) is sent during the wait and does not run before REC's result", async () => {
    const s = await routingScenario()
    s.t.model.script('Name a prime', answer('Seven.', 10, 20))
    await s.send('Name a prime')
    await s.t.advance(50)
    const normal = answerFrom(s.rules)
    let failedOnce = false
    s.t.decisions.answerWith((req) => {
      if (!failedOnce && req.state.includes(`New message: "${REC}"`)) {
        failedOnce = true
        return { ok: false, error: { ...providerError('rate-limited', '429'), retryAfterMs: 2_000 } }
      }
      return normal(req)
    })
    s.t.model.script(REC, answer('ThinkPad.', 10, 3_000))
    s.t.model.script(SUM, answer('Summary.', 10, 20))
    await s.send(REC)
    await s.t.advance(1_000)
    await s.send(SUM, needsRec)
    await s.t.advance(100)
    // SUM has not run: its routing waits for REC's, which is still waiting for capacity.
    expect(!hasDirective(s, SUM) || s.d(SUM).attemptIds.length === 0).toBe(true)
    await s.t.advance(1_500)
    // REC is routed and running; SUM's routing saw it and SUM waits for its result.
    expect(s.d(REC).state).toBe('running')
    expect(s.d(SUM).attemptIds).toHaveLength(0)
    expect(s.d(SUM).prerequisites).toEqual([{ kind: 'directive', directiveId: s.d(REC).id }])
    const queue = (await s.t.snapshot(s.c)).queue.items
    expect(queue.map((i) => i.directiveId)).toContain(s.d(SUM).id)
    await s.t.advance(4_000)
    expect(s.d(SUM).state).toBe('completed')
    expect(inputText(s, SUM)).toContain('ThinkPad.')
  })

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

  test('T3 · a reply target is superseded while the reply is being routed: it resolves to the replacement and says so', async () => {
    const s = await routingScenario()
    const SKY = 'Why is the sky blue'
    s.t.model.script(SKY, answer('Scattering.', 10, 20))
    await s.send(SKY)
    await s.t.advance(50)
    const old = s.d(SKY).sectionId
    s.t.model.script(SKY, answer('Rayleigh.', 10, 20))
    const release = gate(s)
    await submitHeld(s, 'Actually, for a physicist', { message: { corrective: 0.95, relation: 'addition' } }, [old ?? ''])
    await submitHeld(s, 'Shorter please', { message: { relation: 'addition' } }, [old ?? ''])
    release()
    await s.t.settle()
    await s.t.advance(100)
    const replacement = s.d(SKY).sectionId
    expect(replacement).not.toBe(old)
    expect(s.d('Shorter please').targets).toEqual([replacement])
    const snap = await s.t.snapshot(s.c)
    const replyingTo = snap.transcript.messages[s.d('Shorter please').messageId]?.replyingTo
    expect(replyingTo?.targets.map((t) => t.sectionId)).toEqual([replacement])
    expect(replyingTo?.note).toBe(WORDING.replyingToRevised)
    // It is not placed under the superseded node.
    const st = s.state()
    const parents = st.attempts[s.d('Shorter please').attemptIds[0] ?? '']?.parents ?? []
    for (const p of parents) expect(st.nodes[p]?.replacedByNodeId ?? null).toBeNull()
    expect(inputText(s, 'Shorter please')).toContain('Rayleigh.')
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

import { describe, expect, test } from 'vitest'
import type { TestBackendOverrides } from '../../../testing'
import { answer } from '../../../testing'
import { routingScenario } from '../../../testing/acceptance/routing'

/**
 * Joining instead of asking (05 · "Joining instead of asking", T4;
 * `thresholds.joinChoice`). A reply whose target is ambiguous is put to the
 * user, unless the decision model says it brings several lines of work
 * together: "which one?" then has no answer, and the lines are joined.
 *
 * The scene and the scores are those of the conversation exported on
 * 2026-11-12, where routing asked which answer "Tell me about the ocean and
 * sky in kyoto" meant: 0.57, 0.39 and 0.43 for the three answers, none at
 * the target-choice threshold.
 */

const KYOTO = 'Tell me about kyoto'
const SKY = 'Why is the sky blue'
const OCEAN_TEXT = 'And does the ocean reflect the sky'
/** The label and section title routing gives it. */
const OCEAN = 'And does the ocean reflect the…'
const BOTH = 'Tell me about the ocean and sky in kyoto'
const BOTH_LABEL = 'Tell me about the ocean and…'
/** As the three answers scored in the export. */
const WEAK = { [KYOTO]: 0.57, [SKY]: 0.39, [OCEAN]: 0.43 }

async function cityAndSky(overrides: TestBackendOverrides = {}) {
  const s = await routingScenario(overrides)
  s.t.model.script(KYOTO, answer('Kyoto was the imperial capital.', 10, 20))
  s.t.model.script(SKY, answer('Rayleigh scattering.', 10, 20))
  s.t.model.script(OCEAN_TEXT, answer('Partly; water absorbs red light.', 10, 20))
  await s.send(KYOTO)
  await s.send(SKY)
  await s.t.advance(100)
  await s.send(OCEAN_TEXT, { message: { relation: 'addition', targets: { [SKY]: 0.9 } } })
  await s.t.advance(100)
  s.t.model.script(BOTH, answer('Kyoto is inland; its sky is blue for the usual reason.', 10, 20))
  return s
}

const asked = (s: Awaited<ReturnType<typeof cityAndSky>>, text: string): string[] =>
  s.t.decisions.requests.filter((r) => r.state.includes(`New message: "${text}"`)).flatMap((r) => Object.keys(r.questions))

describe('joining instead of asking', () => {
  test('T4 · no section is a clear target and the message brings two lines together: the lines are joined, the user is not asked', async () => {
    const s = await cityAndSky()
    const messageId = await s.send(BOTH, { message: { relation: 'addition', several: 0.66, lines: 0.88, targets: WEAK } })
    await s.t.advance(500)
    expect(asked(s, BOTH)).toContain('m_lines')
    expect(s.state().messages[messageId]?.routing).toBe('routed')
    expect(Object.values(s.state().elicitations)).toHaveLength(0)
    const work = s.d(BOTH_LABEL)
    expect(new Set(work.targets)).toEqual(new Set([s.d(KYOTO).sectionId, s.d(SKY).sectionId, s.d(OCEAN).sectionId]))
    // One parent per line: the sky answer is read through the ocean answer, which continues it.
    expect(s.state().chains[work.chainId]?.kind).toBe('join')
    expect(s.state().nodes[work.nodeId]?.plannedParents).toEqual([
      { kind: 'node', nodeId: s.d(KYOTO).nodeId },
      { kind: 'node', nodeId: s.d(OCEAN).nodeId },
    ])
    const run = s.state().attempts[work.attemptIds[0] ?? '']
    const context = run?.context.messages.map((m) => m.content).join('\n') ?? ''
    expect(context).toContain('Kyoto was the imperial capital.')
    expect(context).toContain('Rayleigh scattering.')
    expect(context).toContain('Partly; water absorbs red light.')
    // The decision records that it joined, on what confidence, and says so.
    const decision = s.state().messages[messageId]?.decision
    expect(decision?.joinedLines).toEqual([{ unit: 'message', sectionIds: [s.d(KYOTO).sectionId, s.d(OCEAN).sectionId, s.d(SKY).sectionId], confidence: 0.88 }])
    expect(decision?.thresholds['joinChoice']).toBe(0.8)
    expect(decision?.explanation).toContain('the lines were joined')
  })

  test('T4 · below the join threshold the same message is put to the user', async () => {
    const s = await cityAndSky()
    const before = s.state().directiveOrder.length
    const messageId = await s.send(BOTH, { message: { relation: 'addition', several: 0.66, lines: 0.6, targets: WEAK } })
    expect(s.state().messages[messageId]?.routing).toBe('awaiting-target')
    expect(s.state().directiveOrder).toHaveLength(before)
    const elicitation = Object.values(s.state().elicitations).at(-1)
    expect(elicitation?.record.kind).toBe('target-ambiguity')
  })

  test('T4 · with the join threshold off the question about the lines is not asked, and the user is', async () => {
    const s = await cityAndSky({ settings: { thresholds: { joinChoice: 1 } } })
    const messageId = await s.send(BOTH, { message: { relation: 'addition', several: 0.66, lines: 1, targets: WEAK } })
    expect(asked(s, BOTH)).not.toContain('m_lines')
    expect(s.state().messages[messageId]?.routing).toBe('awaiting-target')
  })

  test('T4 · plausible sections on one line only are a question to the user, whatever the model says about the lines', async () => {
    const s = await cityAndSky()
    const text = 'Make that shorter'
    const messageId = await s.send(text, { message: { relation: 'addition', lines: 0.95, targets: { [SKY]: 0.5, [OCEAN]: 0.5 } } })
    expect(s.state().messages[messageId]?.routing).toBe('awaiting-target')
    const elicitation = Object.values(s.state().elicitations).at(-1)
    if (elicitation?.record.kind !== 'target-ambiguity') throw new Error('expected a target-ambiguity elicitation')
    expect(elicitation.record.candidates.map((c) => c.sectionId)).toEqual([s.d(SKY).sectionId, s.d(OCEAN).sectionId])
  })

  test('T4 · a clear target and a weaker one on another line: joined at the threshold, asked about below it', async () => {
    const rules = (lines: number) => ({ message: { relation: 'addition' as const, several: 0.9, lines, targets: { [KYOTO]: 0.84, [OCEAN]: 0.45 } } })
    const below = await cityAndSky()
    const askedId = await below.send(BOTH, rules(0.3))
    expect(below.state().messages[askedId]?.routing).toBe('awaiting-target')

    const s = await cityAndSky()
    const messageId = await s.send(BOTH, rules(0.9))
    await s.t.advance(500)
    expect(s.state().messages[messageId]?.routing).toBe('routed')
    const work = s.d(BOTH_LABEL)
    expect(s.state().chains[work.chainId]?.kind).toBe('join')
    expect(work.targets).toEqual([s.d(KYOTO).sectionId, s.d(OCEAN).sectionId])
  })

  test('T4 · a clear single target is not widened into a join by a yes about the lines', async () => {
    const s = await cityAndSky()
    const messageId = await s.send(BOTH, { message: { relation: 'addition', lines: 0.95, targets: { [KYOTO]: 0.84, [OCEAN]: 0.45 } } })
    await s.t.advance(500)
    expect(s.state().messages[messageId]?.routing).toBe('routed')
    const work = s.d(BOTH_LABEL)
    expect(work.targets).toEqual([s.d(KYOTO).sectionId])
    expect(s.state().chains[work.chainId]?.kind).not.toBe('join')
    expect(s.state().messages[messageId]?.decision?.joinedLines).toBeUndefined()
  })
})

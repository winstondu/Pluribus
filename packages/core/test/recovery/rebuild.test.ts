import { describe, expect, test } from 'vitest'
import {
  createSeededRandom,
  emptyConversationSnapshot,
  reconcileFrame,
  type ConversationFrame,
  type ElicitationId,
  type Placement,
  type PrerequisiteRef,
  type SectionId,
} from '@pluribus/protocol'
import { fail, independent, say, spanOf, type ScriptStep, type UnitSpec } from '../../testing'
import { fold, emptyConversationState, rebuildSnapshot } from '../../src/engine'
import type { Scenario } from '../../testing/acceptance/engine'
import { recoveryScenario, revise } from '../../testing/acceptance/recovery'

/**
 * Property, with the recovery slice: whatever revisions, retries, pauses,
 * recovery choices, choices with default and regenerations happen, the
 * state folded from the log equals the engine's, every projection rebuilt
 * from it equals the incremental one, and a client applying every frame
 * holds the same snapshot.
 */

type Rnd = () => number
const pick = <T>(rnd: Rnd, items: readonly T[]): T | undefined => items[Math.floor(rnd() * items.length)]

function script(rnd: Rnd, label: string): ScriptStep[] {
  const at = 10 + Math.floor(rnd() * 300)
  const roll = rnd()
  if (roll < 0.12) return [fail(at, 'bad-gateway')]
  if (roll < 0.2) return [say(at, `${label} partial`), fail(at + 50, 'refusal')]
  if (roll < 0.28) return [say(at, `${label} forever`)]
  return [say(at, `${label} answer`), { afterMs: at + 40 + Math.floor(rnd() * 600), event: { type: 'completed', finishReason: 'stop', usage: null } }]
}

function placementFor(rnd: Rnd, s: Scenario): { placement: Placement; prerequisites: PrerequisiteRef[] } {
  const state = s.state()
  const directives = state.directiveOrder.map((id) => state.directives[id]).filter((d) => d !== undefined && d.kind === 'answer' && d.state !== 'superseded')
  const someone = pick(rnd, directives)
  const roll = rnd()
  if (roll < 0.25 || !someone) return { placement: { kind: 'new-chain' }, prerequisites: [] }
  if (roll < 0.5) return { placement: { kind: 'continue', buildsOn: { kind: 'node', nodeId: someone.nodeId } }, prerequisites: [] }
  if (roll < 0.75) return { placement: { kind: 'continue', buildsOn: { kind: 'node', nodeId: someone.nodeId } }, prerequisites: [{ kind: 'directive', directiveId: someone.id }] }
  const group = pick(rnd, Object.values(state.groups).filter((g) => g.state !== 'dissolved'))
  if (group) return { placement: { kind: 'continue', buildsOn: { kind: 'sibling-group', groupId: group.id } }, prerequisites: [{ kind: 'sibling-group', groupId: group.id }] }
  return { placement: { kind: 'continue', buildsOn: { kind: 'node', nodeId: someone.nodeId } }, prerequisites: [] }
}

async function check(s: Scenario): Promise<void> {
  const events = await s.events()
  const folded = fold(emptyConversationState(s.c), events)
  expect(folded).toEqual(s.state())
  const live = await s.snap()
  expect(rebuildSnapshot(folded)).toEqual(live)
  let client = emptyConversationSnapshot(s.c)
  for (const frame of s.t.frames) {
    if (frame.kind !== 'conversation' || frame.conversationId !== s.c) continue
    const result = reconcileFrame(client, frame as ConversationFrame)
    expect(result.status).toBe('applied')
    client = result.snapshot
  }
  expect(client).toEqual(live)
}

describe('projections rebuild from the log, with recovery', () => {
  for (const seed of [21, 22, 23, 24, 25, 26, 27, 28, 29, 30]) {
    test(`random conversation ${seed} with revisions and recovery: incremental projections equal a rebuild at every step`, async () => {
      const rnd = createSeededRandom(seed)
      const policies = ['standard', 'persistent', 'manual'] as const
      const s = await recoveryScenario({
        seed,
        settings: { concurrencyLimit: 1 + Math.floor(rnd() * 4), retryPolicy: policies[Math.floor(rnd() * 3)] ?? 'standard', defaultChoiceWaitMs: 500 },
        options: { outputChunk: { maxChars: 12, maxDelayMs: 40 } },
      })
      const labels: string[] = []
      for (let step = 0; step < 16; step++) {
        const roll = rnd()
        const label = `w${step}`
        const state = s.state()
        const live = labels.filter((l) => {
          const d = Object.values(state.directives).find((x) => x.label === l)
          return d !== undefined && d.state !== 'superseded'
        })
        if (roll < 0.4 || live.length === 0) {
          s.t.model.script(`ask ${label}`, script(rnd, label), { repeat: true })
          await s.ask(`ask ${label}`, { label, ...placementFor(rnd, s) })
          labels.push(label)
        } else if (roll < 0.47) {
          const text = `ask ${label}a and ask ${label}b`
          s.t.model.script(`ask ${label}a`, script(rnd, `${label}a`), { repeat: true })
          s.t.model.script(`ask ${label}b`, script(rnd, `${label}b`), { repeat: true })
          const specs: UnitSpec[] = [
            { label: `${label}a`, spans: spanOf(text, `ask ${label}a`) },
            { label: `${label}b`, spans: spanOf(text, `ask ${label}b`), ...placementFor(rnd, s) },
          ]
          await s.ask(text, (input) => independent(input, specs))
          labels.push(`${label}a`, `${label}b`)
        } else if (roll < 0.6) {
          const target = pick(rnd, live)
          if (target) await revise(s, `Actually, change ${target} (${label})`, { targets: [target] })
        } else if (roll < 0.66) {
          const target = pick(rnd, live)
          const affected = Object.fromEntries(live.filter((l) => l !== target && rnd() < 0.5).map((l) => [l, rnd() < 0.5]))
          if (target) await revise(s, `Actually, the brief changed (${label})`, { scope: 'shared-requirement', targets: [target], affected })
        } else if (roll < 0.72) {
          const paused = Object.values(state.directives).filter((d) => d.state === 'paused')
          const d = pick(rnd, paused)
          if (d) await s.t.send({ type: rnd() < 0.6 ? 'continue-without' : 'cancel', conversationId: s.c, directiveId: d.id })
        } else if (roll < 0.78) {
          const noted = Object.values(state.sections).filter((x) => (x.supersededInputs?.inputs.length ?? 0) > 0)
          const section = pick(rnd, noted)
          if (section) await s.t.send({ type: 'regenerate', conversationId: s.c, sectionId: section.id })
        } else if (roll < 0.84) {
          const retryable = Object.values(state.directives).filter((d) => ['failed', 'stopped', 'cancelled', 'interrupted'].includes(d.state))
          const d = pick(rnd, retryable)
          if (d) await s.t.send({ type: 'retry', conversationId: s.c, target: { kind: 'section', sectionId: d.sectionId as SectionId } })
        } else if (roll < 0.9) {
          const sections = Object.values(state.sections).filter((x) => x.supersession === null)
          const section = pick(rnd, sections)
          if (section) await s.t.send({ type: 'stop', conversationId: s.c, target: { kind: 'section', sectionId: section.id } })
        } else {
          const open = state.elicitationOrder.map((id) => state.elicitations[id]).find((e) => e?.status === 'open' && e.record.kind === 'choice-with-default')
          if (open && open.record.kind === 'choice-with-default') {
            const finished = open.record.options.filter((o) => o.state === 'finished' && rnd() < 0.5).map((o) => o.directiveId)
            await s.t.send({ type: 'answer-elicitation', conversationId: s.c, elicitationId: open.id as ElicitationId, answer: { kind: 'choice-with-default', redo: finished, confirm: rnd() < 0.7 } })
          }
        }
        await s.t.advance(Math.floor(rnd() * 600))
        await check(s)
      }
      await s.t.advance(30_000)
      await check(s)
    })
  }
})

import { describe, expect, test } from 'vitest'
import {
  createSeededRandom,
  emptyConversationSnapshot,
  reconcileFrame,
  type ConversationFrame,
  type Placement,
  type PrerequisiteRef,
  type SectionId,
} from '@committee/protocol'
import { atomic, fail, independent, say, spanOf, type ScriptStep, type UnitSpec } from '../../testing'
import { fold } from '../reducers'
import { emptyConversationState } from '../state'
import { scenario, type Scenario } from '../acceptance/helpers'
import { rebuildSnapshot } from '.'

/**
 * Property: whatever happens, every projection rebuilt from the log equals
 * the one maintained incrementally, the state folded from the log equals
 * the engine's, and a client that applies every frame's patches holds the
 * same snapshot as the backend.
 */

type Rnd = () => number

const pick = <T>(rnd: Rnd, items: readonly T[]): T | undefined => items[Math.floor(rnd() * items.length)]

function randomScript(rnd: Rnd, label: string): ScriptStep[] {
  const textAt = 10 + Math.floor(rnd() * 300)
  const roll = rnd()
  if (roll < 0.12) return [fail(textAt, 'invalid-request')]
  if (roll < 0.22) return [say(textAt, `${label} partial`), fail(textAt + 50, 'refusal')]
  if (roll < 0.3) return [say(textAt, `${label} forever`)]
  const steps: ScriptStep[] = [say(textAt, `${label} answer`)]
  if (rnd() < 0.5) steps.push(say(textAt + 30, ` and more text for ${label}`))
  steps.push({ afterMs: textAt + 40 + Math.floor(rnd() * 600), event: { type: 'completed', finishReason: 'stop', usage: null } })
  return steps
}

function randomPlacement(rnd: Rnd, s: Scenario): { placement: Placement; prerequisites: PrerequisiteRef[] } {
  const state = s.state()
  const directives = state.directiveOrder.map((id) => state.directives[id]).filter((d) => d !== undefined)
  const groups = Object.values(state.groups).filter((g) => g.state !== 'dissolved')
  const roll = rnd()
  const someone = pick(rnd, directives)
  if (roll < 0.25 || !someone) return { placement: { kind: 'new-chain' }, prerequisites: [] }
  if (roll < 0.5) return { placement: { kind: 'continue', buildsOn: { kind: 'node', nodeId: someone.nodeId } }, prerequisites: [] }
  if (roll < 0.65) {
    return {
      placement: { kind: 'continue', buildsOn: { kind: 'node', nodeId: someone.nodeId } },
      prerequisites: [{ kind: 'directive', directiveId: someone.id }],
    }
  }
  const group = pick(rnd, groups)
  if (roll < 0.8 && group) {
    return { placement: { kind: 'continue', buildsOn: { kind: 'sibling-group', groupId: group.id } }, prerequisites: [{ kind: 'sibling-group', groupId: group.id }] }
  }
  const other = pick(rnd, directives)
  if (other && other.chainId !== someone.chainId) {
    return {
      placement: { kind: 'join-chain', parents: [{ kind: 'node', nodeId: someone.nodeId }, { kind: 'node', nodeId: other.nodeId }] },
      prerequisites: rnd() < 0.5 ? [] : [{ kind: 'directive', directiveId: other.id }],
    }
  }
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

describe('projections rebuild from the log', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    test(`random conversation ${seed}: incremental projections equal a rebuild at every step`, async () => {
      const rnd = createSeededRandom(seed)
      const s = await scenario({ seed, settings: { concurrencyLimit: 1 + Math.floor(rnd() * 4) }, options: { outputChunk: { maxChars: 12, maxDelayMs: 40 } } })
      for (let step = 0; step < 14; step++) {
        const roll = rnd()
        const label = `w${step}`
        if (roll < 0.55) {
          const { placement, prerequisites } = randomPlacement(rnd, s)
          s.t.model.script(`ask ${label}`, randomScript(rnd, label))
          await s.ask(`ask ${label}`, { label, placement, prerequisites })
        } else if (roll < 0.65) {
          const text = `ask ${label}a and ask ${label}b`
          s.t.model.script(`ask ${label}a`, randomScript(rnd, `${label}a`))
          s.t.model.script(`ask ${label}b`, randomScript(rnd, `${label}b`))
          const specs: UnitSpec[] = [
            { label: `${label}a`, spans: spanOf(text, `ask ${label}a`) },
            { label: `${label}b`, spans: spanOf(text, `ask ${label}b`), ...randomPlacement(rnd, s) },
          ]
          await s.ask(text, (input) =>
            independent(input, specs, rnd() < 0.3 ? { barrier: { reason: 'explicit-order', qualifier: 'in order' }, outputOrder: [1, 0] } : {}),
          )
        } else if (roll < 0.75) {
          const sections = Object.values(s.state().sections).filter((x) => x.supersession === null)
          const section = pick(rnd, sections)
          if (section) {
            const target = rnd() < 0.5 ? { kind: 'section' as const, sectionId: section.id } : { kind: 'request' as const, messageId: s.state().directives[section.directiveId]?.messageId ?? ('' as never) }
            await s.t.send({ type: 'stop', conversationId: s.c, target })
          }
        } else if (roll < 0.83) {
          const retryable = Object.values(s.state().directives).filter((d) => ['failed', 'stopped', 'cancelled', 'interrupted'].includes(d.state))
          const d = pick(rnd, retryable)
          if (d) await s.t.send({ type: 'retry', conversationId: s.c, target: { kind: 'section', sectionId: d.sectionId as SectionId } })
        } else {
          await s.ask(`plain ${label}`, (input) => atomic(input, { label }))
        }
        await s.t.advance(Math.floor(rnd() * 400))
        await check(s)
      }
      await s.t.advance(5_000)
      await check(s)
    })
  }

  test('a restart after an interruption rebuilds the same projections from the cache and the log', async () => {
    const s = await scenario({ options: { cacheEveryEvents: 3 } })
    s.t.model.script('ask one', [say(10, 'one forever')])
    await s.ask('ask one', { label: 'one' })
    await s.ask('ask two', { label: 'two', placement: { kind: 'continue', buildsOn: { kind: 'node', nodeId: s.d('one').nodeId } }, prerequisites: [{ kind: 'directive', directiveId: s.d('one').id }] })
    await s.t.advance(100)
    const next = await s.t.restart()
    const result = await next.backend.snapshot({ kind: 'events', conversationId: s.c, afterSeq: 0 })
    const events = result.ok ? result.value.events : []
    const folded = fold(emptyConversationState(s.c), events)
    expect(folded).toEqual(next.state(s.c))
    expect(rebuildSnapshot(folded)).toEqual(await next.snapshot(s.c))
  })
})

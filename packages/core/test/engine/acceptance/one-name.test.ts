import { describe, expect, test } from 'vitest'
import type { ConversationSnapshot, DirectiveId } from '@committee/protocol'
import type { LabelResult } from '../../../src/ports'
import { recoveryModule } from '../../../src/recovery/module'
import { answer, atomic, fail, say } from '../../../testing'
import { engineModule } from '../../../src/engine/engine-module'
import { expectRebuildable, scenario } from '../../../testing/acceptance/engine'

/** Every name the projections give one directive's work, in one place. */
function namesOf(snap: ConversationSnapshot, directiveId: DirectiveId, dependentId: DirectiveId): Record<string, unknown> {
  const sections = Object.values(snap.transcript.sections)
  const section = sections.find((v) => v.directiveId === directiveId)
  const dependent = sections.find((v) => v.directiveId === dependentId)
  const chainId = section?.chainId ?? ''
  const item = snap.queue.items.find((i) => i.directiveId === dependentId)
  return {
    sectionTitle: section?.title,
    transcriptChain: snap.transcript.chains[chainId]?.label,
    genealogyChain: snap.genealogy.chains[chainId]?.label,
    genealogyNode: Object.values(snap.genealogy.nodes).flatMap((n) => (n.kind === 'exchange' && n.directiveId === directiveId ? [n.label] : []))[0],
    operation: snap.operationGraph.operations[section?.operationId ?? '']?.label,
    waitingFor: item?.waitingFor.map((w) => w.label),
    queueText: item?.text,
    recovery: item?.recovery ? [item.recovery.cause.label, item.recovery.retry.label, item.recovery.continueWithout.label] : null,
    dependentStatus: dependent?.status && 'text' in dependent.status ? dependent.status.text : null,
  }
}

describe('one name governs a piece of work', () => {
  test('names · the generated label replaces the provisional one in the section title, chain label, queue item, status, recovery choice, mini-map and operation graph', async () => {
    const s = await scenario({ modules: [engineModule, recoveryModule] })
    // The label is held until the story has failed and its dependent paused. While it is pending the
    // backend is never quiet, so the test steps the clock with `flush` instead of settling.
    let release: ((result: LabelResult) => void) | null = null
    s.t.decomposer.labelWith((text) =>
      text.startsWith('Write')
        ? new Promise<LabelResult>((resolve) => {
            release = resolve
          })
        : { ok: false, error: { code: 'malformed-response', class: 'non-retryable', message: 'none', httpStatus: null, retryAfterMs: null } },
    )
    const step = async (ms: number): Promise<void> => {
      const target = s.t.clock.now() + ms
      await s.t.flush()
      while (s.t.clock.fireNext(target)) await s.t.flush()
      s.t.clock.set(Math.max(s.t.clock.now(), target))
      await s.t.flush()
    }
    const submit = async (text: string): Promise<void> => {
      const result = await s.t.backend.send({ type: 'submit-message', conversationId: s.c, text })
      if (!result.ok) throw new Error(result.error.message)
      await step(0)
    }
    const story = 'Write a 350-word short story about a clock that runs backwards'
    s.t.model.script(story, [say(20, 'Tick'), fail(50, 'invalid-request')])
    s.t.router.when(story, (input) => atomic(input, {}))
    await submit(story)
    const provisional = 'Write a 350-word short story about…'
    const storyId = s.id(provisional)
    s.t.router.when('Then give it a title', (input) => atomic(input, { label: 'title', prerequisites: [{ kind: 'directive', directiveId: storyId }] }))
    await submit('Then give it a title')

    // Before the generated label exists, every surface shows the provisional one.
    let snap = await s.snap()
    expect(namesOf(snap, storyId, s.id('title'))).toMatchObject({
      sectionTitle: provisional,
      transcriptChain: provisional,
      genealogyChain: provisional,
      genealogyNode: provisional,
      operation: provisional,
      waitingFor: [provisional],
    })

    // The story fails before its label arrives: the pause cause is recorded under the provisional name.
    await step(200)
    expect(s.state().directives[s.id('title')]?.state).toBe('paused')

    expect(s.state().directives[storyId]?.label).toBe(provisional)
    const resolve = release as ((result: LabelResult) => void) | null
    resolve?.({ ok: true, label: 'backwards clock' })
    await s.t.settle()
    expect(s.state().directives[storyId]?.label).toBe('backwards clock')

    snap = await s.snap()
    expect(namesOf(snap, storyId, s.id('title'))).toEqual({
      sectionTitle: 'backwards clock',
      transcriptChain: 'backwards clock',
      genealogyChain: 'backwards clock',
      genealogyNode: 'backwards clock',
      operation: 'backwards clock',
      waitingFor: ['backwards clock'],
      queueText: 'Paused — backwards clock failed',
      recovery: ['backwards clock', 'Retry backwards clock', 'Continue without backwards clock'],
      dependentStatus: 'Paused — backwards clock failed',
    })
    await expectRebuildable(s)
  })
})

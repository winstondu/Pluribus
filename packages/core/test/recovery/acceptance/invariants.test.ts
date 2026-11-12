import { describe, expect, test } from 'vitest'
import type { ConversationEvent, SectionId } from '@committee/protocol'
import { answer, fail, independent, say, spanOf } from '../../../testing'
import { recoveryScenario, revise, sectionOf, trip } from '../../../testing/acceptance/recovery'

/** Invariants 3, 5, 7 and 8 of 11 · "Invariants". */

const LUXURY = 'Actually, use a luxury budget for the neighborhood recommendations'

describe('invariants', () => {
  test('I3 · append-only history: superseded, failed, stopped and interrupted attempts are retained and marked, never rewritten', async () => {
    const s = await recoveryScenario({ settings: { retryPolicy: 'manual' } })
    await trip(s, { a: [say(50, 'Gion is'), say(5_000, ' …')], b: [say(50, 'Muse'), fail(100, 'bad-gateway')], withJ: false })
    await s.ask('Explain caching', { label: 'caching' }, [say(50, 'Caching is'), say(5_000, ' …')])
    await s.ask('Explain indexes', { label: 'indexes' }, [say(50, 'Indexes are'), say(50_000, ' …')])
    await s.t.advance(200)
    const early: ConversationEvent[] = await s.events()
    await revise(s, LUXURY, { targets: ['neighborhoods'] })
    await s.t.send({ type: 'stop', conversationId: s.c, target: { kind: 'section', sectionId: s.d('caching').sectionId as SectionId } })
    const next = await s.t.restart()
    await next.advance(200)
    const stored = await next.backend.snapshot({ kind: 'events', conversationId: s.c, afterSeq: 0 })
    if (!stored.ok) throw new Error(stored.error.message)
    // Every earlier event is still there, exactly as it was.
    expect(stored.value.events.slice(0, early.length)).toEqual(early)
    const state = next.state(s.c)
    const byLabel = (label: string) => Object.values(state.directives).find((d) => d.label === label)
    const firstAttempt = (label: string) => state.attempts[byLabel(label)?.attemptIds[0] ?? '']
    expect([firstAttempt('neighborhoods')?.state, state.attemptText[firstAttempt('neighborhoods')?.id ?? '']]).toEqual(['superseded', 'Gion is'])
    expect([firstAttempt('activities')?.state, state.attemptText[firstAttempt('activities')?.id ?? '']]).toEqual(['failed', 'Muse'])
    expect([firstAttempt('caching')?.state, state.attemptText[firstAttempt('caching')?.id ?? '']]).toEqual(['stopped', 'Caching is'])
    expect([firstAttempt('indexes')?.state, state.attemptText[firstAttempt('indexes')?.id ?? '']]).toEqual(['interrupted', 'Indexes are'])
    const snap = await next.snapshot(s.c)
    for (const label of ['neighborhoods', 'activities', 'caching', 'indexes']) {
      const attempt = snap.transcript.attempts[firstAttempt(label)?.id ?? '']
      expect(attempt?.markText).not.toBeNull()
    }
  })

  test('I5 · local failure: there is no aggregate failed or cancelled request state', async () => {
    const s = await recoveryScenario({ settings: { retryPolicy: 'manual' } })
    const text = 'Explain caching, and separately explain indexes'
    s.t.model.script('Explain caching', [fail(10, 'refusal')])
    s.t.model.script('explain indexes', answer('Indexes.', 10, 20))
    s.t.router.when(text, (input) =>
      independent(input, [
        { label: 'caching', spans: spanOf(text, 'Explain caching') },
        { label: 'indexes', spans: spanOf(text, 'explain indexes') },
      ]),
    )
    const messageId = await s.t.submit(s.c, text)
    await s.t.advance(100)
    const snap = await s.snap()
    expect(sectionOf(snap, s, 'caching').state).toBe('failed')
    expect(sectionOf(snap, s, 'indexes').state).toBe('completed')
    const message = snap.transcript.messages[messageId]
    const response = snap.transcript.responses[sectionOf(snap, s, 'caching').responseId]
    for (const view of [message, response]) {
      expect(Object.keys(view ?? {})).not.toContain('state')
      expect(Object.keys(view ?? {})).not.toContain('status')
    }
    expect(response?.header?.countText).toBe('1 done · 1 failed')
    // Every operation of the request is its own; none stands for the request as a whole.
    expect(Object.values(snap.operationGraph.operations).every((o) => o.kind !== 'answer' || o.directiveId !== null)).toBe(true)
  })

  test('I7 · rewound replacement context: replacements and retries never consume an earlier attempt’s partial text', async () => {
    const s = await recoveryScenario()
    await trip(s, { a: [say(50, 'PARTIAL-A'), say(5_000, ' …')], b: answer('Museums.', 50, 100), j: answer('Day 1.', 10, 20) })
    s.t.model.script('Explain caching', [say(10, 'PARTIAL-C'), fail(20, 'network')])
    s.t.model.script('Explain caching', [say(10, 'PARTIAL-D'), fail(20, 'network')])
    await s.ask('Explain caching', { label: 'caching' })
    await s.t.advance(200)
    await revise(s, LUXURY, { targets: ['neighborhoods'] })
    await s.t.advance(5_000)
    const state = s.state()
    for (const id of state.directiveOrder) {
      const d = state.directives[id]
      if (!d) continue
      const partials = d.attemptIds.filter((a) => state.attempts[a]?.state !== 'completed').map((a) => state.attemptText[a] ?? '').filter((t) => t !== '')
      for (const attemptId of d.attemptIds) {
        const attempt = state.attempts[attemptId]
        if (!attempt) continue
        const input = attempt.context.messages.map((m) => m.content).join('\n')
        for (const partial of partials) expect(input).not.toContain(partial)
      }
    }
    // Every partial text of every directive is excluded from every later run, the itinerary's included.
    const everything = state.directiveOrder.flatMap((id) => state.directives[id]?.attemptIds ?? [])
    const allInputs = everything.map((a) => state.attempts[a]?.context.messages.map((m) => m.content).join('\n') ?? '').join('\n')
    for (const partial of ['PARTIAL-A', 'PARTIAL-C', 'PARTIAL-D']) expect(allInputs).not.toContain(partial)
  })

  test('I8 · no server assumed: interrupted work recovers by the retry setting, and core reaches time, timers and I/O only through its ports', async () => {
    for (const [policy, expected] of [
      ['standard', 'completed'],
      ['persistent', 'completed'],
      ['manual', 'interrupted'],
    ] as const) {
      const s = await recoveryScenario({ settings: { retryPolicy: policy } })
      await s.ask('Explain caching', { label: 'caching' }, [say(20, 'Caching is'), say(10_000, ' …')])
      await s.t.advance(50)
      s.t.model.script('Explain caching', answer('Caching keeps copies.', 10, 20))
      const next = await s.t.restart()
      await next.advance(100)
      expect(Object.values(next.state(s.c).directives)[0]?.state).toBe(expected)
    }
    // Production core never touches a host clock, timer, network or storage of its own.
    type Fs = { readdirSync(path: string): string[]; readFileSync(path: string, encoding: 'utf8'): string; statSync(path: string): { isDirectory(): boolean } }
    const fs = (await import(['node', 'fs'].join(':'))) as Fs
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const name of fs.readdirSync(dir)) {
        const path = `${dir}/${name}`
        if (fs.statSync(path).isDirectory()) {
          // The ports declare the injected clock and timers; they do not call anything.
          if (name !== 'ports') walk(path)
        } else if (name.endsWith('.ts')) files.push(path)
      }
    }
    walk('packages/core/src')
    expect(files.length).toBeGreaterThan(20)
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      expect(source, file).not.toMatch(/(?<![.\w])(Date\.now|setTimeout|setInterval|fetch|Math\.random|localStorage|indexedDB)\s*\(/)
    }
  })
})

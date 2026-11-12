import { describe, expect, expectTypeOf, test } from 'vitest'
import type { AttemptStarted, ConversationEvent } from '@committee/protocol'
import type { ModelRequest, ModelStreamEvent } from '../../../src/ports'
import { answer, fail, independent, say, sequential, spanOf } from '../../../testing'
import { clone, scenario } from '../../../testing/acceptance/engine'

/** Architecture invariants 1, 2, 4, 6 and 10 (11 · "Invariants") that milestone 1 can express. */

const startedOf = (events: readonly ConversationEvent[]): AttemptStarted[] =>
  events.filter((e): e is AttemptStarted => e.type === 'attempt-started')

describe('invariants', () => {
  test('I1 · context ancestry, result dependencies and display placement are kept separately and none is derived from another', async () => {
    const s = await scenario()
    await s.ask('Recommend a neighborhood', { label: 'neighborhoods' }, answer('Gion.', 500, 600))
    // Shown below the neighborhoods' message, but reads none of it and waits for none of it.
    await s.ask('Explain dinosaurs', { label: 'dinosaurs' }, answer('Big lizards.', 100, 200))
    // Waits for the neighborhoods (a result dependency) and reads them (ancestry).
    await s.ask('Expand it', { label: 'expansion', placement: s.on('neighborhoods'), prerequisites: [s.needs('neighborhoods')] }, answer('More Gion.', 10, 20))
    // Held by a whole-request barrier: waits for a result it does not read and does not depend on.
    const text = 'In this order: summarize it, then translate "hello"'
    s.t.router.when(text, (input) =>
      independent(
        input,
        [
          { label: 'summary', spans: spanOf(text, 'summarize it'), placement: s.on('neighborhoods'), prerequisites: [s.needs('neighborhoods')] },
          { label: 'hello', spans: spanOf(text, 'translate "hello"') },
        ],
        { barrier: { reason: 'explicit-order', qualifier: 'In this order' }, outputOrder: [0, 1] },
      ),
    )
    await s.t.submit(s.c, text)
    await s.t.advance(300)
    const snap = await s.snap()
    const { transcript, genealogy, operationGraph } = snap

    // Placement: dinosaurs overtook neighborhoods.
    const responses = transcript.order.filter((r) => r.kind === 'response').map((r) => transcript.responses[r.id]?.messageId)
    expect(responses[0]).toBe(s.d('dinosaurs').messageId)
    // Ancestry: dinosaurs is a root; nothing shown above it is its parent.
    const dinoNode = genealogy.nodes[s.d('dinosaurs').nodeId]
    expect(dinoNode?.kind === 'exchange' && dinoNode.parents).toEqual([])
    // Dependency: none for dinosaurs, one for the expansion, which is also its parent.
    const op = (label: string) => operationGraph.operations[(s.d(label).sectionId && transcript.sections[s.d(label).sectionId ?? '']?.operationId) || '']
    expect(op('dinosaurs')?.dependsOn).toEqual([])
    expect(op('expansion')?.dependsOn).toEqual([op('neighborhoods')?.id])
    // The barrier hold is its own list, not a dependency, and not ancestry.
    expect(op('hello')?.heldByBarrier).toBe(true)
    expect(op('hello')?.dependsOn).toEqual([])
    expect(op('hello')?.barrierWaitingFor).toEqual([op('neighborhoods')?.id])
    const helloNode = genealogy.nodes[s.d('hello').nodeId]
    expect(helloNode?.kind === 'exchange' && helloNode.parents).toEqual([])
  })

  test('I2 · every attempt records the context it actually received, and later work never rewrites it', async () => {
    const s = await scenario()
    await s.ask('Trip brief: Kyoto', { label: 'brief' }, answer('Noted.', 10, 20))
    await s.t.advance(30)
    await s.ask('Suggest neighborhoods', { label: 'neighborhoods', placement: s.on('brief') }, answer('Gion.', 100, 400))
    await s.ask('Suggest activities', { label: 'activities', placement: s.onHeadOf('brief') }, [say(50, 'Museums'), fail(80, 'invalid-request')])
    await s.t.advance(100)
    const snapshotOfRecords = () => clone(Object.fromEntries(Object.values(s.state().attempts).map((a) => [a.id, a.context])))
    const before = snapshotOfRecords()
    // What the model received is exactly the record.
    for (const event of startedOf(await s.events())) {
      const request = s.t.model.requests.find((r) => JSON.stringify(r.messages) === JSON.stringify(event.context.messages.map((m) => ({ role: m.role, content: m.content }))))
      expect(request, `request for ${event.attemptId}`).toBeDefined()
      expect(request?.model).toBe(event.model)
    }
    // A retry, a completion and a join-back later, the records are unchanged.
    await s.t.send({ type: 'retry', conversationId: s.c, target: { kind: 'section', sectionId: s.d('activities').sectionId ?? ('' as never) } })
    await s.t.advance(500)
    expect(Object.values(s.state().groups)[0]?.state).toBe('closed')
    const after = snapshotOfRecords()
    for (const [id, context] of Object.entries(before)) expect(after[id]).toEqual(context)
    // The retry starts clean: it never reads the earlier attempt's partial text.
    const retry = s.state().attempts[s.d('activities').attemptIds[1] ?? '']
    expect(retry?.context.messages.some((m) => m.content.includes('Museums'))).toBe(false)
    for (const event of startedOf(await s.events())) {
      const inspected = await s.t.backend.snapshot({ kind: 'run', conversationId: s.c, directiveId: event.directiveId, attemptId: event.attemptId })
      expect(inspected.ok && inspected.value.input).toEqual(event.context)
    }
  })

  test('I4 · dependencies release only on success: never on streaming text, a failure or a stop', async () => {
    const s = await scenario()
    await s.ask('Recommend a neighborhood', { label: 'neighborhoods' }, [say(50, 'Gion is'), fail(300, 'invalid-request')])
    await s.ask('Expand it', { label: 'expansion', placement: s.on('neighborhoods'), prerequisites: [s.needs('neighborhoods')] })
    await s.ask('Recommend a temple', { label: 'temple' }, [say(50, 'Kinkaku-ji'), { afterMs: 10_000, event: { type: 'completed', finishReason: 'stop', usage: null } }])
    await s.ask('Expand the temple', { label: 'temple more', placement: s.on('temple'), prerequisites: [s.needs('temple')] })
    await s.t.advance(100)
    expect(s.d('expansion').state).toBe('dependency-queued')
    await s.t.advance(300)
    expect(s.d('neighborhoods').state).toBe('failed')
    await s.t.send({ type: 'stop', conversationId: s.c, target: { kind: 'section', sectionId: s.d('temple').sectionId ?? ('' as never) } })
    expect(s.d('temple').state).toBe('stopped')
    await s.t.advance(20_000)
    expect(s.d('expansion').state).toBe('dependency-queued')
    expect(s.d('temple more').state).toBe('dependency-queued')
    expect(s.d('expansion').attemptIds).toHaveLength(0)
    expect(s.d('temple more').attemptIds).toHaveLength(0)
  })

  test('I6 · user messages in submission order, split messages in topological order, a reply fixed at first visible output where a failure notice counts', async () => {
    const s = await scenario()
    const text = 'Make an itinerary from the two lists below. List museums. List parks.'
    s.t.router.when(text, (input) => {
      const museums = input.ids.next('directive')
      const parks = input.ids.next('directive')
      return sequential(input, [
        { directiveId: museums, label: 'museums', spans: spanOf(text, 'List museums.') },
        { directiveId: parks, label: 'parks', spans: spanOf(text, 'List parks.') },
        {
          label: 'itinerary',
          spans: spanOf(text, 'Make an itinerary from the two lists below.'),
          placement: { kind: 'continue', buildsOn: { kind: 'directive', directiveId: parks } },
          prerequisites: [
            { kind: 'directive', directiveId: museums },
            { kind: 'directive', directiveId: parks },
          ],
        },
      ])
    })
    s.t.model.script('List museums', answer('MOMAK.', 400, 450))
    s.t.model.script('List parks', [fail(100, 'invalid-request')])
    await s.t.submit(s.c, text)
    await s.ask('Unrelated question', { label: 'unrelated' }, answer('Sure.', 200, 250))
    await s.t.advance(500)
    const snap = await s.snap()
    const items = snap.transcript.order.map((r) =>
      r.kind === 'message' ? `msg:${snap.transcript.messages[r.id]?.text}` : `rsp:${snap.transcript.messages[snap.transcript.responses[r.id]?.messageId ?? '']?.text}`,
    )
    expect(items).toEqual([
      'msg:List museums.',
      'msg:List parks.',
      'msg:Make an itinerary from the two lists below.',
      'msg:Unrelated question',
      // The parks failure notice came first, then the unrelated answer, then the museums text.
      'rsp:List parks.',
      'rsp:Unrelated question',
      'rsp:List museums.',
      'rsp:Make an itinerary from the two lists below.',
    ])
    const placed = (await s.events()).filter((e) => e.type === 'response-placed').map((e) => e.type === 'response-placed' && e.cause)
    expect(placed).toEqual(['failure-notice', 'first-output', 'first-output'])
  })

  test('I10 · text and read-only only: no LangChain or LangGraph, and core ports expose no tool call', async () => {
    type Fs = { readdirSync(path: string): string[]; readFileSync(path: string, encoding: 'utf8'): string; existsSync(path: string): boolean }
    const fs = (await import(['node', 'fs'].join(':'))) as Fs
    const manifests = ['package.json', ...fs.readdirSync('packages').map((p) => `packages/${p}/package.json`)].filter((p) => fs.existsSync(p))
    expect(manifests.length).toBeGreaterThan(1)
    for (const path of manifests) {
      const manifest = JSON.parse(fs.readFileSync(path, 'utf8')) as Record<string, Record<string, string> | undefined>
      const names = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap((k) => Object.keys(manifest[k] ?? {}))
      for (const name of names) expect(name, path).not.toMatch(/langchain|langgraph/i)
    }
    expectTypeOf<ModelRequest>().not.toHaveProperty('tools')
    expectTypeOf<ModelRequest>().not.toHaveProperty('toolChoice')
    expectTypeOf<ModelStreamEvent['type']>().toEqualTypeOf<'text' | 'completed' | 'failed' | 'cancelled' | 'clarification-needed'>()
  })
})

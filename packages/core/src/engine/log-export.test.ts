import { LOG_EXPORT_SCHEMA, LOG_EXPORT_VERSION, type ConversationId, type LogExportDocument, type LogExportFile } from '@committee/protocol'
import { describe, expect, test } from 'vitest'
import { answer, type TestBackend } from '../testing'
import { routingScenario, type RoutingScenario } from '../routing/acceptance/helpers'
import { buildLogExport, canonicalJson, routingDecisionIndex } from './log-export'
import { Projector, projectSnapshot, runInspection } from './projections'
import { fold } from './reducers'
import { emptyConversationState } from './state'

/**
 * The full log export ("Export full logs"): the backend serializes the
 * complete event log of a conversation with the settings in force and the
 * derived views, and never the OpenRouter key.
 */

const REAL_LOOKING_KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef'

async function exportOf(t: TestBackend, conversationId: ConversationId): Promise<LogExportFile> {
  const result = await t.backend.snapshot({ kind: 'log-export', conversationId })
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

const textOf = (file: LogExportFile): string => file.chunks.join('')
const parse = (file: LogExportFile): LogExportDocument => JSON.parse(textOf(file)) as LogExportDocument

/** A trip conversation through the real routing pipeline: a brief, a composite of two parts, a continuation. */
async function trip(): Promise<RoutingScenario> {
  const s = await routingScenario()
  await s.t.send({ type: 'change-settings', openRouterKey: { action: 'set', key: REAL_LOOKING_KEY } })
  s.t.model.script('Plan a trip to Kyoto', answer('Five days in Kyoto, noted.', 10, 20))
  await s.send('Plan a trip to Kyoto')
  await s.t.advance(50)
  const composite = 'Suggest neighborhoods and suggest rainy-day activities'
  s.t.model.script('Suggest neighborhoods', answer('Gion and Higashiyama.', 10, 30))
  s.t.model.script('suggest rainy-day activities', answer('Museums and tea houses.', 10, 40))
  await s.send(composite, { composite: 0.95, parts: [{ chain: 'Plan a trip to Kyoto' }, { chain: 'Plan a trip to Kyoto' }] }, {
    decompose: [
      { part: 'Suggest neighborhoods', label: 'neighborhoods' },
      { part: 'suggest rainy-day activities', label: 'activities' },
    ],
  })
  await s.t.advance(100)
  s.t.model.script('Make day 2 lighter', answer('Day 2: one temple, then rest.', 10, 20))
  await s.send('Make day 2 lighter', { message: { chain: 'Plan a trip to Kyoto', relation: 'addition' } })
  await s.t.advance(100)
  return s
}

describe('log export', () => {
  test('log export · contains every event of the log, in order, as stored, with the settings in force and the app events', async () => {
    const s = await trip()
    const file = await exportOf(s.t, s.c)
    const doc = parse(file)
    const stored = await s.events()
    expect(stored.length).toBeGreaterThan(20)
    expect(doc.events).toEqual(JSON.parse(JSON.stringify(stored)))
    expect(doc.events.map((e) => e.seq)).toEqual(stored.map((_, i) => i + 1))
    expect(file.eventCount).toBe(stored.length)
    expect(file.length).toBe(textOf(file).length)
    expect(doc.schema).toBe(LOG_EXPORT_SCHEMA)
    expect(doc.version).toBe(LOG_EXPORT_VERSION)
    expect(doc.conversation.id).toBe(s.c)
    expect(doc.exportedAtMs).toBe(s.t.clock.now())
    expect(doc.exportedAt).toBe(new Date(s.t.clock.now()).toISOString())
    const app = await s.t.backend.snapshot({ kind: 'app' })
    expect(app.ok && doc.settings).toEqual(app.ok && app.value.settings)
    expect(doc.keyConfigured).toBe(true)
    expect(doc.appEvents.map((e) => e.type)).toContain('conversation-created')
    expect(doc.appEvents.every((e) => !('conversationId' in e) || e.conversationId === s.c)).toBe(true)
    // The routing records are in the events as decided: questions, answers and the plan.
    expect(doc.events.filter((e) => e.type === 'routing-decided')).toHaveLength(3)
    expect(doc.events.some((e) => e.type === 'message-decomposed')).toBe(true)
    expect(file.filename).toMatch(new RegExp(`^committee-log-${s.c}-\\d{8}-\\d{6}\\.json$`))
  })

  test('log export · round-trips: replaying the exported events gives the live state, projections and run inspections', async () => {
    const s = await trip()
    const doc = parse(await exportOf(s.t, s.c))
    const replayed = fold(emptyConversationState(s.c), doc.events)
    expect(replayed).toEqual(s.state())
    const live = await s.t.snapshot(s.c)
    expect(projectSnapshot(new Projector(), replayed)).toEqual(live)
    expect(doc.derived.projections).toEqual(JSON.parse(JSON.stringify(live)))
    expect(doc.derived.throughSeq).toBe(live.throughSeq)
    expect(doc.derived.runs.map((r) => r.directiveId)).toEqual(s.state().directiveOrder)
    for (const run of doc.derived.runs) {
      const result = await s.t.backend.snapshot({ kind: 'run', conversationId: s.c, directiveId: run.directiveId, attemptId: null })
      if (!result.ok) throw new Error(result.error.message)
      const { input, ...rest } = result.value
      const { input: _exportedInput, ...exported } = run
      expect(exported).toEqual(JSON.parse(JSON.stringify(rest)))
      // The input's messages are on the attempt-started event the run points at.
      const at = run.input?.inputMessagesAt
      expect(at?.type).toBe('attempt-started')
      const started = at ? doc.events[at.seq - 1] : undefined
      expect(started?.type === 'attempt-started' && started.context.messages).toEqual(JSON.parse(JSON.stringify(input?.messages)))
      expect(runInspection(replayed, run.directiveId, null)).toEqual(result.value)
    }
  })

  test('log export · the routing decisions index points at every routing and run decision of each message', async () => {
    const s = await trip()
    const doc = parse(await exportOf(s.t, s.c))
    const index = doc.derived.routingDecisions
    expect(index.map((e) => e.text)).toEqual(['Plan a trip to Kyoto', 'Suggest neighborhoods and suggest rainy-day activities', 'Make day 2 lighter'])
    const composite = index[1]
    if (!composite) throw new Error('no entry')
    const types = composite.events.map((ref) => ref.type)
    for (const type of ['message-submitted', 'routing-decided', 'message-decomposed', 'directive-created', 'attempt-started', 'attempt-completed']) expect(types).toContain(type)
    expect(types).not.toContain('attempt-output')
    for (const ref of composite.events) expect(doc.events[ref.seq - 1]?.type).toBe(ref.type)
    expect(composite.routingInForce && doc.events[composite.routingInForce.seq - 1]?.type).toBe('routing-decided')
    expect(composite.directives.map((d) => d.label)).toEqual(['neighborhoods', 'activities'])
    for (const directive of composite.directives) {
      expect(directive.attempts).toHaveLength(1)
      expect(directive.attempts[0]?.ended?.type).toBe('attempt-completed')
      expect(directive.attempts[0]?.outputChunks).toBeGreaterThan(0)
    }
    // Every event but streamed text belongs to some message here.
    const attributed = new Set(index.flatMap((e) => e.events.map((ref) => ref.seq)))
    const unattributed = doc.events.filter((e) => e.type !== 'attempt-output' && !attributed.has(e.seq)).map((e) => e.type)
    expect(unattributed.filter((type) => !['chain-created', 'sibling-group-opened', 'sibling-admitted', 'join-back-formed'].includes(type))).toEqual([])
    expect(routingDecisionIndex(doc.events)).toEqual(index)
  })

  test('log export · is deterministic for the same log: the same text again, and from a backend restarted over the same stores', async () => {
    const s = await trip()
    const first = textOf(await exportOf(s.t, s.c))
    expect(textOf(await exportOf(s.t, s.c))).toBe(first)
    const restarted = await s.t.restart()
    expect(textOf(await exportOf(restarted, s.c))).toBe(first)
    // Key order does not depend on the order an object was built in.
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 0, y: undefined, type: 'x' }], c: 2 }, seq: 3 })).toBe('{"seq":3,"a":{"c":2,"d":[1,{"type":"x","z":0}]},"b":1}')
  })

  test('log export · contains neither the stored key nor an Authorization value', async () => {
    const s = await trip()
    const text = textOf(await exportOf(s.t, s.c))
    expect(text).not.toContain(REAL_LOOKING_KEY)
    expect(text).not.toContain('sk-or-')
    expect(text).not.toMatch(/authorization/i)
    expect(text).not.toMatch(/bearer\s/i)
    expect(await s.t.secretsStore.get('openrouter-key')).toBe(REAL_LOOKING_KEY)
  })

  test('log export · a log that contains the stored key fails the export loudly, and the error does not repeat the key', async () => {
    const s = await trip()
    s.t.model.script(`My key is ${REAL_LOOKING_KEY}`, answer('Please do not share keys.', 10, 20))
    await s.send(`My key is ${REAL_LOOKING_KEY}`)
    await s.t.advance(50)
    const result = await s.t.backend.snapshot({ kind: 'log-export', conversationId: s.c })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.code).toBe('internal')
    expect(JSON.stringify(result)).not.toContain(REAL_LOOKING_KEY)
    expect(!result.ok && result.error.message).toMatch(/contained the stored OpenRouter key/)
  })

  test('log export · the guard reads every chunk of a large export, and ignores secrets too short to search for', () => {
    const secret = 'SECRET-0123456789'
    const event = (seq: number, text: string) =>
      ({ id: `evt_${seq}`, log: 'cnv_x', seq, v: 1, at: 0, type: 'message-submitted', messageId: `msg_${seq}`, text, explicitTargets: [], responseId: `rsp_${seq}` }) as never
    const build = (last: string, secrets: readonly string[] = [secret]) =>
      buildLogExport({
        conversation: { id: 'cnv_x' as ConversationId, title: 't', createdAt: 0 },
        createdAt: 0,
        versions: { protocol: 1, eventSchema: 1, state: 1 },
        settings: {} as never,
        keyConfigured: true,
        appEvents: [],
        events: [event(1, 'a'.repeat(200 * 1024)), event(2, 'b'.repeat(200 * 1024)), event(3, last)],
        projections: { conversationId: 'cnv_x', throughSeq: 3 } as never,
        runs: [],
        secrets,
      })
    const clean = build('nothing to see')
    expect(clean.chunks.length).toBeGreaterThan(1)
    expect(JSON.parse(clean.chunks.join('')).events).toHaveLength(3)
    expect(() => build(`here: ${secret}`)).toThrow(/contained the stored OpenRouter key/)
    expect(build('short', ['short']).eventCount).toBe(3)
  })

  test('log export · an unknown conversation is an error', async () => {
    const s = await routingScenario()
    const result = await s.t.backend.snapshot({ kind: 'log-export', conversationId: 'cnv_missing' as ConversationId })
    expect(result).toEqual({ ok: false, error: { code: 'unknown-conversation', message: 'Unknown conversation cnv_missing' } })
  })
})

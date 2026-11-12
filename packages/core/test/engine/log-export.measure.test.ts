import { APP_LOG, type ConversationEvent, type LogExportDocument, type NodeId } from '@committee/protocol'
import { expect, test } from 'vitest'
import { MemoryEventStore, atomic, createTestBackend, done, say } from '../../testing'
import { engineModule } from '../../src/engine/engine-module'
import { fold } from '../../src/engine/reducers'
import { emptyConversationState } from '../../src/engine/state'

/**
 * Size and time of a log export for a long conversation: 2,000 answer
 * sections. Driving 2,000 messages through the test backend one by one
 * takes tens of minutes (every step projects and diffs the whole
 * conversation), so one line of {@link LINE} messages is run through the
 * engine, and its log is repeated with fresh IDs into a log of 2,000
 * sections, which a new backend then loads. Each message continues the
 * previous answer of its line, so a run's context grows to nine earlier
 * exchanges; answers are about 700 characters, streamed in several chunks.
 *
 * Prints the figures `docs/build/log-export.md` reports:
 * `LOG_EXPORT_MEASURE=1 pnpm vitest run --project unit packages/core/test/engine/log-export.measure.test.ts --silent=false`.
 */

/** What this test needs from the host; core's own types leave out the platform. */
const host = globalThis as unknown as {
  readonly performance: { now(): number }
  readonly TextEncoder: new () => { encode(text: string): Uint8Array }
  readonly console: { info(text: string): void }
  readonly process?: { readonly env: Record<string, string | undefined> }
}
const performance = host.performance
const utf8 = (text: string): number => new host.TextEncoder().encode(text).length

/** 2,000 with `LOG_EXPORT_MEASURE=1` (about 45 s, most of it the backend loading the log); 200 in the ordinary suite. */
const MEASURE = host.process?.env.LOG_EXPORT_MEASURE === '1'
const SECTIONS = MEASURE ? 2_000 : 200
const LINE = 10
const MARK = '@@'
const WORDS = ['tide', 'moon', 'honey', 'bee', 'wool', 'glacier', 'copper', 'violin', 'yeast', 'comet', 'basalt', 'heron', 'quartz', 'saffron', 'lichen', 'otter']
const ID = /\b(msg|frg|dir|att|chn|nod|jbk|sib|eli|que|opr|sec|rsp|req|evt)_([0-9A-Z]{26})\b/g
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function blockCode(block: number): string {
  let out = ''
  let n = block
  for (let i = 0; i < 4; i++) {
    out = (CROCKFORD[n % 32] ?? '0') + out
    n = Math.floor(n / 32)
  }
  return out
}

/** One line of messages through the engine; returns its stores and the conversation. */
async function oneLine() {
  const t = await createTestBackend({ modules: [engineModule] })
  const c = await t.createConversation()
  let previous: NodeId | null = null
  for (let i = 0; i < LINE; i++) {
    const text = `Entry ${MARK}-${i}: tell me about ${WORDS[i % 16] ?? ''} and ${WORDS[(i * 7 + 3) % 16] ?? ''}`
    const body = `Entry ${MARK}-${i} explains ${WORDS[(i * 5 + 1) % 16] ?? ''} and ${WORDS[(i * 11 + 2) % 16] ?? ''} for curious readers. `.repeat(8)
    const steps = []
    for (let at = 0, n = 1; at < body.length; at += 90, n++) steps.push(say(n * 30, body.slice(at, at + 90)))
    t.model.script(text, [...steps, done(steps.length * 30 + 30)])
    const buildsOn = previous
    t.router.when(text, (input) => atomic(input, { label: `entry ${i}`, ...(buildsOn ? { placement: { kind: 'continue', buildsOn: { kind: 'node', nodeId: buildsOn } } } : {}) }))
    await t.submit(c, text)
    await t.advance(1_000)
    const state = t.state(c)
    const id = state.directiveOrder[state.directiveOrder.length - 1]
    previous = id ? (state.directives[id]?.nodeId ?? null) : null
  }
  return { t, c }
}

test(`log export · a conversation of ${SECTIONS} sections exports, parses and replays; size and time are reported`, { timeout: 300_000 }, async () => {
  const { t, c } = await oneLine()
  const line = (await t.eventStore.read(c)) as unknown as ConversationEvent[]
  const template = JSON.stringify(line)
  const store = new MemoryEventStore()
  await store.append(APP_LOG, (await t.eventStore.read(APP_LOG)) as never)
  const blocks = SECTIONS / LINE
  for (let block = 0; block < blocks; block++) {
    const code = blockCode(block)
    const events = (JSON.parse(template.replaceAll(MARK, String(block)).replace(ID, (_, prefix: string, ulid: string) => `${prefix}_${code}${ulid.slice(4)}`)) as ConversationEvent[]).map(
      (event) => ({ ...event, seq: event.seq + block * line.length }),
    )
    await store.append(c, events)
  }
  const loaded = performance.now()
  const big = await createTestBackend({ modules: [engineModule], eventStore: store })
  const loadMs = performance.now() - loaded
  expect(Object.keys(big.state(c).sections)).toHaveLength(SECTIONS)

  const started = performance.now()
  const result = await big.backend.snapshot({ kind: 'log-export', conversationId: c })
  const exportMs = performance.now() - started
  if (!result.ok) throw new Error(result.error.message)
  const file = result.value
  const text = file.chunks.join('')
  const bytes = utf8(text)

  const parsedAt = performance.now()
  const doc = JSON.parse(text) as LogExportDocument
  const parseMs = performance.now() - parsedAt
  expect(doc.events).toHaveLength(file.eventCount)
  expect(fold(emptyConversationState(c), doc.events)).toEqual(big.state(c))
  expect(doc.derived.routingDecisions).toHaveLength(SECTIONS)

  const size = (part: unknown): string => `${(utf8(JSON.stringify(part)) / 1024 / 1024).toFixed(1)} MB`
  const outputs = doc.events.filter((e) => e.type === 'attempt-output').length
  const starts = doc.events.filter((e) => e.type === 'attempt-started')
  host.console.info(
    [
      `log export · ${SECTIONS} sections, ${file.eventCount} events (${outputs} attempt-output), backend loaded in ${loadMs.toFixed(0)} ms`,
      `  export ${exportMs.toFixed(0)} ms → ${(bytes / 1024 / 1024).toFixed(1)} MB in ${file.chunks.length} chunks; JSON.parse ${parseMs.toFixed(0)} ms`,
      `  events ${size(doc.events)} (attempt-started ${size(starts)}), projections ${size(doc.derived.projections)}, runs ${size(doc.derived.runs)}, index ${size(doc.derived.routingDecisions)}`,
    ].join('\n'),
  )
})

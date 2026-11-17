import { describe, expect, it } from 'vitest'
import { createBackend } from '@pluribus/core'
import { MemoryEventStore, MemoryProjectionCache, MemorySecretsStore } from '@pluribus/core/testing'
import {
  DEFAULT_SETTINGS,
  createIdFactory,
  createUlidFactory,
  type ConversationEvent,
  type ConversationId,
  type DirectiveId,
  type MessageId,
  type SectionId,
} from '@pluribus/protocol'
import { createOpenRouterDecisionProvider, createOpenRouterDecomposer, createOpenRouterModelProvider } from '@pluribus/providers'

/**
 * The spec's J request through the whole embedded backend, live: the real
 * engine, the routing pipeline with the default referent strategy, the live
 * decision model, and a cheap model for every generative role. Run with
 * `pnpm smoke`; skipped when OPENROUTER_KEY is absent. The key goes into an
 * in-memory secrets store and is read by the providers on each call.
 *
 * 04's running example: the brief, then A and B as replies to it sent back
 * to back, then J, untargeted: "Use those recommendations to make a
 * five-day itinerary." J must depend on the whole sibling group and read
 * both members (C9, C19), whether it is sent while they run or after.
 */

const key = process.env['OPENROUTER_KEY'] ?? ''
const CHEAP = 'anthropic/claude-haiku-5.5'
const BRIEF = 'I’m planning a five-day trip to Kyoto in November on a moderate budget. Just confirm in one sentence that you have that.'
const A = 'Suggest neighborhoods to stay in'
const B = 'Suggest rainy-day activities'
const J = 'Use those recommendations to make a five-day itinerary.'
const RUNS = 2

async function conversation() {
  const secretsStore = new MemorySecretsStore()
  await secretsStore.set('openrouter-key', key)
  const getKey = (): Promise<string | null> => secretsStore.get('openrouter-key')
  const backend = createBackend({
    modelProvider: createOpenRouterModelProvider({ getKey }),
    decisionProvider: createOpenRouterDecisionProvider({ getKey }),
    decomposer: createOpenRouterDecomposer({ getKey }),
    eventStore: new MemoryEventStore(),
    projectionCache: new MemoryProjectionCache(),
    secretsStore,
    clock: { now: () => Date.now() },
    timers: {
      setTimeout(callback, delayMs) {
        const handle = setTimeout(callback, Math.max(0, delayMs))
        return () => clearTimeout(handle)
      },
    },
    ids: createIdFactory(createUlidFactory(() => Date.now(), () => Math.random())),
  })
  await backend.start()
  const changed = await backend.send({ type: 'change-settings', changes: { models: { answer: CHEAP, synthesis: CHEAP, decomposition: CHEAP } } })
  if (!changed.ok) throw new Error(changed.error.message)
  const created = await backend.send({ type: 'create-conversation' })
  if (!created.ok) throw new Error(created.error.message)
  const id: ConversationId = created.output.conversation.id

  const events = async (): Promise<ConversationEvent[]> => {
    const result = await backend.snapshot({ kind: 'events', conversationId: id, afterSeq: 0 })
    if (!result.ok) throw new Error(result.error.message)
    return [...result.value.events]
  }
  const submit = async (text: string, targets: readonly SectionId[] = []): Promise<MessageId> => {
    const result = await backend.send({ type: 'submit-message', conversationId: id, text, ...(targets.length > 0 ? { targets } : {}) })
    if (!result.ok) throw new Error(result.error.message)
    return result.output.messageId
  }
  /** Polls until `found` returns something, or fails with what routing recorded. */
  const until = async <T>(what: string, found: (events: ConversationEvent[]) => T | undefined, timeoutMs = 150_000): Promise<T> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const all = await events()
      const value = found(all)
      if (value !== undefined) return value
      const failure = all.find((e) => e.type === 'routing-failed' || e.type === 'attempt-failed')
      if (failure) throw new Error(`${what}: ${failure.type}`)
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  const directiveOf = (messageId: MessageId) => (all: ConversationEvent[]) =>
    all.find((e) => e.type === 'directive-created' && e.messageId === messageId) as Extract<ConversationEvent, { type: 'directive-created' }> | undefined
  const sectionOf = (directiveId: DirectiveId) => (all: ConversationEvent[]) =>
    (all.find((e) => e.type === 'section-opened' && e.directiveId === directiveId) as Extract<ConversationEvent, { type: 'section-opened' }> | undefined)?.sectionId
  const completed = (directiveId: DirectiveId) => (all: ConversationEvent[]) => {
    const attempts = all.filter((e) => e.type === 'attempt-started' && e.directiveId === directiveId).map((e) => (e.type === 'attempt-started' ? e.attemptId : ''))
    return all.some((e) => e.type === 'attempt-completed' && attempts.includes(e.attemptId)) ? true : undefined
  }
  return { backend, events, submit, until, directiveOf, sectionOf, completed }
}

type Conversation = Awaited<ReturnType<typeof conversation>>

/** The brief answered, then A and B as explicit replies to it, back to back. */
async function trip(c: Conversation) {
  const brief = await c.until('the brief', c.directiveOf(await c.submit(BRIEF)))
  await c.until('the brief’s answer', c.completed(brief.directiveId))
  const briefSection = await c.until('the brief’s section', c.sectionOf(brief.directiveId))
  const aMessage = await c.submit(A, [briefSection])
  const bMessage = await c.submit(B, [briefSection])
  const a = await c.until('A', c.directiveOf(aMessage))
  const b = await c.until('B', c.directiveOf(bMessage))
  return { brief, a, b }
}

async function checkJ(c: Conversation, t: Awaited<ReturnType<typeof trip>>, jMessage: MessageId): Promise<string[]> {
  const problems: string[] = []
  const outcome = await c.until('J’s routing', (all) => all.find((e) => (e.type === 'routing-decided' && e.messageId === jMessage) || (e.type === 'elicitation-raised' && 'messageId' in e && e.messageId === jMessage)))
  if (outcome.type !== 'routing-decided') return [`J was not routed: ${outcome.type}`]
  const j = await c.until('J', c.directiveOf(jMessage))
  const aSection = await c.until('A’s section', c.sectionOf(t.a.directiveId))
  const bSection = await c.until('B’s section', c.sectionOf(t.b.directiveId))
  if (!(j.targets.includes(aSection) && j.targets.includes(bSection) && j.targets.length === 2)) problems.push(`targets ${j.targets.length}, both siblings ${String(j.targets.includes(aSection) && j.targets.includes(bSection))}`)
  await c.until('J’s answer', c.completed(j.directiveId))
  const all = await c.events()
  const started = all.find((e) => e.type === 'attempt-started' && e.directiveId === j.directiveId)
  const inputs = started?.type === 'attempt-started' ? started.context.inputs.map((i) => i.directiveId) : []
  if (!(inputs.includes(t.a.directiveId) && inputs.includes(t.b.directiveId))) problems.push('J did not read both members')
  const chain = all.find((e) => e.type === 'chain-created' && started?.type === 'attempt-started' && e.chainId === started.chainId)
  if (chain?.type === 'chain-created' && chain.kind === 'join') problems.push('J is on a join chain')
  if (j.chainId !== t.brief.chainId) problems.push('J is not on the chain the siblings forked from')
  // J never started before both members had finished.
  const startedSeq = started?.seq ?? 0
  for (const member of [t.a, t.b]) {
    const attempts = all.filter((e) => e.type === 'attempt-started' && e.directiveId === member.directiveId).map((e) => (e.type === 'attempt-started' ? e.attemptId : ''))
    const done = all.find((e) => e.type === 'attempt-completed' && attempts.includes(e.attemptId))
    if (!done || done.seq > startedSeq) problems.push('J started before a member had finished')
  }
  return problems
}

describe.skipIf(key === '')('the J request through the backend, live', () => {
  it(`the default strategy is the one under test`, () => {
    expect(DEFAULT_SETTINGS.routing.referentStrategy).toBe('tree-walk')
  })

  it(`J sent while A and B are running waits for the whole group and reads both, ${RUNS} runs`, { timeout: 600_000 }, async () => {
    const failures: string[] = []
    for (let run = 0; run < RUNS; run++) {
      const c = await conversation()
      const t = await trip(c)
      const problems = await checkJ(c, t, await c.submit(J))
      const all = await c.events()
      const j = all.find((e) => e.type === 'directive-created' && e.instruction === J)
      if (j?.type === 'directive-created' && !j.prerequisites.some((p) => p.kind === 'sibling-group')) problems.push(`prerequisites ${JSON.stringify(j.prerequisites.map((p) => p.kind))}`)
      if (problems.length > 0) failures.push(`run ${run + 1}: ${problems.join('; ')}`)
      await c.backend.dispose()
    }
    console.log(`J while A and B run: ${RUNS - failures.length}/${RUNS}${failures.length > 0 ? `\n${failures.join('\n')}` : ''}`)
    expect(failures).toEqual([])
  })

  it(`J sent after A and B finished continues from their join-back and reads both, ${RUNS} runs`, { timeout: 600_000 }, async () => {
    const failures: string[] = []
    for (let run = 0; run < RUNS; run++) {
      const c = await conversation()
      const t = await trip(c)
      await c.until('A’s answer', c.completed(t.a.directiveId))
      await c.until('B’s answer', c.completed(t.b.directiveId))
      await c.until('the join-back', (all) => all.find((e) => e.type === 'join-back-formed'))
      const problems = await checkJ(c, t, await c.submit(J))
      if (problems.length > 0) failures.push(`run ${run + 1}: ${problems.join('; ')}`)
      await c.backend.dispose()
    }
    console.log(`J after the join-back: ${RUNS - failures.length}/${RUNS}${failures.length > 0 ? `\n${failures.join('\n')}` : ''}`)
    expect(failures).toEqual([])
  })
})

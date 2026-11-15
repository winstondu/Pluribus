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
  type NodeId,
  type SectionId,
} from '@pluribus/protocol'
import { createOpenRouterDecisionProvider, createOpenRouterDecomposer, createOpenRouterModelProvider, createOpenRouterPreparer } from '@pluribus/providers'

/**
 * Joining instead of asking (05 · "Joining instead of asking", T4) through
 * the whole embedded backend, live: the real engine, the routing pipeline
 * with the default settings, the live decision model, and a cheap model for
 * every generative role. Run with `pnpm smoke`; skipped when OPENROUTER_KEY
 * is absent.
 *
 * The scene is the conversation exported on 2026-11-12 (cnv_01M78JH4…),
 * whose build asked which answer "Tell me about the ocean and sky in kyoto"
 * meant: a line about Kyoto, and a line about the sky with a follow-up about
 * the ocean. The messages are sent as the user typed them, each after the
 * previous answer finished. The fourth must join the lines without asking,
 * on a join chain over each line's leaf, run by the synthesis role.
 *
 * Each run prints the scores the join was decided on (`m_lines` and the
 * sections), so the margin over `joinChoice` is visible on every smoke run.
 */

const key = process.env['OPENROUTER_KEY'] ?? ''
const CHEAP = 'anthropic/claude-haiku-5.5'
const KYOTO = 'Tell me about kyoto'
const SKY = 'why is hte sky blue?'
const OCEAN = 'And does the ocean reflect the sky?'
const BOTH = 'Tell me about the ocean and sky in kyoto'
/** A follow-up that means one answer: never a join (05 · "Make that shorter" is still a question). */
const ONE = 'Make that shorter'
const RUNS = 3

type Of<T extends ConversationEvent['type']> = Extract<ConversationEvent, { type: T }>

async function conversation() {
  const secretsStore = new MemorySecretsStore()
  await secretsStore.set('openrouter-key', key)
  const getKey = (): Promise<string | null> => secretsStore.get('openrouter-key')
  const backend = createBackend({
    modelProvider: createOpenRouterModelProvider({ getKey }),
    preparer: createOpenRouterPreparer({ getKey }),
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
  const submit = async (text: string): Promise<MessageId> => {
    const result = await backend.send({ type: 'submit-message', conversationId: id, text })
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
  /** How routing settled a message: placed (`routing-decided`) or put to the user (`elicitation-raised`). */
  const outcomeOf = (messageId: MessageId) => (all: ConversationEvent[]) =>
    all.find(
      (e): e is Of<'routing-decided'> | Of<'elicitation-raised'> =>
        (e.type === 'routing-decided' && e.messageId === messageId) || (e.type === 'elicitation-raised' && e.elicitation.kind === 'target-ambiguity' && e.elicitation.messageId === messageId),
    )
  const directiveOf = (messageId: MessageId) => (all: ConversationEvent[]) =>
    all.find((e): e is Of<'directive-created'> => e.type === 'directive-created' && e.messageId === messageId)
  const sectionOf = (directiveId: DirectiveId) => (all: ConversationEvent[]) =>
    all.find((e): e is Of<'section-opened'> => e.type === 'section-opened' && e.directiveId === directiveId)?.sectionId
  const completed = (directiveId: DirectiveId) => (all: ConversationEvent[]) => {
    const attempts = all.filter((e): e is Of<'attempt-started'> => e.type === 'attempt-started' && e.directiveId === directiveId).map((e) => e.attemptId)
    return all.some((e) => e.type === 'attempt-completed' && attempts.includes(e.attemptId)) ? true : undefined
  }
  /** Sends a message and waits for its answer to finish; it must be placed, not asked about. */
  const answered = async (text: string): Promise<{ directive: Of<'directive-created'>; sectionId: SectionId }> => {
    const messageId = await submit(text)
    const outcome = await until(`routing of "${text}"`, outcomeOf(messageId))
    if (outcome.type !== 'routing-decided') throw new Error(`"${text}" was put to the user`)
    const directive = await until(`"${text}"`, directiveOf(messageId))
    await until(`the answer to "${text}"`, completed(directive.directiveId))
    return { directive, sectionId: await until(`the section of "${text}"`, sectionOf(directive.directiveId)) }
  }
  return { backend, events, submit, until, outcomeOf, directiveOf, completed, answered }
}

type Conversation = Awaited<ReturnType<typeof conversation>>

/** The three answers of the export, on two lines when routing continues the sky line as it did there. */
async function scene(c: Conversation) {
  const kyoto = await c.answered(KYOTO)
  const sky = await c.answered(SKY)
  const ocean = await c.answered(OCEAN)
  const nodeOf = (d: Of<'directive-created'>): NodeId => d.nodeId
  // Each line contributes its leaf: the ocean answer when it continues the sky line, as in the export; otherwise the sky answer is a line of its own.
  const oceanOnSky = ocean.directive.chainId === sky.directive.chainId
  const leaves = oceanOnSky ? [nodeOf(kyoto.directive), nodeOf(ocean.directive)] : [nodeOf(kyoto.directive), nodeOf(sky.directive), nodeOf(ocean.directive)]
  return { kyoto, sky, ocean, oceanOnSky, leaves }
}

/** The scores routing decided on, by question ID, for the log line. */
function scores(decision: Of<'routing-decided'>['decision'] | undefined): string {
  if (!decision) return 'no decision recorded'
  const wanted = (id: string): boolean => id === 'm_lines' || id === 'm_several' || /^m_s\d+$/.test(id)
  return decision.questions
    .filter((q) => wanted(q.id))
    .map((q) => `${q.id} ${typeof q.answer === 'number' ? q.answer.toFixed(2) : String(q.answer)}`)
    .join(', ')
}

describe.skipIf(key === '')('joining instead of asking, live: the exported Kyoto, sky and ocean conversation', () => {
  it('the default settings are the ones under test: joining is on', () => {
    expect(DEFAULT_SETTINGS.thresholds.joinChoice).toBe(0.8)
    expect(DEFAULT_SETTINGS.routing.strategySelection).toBe('rules')
  })

  it(`T4 · "${BOTH}" joins the lines on a join chain, the user is not asked, ${RUNS} runs`, { timeout: 900_000 }, async () => {
    const failures: string[] = []
    const lines: string[] = []
    for (let run = 0; run < RUNS; run++) {
      const c = await conversation()
      const problems: string[] = []
      try {
        const s = await scene(c)
        const messageId = await c.submit(BOTH)
        const outcome = await c.until('the routing of the join', c.outcomeOf(messageId))
        if (outcome.type !== 'routing-decided') {
          lines.push(`run ${run + 1}: asked; ${scores(outcome.decision)}`)
          failures.push(`run ${run + 1}: the user was asked which answer is meant`)
          continue
        }
        lines.push(`run ${run + 1}: ${s.oceanOnSky ? 'two lines' : 'three lines'}; ${scores(outcome.decision)}; joined ${outcome.decision.joinedLines?.map((j) => j.confidence.toFixed(2)).join(', ') ?? 'no'}`)
        const directive = await c.until('the join', c.directiveOf(messageId))
        if (!(directive.targets.includes(s.kyoto.sectionId) && directive.targets.includes(s.ocean.sectionId))) problems.push(`targets miss Kyoto or the ocean (${directive.targets.length} targets)`)
        if (!outcome.decision.joinedLines?.length) problems.push('the decision does not record joinedLines')
        await c.until('the join’s answer', c.completed(directive.directiveId))
        const all = await c.events()
        const chain = all.find((e): e is Of<'chain-created'> => e.type === 'chain-created' && e.chainId === directive.chainId)
        if (chain?.kind !== 'join') problems.push(`placed on a ${chain?.kind ?? 'existing'} chain, not a join chain`)
        const node = all.find((e): e is Of<'node-created'> => e.type === 'node-created' && e.nodeId === directive.nodeId)
        const parents = (node?.plannedParents ?? []).flatMap((p) => (p.kind === 'node' ? [p.nodeId] : []))
        if (!(parents.length === s.leaves.length && s.leaves.every((leaf) => parents.includes(leaf)))) problems.push(`parents are not each line's leaf (${parents.length} of ${s.leaves.length})`)
        const started = all.find((e): e is Of<'attempt-started'> => e.type === 'attempt-started' && e.directiveId === directive.directiveId)
        if (started?.modelRole !== 'synthesis') problems.push(`run by the ${started?.modelRole ?? 'missing'} role, not synthesis`)
        if (all.some((e) => e.type === 'elicitation-raised')) problems.push('an elicitation was raised')
      } finally {
        await c.backend.dispose()
      }
      if (problems.length > 0) failures.push(`run ${run + 1}: ${problems.join('; ')}`)
    }
    console.log(`Join instead of asking: ${RUNS - failures.length}/${RUNS}\n${lines.join('\n')}${failures.length > 0 ? `\n${failures.join('\n')}` : ''}`)
    expect(failures).toEqual([])
  })

  it(`"${ONE}" in the same scene is never joined: it is asked about or has one target`, { timeout: 600_000 }, async () => {
    const c = await conversation()
    try {
      await scene(c)
      const messageId = await c.submit(ONE)
      const outcome = await c.until('the routing of the control', c.outcomeOf(messageId))
      if (outcome.type === 'elicitation-raised') {
        console.log(`"${ONE}": asked; ${scores(outcome.decision)}`)
        return
      }
      console.log(`"${ONE}": placed; ${scores(outcome.decision)}`)
      expect(outcome.decision.joinedLines ?? []).toEqual([])
      const directive = await c.until('the control', c.directiveOf(messageId))
      const all = await c.events()
      expect(all.find((e) => e.type === 'chain-created' && e.chainId === directive.chainId && e.kind === 'join')).toBeUndefined()
    } finally {
      await c.backend.dispose()
    }
  })
})

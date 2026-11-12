import type { AttemptStarted, SettingsPatch } from '@committee/protocol'
import { describe, expect, test } from 'vitest'
import { contextChainOf, fullChainContextProvider, noContextSummariser } from '../../../src/engine'
import type { ContextSummariser, ContextSummaryProvider, DecisionContext, SummariseRequest } from '../../../src/ports'
import { answer } from '../../../testing'
import { routingScenario, type RoutingScenario } from '../../../testing/acceptance/routing'

/**
 * Context summaries for decisioning (docs/build/context-summaries.md): the
 * port, the provider the backend uses until summaries exist, and the two
 * settings, on a real backend. A run's consumed context is never touched.
 */

const BRIEF = 'Trip brief: Kyoto, five days, November'
const A = 'Suggest neighborhoods to stay in'
const B = 'Suggest rainy-day activities'
const J = 'Use those recommendations to make a five-day itinerary.'

async function trip(overrides: Parameters<typeof routingScenario>[0] = {}): Promise<RoutingScenario> {
  const s = await routingScenario(overrides)
  s.t.model.script(BRIEF, answer('Noted.', 10, 20))
  await s.send(BRIEF)
  await s.t.advance(50)
  s.t.model.script(A, answer('Gion and Higashiyama.', 20, 100))
  s.t.model.script(B, answer('Museums and tea houses.', 20, 100))
  await s.send(A, { message: { relation: 'addition' } }, { replyTo: [BRIEF] })
  await s.send(B, { message: { relation: 'addition' } }, { replyTo: [BRIEF] })
  await s.t.advance(500)
  return s
}

const title = (s: RoutingScenario, label: string): string => s.state().sections[s.d(label).sectionId ?? '']?.title ?? ''

async function sendJ(s: RoutingScenario): Promise<void> {
  s.t.model.script(J, answer('Day 1: Gion.', 10, 20))
  await s.send(J, {
    message: { relation: 'addition', several: 0.4, targets: { [title(s, BRIEF)]: 0.5, [title(s, A)]: 0.77, [title(s, B)]: 0.3 }, together: { [title(s, A)]: 0.86 } },
  })
  await s.t.advance(100)
}

const j = (s: RoutingScenario) => s.d('Use those recommendations to make a…')
const on: SettingsPatch = { routing: { useSummaryIfAvailable: true } }

describe('context summaries', () => {
  test('summaries · the provider the backend uses returns exactly the context chain the engine assembles for a run that continues from the node', async () => {
    const s = await trip()
    await sendJ(s)
    const run = s.state().attempts[j(s).attemptIds[0] ?? '']
    const parent = s.state().nodes[j(s).nodeId]?.startedParents?.[0]
    if (!run || !parent) throw new Error('J did not run')
    const chain = contextChainOf(s.state(), parent)
    // What J consumed, without its own request (the last message), is the chain of the node it continued from.
    expect(chain.messages).toEqual(run.context.messages.slice(0, -1))
    expect(run.context.messages.at(-1)?.origin.kind).toBe('request')
    expect(chain.nodeIds).toEqual(run.context.nodeIds)
    const shown = fullChainContextProvider.contextFor({ nodeId: parent, chain: () => chain })
    expect(shown).toEqual({ kind: 'full-chain', nodeId: parent, chain })
    // A node's chain ends with its own exchange; a root's begins with the preamble.
    const brief = contextChainOf(s.state(), s.d(BRIEF).nodeId)
    expect(brief.messages.map((m) => m.origin.kind)).toEqual(['preamble', 'ancestor-request', 'ancestor-answer'])
    expect(await noContextSummariser.consider({ conversationId: s.c, nodeId: parent, directiveId: null, reason: 'idle', chain: () => chain })).toEqual({
      kind: 'skipped',
      reason: 'Summaries are not generated yet.',
    })
  })

  test('summaries · with that provider, useSummaryIfAvailable changes no routing outcome and no consumed context (C19 holds either way)', async () => {
    const outcomes: unknown[] = []
    for (const settings of [undefined, on]) {
      const s = await trip(settings ? { settings } : {})
      await sendJ(s)
      const work = j(s)
      const joinBack = Object.values(s.state().joinBacks)[0]
      expect(s.state().nodes[work.nodeId]?.startedParents).toEqual([joinBack?.nodeId])
      const started = (await s.events()).filter((e): e is AttemptStarted => e.type === 'attempt-started')
      outcomes.push({
        targets: work.targets.map((id) => s.state().sections[id]?.title),
        chain: s.state().chains[work.chainId]?.kind,
        prerequisites: work.prerequisites.length,
        consumed: started.map((e) => e.context.messages.map((m) => m.content)),
        decisions: s.t.decisions.requests.map((r) => ({ state: r.state, questions: Object.keys(r.questions) })),
      })
    }
    expect(outcomes[1]).toEqual(outcomes[0])
  })

  test('DA5 · with context summaries in use, a run receives the recorded exchanges and never a summary; summaries are used only for search and decisions', async () => {
    // A scripted summary provider: every node that has a context gets the same summary, anchored at the brief.
    const asked: { nodeId: string; chain: number }[] = []
    const provider: ContextSummaryProvider = {
      contextFor(request): DecisionContext | null {
        const chain = request.chain()
        asked.push({ nodeId: request.nodeId, chain: chain.messages.length })
        const anchor = chain.nodeIds[0]
        if (!anchor) return null
        return {
          kind: 'summary',
          nodeId: request.nodeId,
          summary: { anchorNodeId: anchor, text: 'A trip to Kyoto is being planned.', tokens: 8, provenance: { summaryId: 'sum_test', model: 'scripted', coveredNodeIds: [anchor], recordedSeq: 0 } },
          own: chain.messages.slice(3),
        }
      },
    }
    const off = await trip({ contextSummaryProvider: provider })
    await sendJ(off)
    expect(asked).toEqual([])

    const s = await trip({ contextSummaryProvider: provider, settings: on })
    await sendJ(s)
    expect(new Set(asked.map((a) => a.nodeId))).toEqual(new Set([s.d(BRIEF).nodeId, s.d(A).nodeId, s.d(B).nodeId]))
    // The decision model was shown the summary and the content specific to each section.
    const state = s.t.decisions.requests.at(-1)?.state ?? ''
    expect(state).toContain('the work before it, summarised: "A trip to Kyoto is being planned."; after that: request "Suggest neighborhoods to stay in"; answer "Gion and Higashiyama."')
    // The run itself read the recorded exchanges, never the summary (04 · "Context for a run", invariants 2 and 12).
    const run = s.state().attempts[j(s).attemptIds[0] ?? '']
    expect(run?.context.messages.some((m) => m.content.includes('A trip to Kyoto is being planned.'))).toBe(false)
    expect(run?.context.messages.map((m) => m.content)).toEqual(expect.arrayContaining([BRIEF, 'Noted.', A, 'Gion and Higashiyama.', B, 'Museums and tea houses.', J]))
    // The same for a run started while summaries are in use and shown for the section it continues: a reply to the itinerary.
    const before = s.t.decisions.requests.length
    const SHORTER = 'Make the itinerary shorter'
    s.t.model.script(SHORTER, answer('Day 1: Gion, briefly.', 10, 20))
    await s.send(SHORTER, { message: { relation: 'addition', targets: { [title(s, 'Use those recommendations to make a…')]: 0.9 } } })
    await s.t.advance(100)
    expect(s.t.decisions.requests.slice(before).some((r) => r.state.includes('the work before it, summarised: "A trip to Kyoto is being planned."'))).toBe(true)
    // No attempt of the conversation was given the summary, in what it consumed or in what the event log records of it.
    const started = (await s.events()).filter((e): e is AttemptStarted => e.type === 'attempt-started')
    expect(started).toHaveLength(5)
    for (const e of started) expect(e.context.messages.every((m) => !m.content.includes('A trip to Kyoto is being planned.'))).toBe(true)
    expect(started.at(-1)?.context.messages.map((m) => m.content)).toEqual(expect.arrayContaining([BRIEF, A, 'Gion and Higashiyama.', B, 'Museums and tea houses.', J, 'Day 1: Gion.', SHORTER]))
    expect(JSON.stringify(await s.events())).not.toContain('A trip to Kyoto is being planned.')
  })

  test('summaries · backgroundSummaries offers each completed run to the summariser with its node and chain, and only while it is on', async () => {
    const offered: SummariseRequest[] = []
    const summariser: ContextSummariser = {
      async consider(request) {
        offered.push(request)
        return { kind: 'skipped', reason: 'test' }
      },
    }
    const quiet = await trip({ contextSummariser: summariser })
    expect(offered).toEqual([])
    expect(quiet.state().directiveOrder).toHaveLength(3)

    const s = await trip({ contextSummariser: summariser, settings: { routing: { backgroundSummaries: true } } })
    expect(offered.map((r) => r.reason)).toEqual(['run-completed', 'run-completed', 'run-completed'])
    expect(new Set(offered.map((r) => r.nodeId))).toEqual(new Set([s.d(BRIEF).nodeId, s.d(A).nodeId, s.d(B).nodeId]))
    const first = offered.find((r) => r.nodeId === s.d(BRIEF).nodeId)
    expect(first?.directiveId).toBe(s.d(BRIEF).id)
    expect(first?.chain().messages.at(-1)?.content).toBe('Noted.')
    // Nothing is recorded for it yet: the log holds no event the summariser caused.
    expect((await s.events()).some((e) => /summary/i.test(e.type))).toBe(false)
  })
})

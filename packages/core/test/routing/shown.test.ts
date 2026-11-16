import { DEFAULT_SETTINGS, renderShownLine, type AttemptId, type RoutingDecision, type RoutingSettings } from '@pluribus/protocol'
import { describe, expect, test } from 'vitest'
import { emptyConversationState, fold, runInspection } from '../../src/engine'
import { NEVER_CANCELLED, type DecisionContext, type DecisionProvider, type DecisionQuestions, type DecisionRequest, type DecisionResult, type RoutingInput } from '../../src/ports'
import { answer } from '../../testing'
import { answerFrom, routingScenario } from '../../testing/acceptance/routing'
import { corpusInput, oracleDecisionProvider, referenceDecomposer } from '../../testing/routing/corpus/evaluate'
import { ROUTING_CORPUS } from '../../testing'
import { ids, scene } from '../../testing/routing/corpus/scene'
import type { CorpusExample } from '../../testing/routing/corpus/types'
import { createRouter } from '../../src/routing/pipeline'
import { estimateRequestTokens } from '../../src/routing/referents'
import { chooseShown, createShowing, passagesOf, rankPassages, shownWords } from '../../src/routing/shown'

/**
 * What a question about a section by itself shows of its answer
 * (docs/build/dependency-decisioning.md · "What a Point shows"): the whole
 * answer when the request fits, the opening and the passages that match the
 * message when it does not, the opening alone when nothing more fits, and a
 * stored summary in place of the answer where there is one. Recorded with
 * the question, by reference into the attempt's text.
 */

const MESSAGE = 'What is modern Kyoto like?'

/** An answer whose opening is about something else and whose later heading is the message's subject. */
function historyAnswer(filler: number): string {
  const paragraph = (i: number): string =>
    `Period ${i}: the court, the temples and the old capital's festivals shaped the city's calendar for centuries, and the families who ran the guilds kept records of every procession.`
  const before = Array.from({ length: filler }, (_, i) => paragraph(i + 1)).join('\n\n')
  return [
    '# Kyoto history',
    '',
    'Kyoto was the imperial capital for more than a thousand years, from 794 until 1869, and the shape of its streets still follows the grid laid out for the Heian court.',
    '',
    before,
    '',
    '## Modern Kyoto',
    '',
    'Modern Kyoto is a university city of 1.4 million with a busy tech scene: Nintendo and Kyocera have their headquarters here, and the subway and buses tie the new districts to the old centre.',
    '',
    '## Further reading',
    '',
    'Histories of the Heian period and the Meiji move of the capital to Tokyo.',
  ].join('\n')
}

const CITY = 'Kyoto is a city in the Kansai region of Japan, known for its temples, gardens and wooden machiya houses. The city centre sits between the Kamo and Katsura rivers.'
const FOOD = 'Kyoto cooking is known for kaiseki, tofu, yuba and pickles. Nishiki Market is the place to taste them, and the tea houses of Uji are a short train ride away.'

function kyoto(filler = 6): CorpusExample {
  const s = scene()
  for (const [handle, label] of [['S1', 'kyoto city'], ['S2', 'kyoto food'], ['S3', 'kyoto history']] as const) s.chain(handle, 'root', label)
  s.add('S1', { chain: 'S1', on: null, label: 'kyoto city', request: 'Tell me about Kyoto the city', answerText: CITY })
  s.add('S2', { chain: 'S2', on: null, label: 'kyoto food', request: 'What is the food like in Kyoto?', answerText: FOOD })
  s.add('S3', { chain: 'S3', on: null, label: 'kyoto history', request: 'Give me the history of Kyoto', answerText: historyAnswer(filler) })
  return { id: 'kyoto', covers: ['targets'], note: 'the report', scene: s.build(), text: MESSAGE, expect: {} }
}

/** A decision model that judges a Point by what its section's line shows: yes only when the line holds "modern Kyoto". */
function readingProvider(): DecisionProvider & { readonly requests: DecisionRequest<DecisionQuestions>[] } {
  const requests: DecisionRequest<DecisionQuestions>[] = []
  return {
    requests,
    async decide<Q extends DecisionQuestions>(request: DecisionRequest<Q>): Promise<DecisionResult<Q>> {
      requests.push(request)
      const lines = request.state.split('\n')
      const answers: { [id: string]: unknown } = {}
      for (const [id, q] of Object.entries(request.questions)) {
        if (q.type === 'choice') {
          const options = Object.keys(q.options)
          const chosen = options.includes('addition') ? 'addition' : (options[0] ?? '')
          answers[id] = { type: 'choice', choice: chosen, confidence: 0.4, probabilities: Object.fromEntries(options.map((o) => [o, o === chosen ? 0.4 : 0])) }
          continue
        }
        const point = /^m_s(\d+)$/.exec(id)
        const line = point ? lines.find((l) => l.startsWith(`S${point[1]}. `)) : undefined
        answers[id] = { type: 'noul', probability: line && /modern kyoto/i.test(line) ? 0.9 : 0.1 }
      }
      return { ok: true, model: 'reading', answers: answers as never, usage: null }
    },
  }
}

const ONE_PASS: Partial<RoutingSettings> = { referentStrategy: 'one-pass', strategySelection: 'off', candidateSource: 'none' }

async function route(example: CorpusExample, routing: Partial<RoutingSettings> = ONE_PASS, change: (input: RoutingInput) => RoutingInput = (i) => i) {
  const provider = readingProvider()
  const router = createRouter({ decisionProvider: provider, decomposer: referenceDecomposer(example) })
  const input = change(corpusInput(example, { ...DEFAULT_SETTINGS, routing: { ...DEFAULT_SETTINGS.routing, ...routing } }))
  const outcome = await router.route(input, NEVER_CANCELLED)
  if (outcome.kind !== 'plan') throw new Error(`not a plan: ${outcome.kind}`)
  const gate = provider.requests[0]
  if (!gate) throw new Error('nothing was asked')
  const line = (n: number): string => gate.state.split('\n').find((l) => l.startsWith(`S${n}. `)) ?? ''
  const question = (id: string) => outcome.plan.decision.questions.find((q) => q.id === id)
  const tokens = provider.requests.reduce((sum, r) => sum + estimateRequestTokens(r.state, r.questions), 0)
  return { decision: outcome.plan.decision, requests: provider.requests, gate, line, question, tokens }
}

const withoutAnswers = (input: RoutingInput): RoutingInput => {
  const { answerText: _dropped, ...rest } = input
  return rest
}
const absolute = (inputTokens: number): Partial<RoutingSettings> => ({ ...ONE_PASS, tokenBudget: { mode: 'absolute', inputTokens } })
/** The recorded line a question showed, with answer text copied: the corpus has no attempts to point at. */
const recorded = (decision: RoutingDecision, id: string): { form: string; text: string } | null => {
  const shown = decision.questions.find((q) => q.id === id)?.shown?.[0]
  return shown ? { form: shown.form, text: renderShownLine(shown.line, () => '') } : null
}

describe('what a Point shows of its answer', () => {
  test('shown · the report: a later heading of the third answer is about the message, and only the whole answer lets the decision model see it', async () => {
    // As before: every section by its opening. The heading about modern Kyoto is beyond it, so the question about S3 is answered no.
    const before = await route(kyoto(), ONE_PASS, withoutAnswers)
    expect(before.line(3)).toContain('"kyoto history"')
    expect(before.line(3)).not.toMatch(/modern kyoto/i)
    expect(before.question('m_s3')?.answer).toBe(0.1)
    expect(recorded(before.decision, 'm_s3')?.form).toBe('opening')

    // Now: the section asked about by itself is shown whole, the heading with it.
    const after = await route(kyoto())
    expect(after.line(3)).toContain('## Modern Kyoto Modern Kyoto is a university city')
    expect(after.question('m_s3')?.answer).toBe(0.9)
    expect(after.question('m_s1')?.answer).toBe(0.1)
    // The question header is unchanged; what was shown is recorded beside it, exactly as sent.
    expect(after.question('m_s3')?.instructions).toBe(before.question('m_s3')?.instructions)
    expect(recorded(after.decision, 'm_s3')).toEqual({ form: 'full', text: after.line(3) })
    expect(after.decision.shownRecorded).toBe(true)
  })

  test('shown · when the request fits, every Point is shown its whole answer', async () => {
    const r = await route(kyoto())
    for (const [n, text] of [[1, CITY], [2, FOOD]] as const) {
      expect(r.line(n)).toContain(`answer "${text}"`)
      expect(recorded(r.decision, `m_s${n}`)?.form).toBe('full')
    }
    expect(r.tokens).toBeLessThanOrEqual(DEFAULT_SETTINGS.routing.tokenBudget.mode === 'relative' ? DEFAULT_SETTINGS.routing.tokenBudget.floor : Infinity)
  })

  test('shown · when it does not fit, the opening and the passages that match the message, chosen the same way every time; no section is dropped and the budget holds', async () => {
    const long = kyoto(80)
    const whole = await route(long, absolute(1_000_000))
    const base = await route(long, ONE_PASS, withoutAnswers)
    const budget = Math.floor((base.tokens + whole.tokens) / 2)
    const r = await route(long, absolute(budget))
    const again = await route(long, absolute(budget))
    expect(recorded(r.decision, 'm_s3')?.form).toBe('passages')
    expect(r.line(3)).toContain('its opening and the passages that share the most words with the message')
    expect(r.line(3)).toContain('Kyoto was the imperial capital')
    expect(r.line(3)).toContain('## Modern Kyoto Modern Kyoto is a university city')
    expect(r.line(3)).not.toContain('Period 40:')
    expect(r.question('m_s3')?.answer).toBe(0.9)
    // The short answers are still whole.
    expect(recorded(r.decision, 'm_s1')?.form).toBe('full')
    expect(r.gate.state).toBe(again.gate.state)
    // Every section the request listed before is listed now.
    for (const n of [1, 2, 3]) expect(r.line(n)).not.toBe('')
    expect(r.tokens).toBeLessThanOrEqual(budget)
  })

  test('shown · the budget is a hard stop: with no room past the opening, the request is what it was', async () => {
    const long = kyoto(80)
    const base = await route(long, ONE_PASS, withoutAnswers)
    const r = await route(long, absolute(base.tokens))
    expect(r.gate.state).toBe(base.gate.state)
    expect(recorded(r.decision, 'm_s3')?.form).toBe('opening')
    // Below even that, the smallest request is still sent and still lists every first-pass section.
    const tight = await route(long, absolute(500))
    for (const n of [1, 2, 3]) expect(tight.line(n)).not.toBe('')
    expect(tight.gate.state).toBe((await route(long, absolute(500), withoutAnswers)).gate.state)
  })

  test('shown · a tree walk keeps half of what is left for its own requests', async () => {
    const long = kyoto(80)
    const budget = 6_000
    const r = await route(long, { strategySelection: 'off', candidateSource: 'none', referentStrategy: 'tree-walk', tokenBudget: { mode: 'absolute', inputTokens: budget } })
    expect(estimateRequestTokens(r.gate.state, r.gate.questions)).toBeLessThanOrEqual(budget / 2)
    expect(r.tokens).toBeLessThanOrEqual(budget)
  })

  test('shown · a stored summary takes the place of the answer and is recorded by its ID, never its text', async () => {
    const example = kyoto()
    const s3 = example.scene.candidates.sections.find((s) => s.sectionId === ids.section('S3'))
    if (!s3) throw new Error('no S3')
    const summary: DecisionContext = {
      kind: 'summary',
      nodeId: s3.nodeId,
      summary: { anchorNodeId: s3.nodeId, text: 'A history of the old capital.', tokens: 8, provenance: { summaryId: 'sum_kyoto', model: 'scripted', coveredNodeIds: [s3.nodeId], recordedSeq: 0 } },
      own: [],
    }
    const r = await route(example, { ...ONE_PASS, useSummaryIfAvailable: true }, (input) => ({ ...input, decisionContext: (nodeId) => (nodeId === s3.nodeId ? summary : null) }))
    expect(r.line(3)).toContain('summarised: "A history of the old capital."')
    expect(r.line(3)).not.toMatch(/modern kyoto/i)
    const shown = r.question('m_s3')?.shown?.[0]
    expect(shown?.form).toBe('summary')
    expect(shown?.line).toContainEqual({ kind: 'summary', summaryId: 'sum_kyoto', characters: '"A history of the old capital."'.length })
    expect(JSON.stringify(shown)).not.toContain('old capital')
    // The others are still shown whole.
    expect(recorded(r.decision, 'm_s1')?.form).toBe('full')
  })
})

describe('passages', () => {
  test('shown · a heading starts a passage and heads the paragraph after it; long blocks are cut at spaces', () => {
    const text = '# Title\n\nFirst paragraph.\n\n## Later\n\nUnder the later heading.\nStill under it.\n\n' + 'word '.repeat(400)
    const blocks = passagesOf(text)
    const shown = blocks.map((b) => text.slice(b.start, b.end))
    expect(shown[0]).toBe('# Title\n\nFirst paragraph.')
    expect(shown[1]).toBe('## Later\n\nUnder the later heading.\nStill under it.')
    expect(blocks.slice(2).every((b) => b.end - b.start <= 600)).toBe(true)
    expect(blocks.slice(2).reduce((sum, b) => sum + b.end - b.start, 0)).toBe(2000)
  })

  test('shown · passages are ranked by the message’s words, rarer words weighing more, earlier first on ties', () => {
    const text = historyAnswer(20)
    const ranked = rankPassages(text, 280, new Set(shownWords(MESSAGE)))
    const best = ranked[0]
    expect(best && text.slice(best.span.start, best.span.end)).toMatch(/^## Modern Kyoto/)
    expect(rankPassages(text, 280, new Set(shownWords(MESSAGE)))).toEqual(ranked)
    expect(rankPassages(text, 280, new Set())).toEqual([])
  })

  test('shown · the room is shared evenly: short answers whole, the long one by passages, nothing over the allowance', () => {
    const example = kyoto(80)
    const showing = createShowing({ answerOf: (s) => ({ attemptId: null, text: example.scene.answers.get(s.sectionId) ?? s.excerpt }), words: shownWords(MESSAGE) })
    const points = example.scene.candidates.sections.map((section, i) => ({ section, n: i + 1, context: null }))
    const choices = chooseShown(showing, points, 600)
    expect(points.map((p) => choices.get(p.section.sectionId)?.form)).toEqual(['full', 'full', 'passages'])
    const extra = points.reduce((sum, p) => {
      const line = (choice?: Parameters<typeof showing.line>[3]) => showing.line(p.section, p.n, null, choice)
      const length = (l: ReturnType<typeof line>) => l.pieces.map((x) => (x.kind === 'answer' ? x.source.text.slice(x.start, x.end).replace(/\s+/g, ' ').trim() : x.text)).join('').length
      return sum + length(line(choices.get(p.section.sectionId))) - length(line())
    }, 0)
    expect(extra * 0.35).toBeLessThanOrEqual(600)
    expect(chooseShown(showing, points, 0).get(ids.section('S3'))).toEqual({ form: 'opening' })
  })
})

describe('the record of what was shown', () => {
  test('shown · recorded by reference into the attempt text, it reads back exactly as sent from the log and from the projection', async () => {
    const s = await routingScenario({ settings: { routing: { referentStrategy: 'one-pass', strategySelection: 'off', candidateSource: 'none' } } })
    const long = historyAnswer(6)
    s.t.model.script('Give me the history of Kyoto', answer(long, 10, 40))
    await s.send('Give me the history of Kyoto')
    await s.t.advance(100)
    s.t.model.script(MESSAGE, answer('A modern city.', 10, 20))
    s.rules[MESSAGE] = {}
    s.t.decisions.answerWith(answerFrom(s.rules))
    await s.send(MESSAGE)
    await s.t.advance(100)

    const sent = s.t.decisions.requests.at(-1)
    const line = sent?.state.split('\n').find((l) => l.startsWith('S1. ')) ?? ''
    expect(line).toContain('## Modern Kyoto')
    const directive = s.d('What is modern Kyoto like')
    const question = s.state().messages[directive.originalMessageId]?.decision?.questions.find((q) => q.id === 'm_s1')
    // Answer text is a reference, not a copy: the long answer is in the log once, as the attempt's text.
    expect(question?.shown?.[0]?.line.some((p) => p.kind === 'answer')).toBe(true)
    expect(JSON.stringify(question?.shown)).not.toContain('university city')

    const events = await s.events()
    const replayed = fold(emptyConversationState(s.c), JSON.parse(JSON.stringify(events)))
    for (const state of [s.state(), replayed]) {
      const question = state.messages[directive.originalMessageId]?.decision?.questions.find((q) => q.id === 'm_s1')
      expect(question?.shown?.[0]?.form).toBe('full')
      expect(renderShownLine(question?.shown?.[0]?.line ?? [], (id) => state.attemptText[id] ?? '')).toBe(line)
    }
    const text = (id: AttemptId): string => replayed.attemptText[id] ?? ''
    expect(renderShownLine(question?.shown?.[0]?.line ?? [], text)).toBe(line)
  })

  test('shown · every request’s whole state is recorded, answer text by reference, and reads back exactly as sent; each question names its request', async () => {
    const s = await routingScenario({ settings: { routing: { referentStrategy: 'one-pass', strategySelection: 'off', candidateSource: 'none' } } })
    s.t.model.script('Give me the history of Kyoto', answer(historyAnswer(6), 10, 40))
    await s.send('Give me the history of Kyoto')
    await s.t.advance(100)
    s.t.model.script(MESSAGE, answer('A modern city.', 10, 20))
    s.rules[MESSAGE] = {}
    s.t.decisions.answerWith(answerFrom(s.rules))
    const before = s.t.decisions.requests.length
    await s.send(MESSAGE)
    await s.t.advance(100)

    const sent = s.t.decisions.requests.slice(before).map((r) => r.state)
    const directive = s.d('What is modern Kyoto like')
    const decision = s.state().messages[directive.originalMessageId]?.decision
    expect(decision?.requests).toHaveLength(sent.length)
    expect(decision?.questions.every((q) => q.request !== undefined && q.request < sent.length)).toBe(true)
    expect(decision?.requests?.some((r) => r.state.some((p) => p.kind === 'answer'))).toBe(true)
    expect(JSON.stringify(decision?.requests)).not.toContain('university city')
    const replayed = fold(emptyConversationState(s.c), JSON.parse(JSON.stringify(await s.events())))
    for (const state of [s.state(), replayed]) expect(runInspection(state, directive.id, null)?.routing?.requests).toEqual(sent)
  })

  test('shown · across the corpus with the tree walk, every request is recorded with the state it sent, further requests included', async () => {
    const routing = { ...DEFAULT_SETTINGS.routing, referentStrategy: 'tree-walk' as const, strategySelection: 'off' as const }
    let further = 0
    for (const example of ROUTING_CORPUS) {
      const input = corpusInput(example, { ...DEFAULT_SETTINGS, routing })
      const oracle = oracleDecisionProvider(example, input)
      const sent: string[] = []
      const provider: DecisionProvider = { decide: (request, signal) => (sent.push(request.state), oracle.decide(request, signal)) }
      const outcome = await createRouter({ decisionProvider: provider, decomposer: referenceDecomposer(example) }).route(input, NEVER_CANCELLED)
      const decision = outcome.kind === 'plan' ? outcome.plan.decision : 'decision' in outcome ? outcome.decision : null
      if (!decision || decision.source !== 'decision-model') continue
      // The corpus's sections name no attempt, so answer text is copied and renders with no attempt text.
      expect(decision.requests?.map((r) => renderShownLine(r.state, () => '')), example.id).toEqual(sent)
      expect(decision.questions.every((q) => q.request !== undefined && q.request < sent.length), example.id).toBe(true)
      if (sent.length > 1) further += 1
    }
    expect(further).toBeGreaterThan(0)
  })

  test('shown · a decision recorded before the shown text was kept projects every question as showing nothing', () => {
    const state = emptyConversationState('cnv_old' as never)
    expect(runInspection(state, 'dir_missing' as never, null)).toBeNull()
    const decision: RoutingDecision = {
      source: 'decision-model',
      model: 'm',
      composition: { value: 'atomic', confidence: 0.1 },
      units: [],
      thresholds: {},
      explanation: '',
      questions: [{ id: 'm_s1', type: 'noul', instructions: 'Does the new message refer to answer section S1?', candidates: {}, answer: 0.2, confidence: null, probabilities: null }],
    }
    expect(decision.questions.map((q) => q.shown ?? null)).toEqual([null])
  })
})

import { DEFAULT_SETTINGS, type ConversationId, type RoutingDecision, type SectionId, type Settings } from '@pluribus/protocol'
import { describe, expect, test } from 'vitest'
import { NEVER_CANCELLED, type CandidateQuery, type CandidateSection, type DecisionProvider, type DecisionQuestions, type DecisionRequest, type DecisionResult, type RoutingOutcome } from '../../../src/ports'
import { ROUTING_CORPUS } from '../../../testing/routing/corpus/examples'
import { compare, corpusInput, oracleDecisionProvider, referenceDecomposer } from '../../../testing/routing/corpus/evaluate'
import { ids as sceneIds, scene, type Scene } from '../../../testing/routing/corpus/scene'
import type { CorpusExample } from '../../../testing/routing/corpus/types'
import { AMBIGUITY_FLOOR } from '../../../src/routing/derive'
import { createRouter } from '../../../src/routing/pipeline'
import { ancestorsOf, buildTree, firstPassSectionIds, reduceToNonAncestors, startSet } from '../../../src/routing/referents'
import { numberedAnswerSections, supply } from '../../../src/routing/supply'
import { LEXICAL_MAX_CANDIDATES, LEXICAL_MIN_OF_BEST, LEXICAL_MIN_SHARE, LexicalIndex, createLexicalCandidateSource, lexicalTerms, type LexicalDocument } from '../../../src/routing/candidates/lexical'

const id = (n: number | string): SectionId => `sec_${n}` as SectionId
const doc = (n: number | string, request: string, answer = '', title = request): LexicalDocument => ({ sectionId: id(n), title, request, answer })
const ALL = { limit: 100, minShare: 0 }
const DEFAULTS = { limit: LEXICAL_MAX_CANDIDATES, minShare: LEXICAL_MIN_SHARE, minOfBest: LEXICAL_MIN_OF_BEST }

function indexOf(documents: readonly LexicalDocument[]): LexicalIndex {
  const index = new LexicalIndex()
  index.sync(documents)
  return index
}

const TRIP: readonly LexicalDocument[] = [
  doc('brief', 'Plan a five-day trip to Kyoto in November', 'Happy to. Shall I start with where to stay?'),
  doc('stay', 'Find three good neighborhoods to stay in', 'Gion for the old streets, Kawaramachi for food, the station area for price.'),
  doc('rain', 'Suggest rainy-day activities', 'The Kyoto National Museum, Nishiki Market, a tea ceremony.'),
  doc('d1', 'Plan day 1 hour by hour', 'Check in by 15:00, then Yasaka Shrine at dusk and dinner on Pontocho.'),
  doc('d2', 'Plan day 2 hour by hour', 'An early start at Kiyomizu-dera, lunch near Kodai-ji, the Philosopher’s Path.'),
  doc('d3', 'Plan day 3 hour by hour', 'The rain plan: the museum in the morning, the market for lunch, tea at four.'),
  doc('hostel', 'Find hostels around the station', 'Three well-reviewed hostels within ten minutes, each with private rooms as well as dorms.'),
]

describe('the words of a text', () => {
  test('lexical · words are lowercased, numbers are words, stop words and the words of an instruction are left out, English plurals are folded', () => {
    expect(lexicalTerms('Make the Day 2 plan less packed')).toEqual(['day', '2', 'plan', 'packed'])
    expect(lexicalTerms('Which of those hostels has private rooms?')).toEqual(['hostel', 'private', 'room'])
    expect(lexicalTerms('entries, boxes, classes, the bus and a five-day itinerary')).toEqual(['entry', 'box', 'class', 'bus', 'five', 'day', 'itinerary'])
    expect(lexicalTerms('I’m sure it doesn’t')).toEqual(['sure'])
  })

  test('lexical · a message that only names a change has no words to look up', () => {
    for (const text of ['Make that shorter', 'combine both', 'Use that one', 'Make it a bit longer please', 'Try again', 'Rewrite this one']) expect(lexicalTerms(text), text).toEqual([])
  })

  test('lexical · other languages: words split on spaces in any script, accents kept, no stop list; scripts without spaces as pairs of characters', () => {
    expect(lexicalTerms('Erkläre die Gezeiten noch einmal')).toEqual(['erkläre', 'die', 'gezeiten', 'noch', 'einmal'])
    expect(lexicalTerms('Объясни приливы')).toEqual(['объясни', 'приливы'])
    expect(lexicalTerms('café Café cafe')).toEqual(['café', 'café', 'cafe'])
    expect(lexicalTerms('京都の旅行')).toEqual(['京都', '都の', 'の旅', '旅行'])
    expect(lexicalTerms('東京tower 3日')).toEqual(['東京', 'tower', '3', '日'])
    // Full-width forms are folded onto the usual ones.
    expect(lexicalTerms('ＫＹＯＴＯ ２')).toEqual(['kyoto', '2'])
  })
})

describe('the lexical index', () => {
  test('lexical · the section a text names ranks first, and a word of the request counts for more than the same word in an answer', () => {
    const index = indexOf(TRIP)
    expect(index.search('Make the day 2 plan less packed', ALL)[0]?.sectionId).toBe(id('d2'))
    expect(index.search('Which of those hostels has private rooms with a bathroom?', ALL)[0]?.sectionId).toBe(id('hostel'))
    // "museum" is in two answers and in no request; a section asked for it outranks both.
    const asked = indexOf([...TRIP, doc('museum', 'Which museum is best?', 'The national one.')])
    expect(asked.search('museum tickets', ALL).map((h) => h.sectionId)[0]).toBe(id('museum'))
  })

  test('lexical · a word that every section contains tells nothing; a word that one contains tells most', () => {
    const index = indexOf(TRIP)
    const [first, second] = index.search('plan for day 3', ALL)
    expect(first?.sectionId).toBe(id('d3'))
    // The other days share "plan" and "day" with it and nothing else.
    expect(second && first && second.score < first.score / 2).toBe(true)
  })

  test('lexical · minimum score: a section needs a share of the weight of the text\'s words, so one incidental word of an unrelated message is not enough', () => {
    const index = indexOf(TRIP)
    // "market" occurs in two answers; the rest of the message is about something else.
    const loose = index.search('How does the stock market price a company that has never made a profit?', ALL)
    expect(loose.length).toBeGreaterThan(0)
    expect(Math.max(...loose.map((h) => h.share))).toBeLessThan(LEXICAL_MIN_SHARE)
    expect(index.search('How does the stock market price a company that has never made a profit?', DEFAULTS)).toEqual([])
    expect(index.search('How do submarines dive and surface?', DEFAULTS)).toEqual([])
    // A contentless message has no words at all.
    for (const text of ['Make that shorter', 'combine both', '']) expect(index.search(text, ALL), text).toEqual([])
    // The section that is named clears the share.
    expect(index.search('Make the day 2 plan less packed', DEFAULTS).map((h) => h.sectionId)).toContain(id('d2'))
    expect(new LexicalIndex().search('day 2', ALL)).toEqual([])
  })

  test('lexical · of the sections that clear the share, those far below the best are left out', () => {
    const index = indexOf(TRIP)
    const all = index.search('Make the day 2 plan less packed', { ...DEFAULTS, minShare: 0.1, minOfBest: 0 }).map((h) => h.sectionId)
    const close = index.search('Make the day 2 plan less packed', DEFAULTS).map((h) => h.sectionId)
    expect(all).toEqual(expect.arrayContaining([id('d1'), id('d2'), id('d3')]))
    expect(close).toEqual([id('d2')])
    // Two sections about equally close are both kept.
    expect(index.search('Compare the hostels with the neighborhoods', DEFAULTS).map((h) => h.sectionId).sort()).toEqual([id('hostel'), id('stay')].sort())
  })

  test('lexical · cap: at most `limit` sections, the best first; equal scores by recency, the later section first', () => {
    const same = Array.from({ length: 30 }, (_, i) => doc(i, 'Tell me about the tides', 'The moon pulls the sea.'))
    const hits = indexOf(same).search('tides and the moon', DEFAULTS)
    expect(hits).toHaveLength(LEXICAL_MAX_CANDIDATES)
    expect(new Set(hits.map((h) => h.score)).size).toBe(1)
    expect(hits.map((h) => h.sectionId)).toEqual(Array.from({ length: 12 }, (_, i) => id(29 - i)))
    expect(indexOf(same).search('tides', { ...DEFAULTS, limit: 3 }).map((h) => h.sectionId)).toEqual([id(29), id(28), id(27)])
    const sorted = indexOf(TRIP).search('plan the museum day in Kyoto', ALL)
    expect(sorted.map((h) => h.score)).toEqual([...sorted.map((h) => h.score)].sort((a, b) => b - a))
  })

  test('lexical · exclusion: an excluded section is never returned, and still says how close the best is', () => {
    const index = indexOf(TRIP)
    const without = index.search('Make the day 2 plan less packed', { ...DEFAULTS, minShare: 0.1, minOfBest: 0, exclude: new Set([id('d2')]) }).map((h) => h.sectionId)
    expect(without).not.toContain(id('d2'))
    expect(without).toContain(id('d1'))
    // With the best excluded the others are no closer than they were: nothing is promoted in its place.
    expect(index.search('Make the day 2 plan less packed', { ...DEFAULTS, minShare: 0.1, exclude: new Set([id('d2')]) })).toEqual([])
  })

  test('lexical · determinism: the same sections and text give the same hits, and an index brought up to date is the index built at once', () => {
    const texts = ['Make the day 2 plan less packed', 'rain plan museum', 'private rooms near the station', 'Kyoto in November']
    const hitsOf = (index: LexicalIndex) => texts.map((text) => index.search(text, ALL))
    expect(hitsOf(indexOf(TRIP))).toEqual(hitsOf(indexOf(TRIP)))

    const index = new LexicalIndex()
    // Section by section, as a conversation grows.
    for (let n = 1; n <= TRIP.length; n++) index.sync(TRIP.slice(0, n))
    expect(hitsOf(index)).toEqual(hitsOf(indexOf(TRIP)))
    // An answer that is still streaming, a section that is revised, one that is dropped, one that is added.
    const streaming = TRIP.map((d) => (d.sectionId === id('d3') ? { ...d, answer: `${d.answer} Then an early dinner near the station.` } : d))
    index.sync(streaming)
    expect(hitsOf(index)).toEqual(hitsOf(indexOf(streaming)))
    const revised = streaming.filter((d) => d.sectionId !== id('rain')).map((d) => (d.sectionId === id('d1') ? doc('d1', 'Plan the arrival day', 'Land at Kansai, train to Kyoto.') : d))
    index.sync(revised)
    expect(index.size).toBe(revised.length)
    expect(hitsOf(index)).toEqual(hitsOf(indexOf(revised)))
    const grown = [...revised, doc('d4', 'Plan day 4 hour by hour', 'Fushimi Inari at sunrise.')]
    index.sync(grown)
    expect(hitsOf(index)).toEqual(hitsOf(indexOf(grown)))
    index.sync([])
    expect(index.size).toBe(0)
    expect(hitsOf(index)).toEqual(texts.map(() => []))
  })

  test('lexical · a conversation of 2,000 sections: one more section is one section indexed, and the hits are those of a fresh index', () => {
    const words = ['tide', 'moon', 'honey', 'bee', 'wool', 'glacier', 'copper', 'violin', 'yeast', 'comet', 'basalt', 'heron', 'quartz', 'saffron', 'lichen', 'otter']
    const big = Array.from({ length: 2_000 }, (_, i) =>
      doc(i, `Next entry: ${words[i % 16] ?? ''} ${words[(i * 7 + 3) % 16] ?? ''} number ${i}`, `Entry ${i} explains ${words[(i * 5 + 1) % 16] ?? ''} and ${words[(i * 11 + 2) % 16] ?? ''} for curious readers.`),
    )
    const index = indexOf(big)
    const more = [...big, doc('new', 'Next entry: the aurora', 'Charged particles from the sun meet the upper air.')]
    let read = 0
    const counted = function* (): Generator<LexicalDocument> {
      for (const d of more) {
        read += 1
        yield d
      }
    }
    index.sync(counted())
    expect(read).toBe(2_001)
    expect(index.size).toBe(2_001)
    for (const text of ['entry number 1234', 'the aurora and the sun', 'honey bee entry']) expect(index.search(text, DEFAULTS), text).toEqual(indexOf(more).search(text, DEFAULTS))
    expect(index.search('entry number 1234', DEFAULTS)[0]?.sectionId).toBe(id(1234))
  })
})

// ───────────────────────────── the source in a routing ─────────────────────────────

const section = (n: number | string, request: string, answer: string): CandidateSection =>
  ({ sectionId: id(n), title: request, request, excerpt: answer.slice(0, 20), answerLength: answer.length, asksElicitationId: null }) as unknown as CandidateSection

function query(sections: readonly CandidateSection[], text: string, extra: Partial<CandidateQuery> = {}): CandidateQuery {
  return { conversationId: 'cnv_a' as ConversationId, unit: { key: 'm', name: 'the new message' }, text, sections, answerText: (s) => s.excerpt, firstPass: [], ...extra }
}

describe('the lexical candidate source', () => {
  test('lexical · the source indexes the whole answer, leaves the first-pass sections out, and keeps an index for each conversation', async () => {
    const answers = new Map([
      [id(1), 'The opening says little. Much later the answer explains how glaciers carve valleys.'],
      [id(2), 'About yeast and bread.'],
      [id(3), 'About glaciers again: how a glacier carves a valley, at length.'],
    ])
    const sections = [section(1, 'Tell me about ice', answers.get(id(1)) ?? ''), section(2, 'Tell me about baking', answers.get(id(2)) ?? ''), section(3, 'And the valleys?', answers.get(id(3)) ?? '')]
    const whole = (s: CandidateSection): string => answers.get(s.sectionId) ?? ''
    const source = createLexicalCandidateSource()
    expect(source.name).toBe('lexical')
    // The word is beyond the excerpt of section 1: only the whole answer has it.
    expect((await source.candidates(query(sections, 'How do glaciers carve valleys?'))).map((h) => h.sectionId)).not.toContain(id(1))
    const hits = await source.candidates(query(sections, 'How do glaciers carve valleys?', { answerText: whole }))
    expect(hits.map((h) => h.sectionId).sort()).toEqual([id(1), id(3)])
    for (const hit of hits) expect(hit.score).toBeGreaterThan(0)
    // Section 3 is asked about by itself in every routing: it is not a candidate.
    expect((await source.candidates(query(sections, 'How do glaciers carve valleys?', { answerText: whole, firstPass: [id(3)] }))).map((h) => h.sectionId)).toEqual([id(1)])
    // Another conversation has its own sections; coming back to the first finds it as it was.
    const other = [section(1, 'Tell me about copper', 'Copper conducts well.')]
    expect((await source.candidates(query(other, 'And copper?', { conversationId: 'cnv_b' as ConversationId }))).map((h) => h.sectionId)).toEqual([id(1)])
    expect(await source.candidates(query(sections, 'How do glaciers carve valleys?', { answerText: whole }))).toEqual(hits)
    expect(await createLexicalCandidateSource().candidates(query(sections, 'How do glaciers carve valleys?', { answerText: whole }))).toEqual(hits)
  })
})

const below = ROUTING_CORPUS.filter((e) => e.below)
const withSource = (candidateSource: Settings['routing']['candidateSource'], routing: Partial<Settings['routing']> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  routing: { ...DEFAULT_SETTINGS.routing, referentStrategy: 'tree-walk', strategySelection: 'off', ...routing, candidateSource },
})

async function routeExample(example: CorpusExample, settings: Settings, provider?: DecisionProvider): Promise<{ readonly outcome: RoutingOutcome; readonly decision: RoutingDecision | null }> {
  const input = corpusInput(example, settings)
  const router = createRouter({ decisionProvider: provider ?? oracleDecisionProvider(example, input), decomposer: referenceDecomposer(example) })
  const outcome = await router.route(input, NEVER_CANCELLED)
  return { outcome, decision: outcome.kind === 'plan' ? outcome.plan.decision : null }
}

/** The section handles a decision's record names as candidates of the message. */
const candidatesOf = (example: CorpusExample, decision: RoutingDecision | null): string[] =>
  (decision?.candidateSource?.units.find((u) => u.unit === 'message')?.candidates ?? []).map((c) => example.scene.handles.get(c.sectionId) ?? c.sectionId)

describe('the lexical candidate source in a routing', () => {
  test('lexical · three corpus examples have a referent below work the message does not refer to', () => {
    expect(below.map((e) => e.id)).toEqual(['live-referent-beyond-window', 'deep-run-middle-section', 'deep-run-other-branch'])
  })

  test.each(below.map((e) => [e.id, e] as const))('lexical · %s: the tree walk misses the referent with no source and routes as labelled with the lexical source, nothing scripted', async (_id, example) => {
    const off = await routeExample(example, withSource('none'))
    expect(compare(example, off.outcome)).not.toEqual([])
    expect(off.decision?.candidateSource).toBeUndefined()
    const on = await routeExample(example, withSource('lexical'))
    expect(compare(example, on.outcome)).toEqual([])
    // The record names the source and what it returned, with the source's scores.
    expect(on.decision?.candidateSource?.source).toBe('lexical')
    const targets = (example.expect.parts ?? []).flatMap((part) => part.targets ?? [])
    expect(candidatesOf(example, on.decision)).toEqual(expect.arrayContaining(targets))
    for (const c of on.decision?.candidateSource?.units[0]?.candidates ?? []) expect(c.score).toBeGreaterThan(0)
  })

  test('lexical · the strategy the rules select, with the lexical source, routes the referent beyond the window that is below unrelated work', async () => {
    const example = ROUTING_CORPUS.find((e) => e.id === 'live-referent-beyond-window')
    if (!example) throw new Error('missing example')
    const rules = { referentStrategy: 'one-pass', strategySelection: 'rules' } as const
    expect(compare(example, (await routeExample(example, withSource('none', rules))).outcome)).not.toEqual([])
    const on = await routeExample(example, withSource('lexical', rules))
    expect(compare(example, on.outcome)).toEqual([])
    expect(on.decision?.strategySelection?.choice.strategy).toBe('tree-walk')
  })

  test.each(ROUTING_CORPUS.map((e) => [e.id, e] as const))('lexical · with decisions as labelled and the lexical source, the tree walk routes %s as labelled', async (_id, example) => {
    expect(compare(example, (await routeExample(example, withSource('lexical'))).outcome)).toEqual([])
  })

  test.each(ROUTING_CORPUS.map((e) => [e.id, e] as const))('lexical · with decisions as labelled and the lexical source, the strategy the rules select routes %s as labelled', async (_id, example) => {
    expect(compare(example, (await routeExample(example, withSource('lexical', { referentStrategy: 'one-pass', strategySelection: 'rules' }))).outcome)).toEqual([])
  })

  test('lexical · candidates are reduced with the roots to their non-ancestor set: a root with a candidate below it gives way, and no start is an ancestor of another', async () => {
    for (const example of below) {
      const input = corpusInput(example, withSource('lexical'))
      const tree = buildTree({ sections: numberedAnswerSections(input, supply(input, [])), candidates: input.candidates })
      const { decision } = await routeExample(example, withSource('lexical'))
      const candidates = (decision?.candidateSource?.units[0]?.candidates ?? []).flatMap((c) => tree.bySection.get(c.sectionId) ?? [])
      expect(candidates.length).toBeGreaterThan(0)
      const { starts } = startSet(tree.roots, candidates)
      expect(starts).toEqual(reduceToNonAncestors([...tree.roots, ...candidates]))
      for (const start of starts) for (const other of starts) expect(ancestorsOf(other).has(start)).toBe(false)
      // Every candidate is a start or an ancestor of one; the root above a candidate is not a start.
      for (const candidate of candidates) {
        expect(starts.includes(candidate) || starts.some((start) => ancestorsOf(start).has(candidate))).toBe(true)
        const root = [...ancestorsOf(candidate)].find((node) => node.parent === null && node.kind === 'section')
        if (root) expect(starts).not.toContain(root)
      }
    }
  })

  /** A decision provider that says no to every question, or yes to every question that is not about one section or one sibling group by itself. */
  function flat(yes: (questionId: string) => boolean): { readonly provider: DecisionProvider; readonly asked: string[] } {
    const asked: string[] = []
    const provider: DecisionProvider = {
      async decide<Q extends DecisionQuestions>(request: DecisionRequest<Q>): Promise<DecisionResult<Q>> {
        const answers: { [id: string]: unknown } = {}
        for (const [questionId, q] of Object.entries(request.questions)) {
          asked.push(questionId)
          if (q.type === 'choice') {
            const options = Object.keys(q.options)
            const chosen = options.includes('new') ? 'new' : (options[0] ?? '')
            answers[questionId] = { type: 'choice', choice: chosen, confidence: 0.9, probabilities: Object.fromEntries(options.map((o) => [o, o === chosen ? 0.9 : 0])) }
          } else answers[questionId] = { type: 'noul', probability: yes(questionId) ? 0.95 : 0.02 }
        }
        return { ok: true, model: 'flat', answers: answers as never, usage: null }
      },
    }
    return { provider, asked }
  }

  test('lexical · DA3: a candidate is asked about by itself, and is never a referent because the source named it', async () => {
    for (const example of below) {
      const input = corpusInput(example, withSource('lexical'))
      const numbers = new Map(numberedAnswerSections(input, supply(input, [])).map((s) => [s.section.sectionId, s.n]))
      // No to everything: the candidates were handed to the walk and asked about, and none of them is a target.
      const no = flat(() => false)
      const refused = await routeExample(example, withSource('lexical'), no.provider)
      const named = refused.decision?.candidateSource?.units[0]?.candidates ?? []
      expect(named.length).toBeGreaterThan(0)
      for (const c of named) expect(no.asked, `${example.id}: ${c.sectionId}`).toContain(`m_s${numbers.get(c.sectionId) ?? 0}`)
      expect(refused.outcome.kind).toBe('plan')
      if (refused.outcome.kind === 'plan') expect(refused.outcome.plan.units.flatMap((u) => u.targets)).toEqual([])
      // Yes to every question about several sections (a part of a run, "more than one"), no to each section by itself: still no target.
      const around = flat((questionId) => !/^m_(s|j)\d+$/.test(questionId) && /^m_(c\d+|several)/.test(questionId))
      const hinted = await routeExample(example, withSource('lexical'), around.provider)
      if (hinted.outcome.kind === 'plan') expect(hinted.outcome.plan.units.flatMap((u) => u.targets)).toEqual([])
      else expect(hinted.outcome.kind).not.toBe('target-ambiguity')
    }
  })

  test('lexical · every target of a routing with the lexical source was confirmed by a question about that section by itself or about its sibling group as a whole', async () => {
    for (const example of ROUTING_CORPUS) {
      if ((example.replyTo ?? []).length > 0) continue
      const input = corpusInput(example, withSource('lexical'))
      const tree = buildTree({ sections: numberedAnswerSections(input, supply(input, [])), candidates: input.candidates })
      const { outcome, decision } = await routeExample(example, withSource('lexical'))
      if (outcome.kind !== 'plan' || !decision) continue
      const yes = new Set(decision.questions.filter((q) => q.type === 'noul' && typeof q.answer === 'number' && q.answer >= DEFAULT_SETTINGS.thresholds.targetChoice).map((q) => q.id))
      // A unit that joined several lines instead of asking takes its targets at the ambiguity floor, on a yes to the question about the lines (05).
      const plausible = new Set(decision.questions.filter((q) => q.type === 'noul' && typeof q.answer === 'number' && q.answer >= AMBIGUITY_FLOOR).map((q) => q.id))
      const joined = new Set((decision.joinedLines ?? []).flatMap((j) => (yes.has('m_lines') ? j.sectionIds : [])))
      for (const unit of outcome.plan.units) {
        const key = outcome.plan.units.length === 1 && !example.decomposition ? 'm' : null
        if (key === null) continue
        for (const target of unit.targets) {
          const node = tree.bySection.get(target)
          if (!node) continue
          const groups = [...tree.byGroup.values()].filter((g) => g.members.includes(node))
          const confirmed = yes.has(`m_s${node.n}`) || groups.some((g) => yes.has(`m_j${g.index}`))
          expect(confirmed || (joined.has(target) && plausible.has(`m_s${node.n}`)), `${example.id}: ${target}`).toBe(true)
        }
      }
    }
  })

  test('lexical · an injected candidate source wins over the setting, and the setting `none` asks no source', async () => {
    const example = below[1]
    if (!example) throw new Error('missing example')
    const input = corpusInput(example, withSource('lexical'))
    const asked: CandidateQuery[] = []
    const router = createRouter({
      decisionProvider: oracleDecisionProvider(example, input),
      decomposer: referenceDecomposer(example),
      candidateSource: {
        name: 'scripted',
        candidates: async (q) => {
          asked.push(q)
          return [{ sectionId: sceneIds.section('H1'), score: null }]
        },
      },
    })
    const outcome = await router.route(input, NEVER_CANCELLED)
    expect(asked).toHaveLength(1)
    // The query carries what a source needs: the conversation, the first-pass sections, and the answers.
    expect(asked[0]?.conversationId).toBe(input.conversationId)
    expect(asked[0]?.firstPass).toEqual(firstPassSectionIds(input.candidates))
    expect(outcome.kind === 'plan' ? outcome.plan.decision.candidateSource : null).toEqual({ source: 'scripted', units: [{ unit: 'message', candidates: [{ sectionId: sceneIds.section('H1'), score: null }] }] })
    expect((await routeExample(example, withSource('none'))).decision?.candidateSource).toBeUndefined()
  })

  test('lexical · one pass does not walk: with the lexical source it sends the requests it sends without one, and an explicit reply target asks no source', async () => {
    const example = below[1]
    if (!example) throw new Error('missing example')
    const requestsOf = async (settings: Settings, replyTo?: readonly string[]): Promise<{ readonly requests: unknown[]; readonly decision: RoutingDecision | null }> => {
      const routed: CorpusExample = replyTo ? { ...example, replyTo } : example
      const input = corpusInput(routed, settings)
      const oracle = oracleDecisionProvider(routed, input)
      const requests: unknown[] = []
      const provider: DecisionProvider = {
        decide: (request, signal) => {
          requests.push({ state: request.state, questions: request.questions })
          return oracle.decide(request, signal)
        },
      }
      return { requests, decision: (await routeExample(routed, settings, provider)).decision }
    }
    const onePass = { referentStrategy: 'one-pass' } as const
    expect((await requestsOf(withSource('lexical', onePass))).requests).toEqual((await requestsOf(withSource('none', onePass))).requests)
    const given = await requestsOf(withSource('lexical'), ['D2'])
    expect(given.decision?.candidateSource).toBeUndefined()
    expect(given.requests).toEqual((await requestsOf(withSource('none'), ['D2'])).requests)
  })

  test('lexical · a contentless message gets no candidates, and the routing is the routing without a source', async () => {
    const sc: Scene = below[1]?.scene ?? scene().build()
    const example: CorpusExample = { id: 'contentless', covers: ['targets'], note: 'a message with no words to look up', scene: sc, text: 'Make that shorter', expect: {} }
    const on = await routeExample(example, withSource('lexical'), flat(() => false).provider)
    expect(on.decision?.candidateSource).toEqual({ source: 'lexical', units: [{ unit: 'message', candidates: [] }] })
    const off = await routeExample(example, withSource('none'), flat(() => false).provider)
    expect(on.outcome.kind === 'plan' && off.outcome.kind === 'plan' ? on.outcome.plan.units : null).toEqual(off.outcome.kind === 'plan' ? off.outcome.plan.units : undefined)
  })
})

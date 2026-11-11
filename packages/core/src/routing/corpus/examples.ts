import { scene } from './scene'
import type { CorpusExample } from './types'

/**
 * Scenes: the running examples of 01–07, as the router's candidates show
 * them. Section, directive and node handles are the same name.
 */
const BRIEF = 'Trip brief: Kyoto, five days, November, moderate budget'

const empty = scene().build()

const sky = scene()
  .chain('sky', 'root', 'sky')
  .add('S', { chain: 'sky', on: null, label: 'sky', request: 'Why is the sky blue?', answer: 'Rayleigh scattering: air scatters blue light more than red.' })
  .build()

const twoAnswers = scene()
  .chain('sky', 'root', 'sky')
  .add('S', { chain: 'sky', on: null, label: 'sky', request: 'Why is the sky blue?', answer: 'Rayleigh scattering: air scatters blue light more than red.' })
  .chain('menu', 'root', 'menu translation')
  .add('M', { chain: 'menu', on: null, label: 'menu translation', request: 'Translate this menu into French: soup, bread, cheese', answer: 'Soupe, pain, fromage.' })
  .build()

const compositeAnswer = scene()
  .chain('sky', 'root', 'sky')
  .add('S', { chain: 'sky', on: null, label: 'sky', message: 'X', request: 'Explain why the sky is blue', answer: 'Sunlight scatters off air molecules; blue scatters most.' })
  .chain('menu', 'root', 'menu translation')
  .add('M', { chain: 'menu', on: null, label: 'menu translation', message: 'X', request: 'Translate this menu into French: soup, bread', answer: 'Soupe, pain.' })
  .build()

const tripBrief = scene()
  .chain('trip', 'root', 'trip')
  .add('brief', { chain: 'trip', on: null, label: 'brief', request: BRIEF, answer: 'Noted: Kyoto, five days in November, moderate budget.' })
  .build()

const tripOneRunning = scene()
  .chain('trip', 'root', 'trip')
  .add('brief', { chain: 'trip', on: null, label: 'brief', request: BRIEF, answer: 'Noted: Kyoto, five days in November, moderate budget.' })
  .add('A', { chain: 'trip', on: 'brief', label: 'neighborhoods', request: 'Suggest neighborhoods to stay in', answer: 'Gion is', state: 'running', consumed: ['brief'] })
  .build()

const tripRunning = scene()
  .chain('trip', 'root', 'trip')
  .add('brief', { chain: 'trip', on: null, label: 'brief', request: BRIEF, answer: 'Noted: Kyoto, five days in November, moderate budget.' })
  .chain('A', 'fork', 'neighborhoods')
  .add('A', { chain: 'A', on: 'brief', label: 'neighborhoods', request: 'Suggest neighborhoods to stay in', answer: 'Gion is', state: 'running', consumed: ['brief'] })
  .chain('B', 'fork', 'activities')
  .add('B', { chain: 'B', on: 'brief', label: 'activities', request: 'Suggest rainy-day activities', state: 'running', consumed: ['brief'] })
  .group('G', { base: 'trip', start: 'brief', members: ['A', 'B'], open: true })
  .build()

const tripQueuedJ = scene()
  .chain('trip', 'root', 'trip')
  .add('brief', { chain: 'trip', on: null, label: 'brief', request: BRIEF, answer: 'Noted: Kyoto, five days in November, moderate budget.' })
  .chain('A', 'fork', 'neighborhoods')
  .add('A', { chain: 'A', on: 'brief', label: 'neighborhoods', request: 'Suggest neighborhoods to stay in', answer: 'Gion is', state: 'running', consumed: ['brief'] })
  .chain('B', 'fork', 'activities')
  .add('B', { chain: 'B', on: 'brief', label: 'activities', request: 'Suggest rainy-day activities', state: 'running', consumed: ['brief'] })
  .group('G', { base: 'trip', start: 'brief', members: ['A', 'B'], open: true })
  .add('J', { chain: 'trip', on: 'brief', label: 'itinerary', request: 'Use those recommendations to make a five-day itinerary', state: 'dependency-queued' })
  .build()

const tripClosed = scene()
  .chain('trip', 'root', 'trip')
  .add('brief', { chain: 'trip', on: null, label: 'brief', request: BRIEF, answer: 'Noted: Kyoto, five days in November, moderate budget.' })
  .chain('A', 'fork', 'neighborhoods')
  .add('A', { chain: 'A', on: 'brief', label: 'neighborhoods', request: 'Suggest neighborhoods to stay in', answer: 'Stay in Gion or Higashiyama for walkable temples.', consumed: ['brief'] })
  .chain('B', 'fork', 'activities')
  .add('B', { chain: 'B', on: 'brief', label: 'activities', request: 'Suggest rainy-day activities', answer: 'The National Museum, a tea ceremony, and Nishiki Market.', consumed: ['brief'] })
  .group('G', { base: 'trip', start: 'brief', members: ['A', 'B'], open: false })
  .build()

const tripDoneSteps = () =>
  scene()
    .chain('trip', 'root', 'trip')
    .add('brief', { chain: 'trip', on: null, label: 'brief', request: BRIEF, answer: 'Noted: Kyoto, five days in November, moderate budget.' })
    .chain('A', 'fork', 'neighborhoods')
    .add('A', { chain: 'A', on: 'brief', label: 'neighborhoods', request: 'Suggest neighborhoods to stay in', answer: 'Stay in Gion or Higashiyama.', consumed: ['brief'] })
    .chain('B', 'fork', 'activities')
    .add('B', { chain: 'B', on: 'brief', label: 'activities', request: 'Suggest rainy-day activities', answer: 'The National Museum and a tea ceremony.', consumed: ['brief'] })
    .group('G', { base: 'trip', start: 'brief', members: ['A', 'B'], open: false })
    .add('J', { chain: 'trip', on: 'jb_G', label: 'itinerary', request: 'Use those recommendations to make a five-day itinerary', answer: 'Day 1: Gion. Day 2: museum…', consumed: ['brief', 'A', 'B'] })
    .chain('sky', 'root', 'sky')
    .add('S', { chain: 'sky', on: null, label: 'sky', request: 'Why is the sky blue?', answer: 'Rayleigh scattering.' })

const tripDone = tripDoneSteps().build()

const tripBranch = tripDoneSteps()
  .chain('b2', 'branch', 'cheaper activities')
  .add('B2', { chain: 'b2', on: 'B', label: 'cheaper activities', request: 'Give me three cheaper alternatives', answer: 'Free shrines, Philosopher’s Path, Kamo river walk.', consumed: ['brief', 'B'] })
  .build()

const recommendationRunning = scene()
  .chain('rec', 'root', 'laptop')
  .add('R', { chain: 'rec', on: null, label: 'laptop recommendation', request: 'Recommend a laptop for programming, with reasons', state: 'running', answer: 'For programming I would' })
  .build()

const questionOpen = scene()
  .chain('menu', 'root', 'menu translation')
  .add('T', { chain: 'menu', on: null, label: 'menu translation', message: 'Y', request: 'Translate this menu into French: soup, bread', answer: 'Soupe, pain.' })
  .chain('event', 'root', 'yesterday')
  .add('E', { chain: 'event', on: null, label: 'yesterday', message: 'Y', request: 'Explain what happened yesterday', state: 'awaiting-elicitation' })
  .question('Q', 'E', 'Which event yesterday do you mean: the office fire drill or the city marathon?')
  .build()

const session = scene()
  .chain('sky', 'root', 'sky')
  .add('S', { chain: 'sky', on: null, label: 'sky', request: 'Why is the sky blue?', answer: 'Rayleigh scattering.' })
  .sessionRequirement('R1', 'Keep every answer under 100 words')
  .build()

// ───────────────────────────── examples ─────────────────────────────

const SKY_MENU = 'Explain why the sky is blue, and separately translate this menu into French: soup, bread. Keep both accessible to a beginner.'
const SUMMARY_MENU = 'Summarize that recommendation and separately translate this menu: soup, bread'
const SUMMARY_MENU_FIRST = 'Summarize that recommendation and separately translate this menu: soup, bread, but put the translation first'
const SUMMARY_MENU_TOTAL = 'Summarize that recommendation and translate this menu: soup, bread. Keep both answers under 100 words total.'
const BCJ = 'Suggest rainy-day activities, suggest evening activities, and then make an itinerary from the neighborhoods and both of those'

export const ROUTING_CORPUS: readonly CorpusExample[] = [
  // ── targets ──
  {
    id: 'target-single-recent',
    covers: ['targets'],
    note: '05: "Make that shorter" with one recent answer: the target is inferred.',
    scene: sky,
    text: 'Make that shorter',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'addition', targets: ['S'], placement: { continue: 'S' } }] },
  },
  {
    id: 'target-ambiguous-shorter',
    covers: ['targets'],
    note: '05 edge case: "Make that shorter" with several recent answers and no clear one: the user picks among the candidate sections.',
    scene: twoAnswers,
    text: 'Make that shorter',
    expect: { outcome: 'target-ambiguity', ambiguous: ['S', 'M'] },
  },
  {
    id: 'target-ambiguous-use-that-one',
    covers: ['targets'],
    note: '05 edge case: "Use that one" with several possible referents: ask, never assume from topic similarity.',
    scene: twoAnswers,
    text: 'Use that one',
    expect: { outcome: 'target-ambiguity', ambiguous: ['S', 'M'] },
  },
  {
    id: 'target-explicit',
    covers: ['targets', 'placement'],
    note: 'T1: an explicit reply target resolves to its own section, whatever else is recent.',
    scene: twoAnswers,
    text: 'Make it shorter',
    replyTo: ['M'],
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'addition', targets: ['M'], placement: { continue: 'M' } }] },
  },
  {
    id: 'target-both-sections-of-composite',
    covers: ['targets', 'placement'],
    note: 'T1, 05 edge case: an untargeted follow-up that plainly addresses two sections of one composite answer targets both.',
    scene: compositeAnswer,
    text: 'Make both of those answers simpler',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'addition', targets: ['S', 'M'], placement: { join: ['S', 'M'] } }] },
  },
  {
    id: 'target-explicit-question-answer',
    covers: ['targets', 'clarification'],
    note: 'Q98: a reply targeted at a clarification question is its answer.',
    scene: questionOpen,
    text: 'The office fire drill',
    replyTo: ['Q'],
    expect: { composition: 'atomic', answers: 'Q', parts: [] },
  },
  {
    id: 'target-inferred-question-answer',
    covers: ['targets', 'clarification'],
    note: 'Q98: an untargeted message may be recognised as the answer to the open question.',
    scene: questionOpen,
    text: 'I meant the fire drill at the office',
    expect: { composition: 'atomic', answers: 'Q', parts: [] },
  },
  // ── placement ──
  {
    id: 'placement-first-message',
    covers: ['placement'],
    note: '01: the first message of a conversation starts a new chain.',
    scene: empty,
    text: 'Why is the sky blue?',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'new', placement: 'new-chain' }] },
  },
  {
    id: 'placement-unrelated',
    covers: ['placement'],
    note: '05: new independent work with no relation to existing work: a new chain.',
    scene: tripBrief,
    text: 'Explain how volcanoes form',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'new', placement: 'new-chain' }] },
  },
  {
    id: 'placement-continue-chain',
    covers: ['placement'],
    note: '01: related work continues the chain it builds on.',
    scene: tripBrief,
    text: 'What should I pack for that trip?',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'addition', targets: ['brief'], placement: { continue: 'brief' } }] },
  },
  {
    id: 'placement-fork-while-running',
    covers: ['placement', 'dependencies'],
    note: '04: B sent while A runs on the trip chain builds on the brief and becomes a fork beside A; it does not wait for A.',
    scene: tripOneRunning,
    text: 'Also suggest rainy-day activities for the trip',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'addition', targets: ['brief'], placement: { continue: 'brief' }, prerequisites: [] }] },
  },
  {
    id: 'placement-join-back',
    covers: ['placement'],
    note: '04, C19: work needing both siblings continues from their join-back, on the base chain.',
    scene: tripClosed,
    text: 'Use the neighborhoods and the activities to make a five-day itinerary',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'addition', targets: ['A', 'B'], placement: { continue: 'group:G' }, prerequisites: [] }] },
  },
  {
    id: 'placement-branch-from-sibling',
    covers: ['placement'],
    note: '04 step 5, C8: a reply to B alone branches from B and does not import A.',
    scene: tripClosed,
    text: 'Give me three cheaper alternatives',
    replyTo: ['B'],
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'addition', targets: ['B'], placement: { continue: 'B' } }] },
  },
  {
    id: 'placement-join-chain-separate-trees',
    covers: ['placement'],
    note: '05: work across diverged lines (the itinerary and the sky explanation) is a join chain.',
    scene: tripDone,
    text: 'Compare the itinerary with the sky explanation',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'addition', targets: ['J', 'S'], placement: { join: ['J', 'S'] } }] },
  },
  {
    id: 'placement-join-chain-cousins',
    covers: ['placement'],
    note: '04 edge case: a request needing both J and the B-only branch is a join chain over those two leaves.',
    scene: tripBranch,
    text: 'Fit the cheaper alternatives into the itinerary',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'addition', targets: ['J', 'B2'], placement: { join: ['J', 'B2'] } }] },
  },
  {
    id: 'placement-additional-not-revision',
    covers: ['placement', 'revision'],
    note: '06 edge case: "Also give me luxury options" as a reply to A is not a revision; it builds on A and A stays current.',
    scene: tripClosed,
    text: 'Also give me luxury options',
    replyTo: ['A'],
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'addition', targets: ['A'], placement: { continue: 'A' } }] },
  },
  // ── dependencies ──
  {
    id: 'dependency-expand-running',
    covers: ['dependencies'],
    note: '05: "Expand the recommendation you are preparing" needs a result not yet available: result-dependent.',
    scene: recommendationRunning,
    text: 'Expand the recommendation you are preparing',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'result-dependent', targets: ['R'], placement: { continue: 'R' }, prerequisites: ['R'] }] },
  },
  {
    id: 'dependency-unrelated-runs-now',
    covers: ['dependencies', 'placement'],
    note: '05, C1: unrelated work runs at once on its own chain while a long answer streams.',
    scene: recommendationRunning,
    text: 'Translate "good morning" into French',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'new', placement: 'new-chain', prerequisites: [] }] },
  },
  {
    id: 'dependency-topic-is-not-dependency',
    covers: ['dependencies'],
    note: 'Q2, 04: shared subject matter is not a result dependency; a general question about Macs and PCs can be answered without the pending recommendation.',
    scene: recommendationRunning,
    text: 'In general, are Macs or PCs cheaper?',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'new', placement: 'new-chain', prerequisites: [] }] },
  },
  {
    id: 'dependency-full-group',
    covers: ['dependencies', 'placement'],
    note: 'Q30, C9: work needing both running siblings waits for their full join-back.',
    scene: tripRunning,
    text: 'Make an itinerary from the neighborhoods and the activities',
    expect: {
      composition: 'atomic',
      parts: [{ kind: 'unit', relation: 'result-dependent', targets: ['A', 'B'], placement: { continue: 'group:G' }, prerequisites: ['group:G'] }],
    },
  },
  {
    id: 'dependency-one-sibling',
    covers: ['dependencies', 'placement'],
    note: '01: a request that consumes one member’s result is that member’s descendant, and waits for it alone.',
    scene: tripRunning,
    text: 'Expand the neighborhoods you are preparing',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'result-dependent', targets: ['A'], placement: { continue: 'A' }, prerequisites: ['A'] }] },
  },
  // ── revision versus addition ──
  {
    id: 'revision-actually',
    covers: ['revision'],
    note: '06: "Actually, use a luxury budget for the neighborhood recommendations" corrects A only.',
    scene: tripClosed,
    text: 'Actually, use a luxury budget for the neighborhood recommendations',
    replyTo: ['A'],
    expect: { composition: 'atomic', parts: [{ kind: 'revision', scope: 'work', targets: ['A'] }] },
  },
  {
    id: 'revision-inferred-target',
    covers: ['revision', 'targets'],
    note: '05: corrective wording ("No, … instead") with one clear referent revises it.',
    scene: sky,
    text: 'No, explain it for a five-year-old instead',
    expect: { composition: 'atomic', parts: [{ kind: 'revision', scope: 'work', targets: ['S'] }] },
  },
  {
    id: 'revision-unclear-is-addition',
    covers: ['revision'],
    note: '05 edge case: ambiguous between correcting and adding: additional work, and the target stays current.',
    scene: tripClosed,
    text: 'What about some luxury places?',
    replyTo: ['A'],
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'addition', targets: ['A'], placement: { continue: 'A' } }] },
  },
  {
    id: 'revision-shared-brief',
    covers: ['revision'],
    note: '06: "Actually, the trip is four days, not five" changes the brief A, B and J consumed; J is the work judged actually affected (Q44).',
    scene: tripDone,
    text: 'Actually, the trip is four days, not five',
    expect: { composition: 'atomic', parts: [{ kind: 'revision', scope: 'shared-requirement', targets: ['brief'], affected: ['J'] }] },
  },
  {
    id: 'revision-queued-work',
    covers: ['revision'],
    note: '06 edge case: revising J while it is still queued is a revision of J.',
    scene: tripQueuedJ,
    text: 'Actually, make the itinerary three days',
    replyTo: ['J'],
    expect: { composition: 'atomic', parts: [{ kind: 'revision', scope: 'work', targets: ['J'] }] },
  },
  {
    id: 'revision-session-requirement',
    covers: ['revision', 'requirements'],
    note: 'Q17: a correction to a conversation-wide requirement replaces it.',
    scene: session,
    text: 'Actually, from now on keep answers under 200 words',
    decomposition: {
      fragments: [
        {
          part: 'Actually, from now on keep answers under 200 words',
          instruction: 'Keep answers under 200 words from now on.',
          label: 'answer length',
          requirements: [{ text: 'Keep every answer under 200 words', part: 'keep answers under 200 words', scope: 'session-wide' }],
        },
      ],
    },
    expect: { composition: 'atomic', sessionWide: true, parts: [{ kind: 'revision', scope: 'shared-requirement', targets: [], requirements: ['R1'] }] },
  },
  // ── splits ──
  {
    id: 'split-atomic-related-topics',
    covers: ['splits'],
    note: '02: tightly related topics for one audience stay atomic.',
    scene: empty,
    text: 'Explain caching and indexes for beginners',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'new', placement: 'new-chain' }] },
  },
  {
    id: 'split-atomic-contrast',
    covers: ['splits'],
    note: '02: a requested contrast is one integrated output.',
    scene: empty,
    text: 'Compare Python and Go for writing web servers',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'new', placement: 'new-chain' }] },
  },
  {
    id: 'split-independent',
    covers: ['splits', 'requirements'],
    note: '02: two independent intents with a shared requirement: one reply group, the requirement on both.',
    scene: empty,
    text: SKY_MENU,
    decomposition: {
      fragments: [
        { part: 'Explain why the sky is blue', instruction: 'Explain why the sky is blue.', label: 'sky', requirements: [{ text: 'Keep it accessible to a beginner', part: 'Keep both accessible to a beginner' }] },
        { part: 'translate this menu into French: soup, bread', instruction: 'Translate this menu into French: soup, bread.', label: 'menu translation', requirements: [{ text: 'Keep it accessible to a beginner', part: 'Keep both accessible to a beginner' }] },
      ],
    },
    expect: {
      composition: 'independent-composite',
      sessionWide: false,
      parts: [
        { kind: 'unit', relation: 'new', placement: 'new-chain', clarification: false },
        { kind: 'unit', relation: 'new', placement: 'new-chain', clarification: false },
      ],
    },
  },
  {
    id: 'split-sequential',
    covers: ['splits', 'dependencies'],
    note: 'Q53: a later part needs an earlier part’s result: split messages, in dependency order.',
    scene: empty,
    text: 'Find three good neighborhoods in Kyoto, then make a two-day plan around the best one',
    decomposition: {
      fragments: [
        { part: 'Find three good neighborhoods in Kyoto', instruction: 'Find three good neighborhoods in Kyoto.', label: 'neighborhoods' },
        { part: 'make a two-day plan around the best one', instruction: 'Make a two-day plan around the best of the neighborhoods found.', label: 'two-day plan', after: [0] },
      ],
    },
    expect: {
      composition: 'sequential-composite',
      order: [0, 1],
      parts: [
        { kind: 'unit', relation: 'new', placement: 'new-chain' },
        { kind: 'unit', relation: 'result-dependent', placement: { continue: 'part:0' }, prerequisites: ['part:0'], after: [0] },
      ],
    },
  },
  {
    id: 'split-ready-and-blocked',
    covers: ['splits', 'dependencies'],
    note: 'D2, 02 edge case: the translation runs now; the summary of the recommendation in flight is dependency-queued.',
    scene: recommendationRunning,
    text: SUMMARY_MENU,
    decomposition: {
      fragments: [
        { part: 'Summarize that recommendation', instruction: 'Summarize the laptop recommendation.', label: 'summary' },
        { part: 'translate this menu: soup, bread', instruction: 'Translate this menu: soup, bread.', label: 'menu translation' },
      ],
    },
    expect: {
      composition: 'independent-composite',
      barrier: false,
      parts: [
        { kind: 'unit', relation: 'result-dependent', targets: ['R'], placement: { continue: 'R' }, prerequisites: ['R'] },
        { kind: 'unit', relation: 'new', placement: 'new-chain', prerequisites: [] },
      ],
    },
  },
  {
    id: 'split-output-order-barrier',
    covers: ['splits', 'dependencies'],
    note: 'D3, Q19: "put the translation first" relates the outputs, so the whole request waits.',
    scene: recommendationRunning,
    text: SUMMARY_MENU_FIRST,
    decomposition: {
      fragments: [
        { part: 'Summarize that recommendation', instruction: 'Summarize the laptop recommendation.', label: 'summary' },
        { part: 'translate this menu: soup, bread', instruction: 'Translate this menu: soup, bread.', label: 'menu translation' },
      ],
      barrier: { reason: 'explicit-order', qualifier: 'put the translation first' },
      outputOrder: [1, 0],
    },
    expect: {
      composition: 'independent-composite',
      barrier: true,
      parts: [
        { kind: 'unit', relation: 'result-dependent', targets: ['R'], placement: { continue: 'R' }, prerequisites: ['R'] },
        { kind: 'unit', relation: 'new', placement: 'new-chain', prerequisites: [] },
      ],
    },
  },
  {
    id: 'split-combined-limit-barrier',
    covers: ['splits'],
    note: '02 edge case: "under 100 words total" is a combined limit: the barrier applies.',
    scene: recommendationRunning,
    text: SUMMARY_MENU_TOTAL,
    decomposition: {
      fragments: [
        { part: 'Summarize that recommendation', instruction: 'Summarize the laptop recommendation.', label: 'summary' },
        { part: 'translate this menu: soup, bread', instruction: 'Translate this menu: soup, bread.', label: 'menu translation' },
      ],
      barrier: { reason: 'combined-limit', qualifier: 'Keep both answers under 100 words total' },
    },
    expect: {
      composition: 'independent-composite',
      barrier: true,
      parts: [
        { kind: 'unit', relation: 'result-dependent', targets: ['R'], placement: { continue: 'R' }, prerequisites: ['R'] },
        { kind: 'unit', relation: 'new', placement: 'new-chain' },
      ],
    },
  },
  {
    id: 'split-per-part-limit-no-barrier',
    covers: ['splits'],
    note: 'Q25: a requirement applied to each part separately ("each under 100 words") is no barrier.',
    scene: empty,
    text: 'Explain photosynthesis and explain gravity, each answer under 100 words',
    decomposition: {
      fragments: [
        { part: 'Explain photosynthesis', instruction: 'Explain photosynthesis.', label: 'photosynthesis', requirements: [{ text: 'Under 100 words', part: 'each answer under 100 words' }] },
        { part: 'explain gravity', instruction: 'Explain gravity.', label: 'gravity', requirements: [{ text: 'Under 100 words', part: 'each answer under 100 words' }] },
      ],
      barrier: { reason: 'combined-limit', qualifier: 'each answer under 100 words' },
    },
    expect: { composition: 'independent-composite', barrier: false, parts: [{ kind: 'unit', relation: 'new' }, { kind: 'unit', relation: 'new' }] },
  },
  {
    id: 'split-topological-order',
    covers: ['splits', 'dependencies', 'placement'],
    note: '02: with A already sent and one message asking for B, C and J (J needs A, B and C), the split messages appear as B, C, J.',
    scene: tripOneRunning,
    text: BCJ,
    decomposition: {
      fragments: [
        { part: 'Suggest rainy-day activities', instruction: 'Suggest rainy-day activities for the trip.', label: 'activities' },
        { part: 'suggest evening activities', instruction: 'Suggest evening activities for the trip.', label: 'evening activities' },
        {
          part: 'make an itinerary from the neighborhoods and both of those',
          instruction: 'Make an itinerary from the neighborhoods, the rainy-day activities and the evening activities.',
          label: 'itinerary',
          after: [0, 1],
        },
      ],
    },
    expect: {
      composition: 'sequential-composite',
      order: [0, 1, 2],
      parts: [
        { kind: 'unit', relation: 'addition', targets: ['brief'], placement: { continue: 'brief' }, prerequisites: [] },
        { kind: 'unit', relation: 'addition', targets: ['brief'], placement: { continue: 'brief' }, prerequisites: [] },
        { kind: 'unit', relation: 'result-dependent', targets: ['A'], placement: { join: ['A', 'part:0', 'part:1'] }, prerequisites: ['A', 'part:0', 'part:1'], after: [0, 1] },
      ],
    },
  },
  {
    id: 'split-correction-and-new-work',
    covers: ['splits', 'revision'],
    note: 'PLAN §2: a composite with one corrective fragment and one new fragment: a revision beside a unit, not grouped.',
    scene: tripClosed,
    text: 'Actually use a luxury budget for the neighborhoods, and also suggest some day trips',
    decomposition: {
      fragments: [
        { part: 'Actually use a luxury budget for the neighborhoods', instruction: 'Use a luxury budget for the neighborhood recommendations.', label: 'luxury neighborhoods' },
        { part: 'also suggest some day trips', instruction: 'Suggest some day trips from Kyoto.', label: 'day trips' },
      ],
    },
    expect: {
      composition: 'independent-composite',
      parts: [
        { kind: 'revision', scope: 'work', targets: ['A'] },
        { kind: 'unit', relation: 'addition', chain: 'trip', placement: { continue: 'group:G' } },
      ],
    },
  },
  // ── clarification ──
  {
    id: 'clarification-missing',
    covers: ['clarification'],
    note: 'E2: a consequential missing preference elicits a clarification.',
    scene: empty,
    text: 'Recommend a hotel near the conference',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'new', placement: 'new-chain', clarification: 'missing-information' }] },
  },
  {
    id: 'clarification-incompatible',
    covers: ['clarification'],
    note: 'E2: incompatible user requirements elicit a clarification.',
    scene: empty,
    text: 'Write a 50-word summary of the Roman Empire that covers every emperor in detail',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'new', placement: 'new-chain', clarification: 'incompatible-requirements' }] },
  },
  {
    id: 'clarification-not-needed',
    covers: ['clarification'],
    note: 'Q34: ordinary vagueness that a sensible default resolves needs no question.',
    scene: empty,
    text: 'Recommend a good book for a long flight',
    expect: { composition: 'atomic', parts: [{ kind: 'unit', relation: 'new', placement: 'new-chain', clarification: false }] },
  },
  {
    id: 'clarification-one-part',
    covers: ['clarification', 'splits'],
    note: '02 edge case: the translation is answered at once; only the unclear explanation waits for a question.',
    scene: empty,
    text: 'Translate this menu into French: soup, bread, and explain what happened yesterday',
    decomposition: {
      fragments: [
        { part: 'Translate this menu into French: soup, bread', instruction: 'Translate this menu into French: soup, bread.', label: 'menu translation' },
        { part: 'explain what happened yesterday', instruction: 'Explain what happened yesterday.', label: 'yesterday' },
      ],
    },
    expect: {
      composition: 'independent-composite',
      parts: [
        { kind: 'unit', relation: 'new', clarification: false },
        { kind: 'unit', relation: 'new', clarification: 'missing-information' },
      ],
    },
  },
  {
    id: 'clarification-shared-requirement',
    covers: ['clarification', 'requirements'],
    note: '07: an ambiguous shared requirement blocks every fragment it applies to and is asked once.',
    scene: empty,
    text: 'Suggest a hotel and a restaurant, both near the venue',
    decomposition: {
      fragments: [
        { part: 'Suggest a hotel', instruction: 'Suggest a hotel.', label: 'hotel', requirements: [{ text: 'Near the venue', part: 'both near the venue' }] },
        { part: 'a restaurant', instruction: 'Suggest a restaurant.', label: 'restaurant', requirements: [{ text: 'Near the venue', part: 'both near the venue' }] },
      ],
    },
    expect: { composition: 'independent-composite', sharedClarification: true, parts: [{ kind: 'unit', relation: 'new' }, { kind: 'unit', relation: 'new' }] },
  },
  // ── requirement scope ──
  {
    id: 'requirements-local-brevity',
    covers: ['requirements'],
    note: 'D1: a local brevity instruction does not become a conversation-wide preference.',
    scene: sky,
    text: 'Explain rainbows briefly',
    expect: { composition: 'atomic', sessionWide: false, parts: [{ kind: 'unit', relation: 'new', placement: 'new-chain' }] },
  },
  {
    id: 'requirements-session-wide',
    covers: ['requirements'],
    note: 'Q17: "from now on" makes a requirement conversation-wide.',
    scene: empty,
    text: 'From now on, keep every answer under 100 words. Why is the sky blue?',
    decomposition: {
      fragments: [
        {
          part: 'Why is the sky blue?',
          instruction: 'Why is the sky blue?',
          label: 'sky',
          requirements: [{ text: 'Keep every answer under 100 words', part: 'keep every answer under 100 words', scope: 'session-wide' }],
        },
      ],
    },
    expect: { composition: 'atomic', sessionWide: true, parts: [{ kind: 'unit', relation: 'new', placement: 'new-chain' }] },
  },
]

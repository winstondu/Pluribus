import type { RunInspection } from '@pluribus/protocol'
import { fx, type Fixture } from '@/fixtures'
import { ALL_DEBUG_VIEWS, PREAMBLE, consumed, decision, debugApp } from '@/features/debug/fixture-support'

/**
 * Runs to inspect, each answered from a recorded `RunInspection`:
 *
 * - `stay`: a started first attempt on a fork.
 * - `itinerary`: two attempts of one directive. Attempt 1 finished and was
 *   then superseded by a revision; its record still shows exactly what it
 *   read. Attempt 2 is the replacement: it read attempt 1's answer and the
 *   correction, because the work it replaces had finished (06).
 * - `packing`: queued behind the itinerary. No attempt, so no input.
 */

const BRIEF = 'I am planning four days in Lisbon in May with my sister. We like walking and seafood.'
const BRIEF_ANSWER = 'Noted: Lisbon, four days in May, two people, walking and seafood. Tell me what to plan.'
const STAY = 'Where should we stay?'
const STAY_ANSWER = 'Alfama for views and fado, Baixa for flat walking and transit, Príncipe Real for restaurants.'
const FOOD = 'Which seafood places are worth it?'
const FOOD_ANSWER = 'Cervejaria Ramiro for shellfish, Sea Me for grilled fish, and the Time Out Market for variety.'
const ITINERARY = 'Use both to plan the four days. Keep each day under ten kilometres on foot.'
const ITINERARY_ANSWER =
  'Day 1: Baixa and Chiado. Day 2: Alfama and the castle. Day 3: Belém by tram. Day 4: Príncipe Real and the Time Out Market.'
const CORRECTION = 'Actually swap Belém for a day trip to Sintra.'
const ITINERARY_REVISED = 'Day 1: Baixa and Chiado. Day 2: Alfama and the castle. Day 3: Sintra by train, '
const PACKING = 'Then write a packing list for that plan.'

const id = fx.id

const initial = fx
  .conversation('run-inspection')
  .chain('lisbon', { label: 'Lisbon trip' })
  .chain('stay', { kind: 'fork', base: 'lisbon', label: 'where to stay' })
  .chain('food', { kind: 'fork', base: 'lisbon', label: 'seafood places' })

  .message('brief', BRIEF)
  .response('brief', { message: 'brief' })
  .section('brief', { response: 'brief', chain: 'lisbon', state: 'completed', title: 'trip brief' })
  .attempt('brief-1', { section: 'brief', state: 'completed', text: BRIEF_ANSWER })
  .message('stay', STAY)
  .message('food', FOOD)
  .response('stay', { message: 'stay' })
  .section('stay', { response: 'stay', chain: 'stay', state: 'completed', title: 'where to stay' })
  .attempt('stay-1', { section: 'stay', state: 'completed', text: STAY_ANSWER })
  .response('food', { message: 'food' })
  .section('food', { response: 'food', chain: 'food', state: 'completed', title: 'seafood places' })
  .attempt('food-1', { section: 'food', state: 'completed', text: FOOD_ANSWER })
  .message('itinerary', ITINERARY)
  .response('itinerary', { message: 'itinerary' })
  .section('itinerary', {
    response: 'itinerary',
    chain: 'lisbon',
    state: 'superseded',
    title: 'itinerary',
    superseded: { by: 'itinerary-revised' },
  })
  .attempt('itinerary-1', { section: 'itinerary', state: 'completed', text: ITINERARY_ANSWER })
  .message('fix', CORRECTION, { chains: ['lisbon'], replyingTo: { sections: ['itinerary'], mode: 'inferred' } })
  .response('itinerary-revised', { message: 'itinerary', reason: 'revision-replacement' })
  .section('itinerary-revised', {
    response: 'itinerary-revised',
    chain: 'lisbon',
    state: 'streaming',
    title: 'itinerary',
    directive: 'itinerary',
    replaces: 'itinerary',
  })
  .attempt('itinerary-2', { section: 'itinerary-revised', state: 'streaming', origin: 'revision', text: ITINERARY_REVISED })
  .message('packing', PACKING)
  .response('packing', { message: 'packing' })
  .section('packing', {
    response: 'packing',
    chain: 'lisbon',
    state: 'pending',
    title: 'packing list',
    status: { kind: 'waiting-for-results', text: 'Waiting for itinerary' },
  })
  .queueItem('packing', {
    directive: 'packing',
    message: 'packing',
    state: 'waiting',
    waitingFor: [{ label: 'itinerary', directives: ['itinerary'] }],
  })

  .node('brief', { chain: 'lisbon', directive: 'brief' })
  .node('stay', { chain: 'stay', directive: 'stay', parents: ['brief'], group: 'forks' })
  .node('food', { chain: 'food', directive: 'food', parents: ['brief'], group: 'forks' })
  .group('forks', { start: 'brief', base: 'lisbon', members: ['stay', 'food'] })
  .joinBack('join-back', { group: 'forks' })
  .node('itinerary', { chain: 'lisbon', directive: 'itinerary', section: 'itinerary', parents: ['join-back'] })
  .node('itinerary-revised', {
    chain: 'lisbon',
    directive: 'itinerary',
    section: 'itinerary-revised',
    parents: ['join-back'],
    reason: 'revision',
    replaces: 'itinerary',
    label: 'itinerary, revised',
  })
  .node('packing', { chain: 'lisbon', directive: 'packing', parents: ['itinerary-revised'], parentsExact: false })

  .focus('stay', { inherited: { messages: ['brief'], sections: ['brief'] } })
  .focus('food', { inherited: { messages: ['brief'], sections: ['brief'] } })
  .focus('lisbon', { inherited: { messages: ['stay', 'food'], sections: ['stay', 'food'] } })

  .operation('brief', { chain: 'lisbon', status: 'completed', section: 'brief', retired: true })
  .operation('stay', { chain: 'stay', status: 'completed', section: 'stay', retired: true })
  .operation('food', { chain: 'food', status: 'completed', section: 'food', retired: true })
  .operation('join-back', {
    chain: 'lisbon',
    status: 'formed',
    label: 'where to stay + seafood places',
    group: 'forks',
    joinBack: 'join-back',
    dependsOn: ['stay', 'food'],
    retired: true,
  })
  .operation('itinerary', { chain: 'lisbon', status: 'superseded', section: 'itinerary', dependsOn: ['join-back'], retired: true })
  .operation('itinerary-revised', { chain: 'lisbon', status: 'streaming', section: 'itinerary-revised', dependsOn: ['join-back'] })
  .operation('packing', {
    chain: 'lisbon',
    status: 'waiting-for-results',
    statusText: 'Waiting for itinerary',
    section: 'packing',
    dependsOn: ['itinerary-revised'],
    waitingFor: ['itinerary-revised'],
  })
  .build()

// ───────────────────────── the recorded runs ─────────────────────────

const T0 = Date.UTC(2026, 4, 2, 9, 0, 0)
const MODEL = 'anthropic/claude-sonnet-5.5'
const joinBackId = id('joinBack', 'join-back')

const briefExchange = [
  {
    role: 'user' as const,
    content: BRIEF,
    origin: {
      kind: 'ancestor-request' as const,
      nodeId: id('node', 'brief'),
      directiveId: id('directive', 'brief'),
      messageId: id('message', 'brief'),
      joinBackId: null,
    },
  },
  {
    role: 'assistant' as const,
    content: BRIEF_ANSWER,
    origin: {
      kind: 'ancestor-answer' as const,
      nodeId: id('node', 'brief'),
      directiveId: id('directive', 'brief'),
      attemptId: id('attempt', 'brief-1'),
      sectionId: id('section', 'brief'),
      joinBackId: null,
    },
  },
]

const preamble = { role: 'system' as const, content: PREAMBLE, origin: { kind: 'preamble' as const } }

/** The two forks as the join-back recorded them, in the order they were sent. */
const joinBackRecord = (['stay', 'food'] as const).flatMap((name) => [
  {
    role: 'user' as const,
    content: name === 'stay' ? STAY : FOOD,
    origin: {
      kind: 'ancestor-request' as const,
      nodeId: id('node', name),
      directiveId: id('directive', name),
      messageId: id('message', name),
      joinBackId,
    },
  },
  {
    role: 'assistant' as const,
    content: name === 'stay' ? STAY_ANSWER : FOOD_ANSWER,
    origin: {
      kind: 'ancestor-answer' as const,
      nodeId: id('node', name),
      directiveId: id('directive', name),
      attemptId: id('attempt', `${name}-1`),
      sectionId: id('section', name),
      joinBackId,
    },
  },
])

const itineraryAncestry = [
  { nodeId: id('node', 'brief'), chainId: id('chain', 'lisbon'), label: 'trip brief' },
  { nodeId: id('node', 'stay'), chainId: id('chain', 'stay'), label: 'where to stay' },
  { nodeId: id('node', 'food'), chainId: id('chain', 'food'), label: 'seafood places' },
  { nodeId: id('node', 'join-back'), chainId: id('chain', 'lisbon'), label: 'join-back' },
]

const itineraryInputs = [
  { directiveId: id('directive', 'brief'), attemptId: id('attempt', 'brief-1'), marker: null },
  { directiveId: id('directive', 'stay'), attemptId: id('attempt', 'stay-1'), marker: null },
  { directiveId: id('directive', 'food'), attemptId: id('attempt', 'food-1'), marker: null },
]

const dailyLimit = {
  id: id('requirement', 'itinerary-1'),
  text: 'Keep each day under ten kilometres on foot.',
  scope: 'local' as const,
  shared: false,
  provenance: {
    messageId: id('message', 'itinerary'),
    span: { start: ITINERARY.indexOf('Keep each day'), end: ITINERARY.length },
  },
}

/** The wording of a question about one section by itself, as the pipeline asks it. */
const OWN = (n: string, title: string): string =>
  `Does the new message refer to answer section ${n} ("${title}"): reply to it, build on it, compare or combine it with another answer, or correct it?`
const SHOWN_BRIEF_OPENING =
  'Four days in Lisbon in May: warm days, cool evenings, and hills everywhere. Plan one neighbourhood a day, keep the tram 28 for an early morning, and leave an afternoon open for a day trip. Book the castle and the Jerónimos monastery ahead; both have long queues by ten.'
const SHOWN_FOOD_OPENING =
  'Cervejaria Ramiro for prawns and clams (no booking, go before seven). Taberna da Rua das Flores for small plates. Sea Me in Chiado for a modern take. In Belém, the grilled sardines at the stalls by the river are the cheap and right answer in May,'
const SHOWN_FOOD_PASSAGE =
  '## Walking between them Ramiro is at the bottom of Avenida Almirante Reis, an easy walk from Baixa on the flat. Taberna da Rua das Flores is a short climb into Chiado. Plan both on days you are already near; neither is worth a cross-town trip on foot when the day is long.'

const itineraryRouting = decision(
  {
    key: 'message',
    fragmentId: null,
    relation: { value: 'result-dependent', confidence: 0.91 },
    correctiveConfidence: 0.04,
    targets: {
      sectionIds: [id('section', 'stay'), id('section', 'food')],
      mode: 'inferred',
      candidates: [
        { sectionId: id('section', 'stay'), confidence: 0.88 },
        { sectionId: id('section', 'food'), confidence: 0.86 },
        { sectionId: id('section', 'brief'), confidence: 0.21 },
      ],
      redirected: [],
    },
    placement: { value: { kind: 'continue', buildsOn: { kind: 'sibling-group', groupId: id('siblingGroup', 'forks') } }, confidence: 0.9 },
    prerequisites: { value: [{ kind: 'sibling-group', groupId: id('siblingGroup', 'forks') }], confidence: 0.87 },
    needsClarification: 0.06,
    explanation: '“Both” was read as the two parallel answers, so the work continues from their join-back and waits for it.',
  },
  {
    questions: [
      {
        id: 'q-composite',
        type: 'noul',
        instructions: 'Does the message contain independent requests that can be answered separately?',
        candidates: {},
        answer: 0.08,
        confidence: 0.92,
        probabilities: null,
      },
      {
        id: 'q-target',
        type: 'choice',
        instructions: 'Which existing answers does “both” refer to?',
        candidates: { stay: 'where to stay', food: 'seafood places', brief: 'trip brief' },
        answer: 'stay+food',
        confidence: 0.88,
        probabilities: null,
      },
      {
        id: 'm_s1',
        type: 'noul',
        instructions: OWN('S1', 'trip brief'),
        candidates: {},
        answer: 0.21,
        confidence: null,
        probabilities: null,
      },
      {
        id: 'm_s2',
        type: 'noul',
        instructions: OWN('S2', 'where to stay'),
        candidates: {},
        answer: 0.88,
        confidence: null,
        probabilities: null,
      },
      {
        id: 'm_s3',
        type: 'noul',
        instructions: OWN('S3', 'seafood places'),
        candidates: {},
        answer: 0.86,
        confidence: null,
        probabilities: null,
      },
    ],
    shownRecorded: true,
  },
  [
    null,
    null,
    [{ sectionId: id('section', 'brief'), form: 'opening', text: `S1. "trip brief": request "Trip brief: Lisbon, four days, in May"; answer "${SHOWN_BRIEF_OPENING}"` }],
    [{ sectionId: id('section', 'stay'), form: 'full', text: `S2. "where to stay": request "${STAY}"; answer "${STAY_ANSWER}"` }],
    [
      {
        sectionId: id('section', 'food'),
        form: 'passages',
        text: `S3. "seafood places": request "Which seafood places should we try?"; answer, its opening and the passages that share the most words with the message: "${SHOWN_FOOD_OPENING}" … "${SHOWN_FOOD_PASSAGE}"`,
      },
    ],
  ],
)

const itineraryAttempts = [
  { attemptId: id('attempt', 'itinerary-1'), number: 1, resultStatus: 'superseded' as const, sectionId: id('section', 'itinerary') },
  { attemptId: id('attempt', 'itinerary-2'), number: 2, resultStatus: 'in-flight' as const, sectionId: id('section', 'itinerary-revised') },
]

const itineraryBase = {
  directiveId: id('directive', 'itinerary'),
  source: { originalMessageId: id('message', 'itinerary'), originalText: ITINERARY, fragment: null },
  instruction: 'Use both to plan the four days.',
  requirements: [dailyLimit],
  readiness: { readiness: { kind: 'ready' }, source: 'preparation', awaitingResults: false, basis: '8:5f1c2a9e3b7d4c60', model: 'anthropic/claude-haiku-5.5' } as const,
  pauseReason: null,
  waitingFor: [],
  barrier: null,
  ancestry: itineraryAncestry,
  routing: itineraryRouting,
  directiveState: 'running' as const,
  attempts: itineraryAttempts,
}

/** Attempt 1: finished, later superseded. The record is what it read then, and is not touched by the revision. */
const itineraryFirst: RunInspection = {
  ...itineraryBase,
  attemptId: id('attempt', 'itinerary-1'),
  input: consumed(
    [
      preamble,
      ...briefExchange,
      ...joinBackRecord,
      {
        role: 'user',
        content: `${itineraryBase.instruction}\n\nRequirements:\n- ${dailyLimit.text}`,
        origin: { kind: 'request', directiveId: id('directive', 'itinerary'), messageId: id('message', 'itinerary'), fragmentId: null },
      },
    ],
    { nodeIds: itineraryAncestry.map((entry) => entry.nodeId), inputs: itineraryInputs, inputTokens: 412 },
  ),
  attempt: {
    number: 1,
    origin: 'initial',
    state: 'completed',
    resultStatus: 'superseded',
    model: MODEL,
    provider: 'openrouter',
    modelRole: 'answer',
    chainId: id('chain', 'lisbon'),
    nodeId: id('node', 'itinerary'),
    startedAt: T0 + 95_000,
    endedAt: T0 + 109_000,
    failure: null,
  },
  section: { sectionId: id('section', 'itinerary'), responseId: id('response', 'itinerary'), title: 'itinerary' },
}

/** Attempt 2: the replacement of finished work. It reads the old exchange and then the correction (06). */
const itinerarySecond: RunInspection = {
  ...itineraryBase,
  attemptId: id('attempt', 'itinerary-2'),
  input: consumed(
    [
      preamble,
      ...briefExchange,
      ...joinBackRecord,
      {
        role: 'user',
        content: `${itineraryBase.instruction}\n\nRequirements:\n- ${dailyLimit.text}`,
        origin: { kind: 'request', directiveId: id('directive', 'itinerary'), messageId: id('message', 'itinerary'), fragmentId: null },
      },
      {
        role: 'assistant',
        content: ITINERARY_ANSWER,
        origin: {
          kind: 'ancestor-answer',
          nodeId: id('node', 'itinerary'),
          directiveId: id('directive', 'itinerary'),
          attemptId: id('attempt', 'itinerary-1'),
          sectionId: id('section', 'itinerary'),
          joinBackId: null,
        },
      },
      {
        role: 'user',
        content: CORRECTION,
        origin: { kind: 'correction', revisionMessageId: id('message', 'fix'), directiveId: id('directive', 'itinerary') },
      },
    ],
    {
      nodeIds: itineraryAncestry.map((entry) => entry.nodeId),
      inputs: itineraryInputs,
      corrections: [id('message', 'fix')],
      inputTokens: 498,
    },
  ),
  attempt: {
    number: 2,
    origin: 'revision',
    state: 'streaming',
    resultStatus: 'in-flight',
    model: MODEL,
    provider: 'openrouter',
    modelRole: 'answer',
    chainId: id('chain', 'lisbon'),
    nodeId: id('node', 'itinerary-revised'),
    startedAt: T0 + 171_000,
    endedAt: null,
    failure: null,
  },
  section: { sectionId: id('section', 'itinerary-revised'), responseId: id('response', 'itinerary-revised'), title: 'itinerary' },
}

/** A started first attempt on a fork: it read the brief, and nothing of its sibling. */
const stay: RunInspection = {
  directiveId: id('directive', 'stay'),
  attemptId: id('attempt', 'stay-1'),
  source: { originalMessageId: id('message', 'stay'), originalText: STAY, fragment: null },
  instruction: STAY,
  requirements: [],
  input: consumed(
    [
      preamble,
      ...briefExchange,
      {
        role: 'user',
        content: STAY,
        origin: { kind: 'request', directiveId: id('directive', 'stay'), messageId: id('message', 'stay'), fragmentId: null },
      },
    ],
    {
      nodeIds: [id('node', 'brief')],
      inputs: [{ directiveId: id('directive', 'brief'), attemptId: id('attempt', 'brief-1'), marker: null }],
      inputTokens: 143,
    },
  ),
  readiness: { readiness: { kind: 'ready' }, source: 'routing', awaitingResults: false, basis: null, model: 'typesafe/jev-1.13' } as const,
  pauseReason: null,
  waitingFor: [],
  barrier: null,
  ancestry: [{ nodeId: id('node', 'brief'), chainId: id('chain', 'lisbon'), label: 'trip brief' }],
  routing: decision({
    key: 'message',
    fragmentId: null,
    relation: { value: 'addition', confidence: 0.93 },
    correctiveConfidence: 0.02,
    targets: {
      sectionIds: [id('section', 'brief')],
      mode: 'inferred',
      candidates: [{ sectionId: id('section', 'brief'), confidence: 0.9 }],
      redirected: [],
    },
    placement: { value: { kind: 'continue', buildsOn: { kind: 'node', nodeId: id('node', 'brief') } }, confidence: 0.93 },
    prerequisites: { value: [], confidence: 0.95 },
    needsClarification: 0.05,
    explanation: 'It builds on the trip brief and needs no unfinished result, so it started at once beside the other request.',
  }),
  attempt: {
    number: 1,
    origin: 'initial',
    state: 'completed',
    resultStatus: 'current',
    model: MODEL,
    provider: 'openrouter',
    modelRole: 'answer',
    chainId: id('chain', 'stay'),
    nodeId: id('node', 'stay'),
    startedAt: T0 + 31_000,
    endedAt: T0 + 44_000,
    failure: null,
  },
  directiveState: 'completed',
  attempts: [{ attemptId: id('attempt', 'stay-1'), number: 1, resultStatus: 'current', sectionId: id('section', 'stay') }],
  section: { sectionId: id('section', 'stay'), responseId: id('response', 'stay'), title: 'where to stay' },
}

/** Queued: nothing has been sent, and what it waits for is listed apart from any context. */
const packing: RunInspection = {
  directiveId: id('directive', 'packing'),
  attemptId: null,
  source: { originalMessageId: id('message', 'packing'), originalText: PACKING, fragment: null },
  instruction: PACKING,
  requirements: [],
  input: null,
  readiness: { readiness: { kind: 'ready' }, source: 'routing', awaitingResults: true, basis: null, model: 'typesafe/jev-1.13' } as const,
  pauseReason: null,
  waitingFor: [
    {
      ref: { kind: 'directive', directiveId: id('directive', 'itinerary') },
      label: 'itinerary',
      directiveIds: [id('directive', 'itinerary')],
    },
  ],
  barrier: null,
  ancestry: [],
  routing: decision({
    key: 'message',
    fragmentId: null,
    relation: { value: 'result-dependent', confidence: 0.89 },
    correctiveConfidence: 0.03,
    targets: {
      sectionIds: [id('section', 'itinerary-revised')],
      mode: 'inferred',
      candidates: [{ sectionId: id('section', 'itinerary-revised'), confidence: 0.84 }],
      redirected: [],
    },
    placement: { value: { kind: 'continue', buildsOn: { kind: 'node', nodeId: id('node', 'itinerary-revised') } }, confidence: 0.88 },
    prerequisites: { value: [{ kind: 'directive', directiveId: id('directive', 'itinerary') }], confidence: 0.9 },
    needsClarification: 0.07,
    explanation: '“That plan” is the itinerary, which is still being written, so the packing list waits for it.',
  }, {
    // Recorded before the text a question showed of its sections was kept: the inspector shows the question alone.
    questions: [
      {
        id: 'm_s4',
        type: 'noul',
        instructions: OWN('S4', 'itinerary'),
        candidates: {},
        answer: 0.84,
        confidence: null,
        probabilities: null,
      },
    ],
    // A strategy selector was on: the decision model was not confident, so the rules chose.
    strategySelection: {
      selector: 'rules',
      choice: { strategy: 'tree-walk', startAtTrunkBase: false, searchLongRuns: true },
      signature: 'v1|s6|w4|r2|o0|p2|d2|g0.1|k7|t3.2.0s|b3.4.2.3l|q5',
      reason: 'The decision model chose one-pass with confidence 0.58, below 0.70. By the rules: 9 answers are older than the routing request lists, which only the tree walk reaches; long runs are searched.',
      scores: { strategy: 0.58 },
      fallback: 'low-confidence',
      reused: false,
    },
    // The word index handed the walk two places to start: the itinerary the message means, and the brief, which shares its words.
    candidateSource: {
      source: 'lexical',
      units: [
        {
          unit: 'message',
          candidates: [
            { sectionId: id('section', 'itinerary-revised'), score: 6.4 },
            { sectionId: id('section', 'brief'), score: 3.9 },
          ],
        },
      ],
    },
    // The token budget stopped the walk; the target was clear from what had been asked, so nothing had to be taken below the threshold.
    budgetStop: { limit: 'token-budget', fallback: 'one-pass', bestFound: [] },
    // Hop between branch points was on: the line from the brief to the itinerary was asked about as one, and the message was placed on its last answer.
    runEnds: [
      {
        unit: 'message',
        sectionId: id('section', 'itinerary-revised'),
        confidence: 0.84,
        run: { firstSectionId: id('section', 'brief'), lastSectionId: id('section', 'itinerary-revised'), sections: 2 },
        evidence: { firstSectionId: id('section', 'brief'), lastSectionId: id('section', 'itinerary-revised'), sections: 2 },
        limitedByContext: false,
      },
    ],
  }),
  attempt: null,
  directiveState: 'dependency-queued',
  attempts: [],
  section: { sectionId: id('section', 'packing'), responseId: id('response', 'packing'), title: 'packing list' },
}

const fixture: Fixture = {
  id: 'run-inspection',
  title: 'Runs to inspect',
  covers: ['run inspector', 'seven items', 'recorded model input', 'superseded attempt', 'replacement of finished work', 'queued directive', 'C10'],
  app: debugApp(ALL_DEBUG_VIEWS),
  initial,
  runs: {
    [id('directive', 'stay')]: { latest: stay },
    [id('directive', 'itinerary')]: {
      latest: itinerarySecond,
      byAttempt: { [id('attempt', 'itinerary-1')]: itineraryFirst, [id('attempt', 'itinerary-2')]: itinerarySecond },
    },
    [id('directive', 'packing')]: { latest: packing },
  },
}

export default fixture

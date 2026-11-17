import { fx, type Fixture } from '@/fixtures'

/**
 * The running example of 04, with all four projections filled.
 *
 *   brief ─┬─ A (neighborhoods) ─┬─ join-back ── J (itinerary) ─┐
 *          └─ B (rainy days) ────┘                              ├─ X (join chain) ── K (queued)
 *                └─ B2 (cheaper alternatives, a branch) ────────┘
 *   S (why is the sky blue?), an unrelated root
 *
 * Colors: the trip chain, fork A, fork B, the sky chain, branch B2 and the
 * join chain each have their own; the join-back and J use the trip chain's.
 */
const trip = fx
  .conversation('trip')
  .chain('trip', { label: 'Kyoto trip' })
  .chain('hoods', { kind: 'fork', base: 'trip', label: 'neighborhoods' })
  .chain('rain', { kind: 'fork', base: 'trip', label: 'rainy-day activities' })
  .chain('sky', { label: 'why the sky is blue' })
  .chain('cheaper', { kind: 'branch', base: 'rain', label: 'cheaper alternatives' })
  .chain('combined', { kind: 'join', label: 'combined plan' })

  // ── transcript ──
  .message('brief', 'I am planning five days in Kyoto in November on a moderate budget.')
  .response('brief', { message: 'brief' })
  .section('brief', { response: 'brief', chain: 'trip', state: 'completed', title: 'trip brief' })
  .attempt('brief-1', {
    section: 'brief',
    state: 'completed',
    text: 'Noted: Kyoto, five days, November, moderate budget. Ask for anything you want planned.',
  })
  .message('A', 'Suggest neighborhoods to stay in.')
  .message('B', 'Suggest rainy-day activities.')
  .response('B', { message: 'B' })
  .section('B', { response: 'B', chain: 'rain', state: 'completed', title: 'rainy-day activities' })
  .attempt('B-1', {
    section: 'B',
    state: 'completed',
    text: 'When it rains: the Kyoto Railway Museum, the covered Nishiki Market, a tea ceremony in Gion, and the Kyoto National Museum.',
  })
  .message('S', 'Why is the sky blue?')
  .response('S', { message: 'S' })
  .section('S', { response: 'S', chain: 'sky', state: 'completed', title: 'why the sky is blue' })
  .attempt('S-1', {
    section: 'S',
    state: 'completed',
    text: 'Air molecules scatter short blue wavelengths of sunlight far more than long red ones, so blue light reaches you from every direction.',
  })
  .response('A', { message: 'A' })
  .section('A', { response: 'A', chain: 'hoods', state: 'completed', title: 'neighborhoods' })
  .attempt('A-1', {
    section: 'A',
    state: 'completed',
    text: 'Gion for atmosphere and evening walks; the Kyoto Station area for transit and value; Nakagyo for food and a central base.',
  })
  .message('J', 'Use those recommendations to make a five-day itinerary.')
  .response('J', { message: 'J' })
  .section('J', { response: 'J', chain: 'trip', state: 'completed', title: 'itinerary' })
  .attempt('J-1', {
    section: 'J',
    state: 'completed',
    text: 'Day 1: settle into Nakagyo, Nishiki Market. Day 2: Higashiyama and Gion. Day 3: Arashiyama. Day 4: Fushimi Inari, then the Railway Museum if it rains. Day 5: Nara.',
  })
  .message('B2', 'Give me three cheaper alternatives.', { replyingTo: { sections: ['B'] } })
  .response('B2', { message: 'B2' })
  .section('B2', { response: 'B2', chain: 'cheaper', state: 'completed', title: 'cheaper alternatives' })
  .attempt('B2-1', {
    section: 'B2',
    state: 'completed',
    text: 'Free or nearly: the Kyoto Station building and its skyway, the covered Teramachi arcade, and the Kyoto City Library of Historical Documents.',
  })
  .message('X', 'Fit the cheaper alternatives into the itinerary.')
  .response('X', { message: 'X' })
  .section('X', { response: 'X', chain: 'combined', state: 'streaming', title: 'combined plan' })
  .attempt('X-1', {
    section: 'X',
    state: 'streaming',
    model: 'anthropic/claude-sonnet-5.5',
    text: 'Keeping the five days as they are, the cheaper options slot in as rain plans: on Day 1 swap the museum for the Teramachi arcade, ',
  })
  .message('K', 'Then write a packing list for that plan.')
  .response('K', { message: 'K' })
  .section('K', {
    response: 'K',
    chain: 'combined',
    state: 'pending',
    title: 'packing list',
    status: { kind: 'waiting-for-results', text: 'Waiting for combined plan' },
  })
  .order('m:brief', 'r:brief', 'm:A', 'm:B', 'r:B', 'm:S', 'r:S', 'r:A', 'm:J', 'r:J', 'm:B2', 'r:B2', 'm:X', 'r:X', 'm:K', 'r:K')

  // ── queue ──
  .queueItem('K', {
    directive: 'K',
    message: 'K',
    state: 'waiting',
    waitingFor: [{ label: 'combined plan', directives: ['X'] }],
  })

  // ── genealogy ──
  .node('brief', { chain: 'trip', directive: 'brief' })
  .node('A', { chain: 'hoods', directive: 'A', parents: ['brief'], group: 'forks' })
  .node('B', { chain: 'rain', directive: 'B', parents: ['brief'], group: 'forks' })
  .node('S', { chain: 'sky', directive: 'S' })
  .group('forks', { start: 'brief', base: 'trip', members: ['A', 'B'] })
  .joinBack('join-back', { group: 'forks' })
  .node('J', { chain: 'trip', directive: 'J', parents: ['join-back'] })
  .node('B2', { chain: 'cheaper', directive: 'B2', parents: ['B'] })
  .node('X', { chain: 'combined', directive: 'X', parents: ['J', 'B2'] })
  .node('K', { chain: 'combined', directive: 'K', parents: ['X'], parentsExact: false })

  // ── Focus: what each chain's runs read beyond what the chain handled ──
  .focus('hoods', { inherited: { messages: ['brief'], sections: ['brief'] } })
  .focus('rain', { inherited: { messages: ['brief'], sections: ['brief'] } })
  .focus('trip', { inherited: { messages: ['A', 'B'], sections: ['A', 'B'] } })
  .focus('cheaper', { inherited: { messages: ['brief', 'B'], sections: ['brief', 'B'] } })
  .focus('combined', {
    inherited: { messages: ['brief', 'A', 'B', 'J', 'B2'], sections: ['brief', 'A', 'B', 'J', 'B2'] },
  })

  // ── operation graph ──
  .operation('brief', { chain: 'trip', status: 'completed', section: 'brief', retired: true })
  .operation('B', { chain: 'rain', status: 'completed', section: 'B', retired: true })
  .operation('S', { chain: 'sky', status: 'completed', section: 'S', retired: true })
  .operation('A', { chain: 'hoods', status: 'completed', section: 'A', retired: true })
  .operation('join-back', {
    chain: 'trip',
    status: 'formed',
    label: 'neighborhoods + rainy-day activities',
    group: 'forks',
    joinBack: 'join-back',
    dependsOn: ['A', 'B'],
    retired: true,
  })
  .operation('J', { chain: 'trip', status: 'completed', section: 'J', dependsOn: ['join-back'], retired: true })
  .operation('B2', { chain: 'cheaper', status: 'completed', section: 'B2', retired: true })
  .operation('X', { chain: 'combined', status: 'streaming', kind: 'synthesis', section: 'X' })
  .operation('K', {
    chain: 'combined',
    status: 'waiting-for-results',
    statusText: 'Waiting for combined plan',
    kind: 'synthesis',
    section: 'K',
    dependsOn: ['X'],
    waitingFor: ['X'],
  })
  .build()

const other = fx
  .conversation('sourdough')
  .chain('bread', { label: 'sourdough starter' })
  .message('starter', 'How do I keep a sourdough starter alive if I only bake on weekends?')
  .response('starter', { message: 'starter' })
  .section('starter', { response: 'starter', chain: 'bread', state: 'completed', title: 'sourdough starter' })
  .attempt('starter-1', {
    section: 'starter',
    state: 'completed',
    text: 'Keep it in the fridge. Feed it once a week: discard all but a spoonful, add equal weights of flour and water, and leave it out for a few hours before it goes back in the cold.',
  })
  .node('starter', { chain: 'bread', directive: 'starter' })
  .operation('starter', { chain: 'bread', status: 'completed', section: 'starter', retired: true })
  .build()

const fixture: Fixture = {
  id: 'trip',
  title: 'Kyoto in November',
  covers: [
    'C',
    'running example of 04',
    'forks',
    'join-back',
    'branch',
    'join chain',
    'unrelated root',
    'queue item',
    'all four projections',
    'second conversation',
  ],
  initial: trip,
  others: [other],
  titles: { [other.conversationId]: 'Weekend sourdough' },
  steps: [
    {
      label: 'The combined plan keeps streaming',
      delayMs: 900,
      next: (previous) =>
        fx.from(previous).appendText('X-1', 'on Day 2 keep Gion but end at the free station skyway for the night view, ').build(),
    },
    {
      label: 'The combined plan completes; the packing list is released and its queue item clears',
      delayMs: 1200,
      next: (previous) =>
        fx
          .from(previous)
          .appendText('X-1', 'and on Day 4 use the library if the Railway Museum feels like too much.')
          .patch('section', 'X', { state: 'completed' })
          .patch('attempt', 'X-1', { state: 'completed' })
          .remove('queueItem', 'K')
          .patch('section', 'K', { status: 'responding' })
          .attempt('K-1', { section: 'K', state: 'running', model: 'anthropic/claude-sonnet-5.5' })
          .patch('node', 'K', { parentsExact: true })
          .patch('operation', 'X', { status: 'completed', retired: true })
          .patch('operation', 'K', { status: 'running', statusText: 'Responding…', waitingFor: [] })
          .build(),
    },
    {
      label: 'The packing list shows its first text and takes its place',
      delayMs: 1000,
      next: (previous) =>
        fx
          .from(previous)
          .patch('section', 'K', { state: 'streaming', status: null })
          .patch('attempt', 'K-1', { state: 'streaming', text: 'For this plan: layers for 8–17 °C, a compact umbrella, ' })
          .patch('operation', 'K', { status: 'streaming', statusText: 'Streaming' })
          .build(),
    },
  ],
}

export default fixture

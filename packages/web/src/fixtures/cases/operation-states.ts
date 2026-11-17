import { WORDING } from '@pluribus/protocol'
import { fx, type Fixture } from '@/fixtures'
import { debugApp } from '@/features/debug/fixture-support'

const PREP = 'For my conference talk: draft the outline, suggest a slide structure, and script the live demo.'
const QA = 'First give me a timing plan, then prepare Q&A answers based on the speaker page. In that order, please.'

/**
 * The operation graph with every status of 08 at once.
 *
 *   depth 0                         depth 1                   depth 2          depth 3
 *   outline (streaming)             join-back (group open) ─▶ speaker page ─▶ Q&A prep
 *   slides (waiting for capacity)      ▲   ▲                       ┊
 *   demo script (failed) ───────────▶ rehearsal plan (paused)      ┊ barrier
 *   abstract (running) ────────────────┘   │                       ▼
 *   bio (retrying) ────────────────────────┘                  timing plan (held by the barrier, depth 0)
 *   title ideas (waiting for a free slot)
 *   handout (waiting for your answer)
 *   venue notes (interrupted), travel tips (stopped)
 *
 * The slide structure is a pending section inside a reply group that is
 * already placed: its only route from here is "Show in transcript" (Q81).
 * The timing plan needs nothing itself; it is held because its message asked
 * for its outputs in order and the other part is blocked (Q19).
 */
const initial = fx
  .conversation('operation-states')
  .chain('talk', { label: 'conference talk' })
  .chain('outline', { kind: 'fork', base: 'talk', label: 'outline' })
  .chain('slides', { kind: 'fork', base: 'talk', label: 'slide structure' })
  .chain('demo', { kind: 'fork', base: 'talk', label: 'demo script' })
  .chain('abstract', { kind: 'fork', base: 'talk', label: 'abstract' })
  .chain('bio', { kind: 'fork', base: 'talk', label: 'speaker bio' })
  .chain('misc', { label: 'venue and travel' })

  // ── retired work ──
  .message('brief', 'I am giving a 30-minute talk on offline-first apps at a regional conference in June.')
  .response('brief', { message: 'brief' })
  .section('brief', { response: 'brief', chain: 'talk', state: 'completed', title: 'talk brief' })
  .attempt('brief-1', { section: 'brief', state: 'completed', text: 'Noted: 30 minutes, offline-first apps, a regional conference in June.' })
  .message('hook', 'Give me an opening hook.')
  .response('hook', { message: 'hook' })
  .section('hook', { response: 'hook', chain: 'talk', state: 'superseded', title: 'opening hook', superseded: { by: 'hook-revised' } })
  .attempt('hook-1', { section: 'hook', state: 'completed', text: '“Your app works. Until the train enters a tunnel.”' })
  .message('hook-fix', 'Actually make the hook about a field hospital, not a train.', { chains: ['talk'], replyingTo: { sections: ['hook'], mode: 'inferred' } })
  .response('hook-revised', { message: 'hook', reason: 'revision-replacement' })
  .section('hook-revised', { response: 'hook-revised', chain: 'talk', state: 'completed', title: 'opening hook', directive: 'hook', replaces: 'hook' })
  .attempt('hook-2', { section: 'hook-revised', state: 'completed', origin: 'revision', text: '“The clinic has no signal. The app still has to save a life’s worth of notes.”' })
  .message('swag', 'Also list swag ideas.')
  .response('swag', { message: 'swag' })
  .section('swag', { response: 'swag', chain: 'misc', state: 'cancelled', title: 'swag ideas' })

  // ── a placed reply group with a pending section ──
  .message('prep', PREP, {
    decomposition: {
      fragments: [
        { label: 'outline', text: 'Draft the outline of a 30-minute conference talk on offline-first apps.', source: 'draft the outline', directive: 'outline', chain: 'outline', section: 'outline' },
        { label: 'slide structure', text: 'Suggest a slide structure for a 30-minute conference talk on offline-first apps.', source: 'suggest a slide structure', directive: 'slides', chain: 'slides', section: 'slides' },
        { label: 'demo script', text: 'Script the live demo for a 30-minute conference talk on offline-first apps.', source: 'script the live demo', directive: 'demo', chain: 'demo', section: 'demo' },
      ],
    },
  })
  .response('prep', { message: 'prep', grouped: true })
  .section('outline', { response: 'prep', chain: 'outline', state: 'streaming', title: 'outline' })
  .attempt('outline-1', { section: 'outline', state: 'streaming', text: '1. The tunnel problem (3 min). 2. What “offline-first” means (5 min). ' })
  .section('demo', { response: 'prep', chain: 'demo', state: 'failed', title: 'demo script', failure: fx.error('provider-error', 'The provider returned an error', 500) })
  .attempt('demo-1', { section: 'demo', state: 'failed', failure: fx.error('provider-error', 'The provider returned an error', 500) })
  .section('slides', {
    response: 'prep',
    chain: 'slides',
    state: 'pending',
    title: 'slide structure',
    directiveState: 'waiting-for-capacity',
    status: 'waiting-for-capacity',
  })

  // ── an open sibling group and work that waits for its join-back ──
  .message('abstract', 'Write the abstract.')
  .response('abstract', { message: 'abstract' })
  .section('abstract', { response: 'abstract', chain: 'abstract', state: 'pending', title: 'abstract', status: 'responding' })
  .attempt('abstract-1', { section: 'abstract', state: 'running' })
  .message('bio', 'Write a speaker bio.')
  .response('bio', { message: 'bio' })
  .section('bio', { response: 'bio', chain: 'bio', state: 'pending', title: 'speaker bio', directiveState: 'retrying', status: 'retrying' })
  .message('page', 'Use the abstract and the bio to write my speaker page.')
  .response('page', { message: 'page' })
  .section('page', {
    response: 'page',
    chain: 'talk',
    state: 'pending',
    title: 'speaker page',
    status: { kind: 'waiting-for-results', text: 'Waiting for abstract + speaker bio' },
  })
  .queueItem('page', {
    directive: 'page',
    message: 'page',
    state: 'waiting',
    waitingFor: [{ label: 'abstract + speaker bio', directives: ['abstract', 'bio'], group: 'forks' }],
  })

  // ── paused, waiting for a slot, waiting for an answer, interrupted, stopped ──
  .message('rehearsal', 'Plan a rehearsal around the demo script.')
  .response('rehearsal', { message: 'rehearsal' })
  .section('rehearsal', {
    response: 'rehearsal',
    chain: 'demo',
    state: 'pending',
    title: 'rehearsal plan',
    directiveState: 'paused',
    status: { kind: 'paused', text: 'Paused — demo script failed' },
  })
  .queueItem('rehearsal', {
    directive: 'rehearsal',
    message: 'rehearsal',
    state: 'paused',
    recovery: { elicitation: 'recover-rehearsal', cause: { directive: 'demo', label: 'demo script', outcome: 'failed' }, retrySection: 'demo' },
  })
  .message('titles', 'Suggest five titles.')
  .response('titles', { message: 'titles' })
  .section('titles', { response: 'titles', chain: 'talk', state: 'pending', title: 'title ideas', directiveState: 'ready', status: 'waiting-for-slot' })
  .message('handout', 'Make a handout for it.')
  .response('handout', { message: 'handout' })
  .section('handout', {
    response: 'handout',
    chain: 'talk',
    state: 'pending',
    title: 'handout',
    directiveState: 'awaiting-elicitation',
    status: 'awaiting-answer',
  })
  // Paused for the other reason: the run stopped to ask, and waits for the user's input, not for a recovery choice.
  .message('closing', 'Write the closing remarks.')
  .response('closing', { message: 'closing' })
  .section('closing', { response: 'closing', chain: 'talk', state: 'paused', title: 'closing remarks' })
  .attempt('closing-1', { section: 'closing', state: 'paused', text: 'Thank the organizers, then ' })
  .message('venue', 'What should I check about the venue?')
  .response('venue', { message: 'venue' })
  .section('venue', { response: 'venue', chain: 'misc', state: 'interrupted', title: 'venue notes' })
  .attempt('venue-1', { section: 'venue', state: 'interrupted', text: 'Check the projector’s aspect ratio and ' })
  .message('travel', 'Any travel tips?')
  .response('travel', { message: 'travel' })
  .section('travel', { response: 'travel', chain: 'misc', state: 'stopped', title: 'travel tips' })
  .attempt('travel-1', { section: 'travel', state: 'stopped', text: 'Arrive the evening before; ' })

  // ── a message whose parts wait together: the whole-request barrier ──
  .message('qa', QA, {
    decomposition: {
      barrier: { reason: 'explicit-order', qualifier: 'In that order, please.' },
      fragments: [
        { label: 'timing plan', text: 'Give a timing plan for a 30-minute talk on offline-first apps.', source: 'give me a timing plan', directive: 'timing', chain: 'talk', section: 'timing' },
        { label: 'Q&A prep', text: 'Prepare Q&A answers based on the speaker page.', source: 'prepare Q&A answers based on the speaker page', directive: 'qa-prep', chain: 'talk', section: 'qa-prep' },
      ],
    },
  })
  .response('qa', { message: 'qa', grouped: true })
  .section('timing', {
    response: 'qa',
    chain: 'talk',
    state: 'pending',
    title: 'timing plan',
    status: { kind: 'waiting-for-results', text: 'Waiting for speaker page' },
  })
  .section('qa-prep', {
    response: 'qa',
    chain: 'talk',
    state: 'pending',
    title: 'Q&A prep',
    status: { kind: 'waiting-for-results', text: 'Waiting for speaker page' },
  })
  .queueItem('timing', {
    directive: 'timing',
    message: 'qa',
    state: 'waiting',
    heldByBarrier: true,
    waitingFor: [{ label: 'speaker page', directives: ['page'] }],
  })
  .queueItem('qa-prep', { directive: 'qa-prep', message: 'qa', state: 'waiting', waitingFor: [{ label: 'speaker page', directives: ['page'] }] })

  // ── genealogy, as far as the group needs it ──
  .node('brief', { chain: 'talk', directive: 'brief' })
  .node('abstract', { chain: 'abstract', directive: 'abstract', parents: ['brief'], group: 'forks' })
  .node('bio', { chain: 'bio', directive: 'bio', parents: ['brief'], group: 'forks' })
  .group('forks', { start: 'brief', base: 'talk', members: ['abstract', 'bio'] })

  // ── operation graph ──
  .operation('brief', { chain: 'talk', status: 'completed', section: 'brief', retired: true })
  .operation('hook', { chain: 'talk', status: 'superseded', section: 'hook', retired: true })
  .operation('hook-revised', { chain: 'talk', status: 'completed', section: 'hook-revised', retired: true })
  .operation('swag', { chain: 'misc', status: 'cancelled', section: 'swag', retired: true })
  .operation('earlier-join', { chain: 'talk', kind: 'join-back', status: 'formed', label: 'dates + budget', retired: true })
  .operation('outline', { chain: 'outline', status: 'streaming', section: 'outline' })
  .operation('slides', { chain: 'slides', status: 'waiting-for-capacity', section: 'slides' })
  .operation('demo', { chain: 'demo', status: 'failed', section: 'demo' })
  .operation('abstract', { chain: 'abstract', status: 'running', section: 'abstract' })
  .operation('bio', { chain: 'bio', status: 'retrying', section: 'bio' })
  .operation('forks', {
    chain: 'talk',
    status: 'group-open',
    statusText: 'Waiting for abstract + speaker bio',
    label: 'abstract + speaker bio',
    group: 'forks',
    dependsOn: ['abstract', 'bio'],
    waitingFor: ['abstract', 'bio'],
  })
  .operation('page', {
    chain: 'talk',
    status: 'waiting-for-results',
    statusText: 'Waiting for abstract + speaker bio',
    section: 'page',
    dependsOn: ['forks'],
    waitingFor: ['forks'],
  })
  .operation('rehearsal', {
    chain: 'demo',
    status: 'paused',
    statusText: 'Paused — demo script failed',
    section: 'rehearsal',
    dependsOn: ['demo'],
    waitingFor: ['demo'],
  })
  .operation('titles', { chain: 'talk', status: 'waiting-for-slot', section: 'titles' })
  .operation('handout', { chain: 'talk', status: 'awaiting-answer', section: 'handout' })
  .operation('closing', { chain: 'talk', status: 'paused', statusText: WORDING.pausedAwaitingInput, pauseReason: 'awaiting-input', section: 'closing' })
  .operation('venue', { chain: 'misc', status: 'interrupted', section: 'venue' })
  .operation('travel', { chain: 'misc', status: 'stopped', section: 'travel' })
  .operation('timing', {
    chain: 'talk',
    status: 'waiting-for-results',
    statusText: 'Waiting for speaker page',
    section: 'timing',
    heldByBarrier: true,
    barrierWaitingFor: ['page'],
  })
  .operation('qa-prep', {
    chain: 'talk',
    status: 'waiting-for-results',
    statusText: 'Waiting for speaker page',
    section: 'qa-prep',
    dependsOn: ['page'],
    waitingFor: ['page'],
  })
  .build()

const fixture: Fixture = {
  id: 'operation-states',
  title: 'Operation graph, every status',
  covers: [
    'operation graph',
    'every OperationStatus',
    'waiting for capacity',
    'waiting for a free slot',
    'paused',
    'retrying',
    'whole-request barrier',
    'retired operations',
    'pending section in a placed group',
    'Q81',
  ],
  app: debugApp({ operationGraph: true, runInspector: true }),
  initial,
  steps: [
    {
      label: 'The abstract completes and fades from the graph',
      delayMs: 1400,
      next: (previous) =>
        fx
          .from(previous)
          .patch('section', 'abstract', { state: 'completed', status: null })
          .patch('attempt', 'abstract-1', { state: 'completed', text: 'Offline-first is a design stance, not a cache.' })
          .patch('operation', 'abstract', { status: 'completed', retired: true })
          .patch('operation', 'forks', { statusText: 'Waiting for speaker bio', waitingFor: ['bio'] })
          .build(),
    },
    {
      label: 'The bio’s retry completes; the join-back forms and the speaker page moves to the front',
      delayMs: 1600,
      next: (previous) =>
        fx
          .from(previous)
          .patch('section', 'bio', { state: 'completed', status: null, directiveState: 'completed' })
          .attempt('bio-2', { section: 'bio', state: 'completed', origin: 'automatic-retry', text: 'Builds software for places without signal.' })
          .joinBack('forks', { group: 'forks' })
          .remove('queueItem', 'page')
          .patch('section', 'page', { status: 'responding' })
          .attempt('page-1', { section: 'page', state: 'running' })
          .patch('operation', 'bio', { status: 'completed', retired: true })
          .patch('operation', 'forks', { status: 'formed', statusText: 'Formed', joinBack: 'forks', waitingFor: [], retired: true })
          .patch('operation', 'page', { status: 'running', statusText: 'Responding…', waitingFor: [] })
          .build(),
    },
    {
      label: 'New work arrives; nothing scrolls by itself',
      delayMs: 1400,
      next: (previous) =>
        fx
          .from(previous)
          .message('poster', 'And a one-line poster blurb.')
          .response('poster', { message: 'poster' })
          .section('poster', { response: 'poster', chain: 'talk', state: 'pending', title: 'poster blurb', status: 'responding' })
          .attempt('poster-1', { section: 'poster', state: 'running' })
          .operation('poster', { chain: 'talk', status: 'running', section: 'poster' })
          .build(),
    },
    {
      label: 'The speaker page completes; the barrier lifts and both parts of the Q&A message start',
      delayMs: 1600,
      next: (previous) =>
        fx
          .from(previous)
          .patch('section', 'page', { state: 'completed', status: null })
          .patch('attempt', 'page-1', { state: 'completed', text: 'A talk about software that keeps working when the network does not.' })
          .remove('queueItem', 'timing')
          .remove('queueItem', 'qa-prep')
          .patch('section', 'timing', { status: 'responding' })
          .attempt('timing-1', { section: 'timing', state: 'running' })
          .patch('section', 'qa-prep', { status: 'responding' })
          .attempt('qa-prep-1', { section: 'qa-prep', state: 'running' })
          .patch('operation', 'page', { status: 'completed', statusText: 'Completed', retired: true })
          .patch('operation', 'timing', { status: 'running', statusText: 'Responding…', heldByBarrier: false, barrierWaitingFor: [] })
          .patch('operation', 'qa-prep', { status: 'running', statusText: 'Responding…', waitingFor: [] })
          .build(),
    },
  ],
}

export default fixture

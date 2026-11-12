import { fx, type Fixture } from '@/fixtures'
import { debugApp } from '@/features/debug/fixture-support'

/**
 * Work planned on a sibling group that is still open (09 §1).
 *
 *   talk brief ─┬─ abstract (completed) ─┐
 *               └─ speaker bio (running) ─┘  (open: no join-back yet)
 *                                ┊
 *                     speaker page (not started, planned on the group)
 *
 * The speaker page continues the talk chain from the group's join-back,
 * which cannot form until the bio finishes. Its parents are empty and the
 * projection names the group in `plannedGroupIds`, so the mini-map draws a
 * dashed edge from the group's oval, a row below where the join-back will
 * sit, and never a new root. The steps close the group and start the page:
 * the planned edge gives way to the edge from the join-back.
 */
const initial = fx
  .conversation('planned-on-group')
  .chain('talk', { label: 'conference talk' })
  .chain('abstract', { kind: 'fork', base: 'talk', label: 'abstract' })
  .chain('bio', { kind: 'fork', base: 'talk', label: 'speaker bio' })

  // ── transcript ──
  .message('brief', 'I am giving a 30-minute talk on offline-first apps at a regional conference in June.')
  .response('brief', { message: 'brief' })
  .section('brief', { response: 'brief', chain: 'talk', state: 'completed', title: 'talk brief' })
  .attempt('brief-1', { section: 'brief', state: 'completed', text: 'Noted: 30 minutes, offline-first apps, a regional conference in June.' })
  .message('abstract', 'Write the abstract.')
  .response('abstract', { message: 'abstract' })
  .section('abstract', { response: 'abstract', chain: 'abstract', state: 'completed', title: 'abstract' })
  .attempt('abstract-1', { section: 'abstract', state: 'completed', text: 'Offline-first is a design stance, not a cache.' })
  .message('bio', 'Write a speaker bio.')
  .response('bio', { message: 'bio' })
  .section('bio', { response: 'bio', chain: 'bio', state: 'streaming', title: 'speaker bio' })
  .attempt('bio-1', { section: 'bio', state: 'streaming', text: 'Builds software for places ' })
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

  // ── genealogy ──
  .node('brief', { chain: 'talk', directive: 'brief' })
  .node('abstract', { chain: 'abstract', directive: 'abstract', parents: ['brief'], group: 'forks' })
  .node('bio', { chain: 'bio', directive: 'bio', parents: ['brief'], group: 'forks' })
  .group('forks', { start: 'brief', base: 'talk', members: ['abstract', 'bio'] })
  .node('page', { chain: 'talk', directive: 'page', parents: [], parentsExact: false, plannedGroups: ['forks'] })

  .focus('abstract', { inherited: { messages: ['brief'], sections: ['brief'] } })
  .focus('bio', { inherited: { messages: ['brief'], sections: ['brief'] } })

  // ── operation graph ──
  .operation('brief', { chain: 'talk', status: 'completed', section: 'brief', retired: true })
  .operation('abstract', { chain: 'abstract', status: 'completed', section: 'abstract', retired: true })
  .operation('bio', { chain: 'bio', status: 'streaming', section: 'bio' })
  .operation('forks', {
    chain: 'talk',
    status: 'group-open',
    statusText: 'Waiting for speaker bio',
    label: 'abstract + speaker bio',
    group: 'forks',
    dependsOn: ['abstract', 'bio'],
    waitingFor: ['bio'],
  })
  .operation('page', {
    chain: 'talk',
    status: 'waiting-for-results',
    statusText: 'Waiting for abstract + speaker bio',
    section: 'page',
    dependsOn: ['forks'],
    waitingFor: ['forks'],
  })
  .build()

const fixture: Fixture = {
  id: 'planned-on-group',
  title: 'Planned on an open group',
  covers: ['mini-map', 'planned edge', 'open sibling group', 'join-back', '09 §1'],
  app: debugApp({ miniMap: true, operationGraph: true }),
  initial,
  steps: [
    {
      label: 'The bio completes; the join-back forms and becomes the speaker page’s planned parent',
      delayMs: 1400,
      next: (previous) =>
        fx
          .from(previous)
          .appendText('bio-1', 'without signal.')
          .patch('section', 'bio', { state: 'completed' })
          .patch('attempt', 'bio-1', { state: 'completed' })
          .joinBack('join-back', { group: 'forks' })
          .patch('node', 'page', { parents: ['join-back'], plannedGroups: [] })
          .patch('operation', 'bio', { status: 'completed', retired: true })
          .patch('operation', 'forks', { status: 'formed', statusText: 'Formed', joinBack: 'join-back', waitingFor: [], retired: true })
          .build(),
    },
    {
      label: 'The speaker page starts; its parent becomes exact',
      delayMs: 1200,
      next: (previous) =>
        fx
          .from(previous)
          .remove('queueItem', 'page')
          .patch('section', 'page', { status: 'responding' })
          .attempt('page-1', { section: 'page', state: 'running' })
          .patch('node', 'page', { parentsExact: true })
          .patch('operation', 'page', { status: 'running', statusText: 'Responding…', waitingFor: [] })
          .build(),
    },
  ],
}

export default fixture

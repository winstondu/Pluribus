import { fx, type Fixture } from '@/fixtures'
import { ALL_DEBUG_VIEWS, debugApp } from '@/features/debug/fixture-support'

/**
 * A genealogy with every mark the mini-map draws.
 *
 *   launch brief ─┬─ tagline ───────────┬─ join-back ─┬─ plan (superseded) ──┐
 *                 ├─ pricing (failed) ──┤             ├─ plan, revised ──────┼─ announcement ── checklist (planned)
 *                 └─ risks (stopped) ───┘             └─ pricing, retried    │      (a join chain with three parents)
 *                       └─ FAQ (a branch from tagline) ──────────────────────┤
 *   audience ────────────────────────────────────────────────────────────────┘
 *      └─ personas (interrupted) ── channels (cancelled)      added after the join chain was created
 *
 * The three forks ran in parallel; pricing failed and risks was stopped, so
 * the join-back records them as a request and a marker. Pricing was retried
 * after the group closed: the retry is a child of the join-back on the
 * launch chain. The plan was revised after it finished. The announcement is
 * a join chain over the revised plan, the FAQ and the audience answer as
 * they were when it was created; the audience chain carried on afterwards.
 */
const initial = fx
  .conversation('genealogy-marks')
  .chain('launch', { label: 'launch brief' })
  .chain('tagline', { kind: 'fork', base: 'launch', label: 'tagline' })
  .chain('pricing', { kind: 'fork', base: 'launch', label: 'pricing' })
  .chain('risks', { kind: 'fork', base: 'launch', label: 'risks' })
  .chain('audience', { label: 'audience' })
  .chain('faq', { kind: 'branch', base: 'tagline', label: 'FAQ' })
  .chain('announcement', { kind: 'join', label: 'announcement' })

  // ── transcript ──
  .message('brief', 'We are launching a note-taking app for field researchers in March.')
  .response('brief', { message: 'brief' })
  .section('brief', { response: 'brief', chain: 'launch', state: 'completed', title: 'launch brief' })
  .attempt('brief-1', { section: 'brief', state: 'completed', text: 'Understood: a note-taking app for field researchers, launching in March.' })

  .message('tagline', 'Suggest a tagline.')
  .message('pricing', 'Propose pricing tiers.')
  .message('risks', 'List the launch risks.')
  .response('tagline', { message: 'tagline' })
  .section('tagline', { response: 'tagline', chain: 'tagline', state: 'completed', title: 'tagline' })
  .attempt('tagline-1', { section: 'tagline', state: 'completed', text: '“Notes that survive the field.”' })
  .response('pricing', { message: 'pricing' })
  .section('pricing', { response: 'pricing', chain: 'pricing', state: 'completed', title: 'pricing' })
  .attempt('pricing-1', {
    section: 'pricing',
    state: 'failed',
    node: 'pricing',
    failure: fx.error('provider-error', 'The provider returned an error', 502),
  })
  .attempt('pricing-2', {
    section: 'pricing',
    state: 'completed',
    origin: 'user-retry',
    node: 'pricing-retry',
    text: 'Free for one device; Field at $6 a month with offline sync; Team at $15 a seat.',
  })
  .response('risks', { message: 'risks' })
  .section('risks', { response: 'risks', chain: 'risks', state: 'stopped', title: 'risks' })
  .attempt('risks-1', { section: 'risks', state: 'stopped', text: 'The main risks are app-store review delays and ' })

  .message('audience', 'Separately: who exactly reads field notes after a study ends?')
  .response('audience', { message: 'audience' })
  .section('audience', { response: 'audience', chain: 'audience', state: 'completed', title: 'audience' })
  .attempt('audience-1', { section: 'audience', state: 'completed', text: 'Mostly the researcher, then co-authors, then reviewers asking for data.' })

  .message('plan', 'Use those to draft a four-week launch plan.')
  .response('plan', { message: 'plan' })
  .section('plan', { response: 'plan', chain: 'launch', state: 'superseded', title: 'launch plan', superseded: { by: 'plan-revised' } })
  .attempt('plan-1', { section: 'plan', state: 'completed', text: 'Week 1: beta list. Week 2: pricing page. Week 3: press. Week 4: launch.' })
  .message('plan-fix', 'Actually make the plan two weeks, not four.', { chains: ['launch'], replyingTo: { sections: ['plan'], mode: 'inferred' } })
  .response('plan-revised', { message: 'plan', reason: 'revision-replacement' })
  .section('plan-revised', {
    response: 'plan-revised',
    chain: 'launch',
    state: 'completed',
    title: 'launch plan',
    directive: 'plan',
    replaces: 'plan',
  })
  .attempt('plan-2', { section: 'plan-revised', state: 'completed', origin: 'revision', text: 'Week 1: beta list and pricing page. Week 2: press, then launch.' })

  .message('faq', 'Write a short FAQ that fits that tagline.', { replyingTo: { sections: ['tagline'] } })
  .response('faq', { message: 'faq' })
  .section('faq', { response: 'faq', chain: 'faq', state: 'completed', title: 'FAQ' })
  .attempt('faq-1', { section: 'faq', state: 'completed', text: 'Does it work offline? Yes. Can I export? Yes, to plain text and CSV.' })

  .message('announcement', 'Write the launch announcement from the plan, the FAQ and what we know about the audience.')
  .response('announcement', { message: 'announcement' })
  .section('announcement', { response: 'announcement', chain: 'announcement', state: 'streaming', title: 'announcement' })
  .attempt('announcement-1', { section: 'announcement', state: 'streaming', text: 'Field notes are written for one reader and kept for many. ' })

  .message('personas', 'Back to the audience question: sketch two personas.')
  .response('personas', { message: 'personas' })
  .section('personas', { response: 'personas', chain: 'audience', state: 'interrupted', title: 'personas' })
  .attempt('personas-1', { section: 'personas', state: 'interrupted', text: 'Persona one, the solo ethnographer: ' })
  .message('channels', 'Then say which channels reach them.')
  .response('channels', { message: 'channels' })
  .section('channels', { response: 'channels', chain: 'audience', state: 'cancelled', title: 'channels' })

  .message('checklist', 'After the announcement, write a launch-day checklist.')
  .response('checklist', { message: 'checklist' })
  .section('checklist', {
    response: 'checklist',
    chain: 'announcement',
    state: 'pending',
    title: 'checklist',
    status: { kind: 'waiting-for-results', text: 'Waiting for announcement' },
  })
  .queueItem('checklist', {
    directive: 'checklist',
    message: 'checklist',
    state: 'waiting',
    waitingFor: [{ label: 'announcement', directives: ['announcement'] }],
  })

  // ── genealogy ──
  .node('brief', { chain: 'launch', directive: 'brief' })
  .node('tagline', { chain: 'tagline', directive: 'tagline', parents: ['brief'], group: 'forks' })
  .node('pricing', { chain: 'pricing', directive: 'pricing', parents: ['brief'], group: 'forks', state: 'failed' })
  .node('risks', { chain: 'risks', directive: 'risks', parents: ['brief'], group: 'forks' })
  .node('audience', { chain: 'audience', directive: 'audience' })
  .group('forks', { start: 'brief', base: 'launch', members: ['tagline', 'pricing', 'risks'] })
  .joinBack('join-back', {
    group: 'forks',
    members: ['tagline', { node: 'pricing', outcome: 'failed' }, { node: 'risks', outcome: 'stopped' }],
    lateRetries: ['pricing-retry'],
  })
  .node('plan', { chain: 'launch', directive: 'plan', section: 'plan', parents: ['join-back'] })
  .node('pricing-retry', {
    chain: 'launch',
    directive: 'pricing',
    parents: ['join-back'],
    reason: 'retry-after-closure',
    label: 'pricing, retried',
    state: 'completed',
  })
  .node('plan-revised', {
    chain: 'launch',
    directive: 'plan',
    section: 'plan-revised',
    parents: ['join-back'],
    reason: 'revision',
    replaces: 'plan',
    label: 'plan, revised',
  })
  .node('faq', { chain: 'faq', directive: 'faq', parents: ['tagline'] })
  .node('announcement', { chain: 'announcement', directive: 'announcement', parents: ['plan-revised', 'faq', 'audience'] })
  .node('personas', { chain: 'audience', directive: 'personas', parents: ['audience'] })
  .node('channels', { chain: 'audience', directive: 'channels', parents: ['personas'], parentsExact: false })
  .node('checklist', { chain: 'announcement', directive: 'checklist', parents: ['announcement'], parentsExact: false })

  .focus('tagline', { inherited: { messages: ['brief'], sections: ['brief'] } })
  .focus('faq', { inherited: { messages: ['brief', 'tagline'], sections: ['brief', 'tagline'] } })
  .focus('announcement', {
    inherited: {
      messages: ['brief', 'tagline', 'pricing', 'risks', 'plan', 'plan-fix', 'faq', 'audience'],
      sections: ['brief', 'tagline', 'pricing', 'plan-revised', 'faq', 'audience'],
    },
  })

  // ── operation graph ──
  .operation('brief', { chain: 'launch', status: 'completed', section: 'brief', retired: true })
  .operation('tagline', { chain: 'tagline', status: 'completed', section: 'tagline', retired: true })
  .operation('pricing', { chain: 'pricing', status: 'completed', section: 'pricing', retired: true })
  .operation('risks', { chain: 'risks', status: 'stopped', section: 'risks' })
  .operation('audience', { chain: 'audience', status: 'completed', section: 'audience', retired: true })
  .operation('join-back', {
    chain: 'launch',
    status: 'formed',
    label: 'tagline + pricing + risks',
    group: 'forks',
    joinBack: 'join-back',
    dependsOn: ['tagline', 'pricing', 'risks'],
    retired: true,
  })
  .operation('plan', { chain: 'launch', status: 'superseded', section: 'plan', dependsOn: ['join-back'], retired: true })
  .operation('plan-revised', { chain: 'launch', status: 'completed', section: 'plan-revised', dependsOn: ['join-back'], retired: true })
  .operation('faq', { chain: 'faq', status: 'completed', section: 'faq', retired: true })
  .operation('announcement', { chain: 'announcement', status: 'streaming', kind: 'synthesis', section: 'announcement' })
  .operation('personas', { chain: 'audience', status: 'interrupted', section: 'personas' })
  .operation('channels', { chain: 'audience', status: 'cancelled', section: 'channels', dependsOn: ['personas'], retired: true })
  .operation('checklist', {
    chain: 'announcement',
    status: 'waiting-for-results',
    statusText: 'Waiting for announcement',
    section: 'checklist',
    dependsOn: ['announcement'],
    waitingFor: ['announcement'],
  })
  .build()

const fixture: Fixture = {
  id: 'genealogy-marks',
  title: 'Genealogy with every mark',
  covers: [
    'mini-map',
    'sibling group oval',
    'failed sibling',
    'stopped sibling',
    'join-back',
    'retry after closure',
    'superseded node',
    'interrupted',
    'cancelled',
    'branch',
    'join chain with three parents',
    'later source continuation',
    'C3',
    'C10',
  ],
  app: debugApp(ALL_DEBUG_VIEWS),
  initial,
  steps: [
    {
      label: 'The announcement completes; the checklist starts, and its parent becomes exact',
      delayMs: 1200,
      next: (previous) =>
        fx
          .from(previous)
          .appendText('announcement-1', 'Today we are launching an app that keeps them safe for both.')
          .patch('section', 'announcement', { state: 'completed' })
          .patch('attempt', 'announcement-1', { state: 'completed' })
          .remove('queueItem', 'checklist')
          .patch('section', 'checklist', { status: 'responding' })
          .attempt('checklist-1', { section: 'checklist', state: 'running' })
          .patch('node', 'checklist', { parentsExact: true })
          .patch('operation', 'announcement', { status: 'completed', retired: true })
          .patch('operation', 'checklist', { status: 'running', statusText: 'Responding…', waitingFor: [] })
          .build(),
    },
  ],
}

export default fixture

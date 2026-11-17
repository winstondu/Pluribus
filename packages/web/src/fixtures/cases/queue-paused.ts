import { fx, type Fixture } from '@/fixtures'

const initial = fx
  .conversation('queue-paused')
  .chain('trip', { label: 'Kyoto trip' })
  .chain('hoods', { kind: 'fork', base: 'trip', label: 'neighborhoods' })
  .chain('rain', { kind: 'fork', base: 'trip', label: 'activities' })
  .message('brief', 'I am planning five days in Kyoto in November on a moderate budget.')
  .response('brief', { message: 'brief' })
  .section('brief', { response: 'brief', chain: 'trip', state: 'completed', title: 'trip brief' })
  .attempt('brief-1', { section: 'brief', state: 'completed', text: 'Noted: Kyoto, five days, November, moderate budget.' })
  .message('A', 'Recommend neighborhoods to stay in.')
  .response('A', { message: 'A' })
  .section('A', { response: 'A', chain: 'hoods', state: 'completed', title: 'neighborhoods' })
  .attempt('A-1', {
    section: 'A',
    state: 'completed',
    text: 'Nakagyo for food and the subway, the Kyoto Station area for day trips, Gion for evenings.',
  })
  .message('B', 'Recommend rainy-day activities.')
  .response('B', { message: 'B' })
  .section('B', { response: 'B', chain: 'rain', state: 'failed', title: 'activities' })
  .attempt('B-1', {
    section: 'B',
    state: 'failed',
    text: 'For rain, start with the Kyoto Railway Museum, which',
    failure: fx.error('service-unavailable', 'The provider is unavailable. Automatic retries were used up.', 503),
  })
  .message('J', 'Use both recommendations to make a five-day itinerary.')
  .response('J', { message: 'J' })
  .section('J', {
    response: 'J',
    chain: 'trip',
    state: 'pending',
    title: 'itinerary',
    status: { kind: 'paused', text: 'Paused — activities failed' },
  })
  .queueItem('J', {
    directive: 'J',
    message: 'J',
    state: 'paused',
    waitingFor: [{ label: 'neighborhoods + activities', directives: ['B'] }],
    recovery: { elicitation: 'recover-J', cause: { directive: 'B', label: 'activities', outcome: 'failed' }, retrySection: 'B' },
  })
  .build()

/**
 * F5. B failed, so J, which needs the full join-back, is paused. It never
 * runs on a subset. Its queue item names the cause and carries the recovery
 * choice: retry the prerequisite, continue without it, or cancel. There is
 * no default; each button here plays out what that choice does.
 */
const fixture: Fixture = {
  id: 'queue-paused',
  title: 'A paused request and its recovery choice',
  covers: ['F5', 'paused queue item', 'recovery choice', 'Retry', 'Continue without', 'Cancel'],
  initial,
  respond(command) {
    if (command.type === 'retry' && command.target.kind === 'section') {
      return {
        steps: [
          {
            label: 'Retry activities: the partial text collapses and the retry starts beneath it; J waits again',
            delayMs: 0,
            next: (previous) =>
              fx
                .from(previous)
                .patch('attempt', 'B-1', { collapsed: true })
                .patch('section', 'B', { state: 'streaming', status: 'responding', directiveState: 'running', failure: null })
                .attempt('B-2', { section: 'B', state: 'running', origin: 'user-retry' })
                .patch('section', 'J', { status: { kind: 'waiting-for-results', text: 'Waiting for neighborhoods + activities' } })
                .patch('queueItem', 'J', { state: 'waiting', recovery: null })
                .build(),
          },
          {
            label: 'The retry succeeds: J is released and its queue item clears',
            delayMs: 1400,
            next: (previous) =>
              fx
                .from(previous)
                .patch('section', 'B', { state: 'completed', status: null })
                .patch('attempt', 'B-2', {
                  state: 'completed',
                  text: 'For rain: the Kyoto Railway Museum, Nishiki Market under its arcade, and a tea ceremony in Gion.',
                })
                .remove('queueItem', 'J')
                .patch('section', 'J', { status: 'responding' })
                .attempt('J-1', { section: 'J', state: 'running' })
                .build(),
          },
        ],
      }
    }
    if (command.type === 'continue-without') {
      return {
        steps: [
          {
            label: 'Continue without activities: J runs on the join-back with B recorded as failed',
            delayMs: 0,
            next: (previous) =>
              fx
                .from(previous)
                .remove('queueItem', 'J')
                .patch('section', 'J', { status: 'responding' })
                .attempt('J-1', { section: 'J', state: 'running' })
                .build(),
          },
          {
            label: 'The itinerary arrives',
            delayMs: 1200,
            next: (previous) =>
              fx
                .from(previous)
                .patch('section', 'J', { state: 'completed', status: null })
                .patch('attempt', 'J-1', {
                  state: 'completed',
                  text: 'Using the neighborhoods only: stay in Nakagyo; Day 1 Nishiki Market, Day 2 Gion, Day 3 Arashiyama, Day 4 Fushimi Inari, Day 5 Nara.',
                })
                .build(),
          },
        ],
      }
    }
    if (command.type === 'cancel') {
      return {
        steps: [
          {
            label: 'Cancel itinerary: J is cancelled before it started',
            delayMs: 0,
            next: (previous) =>
              fx.from(previous).remove('queueItem', 'J').patch('section', 'J', { state: 'cancelled', status: null }).build(),
          },
        ],
      }
    }
    return null
  },
}

export default fixture

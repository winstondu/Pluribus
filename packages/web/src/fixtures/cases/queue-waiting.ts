import { fx, type Fixture } from '@/fixtures'

const initial = fx
  .conversation('queue-waiting')
  .chain('trip', { label: 'Kyoto trip' })
  .chain('hoods', { kind: 'fork', base: 'trip', label: 'neighborhoods' })
  .chain('rain', { kind: 'fork', base: 'trip', label: 'activities' })
  .message('brief', 'I am planning five days in Kyoto in November on a moderate budget.')
  .response('brief', { message: 'brief' })
  .section('brief', { response: 'brief', chain: 'trip', state: 'completed', title: 'trip brief' })
  .attempt('brief-1', { section: 'brief', state: 'completed', text: 'Noted: Kyoto, five days, November, moderate budget.' })
  .message('A', 'Recommend neighborhoods to stay in.')
  .response('A', { message: 'A' })
  .section('A', { response: 'A', chain: 'hoods', state: 'streaming', title: 'neighborhoods' })
  .attempt('A-1', { section: 'A', state: 'streaming', text: 'Three areas suit a moderate budget. Nakagyo puts you ' })
  .message('B', 'Recommend rainy-day activities.')
  .response('B', { message: 'B' })
  .section('B', { response: 'B', chain: 'rain', state: 'pending', title: 'activities' })
  .attempt('B-1', { section: 'B', state: 'running' })
  .message('J', 'Use both recommendations to make a five-day itinerary.')
  .response('J', { message: 'J' })
  .section('J', {
    response: 'J',
    chain: 'trip',
    state: 'pending',
    title: 'itinerary',
    status: { kind: 'waiting-for-results', text: 'Waiting for neighborhoods + activities' },
  })
  .queueItem('J', {
    directive: 'J',
    message: 'J',
    state: 'waiting',
    waitingFor: [{ label: 'neighborhoods + activities', directives: ['A', 'B'] }],
  })
  .build()

/**
 * P6. J needs both recommendations, which are still in flight, so it is
 * dependency-queued: its message is in the transcript, and a linked queue
 * item above the composer names the whole sibling group it waits for. A and
 * B are free to proceed and have no item. Revising J while it waits changes
 * the wording (Q41). The item clears when processing begins.
 */
const fixture: Fixture = {
  id: 'queue-waiting',
  title: 'A queue item, revised, then cleared',
  covers: ['P6', 'R6', 'queue item', 'Revised · waiting for …', 'queue item clears'],
  initial,
  steps: [
    {
      label: 'J is revised while queued: edited in place, "Revised · waiting for neighborhoods + activities"',
      delayMs: 1500,
      next: (previous) =>
        fx
          .from(previous)
          .message('J-rev', 'Actually, make it a four-day itinerary.', { chains: ['trip'], replyingTo: { sections: ['J'], mode: 'inferred' } })
          .patch('queueItem', 'J', { revised: true })
          .build(),
    },
    {
      label: 'Both recommendations finish: processing begins and the queue item clears',
      delayMs: 1600,
      next: (previous) =>
        fx
          .from(previous)
          .patch('section', 'A', { state: 'completed' })
          .patch('attempt', 'A-1', {
            state: 'completed',
            text: 'Three areas suit a moderate budget. Nakagyo puts you near food and the subway; the Kyoto Station area is best for day trips; Gion costs more and is the prettiest at night.',
          })
          .patch('section', 'B', { state: 'completed', status: null })
          .patch('attempt', 'B-1', {
            state: 'completed',
            text: 'For rain: the Kyoto Railway Museum, Nishiki Market under its arcade, and a tea ceremony in Gion.',
          })
          .remove('queueItem', 'J')
          .patch('section', 'J', { status: 'responding' })
          .attempt('J-1', { section: 'J', state: 'running' })
          .build(),
    },
    {
      label: 'The itinerary shows its first text',
      delayMs: 1200,
      next: (previous) =>
        fx
          .from(previous)
          .patch('section', 'J', { state: 'streaming', status: null })
          .patch('attempt', 'J-1', { state: 'streaming', text: 'Day 1: arrive, settle into Nakagyo, and walk Nishiki Market. ' })
          .build(),
    },
  ],
}

export default fixture

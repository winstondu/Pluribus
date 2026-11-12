import { fx, type Fixture } from '@/fixtures'

const submitted = fx
  .conversation('routing')
  .message('ask', 'Compare the two neighborhoods you liked best, then tell me which has better transit.')
  .response('ask', { message: 'ask', routing: 'routing' })
  .build()

const failed = fx
  .from(submitted)
  .patch('response', 'ask', { routing: { failed: 'The decision model did not answer in time.', code: 'timeout' } })
  .build()

/**
 * The provisional responding bubble. While routing works it says "Routing…";
 * when routing fails it carries the failure text and Retry is on the request.
 * Nothing is ever drawn on the user message (P7).
 */
const fixture: Fixture = {
  id: 'routing',
  title: 'Routing, then a routing failure',
  covers: ['P7', 'routing status', 'routing failure', 'Retry on a request'],
  initial: submitted,
  steps: [{ label: 'Routing fails; Retry appears on the request', delayMs: 1600, next: failed }],
  respond(command) {
    if (command.type !== 'retry' || command.target.kind !== 'request') return null
    return {
      steps: [
        {
          label: 'Retry: routing again',
          delayMs: 0,
          next: (previous) => fx.from(previous).patch('response', 'ask', { routing: 'routing' }).build(),
        },
        {
          label: 'Routed: the same bubble gains its section',
          delayMs: 900,
          next: (previous) =>
            fx
              .from(previous)
              .chain('compare', { label: 'neighborhood comparison' })
              .patch('response', 'ask', { routing: null })
              .section('compare', { response: 'ask', chain: 'compare', state: 'pending', title: 'neighborhood comparison' })
              .build(),
        },
      ],
    }
  },
}

export default fixture

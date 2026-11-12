import { fx, type Fixture } from '@/fixtures'

/**
 * Responding bubbles, one per kind of pending status. Status text is not
 * answer text: none of these is placed, so they are the pending tail, in
 * request order.
 */
const fixture: Fixture = {
  id: 'pending',
  title: 'Responding bubbles with status',
  covers: ['responding bubble', 'P7', 'Responding…', 'Waiting for a free slot', 'Waiting for capacity', 'Retrying…'],
  initial: fx
    .conversation('pending')
    .chain('tea', { label: 'tea ceremony' })
    .chain('rail', { label: 'rail pass' })
    .chain('ryokan', { label: 'ryokan etiquette' })
    .chain('temple', { label: 'temple hours' })
    .message('tea', 'What happens at a tea ceremony, start to finish?')
    .response('tea', { message: 'tea' })
    .section('tea', { response: 'tea', chain: 'tea', state: 'pending', title: 'tea ceremony' })
    .attempt('tea-1', { section: 'tea', state: 'running' })
    .message('rail', 'Is a rail pass worth it for five days based in Kyoto?')
    .response('rail', { message: 'rail' })
    .section('rail', { response: 'rail', chain: 'rail', state: 'pending', status: 'retrying', title: 'rail pass' })
    // What the backend reports while an automatic retry is pending: the failed attempt is listed, with no text.
    .attempt('rail-1', { section: 'rail', state: 'failed', failure: fx.error('service-unavailable', 'The provider is unavailable.') })
    .message('ryokan', 'What should I know before staying in a ryokan?')
    .response('ryokan', { message: 'ryokan' })
    .section('ryokan', {
      response: 'ryokan',
      chain: 'ryokan',
      state: 'pending',
      status: 'waiting-for-capacity',
      title: 'ryokan etiquette',
    })
    .attempt('ryokan-1', { section: 'ryokan', state: 'failed', failure: fx.error('rate-limited', 'The provider is rate limiting requests.') })
    .message('temple', 'Which temples open before eight in the morning?')
    .response('temple', { message: 'temple' })
    .section('temple', {
      response: 'temple',
      chain: 'temple',
      state: 'pending',
      status: 'waiting-for-slot',
      title: 'temple hours',
    })
    .build(),
}

export default fixture

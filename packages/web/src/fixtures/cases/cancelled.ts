import { fx, type Fixture } from '@/fixtures'

const TEXT =
  'Convert 60,000 yen to euros, draft a three-line packing list, and then cut that packing list down to carry-on size.'

/**
 * A whole request stopped while one part was done, one was running and one
 * was still queued (Q22, Q91): the running section is stopped and keeps its
 * text, the queued one is cancelled and has none. The header counts them;
 * there is no "request cancelled" label. The second request is ready and
 * held only by the concurrency limit.
 */
const fixture: Fixture = {
  id: 'cancelled',
  title: 'A stopped request: stopped and cancelled sections',
  covers: ['F7', 'cancelled section', 'stopped section', 'header count', 'Waiting for a free slot'],
  initial: fx
    .conversation('cancelled')
    .chain('money', { label: 'yen to euros' })
    .chain('packing', { label: 'packing list' })
    .chain('festival', { label: 'festivals' })
    .message('ask', TEXT)
    .response('ask', { message: 'ask', grouped: true })
    .section('money', { response: 'ask', chain: 'money', state: 'completed', title: 'Yen to euros' })
    .attempt('money-1', { section: 'money', state: 'completed', text: '60,000 yen is about **365 euros** at 164 yen to the euro.' })
    .section('packing', { response: 'ask', chain: 'packing', state: 'stopped', title: 'Packing list' })
    .attempt('packing-1', { section: 'packing', state: 'stopped', text: '1. Layers for 8–17 °C\n2. A compact umbrella' })
    .section('carry-on', { response: 'ask', chain: 'packing', state: 'cancelled', title: 'Carry-on version' })
    .message('festival', 'Are there any festivals in Kyoto in late November?')
    .response('festival', { message: 'festival' })
    .section('festival', {
      response: 'festival',
      chain: 'festival',
      state: 'pending',
      status: 'waiting-for-slot',
      title: 'festivals',
    })
    .build(),
}

export default fixture

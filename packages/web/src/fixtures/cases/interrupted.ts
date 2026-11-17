import { fx, type Fixture } from '@/fixtures'

/**
 * Interrupted work (Q52): lost with whatever was executing it. Visible text
 * stays, marked interrupted. Under Manual it waits with Retry; under
 * Standard it retries by itself, here beneath the collapsed text. The third
 * request is held by the provider's rate limit, which is its own status
 * and never a dependency wait.
 */
const fixture: Fixture = {
  id: 'interrupted',
  title: 'Interrupted, and waiting for capacity',
  covers: ['F9', 'interrupted section', 'Retry', 'Retrying…', 'Waiting for capacity'],
  initial: fx
    .conversation('interrupted')
    .chain('onsen', { label: 'onsen etiquette' })
    .chain('trains', { label: 'train to Nara' })
    .chain('coffee', { label: 'coffee shops' })
    .message('onsen', 'How does an onsen visit work?')
    .response('onsen', { message: 'onsen' })
    .section('onsen', { response: 'onsen', chain: 'onsen', state: 'interrupted', title: 'onsen etiquette' })
    .attempt('onsen-1', {
      section: 'onsen',
      state: 'interrupted',
      text: 'You wash first, sitting at one of the low showers, and only then get into the shared bath. Towels stay out of',
    })
    .message('trains', 'What is the fastest train to Nara?', { actions: { retry: false, stop: true } })
    .response('trains', { message: 'trains' })
    .section('trains', {
      response: 'trains',
      chain: 'trains',
      state: 'interrupted',
      title: 'train to Nara',
      status: 'retrying',
      directiveState: 'retrying',
      actions: { retry: false, stop: true },
    })
    .attempt('trains-1', {
      section: 'trains',
      state: 'interrupted',
      collapsed: true,
      text: 'The Kintetsu limited express from Kyoto Station takes thirty-five minutes and',
    })
    .message('coffee', 'Where is good coffee near Kyoto Station?')
    .response('coffee', { message: 'coffee' })
    .section('coffee', {
      response: 'coffee',
      chain: 'coffee',
      state: 'pending',
      status: 'waiting-for-capacity',
      title: 'coffee shops',
    })
    .build(),
}

export default fixture

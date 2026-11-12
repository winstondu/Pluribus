import { fx, type Fixture } from '@/fixtures'

const ORDERED = 'Give me a packing list, a phrase list and a tipping guide, in that order.'
const BARRIER = 'Summarize that recommendation and separately translate this menu: yudofu, obanzai, matcha parfait. Put the translation first.'

/**
 * Two things an explicit relation between a request's outputs does.
 *
 * An explicit output order takes precedence over first-output order inside
 * a reply group (Q18, P8): the tipping guide showed text first and still
 * sits third.
 *
 * The whole-request barrier (Q19, Q25): "put the translation first" relates
 * the outputs, and the summary needs a recommendation that is still being
 * written, so the translation waits too. Its queue item says it is held
 * with the rest of its request.
 */
const fixture: Fixture = {
  id: 'barrier-ordered-group',
  title: 'Explicit output order, and the whole-request barrier',
  covers: ['P8', 'D3', 'explicit output order', 'whole-request barrier', 'queue item held by the barrier'],
  initial: fx
    .conversation('barrier-ordered-group')
    .chain('pack', { label: 'packing list' })
    .chain('phrases', { label: 'phrase list' })
    .chain('tips', { label: 'tipping guide' })
    .chain('ryokan', { label: 'ryokan recommendation' })
    .chain('menu', { label: 'menu translation' })
    .message('ordered', ORDERED)
    .response('ordered', { message: 'ordered', grouped: true, sectionOrder: ['pack', 'phrases', 'tips'] })
    .section('tips', { response: 'ordered', chain: 'tips', state: 'completed', title: 'Tipping guide' })
    .attempt('tips-1', { section: 'tips', state: 'completed', text: 'Do not tip. Service is included, and leaving cash on the table causes confusion.' })
    .section('pack', { response: 'ordered', chain: 'pack', state: 'streaming', title: 'Packing list' })
    .attempt('pack-1', { section: 'pack', state: 'streaming', text: 'Layers for 8–17 °C, a compact umbrella, ' })
    .section('phrases', { response: 'ordered', chain: 'phrases', state: 'pending', title: 'Phrase list' })
    .attempt('phrases-1', { section: 'phrases', state: 'running' })
    .message('rec', 'Recommend one ryokan in Higashiyama.')
    .response('rec', { message: 'rec' })
    .section('rec', { response: 'rec', chain: 'ryokan', state: 'streaming', title: 'ryokan recommendation' })
    .attempt('rec-1', { section: 'rec', state: 'streaming', text: 'For a first stay, consider a small family-run ryokan near Kodai-ji: ' })
    .message('both', BARRIER)
    .response('both', { message: 'both', grouped: true, sectionOrder: ['translation', 'summary'] })
    .section('translation', {
      response: 'both',
      chain: 'menu',
      state: 'pending',
      title: 'Menu translation',
      status: { kind: 'waiting-for-results', text: 'Waiting for ryokan recommendation' },
    })
    .section('summary', {
      response: 'both',
      chain: 'ryokan',
      state: 'pending',
      title: 'Summary',
      status: { kind: 'waiting-for-results', text: 'Waiting for ryokan recommendation' },
    })
    .queueItem('translation', {
      directive: 'translation',
      message: 'both',
      state: 'waiting',
      heldByBarrier: true,
      waitingFor: [{ label: 'ryokan recommendation', directives: ['rec'] }],
    })
    .queueItem('summary', {
      directive: 'summary',
      message: 'both',
      state: 'waiting',
      waitingFor: [{ label: 'ryokan recommendation', directives: ['rec'] }],
    })
    .build(),
  steps: [
    {
      label: 'P8 · the phrase list shows text in the place the request asked for; the tipping guide, first to show text, stays third',
      delayMs: 1400,
      next: (previous) =>
        fx
          .from(previous)
          .patch('section', 'phrases', { state: 'streaming', status: null })
          .patch('attempt', 'phrases-1', { state: 'streaming', text: 'Sumimasen (excuse me), arigatou gozaimasu (thank you), ' })
          .build(),
    },
  ],
}

export default fixture

import { fx, type Fixture } from '@/fixtures'

const PARTIAL =
  'A Kyoto day pass covers city buses and both subway lines. It pays for itself after three rides, and most visitors take '

const initial = fx
  .conversation('failed-retry')
  .chain('etiquette', { label: 'temple etiquette' })
  .chain('pass', { label: 'day pass' })
  .message('early', 'What should I know about temple etiquette?')
  .response('early', { message: 'early' })
  .section('early', { response: 'early', chain: 'etiquette', state: 'pending', title: 'temple etiquette' })
  .attempt('early-1', { section: 'early', state: 'running' })
  .message('late', 'Is a bus and subway day pass worth buying?')
  .response('late', { message: 'late' })
  .section('late', { response: 'late', chain: 'pass', state: 'streaming', title: 'day pass' })
  .attempt('late-1', { section: 'late', state: 'streaming', text: PARTIAL })
  .build()

/**
 * P12 and P13.
 *
 * P12: a reply that fails before any answer text is fixed where it was when
 * it failed, and its retry fills that same bubble.
 *
 * P13: a reply that fails after partial text keeps the text, collapsed with
 * its mark, and the retry streams beneath it in the same bubble.
 */
const fixture: Fixture = {
  id: 'failed-retry',
  title: 'Failure and retry in the same bubble',
  covers: ['P12', 'P13', 'F3', 'F4', 'failed before output', 'failed after partial text', 'Retrying…'],
  initial,
  steps: [
    {
      label: 'P12 · the etiquette answer fails before any text: the failure notice fixes the bubble',
      delayMs: 1200,
      next: (previous) =>
        fx
          .from(previous)
          .patch('section', 'early', { state: 'failed', status: null, failure: fx.error('refusal', 'The model declined to answer this request.') })
          .patch('attempt', 'early-1', { state: 'failed', failure: fx.error('refusal', 'The model declined to answer this request.') })
          .build(),
    },
    {
      label: 'P13 · the day pass answer fails after partial text; the text collapses and "Retrying…" shows beneath',
      delayMs: 1400,
      next: (previous) =>
        fx
          .from(previous)
          .patch('attempt', 'late-1', {
            state: 'failed',
            collapsed: true,
            failure: fx.error('mid-stream-error', 'The provider ended the stream with an error.'),
          })
          .patch('section', 'late', { state: 'streaming', status: 'retrying', directiveState: 'retrying' })
          .build(),
    },
    {
      label: 'P13 · the retry streams beneath the collapsed text, in the same bubble',
      delayMs: 1400,
      next: (previous) =>
        fx
          .from(previous)
          .patch('section', 'late', { status: null, directiveState: 'running' })
          .attempt('late-2', {
            section: 'late',
            state: 'streaming',
            origin: 'automatic-retry',
            text: 'Yes, if you ride at least three times in a day. ',
          })
          .build(),
    },
    {
      label: 'The retry completes',
      delayMs: 1200,
      next: (previous) =>
        fx
          .from(previous)
          .patch('section', 'late', { state: 'completed' })
          .patch('attempt', 'late-2', {
            state: 'completed',
            text: 'Yes, if you ride at least three times in a day.\n\n- **Covers:** city buses and both subway lines\n- **Does not cover:** JR trains, or the private lines to Arashiyama and Fushimi\n- **Buy it:** at any subway ticket machine',
          })
          .build(),
    },
  ],
  respond(command) {
    if (command.type !== 'retry' || command.target.kind !== 'section') return null
    if (command.target.sectionId !== fx.id('section', 'early')) return null
    return {
      steps: [
        {
          label: 'P12 · Retry: a new attempt starts in the same bubble',
          delayMs: 0,
          next: (previous) =>
            fx
              .from(previous)
              .patch('section', 'early', { state: 'pending', placed: true, status: 'responding', failure: null })
              .attempt('early-2', { section: 'early', state: 'running', origin: 'user-retry' })
              .build(),
        },
        {
          label: 'P12 · the retry fills the bubble where the failure fixed it',
          delayMs: 1000,
          next: (previous) =>
            fx
              .from(previous)
              .patch('section', 'early', { state: 'completed', status: null })
              .patch('attempt', 'early-2', {
                state: 'completed',
                text: 'Take your shoes off where the floor is raised, keep your voice low, and ask before photographing people or altars.',
              })
              .build(),
        },
      ],
    }
  },
}

export default fixture

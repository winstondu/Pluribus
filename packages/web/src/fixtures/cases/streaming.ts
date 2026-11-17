import { fx, type Fixture, type FixtureStep } from '@/fixtures'

const CHUNKS = [
  'Sunlight looks white, but it is a mix of every color. ',
  'When it enters the atmosphere it meets gas molecules far smaller than its wavelength, ',
  'and they scatter the short, blue end of the spectrum about ten times more strongly than the red end.\n\n',
  'That scattered blue light reaches your eye from every direction, so the whole sky looks blue. ',
  'At sunset the light crosses much more air, most of the blue has been scattered out of the beam, ',
  'and what is left is orange and red.',
]

const initial = fx
  .conversation('streaming')
  .chain('sky', { label: 'why the sky is blue' })
  .message('sky', 'Why is the sky blue?')
  .response('sky', { message: 'sky' })
  .section('sky', { response: 'sky', chain: 'sky', state: 'pending', title: 'why the sky is blue' })
  .attempt('sky-1', { section: 'sky', state: 'running' })
  .build()

const steps: FixtureStep[] = [
  {
    label: 'First answer text: the reply takes its position',
    delayMs: 900,
    next: (previous) =>
      fx
        .from(previous)
        .patch('section', 'sky', { state: 'streaming', status: null })
        .patch('attempt', 'sky-1', { state: 'streaming', text: CHUNKS[0] })
        .build(),
  },
  ...CHUNKS.slice(1).map(
    (chunk, index): FixtureStep => ({
      label: `Text chunk ${index + 2} of ${CHUNKS.length}`,
      delayMs: 350,
      next: (previous) => fx.from(previous).appendText('sky-1', chunk).build(),
    }),
  ),
  {
    label: 'The answer completes',
    delayMs: 400,
    next: (previous) =>
      fx.from(previous).patch('section', 'sky', { state: 'completed' }).patch('attempt', 'sky-1', { state: 'completed' }).build(),
  },
]

/** One answer from responding bubble to streaming text to completed. Text arrives as appends. */
const fixture: Fixture = {
  id: 'streaming',
  title: 'Streaming text',
  covers: ['streaming', 'responding bubble', 'first-output placement'],
  initial,
  steps,
}

export default fixture

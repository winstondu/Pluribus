import { fx, type Fixture } from '@/fixtures'

const TEXT = 'Why is the sky blue? Separately, translate "sopa de verduras" into English, and tell me what to pack for a weekend hike.'

const initial = fx
  .conversation('group-first-output')
  .chain('sky', { label: 'why the sky is blue' })
  .chain('menu', { label: 'menu translation' })
  .chain('hike', { label: 'weekend hike' })
  .chain('tea', { label: 'green tea' })
  .message('ask', TEXT)
  .response('ask', { message: 'ask', grouped: true })
  .section('sky', { response: 'ask', chain: 'sky', state: 'pending', title: 'Why the sky is blue' })
  .attempt('sky-1', { section: 'sky', state: 'running' })
  .section('menu', { response: 'ask', chain: 'menu', state: 'pending', title: 'Menu translation' })
  .attempt('menu-1', { section: 'menu', state: 'running' })
  .section('hike', { response: 'ask', chain: 'hike', state: 'pending', title: 'Weekend hike' })
  .attempt('hike-1', { section: 'hike', state: 'running' })
  .message('tea', 'How hot should the water be for green tea?')
  .response('tea', { message: 'tea' })
  .section('tea', { response: 'tea', chain: 'tea', state: 'pending', title: 'green tea' })
  .attempt('tea-1', { section: 'tea', state: 'running' })
  .build()

/**
 * A reply group taking shape (Q18, Q93). The group is one reply: it is
 * fixed by its first section's first output, here ahead of a bubble that
 * was already pending. Inside it, each section takes its place at its own
 * first output and pending sections are overtaken; a section still pending
 * stays inside the placed group.
 */
const fixture: Fixture = {
  id: 'group-first-output',
  title: 'Sections taking their places in a reply group',
  covers: ['P8', 'reply group', 'section order by first output', 'pending section in a placed group'],
  initial,
  steps: [
    {
      label: 'The green tea answer shows text first: it is placed above the still-pending group',
      delayMs: 1200,
      next: (previous) =>
        fx
          .from(previous)
          .patch('section', 'tea', { state: 'completed', status: null })
          .patch('attempt', 'tea-1', { state: 'completed', text: 'About 70–80 °C. Boiling water makes green tea bitter.' })
          .build(),
    },
    {
      label: 'The translation shows text: the group is fixed here, and the translation takes the first place in it',
      delayMs: 1300,
      next: (previous) =>
        fx
          .from(previous)
          .patch('section', 'menu', { state: 'completed', status: null })
          .patch('attempt', 'menu-1', { state: 'completed', text: '"Sopa de verduras" means vegetable soup.' })
          .build(),
    },
    {
      label: 'The hike answer starts: it takes the second place, above the still-pending sky section',
      delayMs: 1300,
      next: (previous) =>
        fx
          .from(previous)
          .patch('section', 'hike', { state: 'streaming', status: null })
          .patch('attempt', 'hike-1', { state: 'streaming', text: 'Water, weather-ready layers, sturdy shoes, ' })
          .build(),
    },
    {
      label: 'The sky answer arrives last and stays last; the group never moved',
      delayMs: 1300,
      next: (previous) =>
        fx
          .from(previous)
          .patch('section', 'hike', { state: 'completed' })
          .patch('attempt', 'hike-1', { state: 'completed', text: 'Water, weather-ready layers, sturdy shoes, snacks, a map, and a small first-aid kit.' })
          .patch('section', 'sky', { state: 'completed', status: null })
          .patch('attempt', 'sky-1', {
            state: 'completed',
            text: 'Air scatters short blue wavelengths of sunlight far more than long red ones, so blue reaches you from every direction.',
          })
          .build(),
    },
  ],
}

export default fixture

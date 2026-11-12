import { fx, type Fixture } from '@/fixtures'

const initial = fx
  .conversation('stopped')
  .chain('gardens', { label: 'gardens' })
  .chain('sake', { label: 'sake breweries' })
  .message('gardens', 'Which gardens are best in late autumn?')
  .response('gardens', { message: 'gardens' })
  .section('gardens', { response: 'gardens', chain: 'gardens', state: 'stopped', title: 'gardens' })
  .attempt('gardens-1', {
    section: 'gardens',
    state: 'stopped',
    text: 'For maple color, start with Tofuku-ji, whose valley of maples peaks in the last week of November. Then',
  })
  .message('sake', 'Tell me about the sake breweries in Fushimi.')
  .response('sake', { message: 'sake' })
  .section('sake', { response: 'sake', chain: 'sake', state: 'streaming', title: 'sake breweries' })
  .attempt('sake-1', {
    section: 'sake',
    state: 'streaming',
    text: 'Fushimi has brewed sake for four centuries because of its soft spring water. Two breweries welcome visitors: ',
  })
  .build()

/**
 * Stopped work (Q22): visible text stays, marked partial and stopped, and
 * the section offers Retry. A running section offers Stop. A retry streams
 * beneath the collapsed stopped text, in the same bubble.
 */
const fixture: Fixture = {
  id: 'stopped',
  title: 'Stopped, and retried in the same bubble',
  covers: ['F2', 'stopped section', 'Stop', 'Retry', 'retry beneath collapsed stopped text'],
  initial,
  respond(command) {
    if (command.type === 'stop' && command.target.kind === 'section' && command.target.sectionId === fx.id('section', 'sake')) {
      return {
        steps: [
          {
            label: 'Stop: the brewery answer keeps its text, marked partial and stopped',
            delayMs: 0,
            next: (previous) =>
              fx.from(previous).patch('section', 'sake', { state: 'stopped' }).patch('attempt', 'sake-1', { state: 'stopped' }).build(),
          },
        ],
      }
    }
    if (command.type === 'retry' && command.target.kind === 'section' && command.target.sectionId === fx.id('section', 'gardens')) {
      return {
        steps: [
          {
            label: 'Retry: the stopped text collapses and the new attempt starts beneath it',
            delayMs: 0,
            next: (previous) =>
              fx
                .from(previous)
                .patch('attempt', 'gardens-1', { collapsed: true })
                .patch('section', 'gardens', { state: 'streaming', status: 'responding', directiveState: 'running' })
                .attempt('gardens-2', { section: 'gardens', state: 'running', origin: 'user-retry' })
                .build(),
          },
          {
            label: 'The retry streams beneath the collapsed stopped text',
            delayMs: 900,
            next: (previous) =>
              fx
                .from(previous)
                .patch('section', 'gardens', { status: null })
                .patch('attempt', 'gardens-2', {
                  state: 'streaming',
                  text: 'Three gardens are at their best in late November: Tofuku-ji for maples, Eikan-do for evening illumination, ',
                })
                .build(),
          },
          {
            label: 'The retry completes',
            delayMs: 900,
            next: (previous) =>
              fx
                .from(previous)
                .patch('section', 'gardens', { state: 'completed' })
                .patch('attempt', 'gardens-2', {
                  state: 'completed',
                  text: 'Three gardens are at their best in late November: Tofuku-ji for maples, Eikan-do for evening illumination, and Shisen-do for a quiet morning.',
                })
                .build(),
          },
        ],
      }
    }
    return null
  },
}

export default fixture

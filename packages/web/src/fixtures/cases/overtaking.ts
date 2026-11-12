import { fx, type Fixture } from '@/fixtures'

const initial = fx
  .conversation('overtaking')
  .chain('trip', { label: 'Kyoto trip' })
  .chain('hoods', { kind: 'fork', base: 'trip', label: 'neighborhoods' })
  .chain('rain', { kind: 'fork', base: 'trip', label: 'rainy-day activities' })
  .message('brief', 'I am planning five days in Kyoto in November on a moderate budget.')
  .response('brief', { message: 'brief' })
  .section('brief', { response: 'brief', chain: 'trip', state: 'completed', title: 'trip brief' })
  .attempt('brief-1', {
    section: 'brief',
    state: 'completed',
    text: 'Noted: Kyoto, five days, November, moderate budget. Ask for anything you want planned.',
  })
  .message('A', 'Suggest neighborhoods to stay in.')
  .response('A', { message: 'A' })
  .section('A', { response: 'A', chain: 'hoods', state: 'pending', title: 'neighborhoods' })
  .attempt('A-1', { section: 'A', state: 'running' })
  .message('B', 'Suggest rainy-day activities.')
  .response('B', { message: 'B' })
  .section('B', { response: 'B', chain: 'rain', state: 'pending', title: 'rainy-day activities' })
  .attempt('B-1', { section: 'B', state: 'running' })
  .build()

/**
 * P1, then P2, as steps.
 *
 * P1: A was requested first, but independent B shows answer text first, so
 * B's reply sits above A's pending bubble. P3: the user messages keep
 * submission order throughout.
 *
 * P2: C shows text before D and D completes before C; C stays ahead of D.
 */
const fixture: Fixture = {
  id: 'overtaking',
  title: 'Overtaking',
  covers: ['P1', 'P2', 'P3', 'P4', 'overtaking', 'pending bubble pushed down'],
  initial,
  steps: [
    {
      label: 'P1 · B shows text first and takes its place above A’s pending bubble',
      delayMs: 1200,
      next: (previous) =>
        fx
          .from(previous)
          .patch('section', 'B', { state: 'streaming', status: null })
          .patch('attempt', 'B-1', { state: 'streaming', text: 'Three good options when it rains: the Kyoto Railway Museum, ' })
          .build(),
    },
    {
      label: 'B completes while A is still pending',
      delayMs: 900,
      next: (previous) =>
        fx
          .from(previous)
          .patch('section', 'B', { state: 'completed' })
          .patch('attempt', 'B-1', {
            state: 'completed',
            text: 'Three good options when it rains: the Kyoto Railway Museum, the covered Nishiki Market, and an afternoon at a tea house in Gion.',
          })
          .build(),
    },
    {
      label: 'A shows text: it is placed after B, where it was when its first text arrived',
      delayMs: 900,
      next: (previous) =>
        fx
          .from(previous)
          .patch('section', 'A', { state: 'completed', status: null })
          .patch('attempt', 'A-1', {
            state: 'completed',
            text: 'Stay in Gion for atmosphere, near Kyoto Station for transit, or in Nakagyo for food and value.',
          })
          .build(),
    },
    {
      label: 'P2 setup · C and D are sent; both are pending',
      delayMs: 1000,
      next: (previous) =>
        fx
          .from(previous)
          .chain('food', { kind: 'fork', base: 'trip', label: 'where to eat' })
          .chain('day', { kind: 'fork', base: 'trip', label: 'day trip' })
          .message('C', 'Where should I eat on the first night?')
          .response('C', { message: 'C' })
          .section('C', { response: 'C', chain: 'food', state: 'pending', title: 'where to eat' })
          .attempt('C-1', { section: 'C', state: 'running' })
          .message('D', 'Suggest one day trip.')
          .response('D', { message: 'D' })
          .section('D', { response: 'D', chain: 'day', state: 'pending', title: 'day trip' })
          .attempt('D-1', { section: 'D', state: 'running' })
          .build(),
    },
    {
      label: 'P2 · C shows text first',
      delayMs: 900,
      next: (previous) =>
        fx
          .from(previous)
          .patch('section', 'C', { state: 'streaming', status: null })
          .patch('attempt', 'C-1', { state: 'streaming', text: 'For a first night, book a counter seat at an obanzai place in Pontocho, ' })
          .build(),
    },
    {
      label: 'P2 · D starts and completes while C is still streaming; C stays ahead',
      delayMs: 900,
      next: (previous) =>
        fx
          .from(previous)
          .patch('section', 'D', { state: 'completed', status: null })
          .patch('attempt', 'D-1', { state: 'completed', text: 'Nara: forty-five minutes by train, and the deer park and Todai-ji fill a relaxed day.' })
          .build(),
    },
    {
      label: 'C completes; nothing moves',
      delayMs: 900,
      next: (previous) =>
        fx
          .from(previous)
          .patch('section', 'C', { state: 'completed' })
          .patch('attempt', 'C-1', {
            state: 'completed',
            text: 'For a first night, book a counter seat at an obanzai place in Pontocho, where small seasonal dishes come one at a time.',
          })
          .build(),
    },
  ],
}

export default fixture

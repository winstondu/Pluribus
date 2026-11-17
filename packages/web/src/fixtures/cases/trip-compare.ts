import { fx, type Fixture } from '@/fixtures'
import { debugApp } from '@/features/debug/fixture-support'

const TEXT =
  'For Kyoto, suggest neighborhoods to stay in and some rainy-day activities. Keep everything within a short walk of a subway station. Also, why is the sky blue?'

const SUBWAY = {
  text: 'Keep everything within a short walk of a subway station.',
  shared: true,
  source: 'Keep everything within a short walk of a subway station.',
}

/**
 * The running Kyoto example as an independent composite, for the Compare
 * card on the message (the deck's Compare recording). The trip brief came
 * first; the composite then splits into the two trip forks and the
 * unrelated sky question. Both trip parts inherit the subway requirement
 * (local, shared); the sky part carries only its own instruction.
 */
const initial = fx
  .conversation('trip-compare')
  .chain('trip', { label: 'Kyoto trip' })
  .chain('hoods', { kind: 'fork', base: 'trip', label: 'neighborhoods' })
  .chain('rain', { kind: 'fork', base: 'trip', label: 'rainy-day activities' })
  .chain('sky', { label: 'why the sky is blue' })

  .message('brief', 'I am planning five days in Kyoto in November on a moderate budget.')
  .response('brief', { message: 'brief' })
  .section('brief', { response: 'brief', chain: 'trip', state: 'completed', title: 'trip brief' })
  .attempt('brief-1', {
    section: 'brief',
    state: 'completed',
    text: 'Noted: Kyoto, five days, November, moderate budget. Ask for anything you want planned.',
  })

  .message('ask', TEXT, {
    chains: ['hoods', 'rain', 'sky'],
    decomposition: {
      fragments: [
        {
          label: 'neighborhoods',
          text: 'Suggest neighborhoods in Kyoto to stay in. Keep everything within a short walk of a subway station.',
          source: 'suggest neighborhoods to stay in',
          requirements: [SUBWAY],
          directive: 'A',
          chain: 'hoods',
          section: 'A',
        },
        {
          label: 'rainy-day activities',
          text: 'Suggest rainy-day activities in Kyoto. Keep everything within a short walk of a subway station.',
          source: 'some rainy-day activities',
          requirements: [SUBWAY],
          directive: 'B',
          chain: 'rain',
          section: 'B',
        },
        {
          label: 'why the sky is blue',
          text: 'Explain why the sky is blue.',
          source: 'why is the sky blue?',
          requirements: [],
          directive: 'S',
          chain: 'sky',
          section: 'S',
        },
      ],
    },
  })
  .response('ask', { message: 'ask', grouped: true })
  .section('A', { response: 'ask', chain: 'hoods', state: 'completed', title: 'neighborhoods' })
  .attempt('A-1', {
    section: 'A',
    state: 'completed',
    text: 'Karasuma-Oike for a central base on two subway lines; the Kyoto Station area for transit and value; Sanjo-Keihan for Gion on foot.',
  })
  .section('B', { response: 'ask', chain: 'rain', state: 'completed', title: 'rainy-day activities' })
  .attempt('B-1', {
    section: 'B',
    state: 'completed',
    text: 'When it rains: the covered Nishiki Market, the Kyoto International Manga Museum by Karasuma-Oike, and the Kyoto Railway Museum.',
  })
  .section('S', { response: 'ask', chain: 'sky', state: 'streaming', title: 'why the sky is blue' })
  .attempt('S-1', {
    section: 'S',
    state: 'streaming',
    text: 'Air molecules scatter short blue wavelengths of sunlight far more than long red ones, ',
  })

  .node('brief', { chain: 'trip', directive: 'brief' })
  .node('A', { chain: 'hoods', directive: 'A', parents: ['brief'], group: 'forks' })
  .node('B', { chain: 'rain', directive: 'B', parents: ['brief'], group: 'forks' })
  .node('S', { chain: 'sky', directive: 'S' })
  .group('forks', { start: 'brief', base: 'trip', members: ['A', 'B'] })

  .operation('brief', { chain: 'trip', status: 'completed', section: 'brief', retired: true })
  .operation('A', { chain: 'hoods', status: 'completed', section: 'A', retired: true })
  .operation('B', { chain: 'rain', status: 'completed', section: 'B', retired: true })
  .operation('S', { chain: 'sky', status: 'streaming', section: 'S' })
  .build()

const fixture: Fixture = {
  id: 'trip-compare',
  title: 'Kyoto in November',
  covers: ['Compare inspector', 'independent composite', 'shared requirement', 'comparePlacement inline', 'running example of 04'],
  app: debugApp({ compareIndependent: true, comparePlacement: 'inline' }),
  initial,
}

export default fixture

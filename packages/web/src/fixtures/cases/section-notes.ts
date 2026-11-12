import { fx, type Fixture } from '@/fixtures'

/**
 * The two quiet notes a section can carry besides the superseded-input
 * note: the chain is near the model's context limit (Q67, Q82), and "Redid
 * itinerary by default" at the bottom of work a choice with default redid
 * while it was still in flight (Q45, Q95).
 */
const fixture: Fixture = {
  id: 'section-notes',
  title: 'Section notes',
  covers: ['context near limit', 'Redid … by default'],
  initial: fx
    .conversation('section-notes')
    .chain('trip', { label: 'Kyoto trip' })
    .message('brief', 'I am planning four days in Kyoto in November on a moderate budget.')
    .response('brief', { message: 'brief' })
    .section('brief', {
      response: 'brief',
      chain: 'trip',
      state: 'completed',
      title: 'trip brief',
      notes: [fx.note.contextNearLimit(164_000, 200_000)],
    })
    .attempt('brief-1', {
      section: 'brief',
      state: 'completed',
      text: 'Noted: Kyoto, four days, November, moderate budget. Ask for anything you want planned.',
    })
    .message('J', 'Make an itinerary.')
    .response('J2', { message: 'J', reason: 'redo' })
    .section('J2', {
      response: 'J2',
      chain: 'trip',
      state: 'completed',
      directive: 'J',
      title: 'itinerary',
      notes: [fx.note.redoneByDefault('itinerary', 'days')],
    })
    .attempt('J2-1', {
      section: 'J2',
      state: 'completed',
      origin: 'redo',
      text: '**Day 1:** Nakagyo and Nishiki Market.\n\n**Day 2:** Higashiyama and Gion.\n\n**Day 3:** Arashiyama.\n\n**Day 4:** Fushimi Inari, then the train home.',
    })
    .build(),
}

export default fixture

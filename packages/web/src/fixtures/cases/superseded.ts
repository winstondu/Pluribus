import { WORDING } from '@pluribus/protocol'
import { fx, type Fixture } from '@/fixtures'

const A_TEXT =
  'On a moderate budget, three areas work well:\n\n- **Nakagyo** for food and a central base\n- **Kyoto Station** for transit and value\n- **Gion** for atmosphere, at a higher price'

const initial = fx
  .conversation('superseded')
  .chain('trip', { label: 'Kyoto trip' })
  .chain('hoods', { kind: 'fork', base: 'trip', label: 'neighborhoods' })
  .chain('rain', { kind: 'fork', base: 'trip', label: 'activities' })
  .chain('food', { kind: 'fork', base: 'trip', label: 'restaurants' })
  .message('brief', 'I am planning five days in Kyoto in November on a moderate budget.')
  .response('brief', { message: 'brief' })
  .section('brief', { response: 'brief', chain: 'trip', state: 'completed', title: 'trip brief' })
  .attempt('brief-1', { section: 'brief', state: 'completed', text: 'Noted: Kyoto, five days, November, moderate budget.' })
  .message('A', 'Recommend neighborhoods to stay in.')
  .response('A', { message: 'A' })
  .section('A', { response: 'A', chain: 'hoods', state: 'completed', title: 'neighborhoods' })
  .attempt('A-1', { section: 'A', state: 'completed', text: A_TEXT })
  .message('J', 'Use the neighborhoods to sketch an itinerary.')
  .response('J', { message: 'J' })
  .section('J', { response: 'J', chain: 'hoods', state: 'completed', title: 'itinerary' })
  .attempt('J-1', {
    section: 'J',
    state: 'completed',
    text: 'Stay in Nakagyo. Day 1: Nishiki Market. Day 2: Higashiyama and Gion on foot. Day 3: Arashiyama. Day 4: Fushimi Inari. Day 5: Nara.',
  })
  .message('B', 'Recommend rainy-day activities.')
  .response('B', { message: 'B' })
  .section('B', { response: 'B', chain: 'rain', state: 'streaming', title: 'activities' })
  .attempt('B-1', { section: 'B', state: 'streaming', text: 'When it rains, the Kyoto Railway Museum is the easy choice, and the covered ' })
  .message('C', 'Recommend three restaurants.')
  .response('C', { message: 'C' })
  .section('C', { response: 'C', chain: 'food', state: 'pending', title: 'restaurants' })
  .attempt('C-1', { section: 'C', state: 'running' })
  .build()

/**
 * The three things supersession leaves behind (03, 06; P10, P11), then the
 * note on completed work that read a superseded result, then a reply aimed
 * at the superseded section.
 *
 * - C is revised while status-only: its responding bubble is dropped
 *   without a trace.
 * - B is revised with answer text visible: the text stays where it is,
 *   collapsed, marked "Superseded — revised below", linked to B′.
 * - A is revised after finishing: it stays, marked superseded, linked to A′.
 * - Every replacement is a new response at its own first output.
 * - J completed on the original A: it is left as it was, with the
 *   superseded-input note and Regenerate.
 */
const fixture: Fixture = {
  id: 'superseded',
  title: 'Revisions and what they leave behind',
  covers: ['P10', 'P11', 'R5', 'T3', 'superseded attempt', 'superseded-input note', 'Regenerate', 'Replying to the revised version'],
  initial,
  steps: [
    {
      label: 'P10 · C is revised while status-only: its bubble is dropped; the replacement is a new pending response',
      delayMs: 1400,
      next: (previous) =>
        fx
          .from(previous)
          .message('C-rev', 'Actually, make those vegetarian restaurants.', { chains: ['food'], replyingTo: { sections: ['C2'], mode: 'inferred' } })
          .remove('attempt', 'C-1')
          .remove('section', 'C')
          .remove('response', 'C')
          .response('C2', { message: 'C', reason: 'revision-replacement' })
          .section('C2', { response: 'C2', chain: 'food', state: 'pending', directive: 'C', title: 'restaurants' })
          .attempt('C2-1', { section: 'C2', state: 'running', origin: 'revision' })
          .build(),
    },
    {
      label: 'P10 · B is revised with text visible: the text collapses, marked and linked; B′ is a new response',
      delayMs: 1600,
      next: (previous) =>
        fx
          .from(previous)
          .message('B-rev', 'No, indoor activities for children instead.', { chains: ['rain'], replyingTo: { sections: ['B2'], mode: 'inferred' } })
          .patch('section', 'B', { state: 'superseded', superseded: { by: 'B2' } })
          .patch('attempt', 'B-1', { state: 'superseded', collapsed: true })
          .response('B2', { message: 'B', reason: 'revision-replacement' })
          .section('B2', { response: 'B2', chain: 'rain', state: 'pending', directive: 'B', title: 'activities', replaces: 'B' })
          .attempt('B2-1', { section: 'B2', state: 'running', origin: 'revision' })
          .build(),
    },
    {
      label: 'P11 · B′ shows its first text and takes its own place; it never streams into B',
      delayMs: 1200,
      next: (previous) =>
        fx
          .from(previous)
          .patch('section', 'B2', { state: 'completed', status: null })
          .patch('attempt', 'B2-1', {
            state: 'completed',
            text: 'With children on a wet day: the Kyoto Railway Museum, the Kyoto Aquarium next door, and the manga museum in Nakagyo.',
          })
          .patch('section', 'C2', { state: 'completed', status: null })
          .patch('attempt', 'C2-1', {
            state: 'completed',
            text: 'Three vegetarian tables: shojin ryori at Shigetsu in Tenryu-ji, the tofu set at Tousuiro, and Veg Out by the Kamo river.',
          })
          .build(),
    },
    {
      label: 'A is revised after finishing: A stays, marked superseded and linked to A′; J gets the superseded-input note',
      delayMs: 1600,
      next: (previous) =>
        fx
          .from(previous)
          .message('A-rev', 'Actually, use a luxury budget for the neighborhood recommendations.', {
            chains: ['hoods'],
            replyingTo: { sections: ['A2'], mode: 'explicit' },
          })
          .patch('section', 'A', { state: 'superseded', superseded: { by: 'A2' } })
          .response('A2', { message: 'A', reason: 'revision-replacement' })
          .section('A2', { response: 'A2', chain: 'hoods', state: 'completed', directive: 'A', title: 'neighborhoods', replaces: 'A' })
          .attempt('A2-1', {
            section: 'A2',
            state: 'completed',
            origin: 'revision',
            text: 'On a luxury budget: **Higashiyama**, for ryokan with private gardens, and the **Kamo riverside**, for the large international hotels.',
          })
          .patch('section', 'J', { notes: [fx.note.supersededInput('neighborhoods', 'A')] })
          .build(),
    },
    {
      label: 'T3 · a reply aimed at the superseded A goes to A′ and says so',
      delayMs: 1600,
      next: (previous) =>
        fx
          .from(previous)
          .chain('walk', { kind: 'branch', base: 'hoods', label: 'walkability' })
          .message('walk', 'Which of these is the most walkable?', {
            replyingTo: { sections: ['A2'], mode: 'explicit', note: WORDING.replyingToRevised },
          })
          .response('walk', { message: 'walk' })
          .section('walk', { response: 'walk', chain: 'walk', state: 'pending', title: 'walkability' })
          .attempt('walk-1', { section: 'walk', state: 'running' })
          .build(),
    },
  ],
  respond(command) {
    if (command.type !== 'regenerate' || command.sectionId !== fx.id('section', 'J')) return null
    return {
      steps: [
        {
          label: 'Regenerate: J is superseded and redone against A′, as a new response',
          delayMs: 0,
          next: (previous) =>
            fx
              .from(previous)
              .patch('section', 'J', { state: 'superseded', superseded: { by: 'J2' }, notes: [] })
              .response('J2', { message: 'J', reason: 'redo' })
              .section('J2', { response: 'J2', chain: 'hoods', state: 'pending', directive: 'J', title: 'itinerary', replaces: 'J' })
              .attempt('J2-1', { section: 'J2', state: 'running', origin: 'regenerate' })
              .build(),
        },
        {
          label: 'The regenerated itinerary arrives',
          delayMs: 1100,
          next: (previous) =>
            fx
              .from(previous)
              .patch('section', 'J2', { state: 'completed', status: null })
              .patch('attempt', 'J2-1', {
                state: 'completed',
                text: 'Stay in Higashiyama. Day 1: Kiyomizu-dera at dusk. Day 2: a private tea ceremony. Day 3: Arashiyama by car. Day 4: Fushimi Inari at dawn. Day 5: Nara.',
              })
              .build(),
        },
      ],
    }
  },
}

export default fixture

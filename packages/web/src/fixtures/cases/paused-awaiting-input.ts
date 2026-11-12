import { WORDING } from '@committee/protocol'
import { fx, type Fixture } from '@/fixtures'

const PARTIAL =
  'A calm last day works best in three parts. Start with the 9:00 tea ceremony in Higashiyama, then walk north along the Philosopher’s Path while the shops open. For the evening,'

const initial = fx
  .conversation('paused-awaiting-input')
  .chain('day', { label: 'last day' })
  .chain('leaves', { label: 'autumn leaves' })
  .message('day', 'Plan my last day in Kyoto around the morning tea ceremony.')
  .response('day', { message: 'day' })
  .section('day', { response: 'day', chain: 'day', state: 'paused', title: 'last day', pause: { reason: 'awaiting-input', elicitation: 'when-flight', question: 'question' } })
  .attempt('day-1', { section: 'day', state: 'paused', text: PARTIAL })
  .response('question', { message: 'day', reason: 'clarification-question' })
  .section('question', { response: 'question', chain: 'day', state: 'completed', title: 'Question', kind: 'clarification-question', asks: 'when-flight' })
  .attempt('question-1', { section: 'question', state: 'completed', text: 'What time is your flight? The evening plan depends on when you have to leave for the airport.' })
  .message('pack', 'Then turn that plan into a packing list for the day.')
  .response('pack', { message: 'pack' })
  .section('pack', { response: 'pack', chain: 'day', state: 'pending', title: 'packing list', status: { kind: 'waiting-for-results', text: 'Waiting for last day' } })
  .queueItem('pack', { directive: 'pack', message: 'pack', state: 'waiting', waitingFor: [{ label: 'last day', directives: ['day'] }] })
  .message('sky', 'Unrelated: why are autumn leaves red?')
  .response('sky', { message: 'sky' })
  .section('sky', { response: 'sky', chain: 'leaves', state: 'completed', title: 'autumn leaves' })
  .attempt('sky-1', { section: 'sky', state: 'completed', text: 'As chlorophyll breaks down, the leaf makes anthocyanins, which are red; cool nights and sunny days make more of them.' })
  .elicitation({ kind: 'clarification', id: fx.id('elicitation', 'when-flight'), questionSectionId: fx.id('section', 'question'), blockedLabels: ['last day'] })
  .build()

/**
 * Paused awaiting user input (Q106; E5). The run discovered partway that it
 * cannot plan the evening without the flight time. It stopped: its text
 * stays, labeled partial; the section is paused, neither completed nor
 * failed; the question is an additional response with the reply affordance.
 * The packing list, which depends on the plan, stays queued with no recovery
 * choice, and unrelated work is untouched. The answer, once the user gives
 * the time, is another additional response: the paused one is not reopened.
 */
const fixture: Fixture = {
  id: 'paused-awaiting-input',
  title: 'Paused awaiting user input, with partial text and its question',
  covers: ['E5', 'paused awaiting user input', 'late clarification', 'partial text kept', 'dependents stay queued', 'Answer'],
  initial,
  steps: [
    {
      label: 'The user answers; the plan continues as another additional response and the partial text stays, labeled',
      delayMs: 2200,
      next: (previous) =>
        fx
          .from(previous)
          .resolveElicitation('when-flight')
          .patch('section', 'question', { actions: { reply: false } })
          .message('answer', '9:40 in the evening, from Kansai.', { chains: ['day'], replyingTo: { sections: ['question'], mode: 'explicit' } })
          .response('plan', { message: 'day', reason: 'clarified-answer' })
          .section('plan', { response: 'plan', chain: 'day', state: 'pending', title: 'last day', status: 'responding', directive: 'day', replaces: 'day' })
          .attempt('day-2', { section: 'plan', state: 'running', origin: 'clarified' })
          .patch('section', 'day', {
            state: 'superseded',
            status: null,
            pause: null,
            superseded: { mark: WORDING.clarifiedPartial, by: 'plan', link: WORDING.seeAnswer },
          })
          .patch('attempt', 'day-1', { markText: WORDING.clarifiedPartial, collapsed: true })
          .build(),
    },
    {
      label: 'The answer completes; only now is the packing list released',
      delayMs: 1600,
      next: (previous) =>
        fx
          .from(previous)
          .patch('section', 'plan', { state: 'completed', status: null })
          .patch('attempt', 'day-2', {
            state: 'completed',
            text: 'With a 9:40 pm flight from Kansai, leave Kyoto Station on the 6:15 Haruka. That gives you the tea ceremony, the Philosopher’s Path, a long lunch near Ginkaku-ji, and an hour at Nishiki Market for gifts before you collect your bags.',
          })
          .remove('queueItem', 'pack')
          .patch('section', 'pack', { status: 'responding' })
          .attempt('pack-1', { section: 'pack', state: 'running' })
          .build(),
    },
  ],
}

export default fixture

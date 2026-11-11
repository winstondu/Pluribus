import { fx, type Fixture } from '@/fixtures'

const TEXT = 'Translate "kaiseki" for me and explain what happened at the temple yesterday.'

const initial = fx
  .conversation('clarification')
  .chain('word', { label: 'kaiseki' })
  .chain('temple', { label: 'the temple' })
  .message('ask', TEXT, { chains: ['word', 'temple'] })
  .response('ask', { message: 'ask' })
  .section('word', { response: 'ask', chain: 'word', state: 'completed', title: 'kaiseki' })
  .attempt('word-1', {
    section: 'word',
    state: 'completed',
    text: '*Kaiseki* is a formal multi-course dinner built around the season: many small dishes, served one at a time.',
  })
  .response('question', { message: 'ask', reason: 'clarification-question' })
  .section('question', {
    response: 'question',
    chain: 'temple',
    state: 'completed',
    title: 'which temple',
    kind: 'clarification-question',
    asks: 'which-temple',
  })
  .attempt('question-1', {
    section: 'question',
    state: 'completed',
    text: 'Which temple do you mean, and what did you hear about it? I do not have yesterday’s news unless you tell me.',
  })
  .elicitation({
    kind: 'clarification',
    id: fx.id('elicitation', 'which-temple'),
    questionSectionId: fx.id('section', 'question'),
    blockedLabels: ['the temple'],
  })
  .build()

/**
 * Clarification (Q23, Q26, Q98; P9). The translation needs nothing and is
 * answered in the initial response. The explanation is missing information,
 * so a question appears as an additional response, with a reply affordance
 * like any answer section. The answer it unblocks arrives as a further
 * response: the earlier one is never reopened.
 */
const fixture: Fixture = {
  id: 'clarification',
  title: 'A clarification question and the answer it unblocks',
  covers: ['P9', 'E1', 'E2', 'clarification question', 'additional response', 'Answer'],
  initial,
  steps: [
    {
      label: 'The user answers the question; the explanation is released',
      delayMs: 1800,
      next: (previous) =>
        fx
          .from(previous)
          .resolveElicitation('which-temple')
          .message('answer', 'Kiyomizu-dera. I read that part of the stage was closed.', {
            chains: ['temple'],
            replyingTo: { sections: ['question'], mode: 'explicit' },
          })
          .response('explain', { message: 'ask', reason: 'clarified-answer' })
          .section('explain', { response: 'explain', chain: 'temple', state: 'pending', title: 'the temple', status: 'responding' })
          .attempt('explain-1', { section: 'explain', state: 'running' })
          .build(),
    },
    {
      label: 'P9 · the clarified answer is a later response, not an insertion into the first one',
      delayMs: 1300,
      next: (previous) =>
        fx
          .from(previous)
          .patch('section', 'explain', { state: 'completed', status: null })
          .patch('attempt', 'explain-1', {
            state: 'completed',
            text: 'From what you describe, part of the wooden stage at Kiyomizu-dera was roped off. That usually means routine inspection of the pillars, and the rest of the grounds stay open.',
          })
          .build(),
    },
  ],
}

export default fixture

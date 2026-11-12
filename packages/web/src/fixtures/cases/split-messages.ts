import { fx, type Fixture } from '@/fixtures'

const ORIGINAL = 'Translate this menu into English: yudofu, obanzai, matcha parfait. Then pick the best dish for a cold evening from the translation.'

const decomposition = {
  originalText: ORIGINAL,
  fragments: [
    {
      label: 'menu translation',
      text: 'Translate this menu into English: yudofu, obanzai, matcha parfait.',
      source: 'Translate this menu into English: yudofu, obanzai, matcha parfait.',
      directive: 'translate',
      chain: 'menu',
      section: 'translate',
      message: 'translate',
    },
    {
      label: 'dish for a cold evening',
      text: 'Pick the best dish for a cold evening from the translated menu.',
      source: 'pick the best dish for a cold evening from the translation',
      directive: 'pick',
      chain: 'menu',
      section: 'pick',
      message: 'pick',
    },
  ],
}

const initial = fx
  .conversation('split-messages')
  .chain('menu', { label: 'menu' })
  .message('translate', 'Translate this menu into English: yudofu, obanzai, matcha parfait.', {
    split: { original: 'whole', index: 0, count: 2 },
  })
  .message('pick', 'Then pick the best dish for a cold evening from the translation.', {
    split: { original: 'whole', index: 1, count: 2 },
  })
  .splitSet('whole', { messages: ['translate', 'pick'], undoAvailable: true, decomposition })
  .response('translate', { message: 'translate' })
  .section('translate', { response: 'translate', chain: 'menu', state: 'pending', title: 'menu translation' })
  .attempt('translate-1', { section: 'translate', state: 'running' })
  .response('pick', { message: 'pick' })
  .section('pick', {
    response: 'pick',
    chain: 'menu',
    state: 'pending',
    title: 'dish for a cold evening',
    status: { kind: 'waiting-for-results', text: 'Waiting for menu translation' },
  })
  .queueItem('pick', {
    directive: 'pick',
    message: 'pick',
    state: 'waiting',
    waitingFor: [{ label: 'menu translation', directives: ['translate'] }],
  })
  .build()

/**
 * Split messages (Q53, Q85, D4). The second part needs the first part's
 * result, so the one message is shown as two user bubbles in dependency
 * order, joined by the faint "split from one message" link, which opens
 * Compare with the exact original text. Undo split is offered until a split
 * message shows answer text; using it restores one atomic request.
 */
const fixture: Fixture = {
  id: 'split-messages',
  title: 'Split messages and Undo split',
  covers: ['D4', 'split messages', 'split from one message', 'Undo split'],
  initial,
  steps: [
    {
      label: 'D4 · the translation shows answer text: Undo split is no longer offered',
      delayMs: 2500,
      next: (previous) =>
        fx
          .from(previous)
          .patch('section', 'translate', { state: 'streaming', status: null })
          .patch('attempt', 'translate-1', { state: 'streaming', text: 'Yudofu is simmered tofu; obanzai is ' })
          .patch('splitSet', 'whole', { undoAvailable: false })
          .build(),
    },
    {
      label: 'The translation completes; the second part is released',
      delayMs: 1200,
      next: (previous) =>
        fx
          .from(previous)
          .patch('section', 'translate', { state: 'completed' })
          .patch('attempt', 'translate-1', {
            state: 'completed',
            text: 'Yudofu is simmered tofu; obanzai is Kyoto home-style small dishes; a matcha parfait is green tea ice cream layered with red beans and rice dumplings.',
          })
          .remove('queueItem', 'pick')
          .patch('section', 'pick', { status: 'responding' })
          .attempt('pick-1', { section: 'pick', state: 'running' })
          .build(),
    },
  ],
  respond(command, current) {
    if (command.type !== 'undo-split') return null
    if (current.transcript.splits[fx.id('message', 'whole')]?.undoAvailable !== true) {
      return { result: { ok: false, error: { code: 'not-allowed', message: 'A split message already shows answer text.' } } }
    }
    return {
      steps: [
        {
          label: 'Undo split: the running attempt stops, its status-only bubbles are dropped, and one atomic request is routed',
          delayMs: 0,
          next: (previous) =>
            fx
              .from(previous)
              .remove('queueItem', 'pick')
              .remove('attempt', 'translate-1')
              .remove('section', 'translate')
              .remove('section', 'pick')
              .remove('response', 'translate')
              .remove('response', 'pick')
              .remove('message', 'translate')
              .remove('message', 'pick')
              .remove('splitSet', 'whole')
              .message('whole', ORIGINAL)
              .response('whole', { message: 'whole', routing: 'routing' })
              .build(),
        },
        {
          label: 'Routed as one atomic request',
          delayMs: 900,
          next: (previous) =>
            fx
              .from(previous)
              .patch('response', 'whole', { routing: null })
              .section('whole', { response: 'whole', chain: 'menu', state: 'pending', title: 'menu and a dish' })
              .attempt('whole-1', { section: 'whole', state: 'running' })
              .build(),
        },
      ],
    }
  },
}

export default fixture

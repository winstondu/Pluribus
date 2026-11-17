import { fx, type Fixture } from '@/fixtures'

const TEA =
  '**A tea ceremony** lasts about forty-five minutes. The host cleans each utensil in front of you, whisks the matcha, and serves it with a sweet that is eaten first.'
const RAIL =
  'Not for five days based in Kyoto. A national rail pass only pays off with long shinkansen trips; local trains and buses cost a few hundred yen each.'

const initial = fx
  .conversation('modal-target-ambiguity')
  .chain('tea', { label: 'tea ceremony' })
  .chain('rail', { label: 'rail pass' })
  .message('tea', 'What happens at a tea ceremony?')
  .response('tea', { message: 'tea' })
  .section('tea', { response: 'tea', chain: 'tea', state: 'completed', title: 'tea ceremony' })
  .attempt('tea-1', { section: 'tea', state: 'completed', text: TEA })
  .message('rail', 'Is a rail pass worth it?')
  .response('rail', { message: 'rail' })
  .section('rail', { response: 'rail', chain: 'rail', state: 'completed', title: 'rail pass' })
  .attempt('rail-1', { section: 'rail', state: 'completed', text: RAIL })
  .message('shorter', 'Make that shorter.', { routing: 'awaiting-target' })
  .response('shorter', { message: 'shorter', routing: 'awaiting-target' })
  .elicitation({
    kind: 'target-ambiguity',
    id: fx.id('elicitation', 'which'),
    messageId: fx.id('message', 'shorter'),
    messageText: 'Make that shorter.',
    candidates: [
      { sectionId: fx.id('section', 'tea'), title: 'tea ceremony', excerpt: TEA, chainId: fx.id('chain', 'tea') },
      { sectionId: fx.id('section', 'rail'), title: 'rail pass', excerpt: RAIL, chainId: fx.id('chain', 'rail') },
    ],
  })
  .build()

/**
 * Target ambiguity (Q10, Q20, Q95): "Make that shorter" could address
 * either answer, so the reply is not acted on. A modal above the composer
 * offers the existing sections; there is no default. The message's
 * responding bubble says it is waiting for the answer. Choosing routes the
 * message with the chosen target.
 */
const fixture: Fixture = {
  id: 'modal-target-ambiguity',
  title: 'Target ambiguity: choose a section',
  covers: ['E', 'T1', 'target-ambiguity modal', 'Choose section', 'awaiting-target status'],
  initial,
  respond(command) {
    if (command.type !== 'answer-elicitation' || command.answer.kind !== 'target-ambiguity') return null
    const chosen = command.answer.sectionIds
    const names = (['tea', 'rail'] as const).filter((name) => chosen.includes(fx.id('section', name)))
    const first = names[0] ?? 'tea'
    return {
      steps: [
        {
          label: 'Chosen: the modal closes and the message is routed with that target',
          delayMs: 0,
          next: (previous) =>
            fx
              .from(previous)
              .resolveElicitation('which')
              .patch('message', 'shorter', { routing: 'routing', replyingTo: { sections: [...names], mode: 'elicited' } })
              .patch('response', 'shorter', { routing: 'routing' })
              .build(),
        },
        {
          label: 'Routed as a revision: the target is superseded and its replacement is a new response',
          delayMs: 900,
          next: (previous) =>
            fx
              .from(previous)
              .remove('response', 'shorter')
              .patch('message', 'shorter', { routing: 'routed', chains: [first] })
              .patch('section', first, { state: 'superseded', superseded: { by: `${first}-short` } })
              .response(`${first}-short`, { message: first, reason: 'revision-replacement' })
              .section(`${first}-short`, {
                response: `${first}-short`,
                chain: first,
                state: 'completed',
                directive: first,
                title: first === 'tea' ? 'tea ceremony' : 'rail pass',
                replaces: first,
              })
              .attempt(`${first}-short-1`, {
                section: `${first}-short`,
                state: 'completed',
                origin: 'revision',
                text:
                  first === 'tea'
                    ? 'About forty-five minutes: the host prepares matcha in front of you and serves it after a sweet.'
                    : 'No. For five days in Kyoto, pay per ride.',
              })
              .build(),
        },
      ],
    }
  },
}

export default fixture

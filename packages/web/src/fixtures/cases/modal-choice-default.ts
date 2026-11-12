import type { ElicitationView } from '@pluribus/protocol'
import { fx, type Fixture } from '@/fixtures'

const WAIT_MS = 30_000

type Choice = Extract<ElicitationView, { kind: 'choice-with-default' }>

function choice(selected: readonly string[]): Choice {
  const option = (name: string, label: string, state: 'finished' | 'running' | 'queued', preselected: boolean) => ({
    directiveId: fx.id('directive', name),
    label,
    state,
    locked: state !== 'finished',
    preselected: state !== 'finished' || preselected,
    selected: state !== 'finished' || selected.includes(name),
  })
  return {
    kind: 'choice-with-default',
    id: fx.id('elicitation', 'days'),
    revisionMessageId: fx.id('message', 'days'),
    correction: 'Actually, the trip is four days, not five.',
    options: [
      option('J', 'itinerary', 'finished', true),
      option('A', 'neighborhoods', 'finished', false),
      option('B', 'activities', 'finished', false),
      option('P', 'packing list', 'running', true),
      option('D', 'day trip', 'queued', true),
    ],
    // Counted from when the fixture is loaded, so the countdown is live in the gallery.
    deadlineAt: Date.now() + WAIT_MS,
    waitMs: WAIT_MS,
  }
}

const initial = fx
  .conversation('modal-choice-default')
  .chain('trip', { label: 'Kyoto trip' })
  .chain('hoods', { kind: 'fork', base: 'trip', label: 'neighborhoods' })
  .chain('rain', { kind: 'fork', base: 'trip', label: 'activities' })
  .chain('pack', { kind: 'branch', base: 'trip', label: 'packing list' })
  .message('brief', 'I am planning five days in Kyoto in November on a moderate budget.')
  .response('brief', { message: 'brief' })
  .section('brief', { response: 'brief', chain: 'trip', state: 'completed', title: 'trip brief' })
  .attempt('brief-1', { section: 'brief', state: 'completed', text: 'Noted: Kyoto, five days, November, moderate budget.' })
  .message('A', 'Recommend neighborhoods to stay in.')
  .response('A', { message: 'A' })
  .section('A', { response: 'A', chain: 'hoods', state: 'completed', title: 'neighborhoods' })
  .attempt('A-1', { section: 'A', state: 'completed', text: 'Nakagyo for food and the subway, the Kyoto Station area for day trips, Gion for evenings.' })
  .message('B', 'Recommend rainy-day activities.')
  .response('B', { message: 'B' })
  .section('B', { response: 'B', chain: 'rain', state: 'completed', title: 'activities' })
  .attempt('B-1', { section: 'B', state: 'completed', text: 'The Kyoto Railway Museum, Nishiki Market under its arcade, and a tea ceremony in Gion.' })
  .message('J', 'Use both to make a five-day itinerary.')
  .response('J', { message: 'J' })
  .section('J', { response: 'J', chain: 'trip', state: 'completed', title: 'itinerary' })
  .attempt('J-1', {
    section: 'J',
    state: 'completed',
    text: 'Day 1: Nishiki Market. Day 2: Higashiyama and Gion. Day 3: Arashiyama. Day 4: Fushimi Inari. Day 5: Nara.',
  })
  .message('P', 'Write a packing list for the trip.')
  // The packing list was running when the brief was revised: it stopped at once, with only status showing,
  // so its bubble was dropped, and its replacement is held until the choice is made.
  .response('P2', { message: 'P', reason: 'redo' })
  .section('P2', { response: 'P2', chain: 'pack', state: 'pending', directive: 'P', title: 'packing list', status: 'awaiting-answer' })
  .message('D', 'Then suggest a day trip that fits the itinerary.')
  .response('D', { message: 'D' })
  .section('D', { response: 'D', chain: 'trip', state: 'pending', title: 'day trip', status: 'awaiting-answer' })
  .message('days', 'Actually, the trip is four days, not five.', { chains: ['trip'] })
  .elicitation(choice(['J']))
  .build()

/**
 * Choice with default (Q42–Q45, Q84, Q95), after a shared requirement was
 * revised. The itinerary is pre-selected because it is the work actually
 * affected. The packing list was running, so it stopped at once and is
 * always redone; the day trip was queued and always picks up the change.
 * Both are locked. The countdown runs to the default, which is also carried
 * out when another message is sent.
 *
 * Regenerate is rejected while the choice is open, to show a command error.
 */
const fixture: Fixture = {
  id: 'modal-choice-default',
  title: 'Choice with default: which work to redo',
  covers: ['E3', 'E4', 'choice-with-default modal', 'countdown', 'locked option', 'rejected command'],
  initial: fx
    .from(initial)
    .patch('section', 'A', { notes: [fx.note.supersededInput('an earlier trip brief', 'brief')] })
    .build(),
  steps: [
    {
      label: 'The wait elapses: the default runs. The itinerary is redone as a new response; held work starts',
      delayMs: WAIT_MS,
      next: (previous) => carryOut(previous, ['J'], true),
    },
  ],
  respond(command, current) {
    if (command.type === 'regenerate') {
      return { result: { ok: false, error: { code: 'not-allowed', message: 'Answer the open choice before regenerating.' } } }
    }
    if (command.type !== 'answer-elicitation' || command.answer.kind !== 'choice-with-default') return null
    const names = (['J', 'A', 'B'] as const).filter((name) => command.answer.kind === 'choice-with-default' && command.answer.redo.includes(fx.id('directive', name)))
    if (!command.answer.confirm) {
      const open = current.queue.elicitations.find((elicitation) => elicitation.kind === 'choice-with-default')
      const edited = { ...choice(names), deadlineAt: open?.kind === 'choice-with-default' ? open.deadlineAt : Date.now() + WAIT_MS }
      return { steps: [{ label: 'The selection is edited', delayMs: 0, next: (previous) => fx.from(previous).elicitation(edited).build() }] }
    }
    return {
      steps: [{ label: 'Confirmed: the selection is carried out', delayMs: 0, next: (previous) => carryOut(previous, names, false) }],
    }
  },
}

const TITLES = { J: 'itinerary', A: 'neighborhoods', B: 'activities' } as const
const CHAINS = { J: 'trip', A: 'hoods', B: 'rain' } as const

function carryOut(previous: Parameters<typeof fx.from>[0], redo: readonly ('J' | 'A' | 'B')[], byDefault: boolean) {
  let next = fx.from(previous).resolveElicitation('days')
  for (const name of ['J', 'A', 'B'] as const) {
    if (redo.includes(name)) {
      next = next
        .patch('section', name, { state: 'superseded', superseded: { by: `${name}2` }, notes: [] })
        .response(`${name}2`, { message: name, reason: 'redo' })
        .section(`${name}2`, {
          response: `${name}2`,
          chain: CHAINS[name],
          state: 'pending',
          directive: name,
          title: TITLES[name],
          replaces: name,
          status: 'responding',
        })
        .attempt(`${name}2-1`, { section: `${name}2`, state: 'running', origin: 'redo' })
    } else {
      next = next.patch('section', name, { notes: [fx.note.supersededInput('trip brief', 'brief')] })
    }
  }
  return next
    .patch('section', 'P2', {
      status: 'responding',
      notes: byDefault ? [fx.note.redoneByDefault('packing list', 'days')] : [],
    })
    .attempt('P2-1', { section: 'P2', state: 'running', origin: 'redo' })
    .patch('section', 'D', { status: { kind: 'waiting-for-results', text: 'Waiting for itinerary' } })
    .build()
}

export default fixture

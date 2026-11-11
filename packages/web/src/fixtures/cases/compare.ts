import { fx, type Fixture } from '@/fixtures'
import { debugApp } from '@/features/debug/fixture-support'

const TEXT =
  'For the spring newsletter: write the welcome paragraph, summarize the three workshop dates, and actually the volunteer call should ask for weekend help, not weekday help. Keep each piece under 120 words. From now on, use British spelling.'

const WORD_LIMIT = { text: 'Keep it under 120 words.', shared: true, source: 'Keep each piece under 120 words.' }
const SPELLING = { text: 'Use British spelling.', shared: true, scope: 'session-wide' as const, source: 'From now on, use British spelling.' }

/**
 * An independent composite, shown as one reply with sections, for the
 * Compare inspector. Two parts are new work; the third corrects an earlier
 * answer and starts no work of its own. Every part inherited the word limit
 * (local, shared) and the spelling rule (session-wide, because the user
 * said "from now on").
 */
const initial = fx
  .conversation('compare')
  .chain('volunteer', { label: 'volunteer call' })
  .chain('welcome', { label: 'welcome paragraph' })
  .chain('dates', { label: 'workshop dates' })

  .message('volunteer', 'Draft a call for volunteers for the spring fair.')
  .response('volunteer', { message: 'volunteer' })
  .section('volunteer', {
    response: 'volunteer',
    chain: 'volunteer',
    state: 'superseded',
    title: 'volunteer call',
    superseded: { by: 'volunteer-revised' },
  })
  .attempt('volunteer-1', {
    section: 'volunteer',
    state: 'completed',
    text: 'Can you spare a weekday afternoon? We need help setting up stalls for the spring fair.',
  })

  .message('newsletter', TEXT, {
    chains: ['welcome', 'dates', 'volunteer'],
    decomposition: {
      fragments: [
        {
          label: 'welcome paragraph',
          text: 'Write the welcome paragraph of the spring newsletter. Keep it under 120 words. Use British spelling.',
          source: 'write the welcome paragraph',
          requirements: [WORD_LIMIT, SPELLING],
          directive: 'welcome',
          chain: 'welcome',
          section: 'welcome',
        },
        {
          label: 'workshop dates',
          text: 'Summarize the three workshop dates for the spring newsletter. Keep it under 120 words. Use British spelling.',
          source: 'summarize the three workshop dates',
          requirements: [WORD_LIMIT, SPELLING],
          directive: 'dates',
          chain: 'dates',
          section: 'dates',
        },
        {
          label: 'volunteer call',
          kind: 'revision',
          text: 'The volunteer call should ask for weekend help, not weekday help.',
          source: 'actually the volunteer call should ask for weekend help, not weekday help',
          requirements: [WORD_LIMIT, SPELLING],
          directive: 'volunteer',
          chain: 'volunteer',
          section: 'volunteer-revised',
        },
      ],
    },
  })
  .response('newsletter', { message: 'newsletter', grouped: true })
  .section('welcome', { response: 'newsletter', chain: 'welcome', state: 'completed', title: 'welcome paragraph' })
  .attempt('welcome-1', {
    section: 'welcome',
    state: 'completed',
    text: 'Welcome to the spring issue. The days are longer, the allotment is waking up, and our programme is fuller than ever.',
  })
  .section('dates', { response: 'newsletter', chain: 'dates', state: 'streaming', title: 'workshop dates' })
  .attempt('dates-1', { section: 'dates', state: 'streaming', text: 'Three workshops this season: seed-saving on 12 April, ' })
  .response('volunteer-revised', { message: 'volunteer', reason: 'revision-replacement' })
  .section('volunteer-revised', {
    response: 'volunteer-revised',
    chain: 'volunteer',
    state: 'completed',
    title: 'volunteer call',
    directive: 'volunteer',
    replaces: 'volunteer',
  })
  .attempt('volunteer-2', {
    section: 'volunteer-revised',
    state: 'completed',
    origin: 'revision',
    text: 'Can you spare a few hours one weekend? We need help setting up stalls for the spring fair.',
  })

  .node('volunteer', { chain: 'volunteer', directive: 'volunteer', section: 'volunteer' })
  .node('volunteer-revised', {
    chain: 'volunteer',
    directive: 'volunteer',
    section: 'volunteer-revised',
    reason: 'revision',
    replaces: 'volunteer',
    label: 'volunteer call, revised',
  })
  .node('welcome', { chain: 'welcome', directive: 'welcome' })
  .node('dates', { chain: 'dates', directive: 'dates' })

  .operation('volunteer', { chain: 'volunteer', status: 'superseded', section: 'volunteer', retired: true })
  .operation('volunteer-revised', { chain: 'volunteer', status: 'completed', section: 'volunteer-revised', retired: true })
  .operation('welcome', { chain: 'welcome', status: 'completed', section: 'welcome', retired: true })
  .operation('dates', { chain: 'dates', status: 'streaming', section: 'dates' })
  .build()

const fixture: Fixture = {
  id: 'compare',
  title: 'Compare: a composite with a correction',
  covers: [
    'Compare inspector',
    'independent composite',
    'shared requirement',
    'session-wide requirement',
    'corrective fragment',
    'provenance',
    'Q94',
  ],
  app: debugApp({ compareIndependent: true, miniMap: true }),
  initial,
}

export default fixture

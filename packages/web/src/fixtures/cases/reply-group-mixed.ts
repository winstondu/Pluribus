import { fx, type Fixture } from '@/fixtures'

const TEXT =
  'For the Kyoto trip: list what to pack, translate five phrases I will need, convert a 60,000 yen budget to euros, and name two books to read on the flight. Keep each answer short.'

/**
 * One reply group for an independent composite, with a section in each
 * settled state and one still pending inside the placed group (Q93). The
 * header counts the mixed results; there is no overall failed label (Q50).
 */
const fixture: Fixture = {
  id: 'reply-group-mixed',
  title: 'Reply group with mixed results',
  covers: ['reply group', 'header count', 'failed section', 'stopped section', 'pending section in a placed group', 'F'],
  initial: fx
    .conversation('reply-group-mixed')
    .chain('pack', { label: 'packing list' })
    .chain('phrases', { label: 'phrases' })
    .chain('budget', { label: 'budget in euros' })
    .chain('books', { label: 'books' })
    .message('ask', TEXT, {
      decomposition: {
        fragments: [
          {
            label: 'packing list',
            text: 'List what to pack for a November trip to Kyoto. Keep the answer short.',
            source: 'list what to pack',
            requirements: [{ text: 'Keep the answer short.', shared: true, source: 'Keep each answer short.' }],
            directive: 'pack',
            chain: 'pack',
            section: 'pack',
          },
          {
            label: 'phrases',
            text: 'Translate five phrases a visitor to Kyoto will need. Keep the answer short.',
            source: 'translate five phrases I will need',
            requirements: [{ text: 'Keep the answer short.', shared: true, source: 'Keep each answer short.' }],
            directive: 'phrases',
            chain: 'phrases',
            section: 'phrases',
          },
          {
            label: 'budget in euros',
            text: 'Convert a budget of 60,000 yen to euros. Keep the answer short.',
            source: 'convert a 60,000 yen budget to euros',
            requirements: [{ text: 'Keep the answer short.', shared: true, source: 'Keep each answer short.' }],
            directive: 'budget',
            chain: 'budget',
            section: 'budget',
          },
          {
            label: 'books',
            text: 'Name two books to read on a flight to Kyoto. Keep the answer short.',
            source: 'name two books to read on the flight',
            requirements: [{ text: 'Keep the answer short.', shared: true, source: 'Keep each answer short.' }],
            directive: 'books',
            chain: 'books',
            section: 'books',
          },
        ],
      },
    })
    .response('ask', { message: 'ask', grouped: true })
    .section('pack', { response: 'ask', chain: 'pack', state: 'completed', title: 'Packing list' })
    .attempt('pack-1', {
      section: 'pack',
      state: 'completed',
      text: 'Layers for 8–17 °C, a compact umbrella, slip-on shoes for temples, a coin purse, and a small towel.',
    })
    .section('budget', { response: 'ask', chain: 'budget', state: 'failed', title: 'Budget in euros' })
    .attempt('budget-1', {
      section: 'budget',
      state: 'failed',
      text: '',
      failure: fx.error('out-of-credits', 'Out of OpenRouter credits', 402),
    })
    .section('phrases', { response: 'ask', chain: 'phrases', state: 'stopped', title: 'Phrases' })
    .attempt('phrases-1', {
      section: 'phrases',
      state: 'stopped',
      text: 'Sumimasen (excuse me), arigatou gozaimasu (thank you), kore o kudasai (this one, please),',
    })
    .section('books', { response: 'ask', chain: 'books', state: 'pending', title: 'Books' })
    .attempt('books-1', { section: 'books', state: 'running' })
    .build(),
}

export default fixture

import { fx, type Fixture } from '@/fixtures'
import { debugApp } from '@/features/debug/fixture-support'

const TEXT = 'Why is the sky blue? Also, translate “sopa de verduras” into English. Keep both answers brief.'

const BRIEF = { text: 'Keep the answer brief.', shared: true, source: 'Keep both answers brief.' }

/**
 * Compare placed on the message (`debug.comparePlacement: 'inline'`): an
 * independent composite with two fragments that share one local
 * requirement. "Show decomposition" in the message header opens the card
 * under the message; the side panel has no Compare tab.
 */
const initial = fx
  .conversation('compare-inline')
  .chain('sky', { label: 'sky' })
  .chain('menu', { label: 'menu' })
  .message('ask', TEXT, {
    chains: ['sky', 'menu'],
    decomposition: {
      fragments: [
        {
          label: 'sky',
          text: 'Explain why the sky is blue. Keep the answer brief.',
          source: 'Why is the sky blue?',
          requirements: [BRIEF],
          directive: 'sky',
          chain: 'sky',
          section: 'sky',
        },
        {
          label: 'menu',
          text: 'Translate “sopa de verduras” into English. Keep the answer brief.',
          source: 'Also, translate “sopa de verduras” into English.',
          requirements: [BRIEF],
          directive: 'menu',
          chain: 'menu',
          section: 'menu',
        },
      ],
    },
  })
  .response('ask', { message: 'ask', grouped: true })
  .section('sky', { response: 'ask', chain: 'sky', state: 'completed', title: 'Why the sky is blue' })
  .attempt('sky-1', {
    section: 'sky',
    state: 'completed',
    text: 'Air molecules scatter shorter blue wavelengths of sunlight much more strongly than red ones, so blue light reaches your eyes from every part of the sky.',
  })
  .section('menu', { response: 'ask', chain: 'menu', state: 'completed', title: 'Menu translation' })
  .attempt('menu-1', { section: 'menu', state: 'completed', text: '“Sopa de verduras” means vegetable soup.' })
  .node('sky', { chain: 'sky', directive: 'sky', section: 'sky' })
  .node('menu', { chain: 'menu', directive: 'menu', section: 'menu' })
  .operation('sky', { chain: 'sky', status: 'completed', section: 'sky', retired: true })
  .operation('menu', { chain: 'menu', status: 'completed', section: 'menu', retired: true })
  .build()

const fixture: Fixture = {
  id: 'compare-inline',
  title: 'Compare on the message',
  covers: ['Compare inspector', 'independent composite', 'shared requirement', 'comparePlacement inline'],
  app: debugApp({ compareIndependent: true, comparePlacement: 'inline' }),
  initial,
}

export default fixture

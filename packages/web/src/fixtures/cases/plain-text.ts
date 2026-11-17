import { fx, type Fixture } from '@/fixtures'

const initial = fx
  .conversation('plain-text')
  .chain('fruit', { label: 'yellow fruits' })
  .chain('steps', { label: 'tea steps' })
  .message('fruit', 'List three fruits that are yellow. Just the names, one per line.')
  .response('fruit', { message: 'fruit' })
  .section('fruit', { response: 'fruit', chain: 'fruit', state: 'completed', title: 'yellow fruits' })
  .attempt('fruit-1', { section: 'fruit', state: 'completed', text: 'Banana\nLemon\nPineapple' })
  .message('steps', 'How do I brew sencha? Short.')
  .response('steps', { message: 'steps' })
  .section('steps', { response: 'steps', chain: 'steps', state: 'completed', title: 'tea steps' })
  .attempt('steps-1', {
    section: 'steps',
    state: 'completed',
    text: 'Brewing sencha\nWater at 70 to 80 °C, never boiling.\n\n1. Warm the pot.\n2. One teaspoon of leaves per cup.\n3. Steep for a minute, then pour out every drop.\n\nA second steeping needs only 20 seconds.',
  })
  .build()

/**
 * The backend asks models for plain text, so an answer's single newlines
 * are its line breaks. They are drawn as breaks; Markdown lists and blank
 * lines keep working beside them.
 */
const fixture: Fixture = {
  id: 'plain-text',
  title: 'Plain-text answers keep their line breaks',
  covers: ['line breaks in answer text', 'Markdown beside plain text'],
  initial,
  steps: [],
}

export default fixture

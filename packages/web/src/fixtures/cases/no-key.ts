import { fx, type Fixture } from '@/fixtures'

/** First run: no OpenRouter key yet. The key prompt opens by itself and the composer cannot send. */
const fixture: Fixture = {
  id: 'no-key',
  title: 'First run, no key',
  covers: ['key prompt', 'no key', 'composer without a key'],
  app: { key: { configured: false } },
  initial: fx.conversation('no-key').build(),
}

export default fixture

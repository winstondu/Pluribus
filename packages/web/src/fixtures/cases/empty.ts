import { fx, type Fixture } from '@/fixtures'

/** A new conversation: nothing sent yet. */
const fixture: Fixture = {
  id: 'empty',
  title: 'New conversation',
  covers: ['empty conversation', 'conversation list'],
  initial: fx.conversation('empty').build(),
}

export default fixture

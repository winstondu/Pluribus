import { describe, expect, test } from 'vitest'
import { answer } from '../../../testing'
import { routingScenario } from '../../../testing/acceptance/routing'

/**
 * A fork (04 · "Forks and sibling groups", C1) whose decision model scores
 * both the answer its line settled on and the work running from it weakly.
 * The running work's result is not available, and the model says the
 * message does not need it: it is no second candidate, so the message is a
 * fork on the line's settled head and the user is not asked which one is
 * meant (05 · "Additional related work … continues the chain, as a fork if
 * work there is in flight").
 */

const GOAL = 'Cloud exam in six weeks'
const PLAN = 'Make a study plan'
const COURSE = 'Also recommend a course'

async function planRunning() {
  const s = await routingScenario()
  s.t.model.script(GOAL, answer('Six weeks is workable.', 10, 20))
  await s.send(GOAL)
  await s.t.advance(50)
  s.t.model.script(PLAN, answer('Week 1 covers the basics.', 10, 5_000))
  await s.send(PLAN, { message: { relation: 'addition', targets: { [GOAL]: 0.9 } } })
  await s.t.advance(20)
  s.t.model.script(COURSE, answer('Take the official course.', 10, 20))
  const line = s.state().chains[s.d(GOAL).chainId]?.label ?? ''
  return { s, line }
}

describe('forks beside running work', () => {
  test('C1 · related work scored weakly against the settled head and the running plan, needing neither result, forks from the head without asking', async () => {
    const { s, line } = await planRunning()
    const messageId = await s.send(COURSE, { message: { relation: 'addition', chain: line, targets: { [GOAL]: 0.67, [PLAN]: 0.46 }, needs: { [PLAN]: 0.1 } } })
    await s.t.advance(50)
    expect(s.state().messages[messageId]?.routing).toBe('routed')
    const fork = s.d(COURSE)
    expect(fork.targets).toEqual([])
    expect(s.state().nodes[fork.nodeId]?.plannedParents).toEqual([{ kind: 'node', nodeId: s.d(GOAL).nodeId }])
    expect(s.d(PLAN).state).toBe('running')
    expect(fork.state).toBe('completed')
  })

  test('C1 · the same scores with the running plan plausibly needed are a question to the user', async () => {
    const { s, line } = await planRunning()
    const messageId = await s.send(COURSE, { message: { relation: 'addition', chain: line, targets: { [GOAL]: 0.67, [PLAN]: 0.46 }, needs: { [PLAN]: 0.4 } } })
    expect(s.state().messages[messageId]?.routing).toBe('awaiting-target')
  })
})

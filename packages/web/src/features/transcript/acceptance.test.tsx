import { WORDING } from '@committee/protocol'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { fx, getFixture } from '@/fixtures'
import { renderWithBackend } from '@/test/render'
import { TranscriptPane } from './index'
import { byId, play } from './test-helpers'

/** jsdom has no layout: give the scroller a size, a content height and a real scroll position. */
function layOut(scroller: HTMLElement, sizes: { clientHeight: number; scrollHeight: number }) {
  let top = 0
  let height = sizes.scrollHeight
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => sizes.clientHeight })
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => height })
  Object.defineProperty(scroller, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = Math.max(0, Math.min(value, height - sizes.clientHeight))
    },
  })
  scroller.scrollTo = ((options: ScrollToOptions) => {
    scroller.scrollTop = options.top ?? 0
  }) as typeof scroller.scrollTo
  return {
    grow(by: number) {
      height += by
    },
    userScrollTo(value: number) {
      scroller.scrollTop = value
      fireEvent.scroll(scroller)
    },
    get top() {
      return top
    },
    get bottom() {
      return height - sizes.clientHeight
    },
  }
}

test('P5 · a reader who scrolled away is not pulled to new output; a reader at the live bottom follows it', async () => {
  const view = renderWithBackend(<TranscriptPane />, { fixture: getFixture('overtaking') })
  await act(() => view.ready)
  const scroller = byId(view.container, 'data-slot', 'transcript-scroller')
  const layout = layOut(scroller, { clientHeight: 400, scrollHeight: 1000 })

  // At the live bottom: new output is followed.
  layout.userScrollTo(layout.bottom)
  layout.grow(120)
  await play(view)
  expect(layout.top).toBe(layout.bottom)
  expect(screen.queryByRole('button', { name: WORDING.newOutput })).toBeNull()

  // Scrolled away: the position is kept and "New output ↓" is offered.
  layout.userScrollTo(200)
  layout.grow(150)
  await play(view)
  expect(layout.top).toBe(200)
  layout.grow(150)
  await play(view)
  expect(layout.top).toBe(200)
  const affordance = screen.getByRole('button', { name: WORDING.newOutput })

  // Taking it goes to the live bottom, and following resumes.
  fireEvent.click(affordance)
  expect(layout.top).toBe(layout.bottom)
  fireEvent.scroll(scroller)
  layout.grow(90)
  await play(view)
  expect(layout.top).toBe(layout.bottom)
  // The affordance fades out; it is gone once that has run.
  await waitFor(() => expect(screen.queryByRole('button', { name: WORDING.newOutput })).toBeNull())
})

test('P7 · pending status appears on A’s responding bubble; user message A carries no status badge and there is no up-arrow to pending work', async () => {
  const view = renderWithBackend(<TranscriptPane />, { fixture: getFixture('pending') })
  await act(() => view.ready)

  const statuses = [WORDING.responding, WORDING.retrying, WORDING.waitingForCapacity, WORDING.waitingForSlot]
  for (const name of ['tea', 'rail', 'ryokan', 'temple'] as const) {
    const message = byId(view.container, 'data-message-id', fx.id('message', name))
    const bubble = byId(view.container, 'data-response-id', fx.id('response', name))

    // The status is on the responding bubble, which is in the pending tail.
    expect(bubble.dataset.placement).toBe('pending')
    const status = within(bubble).getByRole('status')
    expect(statuses).toContain(status.textContent)

    // Nothing about it is on the user message: no status, no badge, none of the status wording.
    expect(within(message).queryByRole('status')).toBeNull()
    expect(message.querySelector('[data-status], [data-slot="badge"]')).toBeNull()
    for (const text of statuses) expect(message.textContent).not.toContain(text)
  }

  // No arrow or link from anywhere to earlier pending work.
  expect(view.container.textContent).not.toMatch(/[↑⬆]/)
  expect(screen.queryByRole('button', { name: /earlier|still responding|pending/i })).toBeNull()
  expect(screen.queryByRole('link', { name: /earlier|still responding|pending/i })).toBeNull()
})

test('P7 (routing) · routing status and a routing failure are on the provisional responding bubble, never on the user message', async () => {
  const view = renderWithBackend(<TranscriptPane />, { fixture: getFixture('routing') })
  await act(() => view.ready)
  const message = byId(view.container, 'data-message-id', fx.id('message', 'ask'))
  const bubble = byId(view.container, 'data-response-id', fx.id('response', 'ask'))

  expect(within(bubble).getByRole('status').textContent).toBe(WORDING.routing)
  expect(message.textContent).not.toContain(WORDING.routing)
  expect(within(message).queryByRole('status')).toBeNull()

  await play(view)
  // The failure is status text on the bubble. A request as a whole never shows a failed mark (08, 10).
  const failure = within(bubble).getByRole('status')
  expect(failure.textContent).toContain('The decision model did not answer in time.')
  expect(failure.dataset.status).toBe('routing-failed')
  expect(bubble.querySelector('[data-mark]')).toBeNull()
  expect(within(bubble).queryByRole('alert')).toBeNull()
  expect(bubble.dataset.placement).toBe('pending')
  expect(within(message).queryByRole('alert')).toBeNull()
  expect(message.textContent).not.toContain('did not answer')

  // Retry on the request routes again. It is the request's control (10 · Controls: Retry on "a request"),
  // offered once: the bubble's failure text carries no second Retry that sends the same command.
  expect(within(bubble).queryByRole('button', { name: /retry/i })).toBeNull()
  expect([...view.container.querySelectorAll('button')].filter((button) => /retry/i.test(button.textContent ?? ''))).toHaveLength(1)
  fireEvent.click(within(message).getByRole('button', { name: 'Retry request' }))
  expect(view.backend?.sent.at(-1)).toEqual({
    type: 'retry',
    conversationId: view.backend?.current.conversationId,
    target: { kind: 'request', messageId: fx.id('message', 'ask') },
  })
})

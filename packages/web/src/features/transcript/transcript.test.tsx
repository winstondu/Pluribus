import { WORDING } from '@committee/protocol'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { fx, getFixture, type Fixture } from '@/fixtures'
import { renderWithBackend } from '@/test/render'
import { TranscriptPane } from './index'
import { excerpt } from './section'
import { byId, drawnOrder, play } from './test-helpers'

const m = (name: string) => `m:${fx.id('message', name)}`
const r = (name: string) => `r:${fx.id('response', name)}`
const section = (container: HTMLElement, name: string) => byId(container, 'data-section-id', fx.id('section', name))
const response = (container: HTMLElement, name: string) => byId(container, 'data-response-id', fx.id('response', name))

async function open(id: string) {
  const view = renderWithBackend(<TranscriptPane />, { fixture: getFixture(id) })
  await act(() => view.ready)
  return view
}

test('P1 (web) · B, which shows an answer first, is drawn ahead of A’s pending bubble although A was requested first', async () => {
  const view = await open('overtaking')
  expect(drawnOrder(view.container).slice(-2)).toEqual([r('A'), r('B')])
  await play(view)
  expect(drawnOrder(view.container)).toEqual([m('brief'), r('brief'), m('A'), m('B'), r('B'), r('A')])
  expect(response(view.container, 'A').dataset.placement).toBe('pending')
  expect(response(view.container, 'B').dataset.placement).toBe('fixed')
})

test('P2 (web) · A reply that showed text first stays ahead of one that completed first', async () => {
  const view = await open('overtaking')
  await play(view, 5)
  const afterFirstText = drawnOrder(view.container)
  expect(afterFirstText.indexOf(r('C'))).toBeLessThan(afterFirstText.indexOf(r('D')))
  await play(view) // D completes while C still streams
  expect(section(view.container, 'D').dataset.state).toBe('completed')
  expect(section(view.container, 'C').dataset.state).toBe('streaming')
  const afterCompletion = drawnOrder(view.container)
  expect(afterCompletion.indexOf(r('C'))).toBeLessThan(afterCompletion.indexOf(r('D')))
  await play(view)
  expect(drawnOrder(view.container)).toEqual(afterCompletion)
})

test('P3 (web) · user messages stay in submission order while replies overtake', async () => {
  const view = await open('overtaking')
  const messages = () => drawnOrder(view.container).filter((item) => item.startsWith('m:'))
  expect(messages()).toEqual([m('brief'), m('A'), m('B')])
  await play(view, 3)
  expect(messages()).toEqual([m('brief'), m('A'), m('B')])
  await play(view, 4)
  expect(messages()).toEqual([m('brief'), m('A'), m('B'), m('C'), m('D')])
})

test('P4 (web) · B’s answer can be read while A is still in progress', async () => {
  const view = await open('overtaking')
  await play(view, 2)
  expect(within(section(view.container, 'B')).getByText(/Kyoto Railway Museum/)).toBeVisible()
  expect(within(section(view.container, 'A')).getByRole('status').textContent).toBe(WORDING.responding)
  // And it can be replied to.
  fireEvent.click(within(section(view.container, 'B')).getByRole('button', { name: 'Reply to this' }))
  expect(view.ui.getState().replyTargets).toEqual([fx.id('section', 'B')])
})

test('P8 (web) · a reply group keeps its position and honours an explicit output order', async () => {
  const view = await open('barrier-ordered-group')
  const titles = () =>
    [...response(view.container, 'ordered').querySelectorAll<HTMLElement>('[data-section-id]')].map((element) => element.getAttribute('aria-label'))
  const before = drawnOrder(view.container)
  // The tipping guide showed text first and is still third, as the request asked.
  expect(titles()).toEqual(['Packing list', 'Phrase list', 'Tipping guide'])
  await play(view)
  expect(titles()).toEqual(['Packing list', 'Phrase list', 'Tipping guide'])
  expect(drawnOrder(view.container)).toEqual(before)
})

test('reply group · the group is fixed by its first section’s first output, and sections take their places at their own', async () => {
  const view = await open('group-first-output')
  const titles = () =>
    [...response(view.container, 'ask').querySelectorAll<HTMLElement>('[data-section-id]')].map((element) => element.getAttribute('aria-label'))
  expect(drawnOrder(view.container)).toEqual([m('ask'), m('tea'), r('ask'), r('tea')])
  await play(view) // another reply shows text first and overtakes the pending group
  expect(drawnOrder(view.container)).toEqual([m('ask'), m('tea'), r('tea'), r('ask')])
  await play(view) // the group's first output fixes it where it is
  expect(response(view.container, 'ask').dataset.placement).toBe('fixed')
  expect(titles()).toEqual(['Menu translation', 'Why the sky is blue', 'Weekend hike'])
  await play(view) // a second section overtakes the one still pending, inside the group
  expect(titles()).toEqual(['Menu translation', 'Weekend hike', 'Why the sky is blue'])
  expect(section(view.container, 'sky').dataset.placement).toBe('pending')
  expect(response(view.container, 'ask').contains(section(view.container, 'sky'))).toBe(true)
  await play(view)
  expect(titles()).toEqual(['Menu translation', 'Weekend hike', 'Why the sky is blue'])
  expect(drawnOrder(view.container)).toEqual([m('ask'), m('tea'), r('tea'), r('ask')])
})

test('reply group · a section per fragment, a pending section inside the placed group, and the mixed-result count with no overall label', async () => {
  const view = await open('reply-group-mixed')
  const group = response(view.container, 'ask')
  expect(group.dataset.placement).toBe('fixed')
  expect(group.querySelectorAll('[data-section-id]')).toHaveLength(4)
  expect(group.querySelector('[data-slot="group-count"]')?.textContent).toBe('1 done · 1 failed · 1 stopped · 1 pending')
  expect(section(view.container, 'books').dataset.placement).toBe('pending')
  expect(within(section(view.container, 'budget')).getByRole('alert').textContent).toContain(WORDING.outOfCredits)
  expect(within(section(view.container, 'phrases')).getByText(WORDING.stoppedPartial)).toBeVisible()
  // The header says nothing of the request as a whole (Q50).
  const header = group.querySelector('header')
  expect(header?.textContent).not.toMatch(/\b(Failed|Cancelled|Stopped)\b/)
})

test('P10 (web) · a status-only bubble disappears on supersession; partial and finished text stay, marked and linked to the replacement', async () => {
  const view = await open('superseded')
  expect(response(view.container, 'C')).toBeTruthy()
  await play(view)
  await waitFor(() => expect(view.container.querySelector(`[data-response-id="${fx.id('response', 'C')}"]`)).toBeNull())

  const before = drawnOrder(view.container).indexOf(r('B'))
  await play(view)
  const b = section(view.container, 'B')
  expect(drawnOrder(view.container).indexOf(r('B'))).toBe(before)
  expect(b.dataset.state).toBe('superseded')
  expect(within(b).getByText(WORDING.supersededPartial)).toBeVisible()
  expect(b.querySelector('[data-attempt-id]')?.hasAttribute('data-collapsed')).toBe(true)
  expect(b.textContent).toContain('Kyoto Railway Museum')
  fireEvent.click(within(b).getByRole('button', { name: /See the revision/ }))
  expect(view.ui.getState().reveal?.sectionId).toBe(fx.id('section', 'B2'))

  await play(view, 2)
  const a = section(view.container, 'A')
  expect(within(a).getByText(WORDING.supersededFinished)).toBeVisible()
  expect(within(a).queryByRole('button', { name: 'Reply to this' })).toBeNull()
  fireEvent.click(within(a).getByRole('button', { name: /See the revision/ }))
  expect(view.ui.getState().reveal?.sectionId).toBe(fx.id('section', 'A2'))
})

test('P11 (web) · a replacement is a new response, never inside the original bubble', async () => {
  const view = await open('superseded')
  await play(view, 3)
  const original = response(view.container, 'B')
  const replacement = response(view.container, 'B2')
  expect(original.contains(replacement)).toBe(false)
  expect(original.querySelectorAll('[data-section-id]')).toHaveLength(1)
  expect(original.textContent).not.toContain('Kyoto Aquarium')
  expect(replacement.textContent).toContain('Kyoto Aquarium')
  const order = drawnOrder(view.container)
  expect(order.indexOf(r('B2'))).toBeGreaterThan(order.indexOf(r('B')))
})

test('superseded-input note · quiet note with Regenerate; a reply to the superseded section says it goes to the revised version', async () => {
  const view = await open('superseded')
  await play(view, 5)
  const j = section(view.container, 'J')
  expect(within(j).getByText('Based on superseded neighborhoods')).toBeVisible()
  fireEvent.click(within(j).getByRole('button', { name: 'Regenerate' }))
  expect(view.backend?.sent.at(-1)).toMatchObject({ type: 'regenerate', sectionId: fx.id('section', 'J') })
  const reply = byId(view.container, 'data-message-id', fx.id('message', 'walk'))
  expect(within(reply).getByText(WORDING.replyingToRevised)).toBeVisible()
})

test('P12 (web) · a reply that failed before output stays where it failed; its retry fills the same bubble', async () => {
  const view = await open('failed-retry')
  await play(view)
  const bubble = response(view.container, 'early')
  expect(bubble.dataset.placement).toBe('fixed')
  expect(within(bubble).getByRole('alert').textContent).toContain('The model declined to answer this request.')
  const fixedAt = drawnOrder(view.container)

  fireEvent.click(within(bubble).getByRole('button', { name: 'Retry' }))
  await act(async () => {
    view.backend?.playAll()
  })
  // The other reply went on meanwhile; this one did not move, and no response was added for the retry.
  expect(drawnOrder(view.container)).toEqual(fixedAt)
  expect(response(view.container, 'early')).toBe(bubble)
  expect(bubble.textContent).toContain('Take your shoes off')
  expect(within(bubble).queryByRole('alert')).toBeNull()
})

test('P13 (web) · a retry after partial output streams in the same bubble beneath the collapsed, failed partial text', async () => {
  const view = await open('failed-retry')
  const responses = () => drawnOrder(view.container).filter((item) => item.startsWith('r:')).length
  const count = responses()
  await play(view, 2)
  const bubble = section(view.container, 'late')
  expect(within(bubble).getByRole('status').textContent).toBe(WORDING.retrying)
  await play(view)
  const attempts = [...bubble.querySelectorAll<HTMLElement>('[data-attempt-id]')]
  expect(attempts.map((attempt) => attempt.dataset.state)).toEqual(['failed', 'streaming'])
  expect(attempts[0]?.hasAttribute('data-collapsed')).toBe(true)
  expect(within(attempts[0] as HTMLElement).getByText(WORDING.failed)).toBeVisible()
  expect(attempts[1]?.textContent).toContain('Yes, if you ride')
  expect(responses()).toBe(count)
  // The collapsed text opens again on request.
  fireEvent.click(within(attempts[0] as HTMLElement).getByRole('button', { expanded: false }))
  expect(attempts[0]?.hasAttribute('data-collapsed')).toBe(false)
})

test('states · stopped, interrupted and cancelled are labelled distinctly and offer what the projection offers', async () => {
  const cancelled = await open('cancelled')
  expect(within(section(cancelled.container, 'packing')).getByText(WORDING.stoppedPartial)).toBeVisible()
  const never = section(cancelled.container, 'carry-on')
  expect(within(never).getByText(WORDING.cancelled)).toBeVisible()
  expect(never.querySelector('[data-attempt-id]')).toBeNull()
  expect(response(cancelled.container, 'ask').querySelector('[data-slot="group-count"]')?.textContent).toBe('1 done · 1 stopped · 1 cancelled')
  cancelled.unmount()

  const interrupted = await open('interrupted')
  const onsen = section(interrupted.container, 'onsen')
  expect(within(onsen).getByText(WORDING.interrupted)).toBeVisible()
  fireEvent.click(within(onsen).getByRole('button', { name: 'Retry' }))
  expect(interrupted.backend?.sent.at(-1)).toMatchObject({ type: 'retry', target: { kind: 'section', sectionId: fx.id('section', 'onsen') } })
  expect(within(section(interrupted.container, 'coffee')).getByRole('status').textContent).toBe(WORDING.waitingForCapacity)
})

test('stop · a running section and a whole request each have Stop', async () => {
  const view = await open('reply-group-mixed')
  fireEvent.click(within(section(view.container, 'books')).getByRole('button', { name: 'Stop' }))
  expect(view.backend?.sent.at(-1)).toMatchObject({ type: 'stop', target: { kind: 'section', sectionId: fx.id('section', 'books') } })
  const message = byId(view.container, 'data-message-id', fx.id('message', 'ask'))
  fireEvent.click(within(message).getByRole('button', { name: 'Stop request' }))
  expect(view.backend?.sent.at(-1)).toMatchObject({ type: 'stop', target: { kind: 'request', messageId: fx.id('message', 'ask') } })
  fireEvent.click(within(message).getByRole('button', { name: 'Retry request' }))
  expect(view.backend?.sent.at(-1)).toMatchObject({ type: 'retry', target: { kind: 'request', messageId: fx.id('message', 'ask') } })
})

test('split messages · joined by the "split from one message" link, which opens Compare; Undo split only while offered', async () => {
  const view = await open('split-messages')
  expect(drawnOrder(view.container).slice(0, 2)).toEqual([m('translate'), m('pick')])
  fireEvent.click(screen.getByRole('button', { name: WORDING.splitLink }))
  expect(view.ui.getState().compare).toBe(fx.id('message', 'whole'))
  expect(screen.getByRole('button', { name: 'Undo split' })).toBeVisible()
  await play(view)
  expect(screen.queryByRole('button', { name: 'Undo split' })).toBeNull()
  expect(screen.getByRole('button', { name: WORDING.splitLink })).toBeVisible()
})

test('split messages · Undo split sends the command for the original message', async () => {
  const view = await open('split-messages')
  fireEvent.click(screen.getByRole('button', { name: 'Undo split' }))
  expect(view.backend?.sent.at(-1)).toMatchObject({ type: 'undo-split', originalMessageId: fx.id('message', 'whole') })
})

test('P9 (web) · a clarification question and the answer it unblocks are additional responses; the first response is not reopened', async () => {
  const view = await open('clarification')
  const first = response(view.container, 'ask')
  const question = section(view.container, 'question')
  expect(first.contains(question)).toBe(false)
  expect(within(question).getByRole('button', { name: 'Answer' })).toBeVisible()
  await play(view, 2)
  expect(first.querySelectorAll('[data-section-id]')).toHaveLength(1)
  const order = drawnOrder(view.container)
  expect(order.indexOf(r('explain'))).toBeGreaterThan(order.indexOf(r('question')))
  expect(response(view.container, 'explain').dataset.reason).toBe('clarified-answer')
})

test('section notes · the context warning and "Redid itinerary by default" are shown on their sections', async () => {
  const view = await open('section-notes')
  expect(within(section(view.container, 'brief')).getByText(/82% of the model's context limit/)).toBeVisible()
  expect(within(section(view.container, 'J2')).getByText('Redid itinerary by default')).toBeVisible()
})

test('Focus · inherited items are highlighted in their own color; later source items are not', async () => {
  const view = await open('trip')
  const focusOf = (kind: 'message' | 'section', name: string) =>
    byId(view.container, kind === 'message' ? 'data-message-id' : 'data-section-id', fx.id(kind, name)).dataset.focus
  const railColor = (name: string) => section(view.container, name).querySelector<HTMLElement>('[data-chain]')?.dataset.colorIndex

  expect(focusOf('section', 'B2')).toBe('none')
  const colorsBefore = ['brief', 'B', 'B2', 'J', 'X'].map(railColor)

  // Pin the branch "cheaper alternatives" from its rail.
  fireEvent.click(within(section(view.container, 'B2')).getByRole('button', { name: 'Focus cheaper alternatives' }))
  expect(view.ui.getState().focus.pinned).toBe(fx.id('chain', 'cheaper'))
  expect(focusOf('section', 'B2')).toBe('own')
  expect(focusOf('message', 'B2')).toBe('own')
  // What its run read: the brief and B, lit but still in their own colors.
  expect(focusOf('section', 'brief')).toBe('inherited')
  expect(focusOf('section', 'B')).toBe('inherited')
  expect(focusOf('message', 'B')).toBe('inherited')
  expect(['brief', 'B', 'B2', 'J', 'X'].map(railColor)).toEqual(colorsBefore)
  expect(railColor('B')).not.toBe(railColor('B2'))
  // Never read by it: A, the join-back's continuation J, the join chain X, the unrelated root.
  for (const name of ['A', 'J', 'X', 'S', 'K']) expect(focusOf('section', name)).toBe('dimmed')

  // The trip chain was continued by J after B2 branched off; focusing the fork B does not light
  // J merely because J is on the chain B forked from, nor B2, which came later on B's line.
  fireEvent.click(within(section(view.container, 'B')).getByRole('button', { name: 'Focus rainy-day activities' }))
  expect(focusOf('section', 'B')).toBe('own')
  expect(focusOf('section', 'brief')).toBe('inherited')
  expect(focusOf('section', 'B2')).toBe('dimmed')
  expect(focusOf('section', 'J')).toBe('dimmed')
})

test('Focus · hover and keyboard focus preview, a click pins, and leaving a preview returns to the pin', async () => {
  const view = await open('trip')
  const railA = within(section(view.container, 'A')).getByRole('button', { name: 'Focus neighborhoods' })
  const railS = within(section(view.container, 'S')).getByRole('button', { name: 'Focus why the sky is blue' })
  const focus = () => view.ui.getState().focus

  fireEvent.pointerEnter(railA, { pointerType: 'mouse' })
  expect(focus()).toEqual({ pinned: null, preview: fx.id('chain', 'hoods') })
  expect(section(view.container, 'S').dataset.focus).toBe('dimmed')
  fireEvent.pointerLeave(railA)
  expect(focus()).toEqual({ pinned: null, preview: null })
  expect(section(view.container, 'S').dataset.focus).toBe('none')

  fireEvent.click(railS)
  expect(railS.getAttribute('aria-pressed')).toBe('true')
  fireEvent.pointerEnter(railA, { pointerType: 'mouse' })
  expect(section(view.container, 'A').dataset.focus).toBe('own')
  fireEvent.pointerLeave(railA)
  expect(section(view.container, 'S').dataset.focus).toBe('own')
  expect(section(view.container, 'A').dataset.focus).toBe('dimmed')

  // Keyboard: focus previews; blur returns.
  Object.defineProperty(railA, 'matches', { value: (selector: string): boolean => selector === ':focus-visible' })
  fireEvent.focus(railA)
  expect(focus().preview).toBe(fx.id('chain', 'hoods'))
  fireEvent.blur(railA)
  expect(focus().preview).toBeNull()

  fireEvent.click(railS)
  expect(focus().pinned).toBeNull()
})

test('rail · a join-back continues in the base chain’s color', async () => {
  const view = await open('trip')
  const color = (name: string) => section(view.container, name).querySelector<HTMLElement>('[data-chain]')?.dataset.colorIndex
  // J continues from the A/B join-back: it is the trip chain, in the brief's color, not a new one.
  expect(color('J')).toBe(color('brief'))
  expect(color('J')).not.toBe(color('A'))
  expect(color('J')).not.toBe(color('B'))
  // Forks, the later branch and the join chain each have their own.
  expect(new Set(['brief', 'A', 'B', 'S', 'B2', 'X'].map(color)).size).toBe(6)
})

test('rail · a message handled by several chains is hard segments, one per chain, never a gradient', async () => {
  const view = await open('reply-group-mixed')
  const rail = byId(view.container, 'data-message-id', fx.id('message', 'ask')).querySelector<HTMLElement>('[data-slot="chain-rail"]')
  const segments = [...(rail?.querySelectorAll<HTMLElement>('[data-chain]') ?? [])]
  expect(segments.map((segment) => segment.dataset.colorIndex)).toEqual(['0', '2', '1', '3'])
  for (const segment of segments) {
    const fill = segment.querySelector<HTMLElement>('span')
    expect(fill?.style.background).toMatch(/^var\(--chain-\d\)$/)
  }
  expect(rail?.outerHTML).not.toContain('gradient')
})

test('inspect · the run inspector affordance appears only with its toggle and sets inspected', async () => {
  const view = await open('failed-retry')
  await play(view, 3)
  expect(screen.queryByRole('button', { name: /Inspect run/ })).toBeNull()
  await act(async () => {
    await view.backend?.send({ type: 'change-settings', changes: { debug: { runInspector: true } } })
  })
  const late = section(view.container, 'late')
  fireEvent.click(within(late).getByRole('button', { name: 'Inspect run' }))
  expect(view.ui.getState().inspected).toEqual({ directiveId: fx.id('directive', 'late'), attemptId: null })
  // Beside a listed earlier attempt: that attempt.
  fireEvent.click(within(late).getByRole('button', { name: 'Inspect run of attempt 1' }))
  expect(view.ui.getState().inspected).toEqual({ directiveId: fx.id('directive', 'late'), attemptId: fx.id('attempt', 'late-1') })
})

test('inspect · Inspect decomposition appears only with its toggle, on a message that was decomposed', async () => {
  const view = await open('reply-group-mixed')
  expect(screen.queryByRole('button', { name: 'Inspect decomposition' })).toBeNull()
  await act(async () => {
    await view.backend?.send({ type: 'change-settings', changes: { debug: { compareIndependent: true } } })
  })
  fireEvent.click(screen.getByRole('button', { name: 'Inspect decomposition' }))
  expect(view.ui.getState().compare).toBe(fx.id('message', 'ask'))
})

test('answer text · the line breaks of a plain-text answer are kept: "a\\nb\\nc" is three lines', async () => {
  const fixture: Fixture = {
    id: 'lines',
    title: 'Line breaks',
    covers: [],
    initial: fx
      .conversation('lines')
      .chain('fruit', { label: 'yellow fruits' })
      .message('ask', 'List three yellow fruits, one per line.')
      .response('ask', { message: 'ask' })
      .section('fruit', { response: 'ask', chain: 'fruit', state: 'completed', title: 'yellow fruits' })
      .attempt('fruit-1', { section: 'fruit', state: 'completed', text: 'Banana\nLemon\nPineapple' })
      .build(),
    steps: [],
  }
  const view = renderWithBackend(<TranscriptPane />, { fixture })
  await act(() => view.ready)
  const paragraph = await waitFor(() => {
    const found = section(view.container, 'fruit').querySelector('.answer-text p')
    expect(found).not.toBeNull()
    return found as HTMLElement
  })
  // One paragraph whose newlines are intact; `answer-text.css` draws them as breaks (`white-space: pre-line`).
  expect(paragraph.textContent?.split('\n')).toEqual(['Banana', 'Lemon', 'Pineapple'])
})

test('P13 (web) · the partial text is closed in the same commit that adds its header row and the retry status', async () => {
  const view = await open('failed-retry')
  await play(view, 3)
  const late = section(view.container, 'late')
  const attempt = late.querySelector<HTMLElement>('[data-attempt-id]')
  expect(attempt?.hasAttribute('data-collapsed')).toBe(true)
  // No frame at full height: the fold is already shut when the collapsed row is first drawn.
  const fold = attempt?.querySelector<HTMLElement>('.answer-text')?.parentElement
  expect(fold?.style.height).toBe('0px')
})

test('request controls · Stop and Retry sit in the message header line, so they add no row that comes and goes', async () => {
  const view = await open('routing')
  await play(view)
  const message = byId(view.container, 'data-message-id', fx.id('message', 'ask'))
  const controls = message.querySelector('[data-slot="request-controls"]')
  expect(controls).not.toBeNull()
  expect(controls?.parentElement?.tagName).toBe('HEADER')
})

test('Focus · previewing a chain adds and removes no element, so nothing moves under the pointer', async () => {
  const view = await open('trip')
  const shape = () => [...view.container.querySelectorAll('[data-slot="transcript-scroller"] *, [data-section-id] *')].map((element) => element.tagName).join(' ')
  const tagOf = (name: string) => {
    const own = section(view.container, name).querySelector<HTMLElement>('[data-slot="focus-tag"]')
    return own ?? section(view.container, name).closest('article')?.querySelector<HTMLElement>('header [data-slot="focus-tag"]') ?? null
  }
  const before = shape()
  // The tag's space is there before any Focus: hidden, and out of the accessibility tree.
  expect(tagOf('brief')?.className).toContain('invisible')
  expect(tagOf('brief')?.getAttribute('aria-hidden')).toBe('true')

  fireEvent.pointerEnter(within(section(view.container, 'B2')).getByRole('button', { name: 'Focus cheaper alternatives' }))
  expect(section(view.container, 'brief').dataset.focus).toBe('inherited')
  expect(tagOf('brief')?.className).not.toContain('invisible')
  expect(tagOf('brief')?.hasAttribute('aria-hidden')).toBe(false)
  expect(tagOf('B')?.className).not.toContain('invisible')
  expect(tagOf('A')?.className).toContain('invisible')
  expect(shape()).toBe(before)
})

test('reply group · a group whose sections all ended the same way has no header count: never an overall failed or cancelled label', async () => {
  const base = getFixture('reply-group-mixed')!
  const responseId = fx.id('response', 'ask')
  const withCounts = (counts: Partial<Record<'done' | 'failed' | 'stopped' | 'interrupted' | 'cancelled' | 'inProgress', number>>, countText: string): Fixture => ({
    ...base,
    steps: [],
    initial: {
      ...base.initial,
      transcript: {
        ...base.initial.transcript,
        responses: {
          ...base.initial.transcript.responses,
          [responseId]: {
            ...base.initial.transcript.responses[responseId]!,
            header: { counts: { done: 0, failed: 0, stopped: 0, interrupted: 0, cancelled: 0, inProgress: 0, ...counts }, countText },
          },
        },
      },
    },
  })
  for (const [counts, text] of [
    [{ failed: 2 }, '2 failed'],
    [{ cancelled: 3 }, '3 cancelled'],
  ] as const) {
    const view = renderWithBackend(<TranscriptPane />, { fixture: withCounts(counts, text) })
    await act(() => view.ready)
    expect(response(view.container, 'ask').querySelector('[data-slot="group-count"]')).toBeNull()
    expect(response(view.container, 'ask').querySelector('header')?.textContent).toBe('Committee')
    view.unmount()
  }
  // Mixed results keep the count.
  const mixed = renderWithBackend(<TranscriptPane />, { fixture: withCounts({ failed: 1, cancelled: 1 }, '1 failed · 1 cancelled') })
  await act(() => mixed.ready)
  expect(response(mixed.container, 'ask').querySelector('[data-slot="group-count"]')?.textContent).toBe('1 failed · 1 cancelled')
})

test('section title · a single answer is named in its reply header, where a queue item or a note that names it can be matched', async () => {
  const view = await open('queue-waiting')
  const sectionA = section(view.container, 'A')
  const title = sectionA.getAttribute('aria-label')
  expect(title).toBeTruthy()
  expect(sectionA.closest('article')?.querySelector('header [data-slot="section-title"]')?.textContent).toBe(`· ${title}`)
})

test('collapsed text · the one-line excerpt is plain text, without Markdown syntax', () => {
  expect(excerpt('**The Hour Returned**\n\nElias Vance had *repaired* clocks.')).toBe('The Hour Returned Elias Vance had repaired clocks.')
  expect(excerpt('## Day one\n- Fushimi Inari\n- `Nishiki` market\n1. [Gion](https://example.com)')).toBe('Day one Fushimi Inari Nishiki market Gion')
  expect(excerpt('```ts\nconst a = 2 * 3 * 4\n```\nsnake_case_name stays, 5 * 3 too')).toBe('const a = 2 * 3 * 4 snake_case_name stays, 5 * 3 too')
  // A marker the stream left open.
  expect(excerpt('The **unfinished')).toBe('The unfinished')
})

test('F3 (web) · no Failed mark while an automatic retry or a rate-limit wait is pending: status text only', async () => {
  const view = await open('pending')
  for (const [name, status] of [
    ['rail', WORDING.retrying],
    ['ryokan', WORDING.waitingForCapacity],
  ] as const) {
    const bubble = section(view.container, name)
    // The failed attempt is listed, as the backend reports it, and leaves no mark of its own.
    expect(bubble.querySelector('[data-attempt-id][data-state="failed"]')).not.toBeNull()
    expect(bubble.querySelector('[data-mark]')).toBeNull()
    expect(within(bubble).queryByRole('alert')).toBeNull()
    expect(within(bubble).getByRole('status').textContent).toBe(status)
  }
})

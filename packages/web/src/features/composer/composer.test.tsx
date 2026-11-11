import { WORDING } from '@committee/protocol'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { FocusBar } from '@/features/association'
import { fx, getFixture } from '@/fixtures'
import { TranscriptPane } from '@/features/transcript'
import { byId, play } from '@/features/transcript/test-helpers'
import { renderWithBackend } from '@/test/render'
import { ComposerDock } from './index'

afterEach(() => {
  vi.useRealTimers()
})

async function open(id: string, withTranscript = false) {
  const view = renderWithBackend(
    <>
      {withTranscript ? <TranscriptPane /> : null}
      <ComposerDock />
    </>,
    { fixture: getFixture(id) },
  )
  await act(() => view.ready)
  return view
}

const lastSent = (view: Awaited<ReturnType<typeof open>>) => view.backend?.sent.at(-1)

test('P6 (web) · a result-dependent follow-up has a queue item above the composer; independent work has none', async () => {
  const view = await open('queue-waiting', true)
  const items = view.container.querySelectorAll<HTMLElement>('[data-queue-item]')
  expect(items).toHaveLength(1)
  const item = items[0] as HTMLElement
  expect(item.textContent).toContain('itinerary')
  expect(item.textContent).toContain('Waiting for neighborhoods + activities')
  // A and B are free to proceed: nothing in the queue names them as waiting.
  expect(item.textContent).not.toMatch(/Waiting for (trip brief|itinerary)/)
  // It is above the composer, and its message is in the transcript.
  const composer = byId(view.container, 'data-slot', 'composer')
  expect(item.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(byId(view.container, 'data-message-id', fx.id('message', 'J'))).toBeTruthy()

  // Revised while queued: the wording changes (Q41).
  await play(view)
  expect(byId(view.container, 'data-queue-item', fx.id('queueItem', 'J')).textContent).toContain('Revised · waiting for neighborhoods + activities')

  // The item clears when processing begins; the message stays.
  await play(view)
  await waitFor(() => expect(view.container.querySelector('[data-queue-item]')).toBeNull())
  expect(byId(view.container, 'data-message-id', fx.id('message', 'J'))).toBeTruthy()
})

test('queue item · links to its message in the transcript', async () => {
  const view = await open('queue-waiting', true)
  const message = byId(view.container, 'data-message-id', fx.id('message', 'J'))
  const scrollIntoView = vi.fn()
  message.scrollIntoView = scrollIntoView
  fireEvent.click(within(byId(view.container, 'data-queue-item', fx.id('queueItem', 'J'))).getByRole('button', { name: /Show its message/ }))
  expect(scrollIntoView).toHaveBeenCalledOnce()
  expect(message.hasAttribute('data-revealed')).toBe(true)
})

test('queue item · a paused request names the cause and carries Retry, Continue without and Cancel', async () => {
  const view = await open('queue-paused')
  const item = byId(view.container, 'data-queue-item', fx.id('queueItem', 'J'))
  expect(item.dataset.state).toBe('paused')
  expect(item.textContent).toContain('Paused — activities failed')

  fireEvent.click(within(item).getByRole('button', { name: 'Continue without activities' }))
  expect(lastSent(view)).toMatchObject({ type: 'continue-without', directiveId: fx.id('directive', 'J') })
  fireEvent.click(within(item).getByRole('button', { name: 'Cancel itinerary' }))
  expect(lastSent(view)).toMatchObject({ type: 'cancel', directiveId: fx.id('directive', 'J') })
  fireEvent.click(within(item).getByRole('button', { name: 'Retry activities' }))
  expect(lastSent(view)).toMatchObject({ type: 'retry', target: { kind: 'section', sectionId: fx.id('section', 'B') } })
})

test('queue item · one held by the whole-request barrier says so', async () => {
  const view = await open('barrier-ordered-group')
  expect(byId(view.container, 'data-queue-item', fx.id('queueItem', 'translation')).textContent).toContain('held with the rest of its request')
  expect(byId(view.container, 'data-queue-item', fx.id('queueItem', 'summary')).textContent).not.toContain('held with the rest')
})

test('composer · Send submits the text; explicit reply targets are chips, sent with the message and cleared', async () => {
  const view = await open('overtaking', true)
  await play(view, 3)
  const box = screen.getByRole('textbox', { name: 'Message' })
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()

  fireEvent.click(within(byId(view.container, 'data-section-id', fx.id('section', 'B'))).getByRole('button', { name: 'Reply to this' }))
  const chips = byId(view.container, 'data-slot', 'reply-targets')
  expect(chips.textContent).toContain('Replying to')
  expect(chips.textContent).toContain('rainy-day activities')

  fireEvent.change(box, { target: { value: 'Which of these is closest to Gion?' } })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  })
  expect(lastSent(view)).toEqual({
    type: 'submit-message',
    conversationId: view.backend?.current.conversationId,
    text: 'Which of these is closest to Gion?',
    targets: [fx.id('section', 'B')],
  })
  expect((box as HTMLTextAreaElement).value).toBe('')
  expect(view.ui.getState().replyTargets).toEqual([])
  expect(view.container.querySelector('[data-slot="reply-targets"]')).toBeNull()

  // Untargeted: no targets are sent, so the backend infers them.
  fireEvent.change(box, { target: { value: 'Also explain dinosaurs' } })
  await act(async () => {
    fireEvent.keyDown(box, { key: 'Enter' })
  })
  expect(lastSent(view)).toEqual({
    type: 'submit-message',
    conversationId: view.backend?.current.conversationId,
    text: 'Also explain dinosaurs',
  })
})

test('composer · a chip can be removed, and a target superseded after it was chosen reads "Replying to the revised version"', async () => {
  const view = await open('superseded', true)
  await play(view, 3)
  act(() => {
    view.ui.getState().toggleReplyTarget(fx.id('section', 'A'))
    view.ui.getState().toggleReplyTarget(fx.id('section', 'J'))
  })
  let chips = byId(view.container, 'data-slot', 'reply-targets')
  expect(chips.textContent).not.toContain(WORDING.replyingToRevised)
  fireEvent.click(within(chips).getByRole('button', { name: 'Remove reply target itinerary' }))
  expect(view.ui.getState().replyTargets).toEqual([fx.id('section', 'A')])

  await play(view) // A is revised
  chips = byId(view.container, 'data-slot', 'reply-targets')
  expect(chips.textContent).toContain(WORDING.replyingToRevised)
  // The command still names what the user chose; the backend resolves it to the replacement (Q43).
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Which is most walkable?' } })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  })
  expect(lastSent(view)).toMatchObject({ type: 'submit-message', targets: [fx.id('section', 'A')] })
})

test('composer · without a key it says so and opens the key prompt', async () => {
  const view = await open('no-key')
  expect(screen.getByText('Add an OpenRouter key to send messages')).toBeVisible()
  expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Add key' }))
  expect(view.ui.getState().keyPromptOpen).toBe(true)
})

test('target ambiguity · a modal above the composer offers the candidate sections; nothing is chosen by default', async () => {
  const view = await open('modal-target-ambiguity')
  const modal = screen.getByRole('dialog', { name: 'Which answer is this about?' })
  expect(modal.getAttribute('aria-modal')).toBe('false')
  const composer = byId(view.container, 'data-slot', 'composer')
  expect(modal.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(within(modal).getByText('Make that shorter.')).toBeInTheDocument()

  const choose = within(modal).getByRole('button', { name: 'Choose section' })
  expect(choose).toBeDisabled()
  const rail = within(modal).getByRole('button', { name: /rail pass/, pressed: false })
  fireEvent.click(rail)
  await act(async () => {
    fireEvent.click(choose)
  })
  expect(lastSent(view)).toEqual({
    type: 'answer-elicitation',
    conversationId: view.backend?.current.conversationId,
    elicitationId: fx.id('elicitation', 'which'),
    answer: { kind: 'target-ambiguity', sectionIds: [fx.id('section', 'rail')] },
  })
  await act(async () => {
    view.backend?.playAll()
  })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  // The composer was usable throughout.
  expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled()
})

test('choice with default · pre-selection, locked options, the countdown, editing and confirming', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  const view = await open('modal-choice-default')
  const modal = screen.getByRole('dialog', { name: 'Which work should be redone?' })
  const box = (label: string) => within(modal).getByRole('checkbox', { name: `Redo ${label}` })

  // The backend's pre-selection: the itinerary. Work that was running or queued is locked on.
  expect(box('itinerary')).toBeChecked()
  expect(box('neighborhoods')).not.toBeChecked()
  expect(box('packing list')).toBeChecked()
  expect(box('packing list')).toBeDisabled()
  expect(box('day trip')).toBeChecked()
  expect(box('day trip')).toBeDisabled()

  // The countdown runs down to the default.
  const countdown = byId(view.container, 'data-slot', 'countdown')
  const seconds = () => Number(/in (\d+) s/.exec(countdown.textContent ?? '')?.[1])
  const start = seconds()
  expect(start).toBeGreaterThan(20)
  expect(start).toBeLessThanOrEqual(30)
  act(() => {
    vi.advanceTimersByTime(5000)
  })
  expect(seconds()).toBe(start - 5)

  // Editing keeps waiting; locked work is never in what is sent.
  await act(async () => {
    fireEvent.click(box('neighborhoods'))
  })
  expect(lastSent(view)).toMatchObject({
    type: 'answer-elicitation',
    elicitationId: fx.id('elicitation', 'days'),
    answer: { kind: 'choice-with-default', redo: [fx.id('directive', 'J'), fx.id('directive', 'A')], confirm: false },
  })
  await act(async () => {
    view.backend?.step()
  })
  expect(box('neighborhoods')).toBeChecked()

  await act(async () => {
    fireEvent.click(within(modal).getByRole('button', { name: 'Confirm selection' }))
  })
  expect(lastSent(view)).toMatchObject({
    answer: { kind: 'choice-with-default', redo: [fx.id('directive', 'J'), fx.id('directive', 'A')], confirm: true },
  })
})

test('command error · a rejected command is reported and changes nothing', async () => {
  const view = await open('modal-choice-default', true)
  const before = view.backend?.current
  await act(async () => {
    fireEvent.click(within(byId(view.container, 'data-section-id', fx.id('section', 'A'))).getByRole('button', { name: 'Regenerate' }))
  })
  expect(lastSent(view)).toMatchObject({ type: 'regenerate' })
  expect(view.backend?.current).toBe(before)
})

test('modals · one at a time, oldest first; clarification and recovery elicitations are not modals', async () => {
  const paused = await open('queue-paused')
  expect(screen.queryByRole('dialog')).toBeNull()
  paused.unmount()
  await open('clarification')
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('reply target · "Reply to this" moves keyboard focus to the message box; removing a target leaves focus alone', async () => {
  const view = await open('trip', true)
  await act(async () => {
    view.backend?.playAll()
  })
  const reply = screen.getAllByRole('button', { name: 'Reply to this' }).at(-1) as HTMLElement
  reply.focus()
  await act(async () => {
    fireEvent.click(reply)
  })
  expect(view.ui.getState().replyTargets).toHaveLength(1)
  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Message' }))

  reply.focus()
  await act(async () => {
    fireEvent.click(reply)
  })
  expect(view.ui.getState().replyTargets).toHaveLength(0)
  expect(document.activeElement).toBe(reply)
})

test('Focus · Escape clears a pinned Focus while a target-ambiguity panel is shown: the panel is not a modal layer', async () => {
  const view = renderWithBackend(
    <>
      <FocusBar />
      <ComposerDock />
    </>,
    { fixture: getFixture('modal-target-ambiguity') },
  )
  await act(() => view.ready)
  expect(screen.getByRole('dialog', { name: 'Which answer is this about?' })).toBeInTheDocument()
  const chainId = view.store.getState().conversation?.genealogy.chainIds[0]
  expect(chainId).toBeDefined()
  act(() => {
    if (chainId) view.ui.getState().pinFocus(chainId)
  })
  expect(view.ui.getState().focus.pinned).toBe(chainId)
  fireEvent.keyDown(document.body, { key: 'Escape' })
  expect(view.ui.getState().focus.pinned).toBeNull()
})

test('countdown bar · one linear transition over the whole remaining wait, not a step each second', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  const view = await open('modal-choice-default')
  const bar = byId(view.container, 'data-slot', 'countdown-bar').firstElementChild as HTMLElement
  expect(bar.style.transform).toBe('scaleX(0)')
  const duration = Number(/transform (\d+)ms linear/.exec(bar.style.transition)?.[1])
  expect(duration).toBeGreaterThan(20_000)
  act(() => {
    vi.advanceTimersByTime(3000)
  })
  // The seconds tick in the text; the bar's transition is not restarted.
  expect(bar.style.transition).toBe(`transform ${duration}ms linear`)
})

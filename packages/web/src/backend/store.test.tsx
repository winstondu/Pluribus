import { act, screen, waitFor } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { useAttempt, useSection, useTranscriptOrder } from '@/backend'
import { createFixtureBackend, fx, type Fixture } from '@/fixtures'
import { renderWithBackend } from '@/test/render'

const initial = fx
  .conversation('s')
  .chain('c')
  .message('m', 'Why is the sky blue?')
  .response('r', { message: 'm' })
  .section('sky', { response: 'r', chain: 'c', state: 'streaming' })
  .attempt('a', { section: 'sky', state: 'streaming', text: 'Sunlight' })
  .section('other', { response: 'r', chain: 'c', state: 'completed' })
  .attempt('b', { section: 'other', state: 'completed', text: 'Done' })
  .build()

const fixture: Fixture = {
  id: 's',
  title: 'Store',
  covers: [],
  initial,
  steps: [{ label: 'more text', delayMs: 0, next: (previous) => fx.from(previous).appendText('a', ' scatters').build() }],
}

let otherRenders = 0

function Text() {
  const attempt = useAttempt(fx.id('attempt', 'a'))
  return <p data-testid="text">{attempt?.text}</p>
}

function Other() {
  const section = useSection(fx.id('section', 'other'))
  otherRenders++
  return <p data-testid="other">{section?.state}</p>
}

function Order() {
  return <p data-testid="order">{useTranscriptOrder().length}</p>
}

describe('backend store', () => {
  test('loads the app, opens the first conversation, and applies frames', async () => {
    const { backend, ready, store } = renderWithBackend(
      <>
        <Text />
        <Other />
        <Order />
      </>,
      { fixture },
    )
    await act(() => ready)
    expect(store.getState().status).toBe('ready')
    expect(screen.getByTestId('text')).toHaveTextContent('Sunlight')
    expect(screen.getByTestId('order')).toHaveTextContent('2')
    const before = otherRenders
    act(() => {
      backend?.step()
    })
    expect(screen.getByTestId('text')).toHaveTextContent('Sunlight scatters')
    // A streaming append re-renders its own attempt only.
    expect(otherRenders).toBe(before)
  })

  test('falls back to the newest conversation when the open one is deleted', async () => {
    const other = fx.conversation('second').build()
    const backend = createFixtureBackend({ ...fixture, others: [other] })
    const { store, ready } = renderWithBackend(<Order />, { client: backend })
    await act(() => ready)
    expect(store.getState().activeConversationId).toBe(initial.conversationId)
    await act(async () => {
      await backend.send({ type: 'delete-conversation', conversationId: initial.conversationId })
    })
    await waitFor(() => expect(store.getState().activeConversationId).toBe(other.conversationId))
  })
})

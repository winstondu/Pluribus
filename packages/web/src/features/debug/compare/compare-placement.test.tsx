import { DEFAULT_SETTINGS, applySettingsPatch, normalizeSettings, validateSettingsPatch, type Settings } from '@pluribus/protocol'
import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test } from 'vitest'
import { fx, getFixture, type Fixture } from '@/fixtures'
import { TranscriptPane } from '@/features/transcript'
import { renderWithBackend } from '@/test/render'
import { useDebugState } from '../debug-state'
import { debugApp } from '../fixture-support'
import { DebugSidePanel } from '../side-panel'

function fixture(id: string): Fixture {
  const found = getFixture(id)
  if (!found) throw new Error(`missing fixture ${id}`)
  return found
}

beforeEach(() => useDebugState.getState().reset(null))

describe('Compare placement setting', () => {
  test('defaults to the side panel, and stored settings without it, or with an unknown value, get the default', () => {
    expect(DEFAULT_SETTINGS.debug.comparePlacement).toBe('sidebar')
    const { comparePlacement: _dropped, ...older } = DEFAULT_SETTINGS.debug
    const stored = { ...DEFAULT_SETTINGS, debug: older } as Partial<Settings>
    expect(normalizeSettings(stored).debug.comparePlacement).toBe('sidebar')
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, debug: { ...DEFAULT_SETTINGS.debug, comparePlacement: 'floating' as never } }).debug.comparePlacement).toBe('sidebar')
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, debug: { ...DEFAULT_SETTINGS.debug, comparePlacement: 'inline' } }).debug.comparePlacement).toBe('inline')
    expect(applySettingsPatch(DEFAULT_SETTINGS, { debug: { comparePlacement: 'inline' } }).debug).toEqual({ ...DEFAULT_SETTINGS.debug, comparePlacement: 'inline' })
    expect(validateSettingsPatch({ debug: { comparePlacement: 'inline' } })).toBeNull()
    expect(validateSettingsPatch({ debug: { comparePlacement: 'floating' as never } })).toMatch(/Unknown Compare placement/)
  })
})

describe('Compare on the message', () => {
  test('the toggle opens a card under the message: the message marks the selected part, the card shows its source and rewrite', async () => {
    const user = userEvent.setup()
    const view = renderWithBackend(<TranscriptPane />, { fixture: fixture('compare-inline') })
    await act(() => view.ready)
    const message = fixture('compare-inline').initial.transcript.messages[fx.id('message', 'ask')]
    if (!message) throw new Error('fixture message missing')

    expect(screen.queryByRole('button', { name: 'Inspect decomposition' })).toBeNull()
    const toggle = screen.getByRole('button', { name: 'Show decomposition' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('compare-card')).toBeNull()

    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(toggle).toHaveTextContent('Hide decomposition')
    const card = screen.getByTestId('compare-card')
    expect(toggle.getAttribute('aria-controls')).toBe(card.id)

    // The message itself is the source, exactly as sent, with the selected part and its inherited requirement marked.
    const text = view.container.querySelector<HTMLElement>(`[data-message-id="${message.id}"] [data-slot="message-text"]`)
    if (!text) throw new Error('message text missing')
    expect(text.textContent).toBe(message.text)
    const marked = () => [...text.querySelectorAll('mark[data-selected]')].map((mark) => mark.textContent).join('')
    expect(marked()).toBe('Why is the sky blue?')
    expect([...text.querySelectorAll('mark[data-requirement]')].map((mark) => mark.textContent).join('')).toBe('Keep both answers brief.')
    // ... so the card does not repeat it.
    expect(within(card).queryByTestId('compare-original')).toBeNull()

    const tabs = within(card).getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual(['sky', 'menu'])
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    expect(within(card).getByLabelText('Source of this part')).toHaveTextContent('Why is the sky blue?')
    expect(within(card).getByLabelText('Rewritten instruction').textContent).toBe('Explain why the sky is blue. Keep the answer brief.')

    // Arrow keys move between the parts; the message's marks follow.
    tabs[0]?.focus()
    await user.keyboard('{ArrowRight}')
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true')
    expect(tabs[1]).toHaveFocus()
    expect(marked()).toBe('Also, translate “sopa de verduras” into English.')
    expect(within(card).getByLabelText('Rewritten instruction').textContent).toBe('Translate “sopa de verduras” into English. Keep the answer brief.')
    const requirements = within(within(card).getByTestId('requirements')).getAllByRole('listitem')
    expect(requirements).toHaveLength(1)
    expect(requirements[0]).toHaveTextContent('From the source: “Keep both answers brief.”')
    expect(requirements[0]).toHaveTextContent('Also applies to sky.')

    await user.click(toggle)
    expect(screen.queryByTestId('compare-card')).toBeNull()
    expect(text.querySelector('mark')).toBeNull()
    expect(text.textContent).toBe(message.text)
  })

  test('a message that was not decomposed shows no toggle', async () => {
    const view = renderWithBackend(<TranscriptPane />, { fixture: { ...fixture('trip'), app: debugApp({ compareIndependent: true, comparePlacement: 'inline' }) } })
    await act(() => view.ready)
    expect(screen.queryByRole('button', { name: /decomposition/ })).toBeNull()
  })

  test('the side panel offers no Compare tab, even when a decomposition was opened', async () => {
    const view = renderWithBackend(<DebugSidePanel />, { fixture: { ...fixture('compare'), app: debugApp({ compareIndependent: true, miniMap: true, comparePlacement: 'inline' }) } })
    await act(() => view.ready)
    act(() => view.ui.getState().openCompare(fx.id('message', 'newsletter')))
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Mini-map'])
    expect(screen.queryByTestId('compare')).toBeNull()
  })

  test('split messages: the "split from one message" link opens the card under it, with the exact original', async () => {
    const user = userEvent.setup()
    const view = renderWithBackend(<TranscriptPane />, { fixture: { ...fixture('split-messages'), app: debugApp({ comparePlacement: 'inline' }) } })
    await act(() => view.ready)
    const link = screen.getByRole('button', { name: /split from one message/i })
    expect(link).toHaveAttribute('aria-expanded', 'false')
    await user.click(link)
    expect(view.ui.getState().compare).toBeNull()
    const card = screen.getByTestId('compare-card')
    const split = fixture('split-messages').initial.transcript.splits[fx.id('message', 'whole')]
    expect(within(card).getByTestId('compare-original').textContent).toBe(split?.decomposition.originalText)
  })
})

describe('Compare in the side panel (the default)', () => {
  test('is unchanged: the message offers Inspect decomposition, which opens the side panel, and no card', async () => {
    const user = userEvent.setup()
    const view = renderWithBackend(<TranscriptPane />, { fixture: { ...fixture('compare-inline'), app: debugApp({ compareIndependent: true }) } })
    await act(() => view.ready)
    expect(screen.queryByRole('button', { name: /Show decomposition/ })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Inspect decomposition' }))
    expect(view.ui.getState().compare).toBe(fx.id('message', 'ask'))
    expect(screen.queryByTestId('compare-card')).toBeNull()
  })
})

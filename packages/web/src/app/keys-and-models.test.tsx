import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test } from 'vitest'
import { SettingsDialog } from '@/app/settings/settings-dialog'
import { Shell } from '@/app/shell'
import { serverKeyProvision } from '@/backend'
import { getFixture, type Fixture } from '@/fixtures'
import { renderWithBackend } from '@/test/render'

function fixture(id: string, app: Fixture['app'] = {}, extra: Partial<Fixture> = {}): Fixture {
  const found = getFixture(id)
  if (!found) throw new Error(`missing fixture ${id}`)
  return { ...found, ...extra, app: { ...found.app, ...app } }
}

describe('a deployment whose keys and models are the server\'s', () => {
  test('no key prompt, even with no key configured; the settings say where keys are configured', async () => {
    const user = userEvent.setup()
    const { ready, ui } = renderWithBackend(<Shell />, { fixture: fixture('no-key'), keys: serverKeyProvision })
    await act(() => ready)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByText('Add an OpenRouter key')).not.toBeInTheDocument()
    // Even asked for directly, the prompt does not show.
    act(() => ui.getState().openKeyPrompt())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    act(() => {
      ui.getState().closeKeyPrompt()
      ui.getState().openSettings()
    })
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('tab', { name: 'Keys' }))
    expect(within(dialog).getByTestId('key-status')).toHaveTextContent('Not configured on the server')
    expect(within(dialog).queryByRole('button', { name: /Add key|Replace|Remove/ })).not.toBeInTheDocument()
  })

  test('the Models section shows the provider and model the backend reports, and offers nothing to change', async () => {
    const user = userEvent.setup()
    const { ready, ui, backend } = renderWithBackend(<SettingsDialog />, {
      fixture: fixture('trip', { key: { configured: true } }, { modelsEditable: false }),
      keys: serverKeyProvision,
    })
    await act(() => ready)
    act(() => ui.getState().openSettings())
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('tab', { name: 'Models' }))
    expect(within(dialog).getByText(/set by the server/)).toBeInTheDocument()
    expect(within(dialog).queryByRole('radiogroup', { name: /provider/ })).not.toBeInTheDocument()
    for (const role of ['Answers', 'Synthesis', 'Decomposition', 'Decisions']) {
      expect(within(dialog).getByRole('button', { name: new RegExp(`^${role} model`) })).toBeDisabled()
    }
    // And the backend refuses the change if it is sent anyway.
    const refused = await backend?.send({ type: 'change-settings', changes: { models: { synthesis: 'anthropic/claude-opus-5.5' } } })
    expect(refused?.ok).toBe(false)
  })
})

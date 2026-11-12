import type { KeyCheck } from '@pluribus/protocol'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test } from 'vitest'
import { KeyPrompt } from '@/app/key-prompt'
import { SettingsDialog } from '@/app/settings/settings-dialog'
import { Shell } from '@/app/shell'
import { createScriptedKeyProvision, serverKeyProvision, type KeyProvision } from '@/backend'
import { getFixture, type Fixture } from '@/fixtures'
import { renderWithBackend } from '@/test/render'

const OPENROUTER_KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef'
const ANTHROPIC_KEY = 'sk-ant-api03-0123456789abcdef0123456789abcdef'

function fixture(id: string, app: Fixture['app'] = {}, extra: Partial<Fixture> = {}): Fixture {
  const found = getFixture(id)
  if (!found) throw new Error(`missing fixture ${id}`)
  return { ...found, ...extra, app: { ...found.app, ...app } }
}

/** A key provision whose calls are recorded, over the fixture backend's scripted one. */
function recording(inner: KeyProvision, checks: Partial<Record<'openrouter' | 'anthropic', KeyCheck>> = {}) {
  const calls: { op: string; provider: string; key?: string }[] = []
  const keys: KeyProvision = {
    canProvideKeys: inner.canProvideKeys,
    check: async (provider, key, signal) => {
      calls.push({ op: 'check', provider, key })
      return checks[provider] ?? inner.check(provider, key, signal)
    },
    set: (provider, key) => {
      calls.push({ op: 'set', provider, key })
      return inner.set(provider, key)
    },
    remove: (provider) => {
      calls.push({ op: 'remove', provider })
      return inner.remove(provider)
    },
  }
  return { keys, calls }
}

describe('key prompt · the optional Anthropic key', () => {
  test('the Anthropic section is closed by default and the prompt completes with the OpenRouter key alone', async () => {
    const user = userEvent.setup()
    const { ready, ui, store, backend } = renderWithBackend(<KeyPrompt />, { fixture: fixture('no-key') })
    await act(() => ready)
    act(() => ui.getState().openKeyPrompt())
    const toggle = await screen.findByRole('button', { name: /Also use an Anthropic key/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveTextContent('Optional')
    expect(screen.queryByLabelText('Anthropic API key')).not.toBeInTheDocument()

    await user.type(screen.getByLabelText('API key'), OPENROUTER_KEY)
    expect(await screen.findByText(/Key works/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save key' }))
    await waitFor(() => expect(store.getState().app?.key.configured).toBe(true))
    expect(store.getState().app?.anthropicKey.configured).toBe(false)
    expect(backend?.sent).toEqual([])
  })

  test('expanded, it takes an Anthropic key with its own status line and saves both keys through the key provision', async () => {
    const user = userEvent.setup()
    const { ready, ui, store, backend } = renderWithBackend(<KeyPrompt />, { fixture: fixture('no-key') })
    await act(() => ready)
    const { keys, calls } = recording(createScriptedKeyProvision(backend, 0))
    // Mounted again with the recording provision; the first render only served to get the fixture backend.
    const view = renderWithBackend(<KeyPrompt keys={keys} />, { client: backend ?? undefined })
    void ui
    void store
    await act(() => view.ready)
    act(() => view.ui.getState().openKeyPrompt())

    await user.click(await screen.findByRole('button', { name: /Also use an Anthropic key/ }))
    const anthropic = await screen.findByLabelText('Anthropic API key')
    expect(anthropic).toHaveAttribute('type', 'password')
    expect(screen.getByText(/used from this browser, and sent only to\s+Anthropic/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /platform\.claude\.com/ })).toBeInTheDocument()

    // Its own format check and status line.
    await user.type(anthropic, 'sk-or-wrong-provider-0123456789')
    expect(await screen.findByText(/Anthropic keys start with “sk-ant-”/)).toBeInTheDocument()
    await user.type(screen.getByLabelText('API key'), OPENROUTER_KEY)
    // A typed key that may not be saved holds the save back, even though the OpenRouter key is fine.
    expect(await screen.findByText(/of credit remaining/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save keys' })).toBeDisabled()

    await user.clear(anthropic)
    await user.type(anthropic, ANTHROPIC_KEY)
    // The Anthropic check says what it could learn: the key works and a test request was paid for, never an amount.
    expect(await screen.findByText(/one-token test request was accepted/)).toBeInTheDocument()
    expect(screen.getByText(/does not let a key read its balance/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Save keys' }))
    await waitFor(() => expect(view.store.getState().app?.anthropicKey.configured).toBe(true))
    expect(view.store.getState().app?.key.configured).toBe(true)
    expect(calls.filter((call) => call.op === 'set')).toEqual([
      { op: 'set', provider: 'openrouter', key: OPENROUTER_KEY },
      { op: 'set', provider: 'anthropic', key: ANTHROPIC_KEY },
    ])
    // Neither key is in a backend command, the store, the ui-state or the page.
    for (const secret of [OPENROUTER_KEY, ANTHROPIC_KEY]) {
      expect(JSON.stringify(backend?.sent)).not.toContain(secret)
      expect(JSON.stringify(view.store.getState())).not.toContain(secret)
      expect(JSON.stringify(view.ui.getState())).not.toContain(secret)
      expect(document.body.innerHTML).not.toContain(secret)
    }
  })

  test('the three outcomes of the Anthropic check read differently: valid, invalid, valid but out of credit; and undeterminable is said as such', async () => {
    const user = userEvent.setup()
    let result: KeyCheck = { status: 'invalid' }
    const base = createScriptedKeyProvision(null, 0)
    const keys: KeyProvision = { ...base, check: async () => result }
    const { ready, ui } = renderWithBackend(<KeyPrompt keys={keys} />, { fixture: fixture('no-key', { key: { configured: true } }) })
    await act(() => ready)
    act(() => ui.getState().openKeyPrompt('anthropic'))
    expect(await screen.findByRole('dialog', { name: 'Add an Anthropic key' })).toBeInTheDocument()
    const input = screen.getByLabelText('API key')

    await user.type(input, ANTHROPIC_KEY)
    expect(await screen.findByText(/Anthropic does not recognize this key/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save key' })).toBeDisabled()

    result = { status: 'valid', label: null, credit: { kind: 'exhausted' } }
    await user.type(input, 'a')
    expect(await screen.findByText(/refused a one-token test request for lack of credit/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save key' })).toBeEnabled()

    result = { status: 'valid', label: null, credit: { kind: 'unknown' } }
    await user.type(input, 'b')
    expect(await screen.findByText(/Whether the account has credit could not be determined/)).toBeInTheDocument()

    result = { status: 'valid', label: null, credit: { kind: 'available' } }
    await user.type(input, 'c')
    expect(await screen.findByText(/so the account has credit/)).toBeInTheDocument()

    result = { status: 'blocked', reason: 'This Anthropic organization does not allow requests from a browser.' }
    await user.type(input, 'd')
    expect(await screen.findByText(/does not allow requests from a browser/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save key' })).toBeDisabled()
  })
})

describe('Settings → Models · what the backend reports', () => {
  async function openModels(app: Fixture['app'], extra: Partial<Fixture> = {}, keys?: KeyProvision) {
    const user = userEvent.setup()
    const view = renderWithBackend(<SettingsDialog />, { fixture: fixture('trip', app, extra), ...(keys ? { keys } : {}) })
    await act(() => view.ready)
    act(() => view.ui.getState().openSettings())
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('tab', { name: 'Models' }))
    return { ...view, user, dialog }
  }

  test('with the OpenRouter key alone there is no provider choice, and one line says how to get it', async () => {
    const { dialog } = await openModels({})
    expect(within(dialog).queryByRole('radiogroup', { name: /provider/ })).not.toBeInTheDocument()
    expect(within(dialog).getByText(/Add an Anthropic key to use the Claude API/)).toBeInTheDocument()
    expect(within(dialog).getByText(/Decisions always run on OpenRouter/)).toBeInTheDocument()
  })

  test('with both keys each selectable role has a provider choice first, the dropdown follows it, and decisions stay on OpenRouter', async () => {
    const { dialog, user, store, backend } = await openModels({ anthropicKey: { configured: true } })
    for (const role of ['Answers', 'Synthesis', 'Decomposition']) {
      const group = within(dialog).getByRole('radiogroup', { name: `${role} provider` })
      expect(within(group).getByRole('radio', { name: 'OpenRouter' })).toBeChecked()
      expect(within(group).getByRole('radio', { name: 'Claude API' })).not.toBeChecked()
    }
    expect(within(dialog).queryByRole('radiogroup', { name: 'Decisions provider' })).not.toBeInTheDocument()
    expect(within(dialog).queryByText(/Add an Anthropic key/)).not.toBeInTheDocument()

    // Choosing the provider sends the provider alone; the backend picks that provider's default model for the role.
    await user.click(within(within(dialog).getByRole('radiogroup', { name: 'Answers provider' })).getByRole('radio', { name: 'Claude API' }))
    expect(backend?.sent.at(-1)).toEqual({ type: 'change-settings', changes: { modelProviders: { answer: 'anthropic' } } })
    await waitFor(() => expect(store.getState().app?.settings.models.answer).toBe('claude-sonnet-5-5'))
    expect(within(dialog).getByRole('button', { name: 'Answers model: claude-sonnet-5-5' })).toBeInTheDocument()
    // The other roles did not move.
    expect(store.getState().app?.settings.modelProviders).toMatchObject({ synthesis: 'openrouter', decomposition: 'openrouter', decision: 'openrouter' })

    // The dropdown lists the Claude API's models for the role, by their Claude API IDs.
    await user.click(within(dialog).getByRole('button', { name: /^Answers model/ }))
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
      expect.stringContaining('claude-sonnet-5-5'),
      expect.stringContaining('claude-haiku-5-5'),
    ])
    await user.click(screen.getByRole('option', { name: /Claude Haiku 5.5/ }))
    await waitFor(() => expect(store.getState().app?.settings.models.answer).toBe('claude-haiku-5-5'))

    // And back: OpenRouter's default for the role.
    await user.click(within(within(dialog).getByRole('radiogroup', { name: 'Answers provider' })).getByRole('radio', { name: 'OpenRouter' }))
    await waitFor(() => expect(store.getState().app?.settings.models.answer).toBe('anthropic/claude-sonnet-5.5'))
  })

  test('removing the Anthropic key returns the roles that used it to OpenRouter, and says so', async () => {
    const { dialog, user, store, backend } = await openModels({ anthropicKey: { configured: true } })
    await user.click(within(within(dialog).getByRole('radiogroup', { name: 'Synthesis provider' })).getByRole('radio', { name: 'Claude API' }))
    await waitFor(() => expect(store.getState().app?.settings.modelProviders.synthesis).toBe('anthropic'))

    await user.click(within(dialog).getByRole('tab', { name: 'Keys' }))
    expect(within(dialog).getByTestId('anthropic-key-status')).toHaveTextContent('Key configured')
    const card = within(dialog).getByTestId('anthropic-key-status').closest('[data-key-card]') as HTMLElement
    const sent = backend?.sent.length
    await user.click(within(card).getByRole('button', { name: 'Remove' }))
    expect(within(card).getByText(/Synthesis will return to OpenRouter/)).toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(within(dialog).getByTestId('anthropic-key-status')).toHaveTextContent('No key'))
    expect(store.getState().app?.settings.modelProviders.synthesis).toBe('openrouter')
    expect(store.getState().app?.settings.models.synthesis).toBe('anthropic/claude-sonnet-5.5')
    expect(within(dialog).getByRole('status')).toHaveTextContent('Synthesis was running on the Claude API and now runs on OpenRouter')
    // The OpenRouter key is untouched, and the removal was not a backend command.
    expect(within(dialog).getByTestId('key-status')).toHaveTextContent('Key configured')
    expect(backend?.sent.length).toBe(sent)

    await user.click(within(dialog).getByRole('tab', { name: 'Models' }))
    expect(within(dialog).queryByRole('radiogroup', { name: 'Synthesis provider' })).not.toBeInTheDocument()
  })
})

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
    expect(within(dialog).getByTestId('anthropic-key-status')).toHaveTextContent('Not configured on the server')
    expect(within(dialog).queryByRole('button', { name: /Add key|Replace|Remove/ })).not.toBeInTheDocument()
  })

  test('the Models section shows the provider and model the backend reports, and offers nothing to change', async () => {
    const user = userEvent.setup()
    const { ready, ui, backend } = renderWithBackend(<SettingsDialog />, {
      fixture: fixture('trip', { key: { configured: true }, anthropicKey: { configured: true } }, { modelsEditable: false }),
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
    expect(within(dialog).queryByText(/You can add one under Keys/)).not.toBeInTheDocument()
    // And the backend refuses the change if it is sent anyway.
    const refused = await backend?.send({ type: 'change-settings', changes: { models: { synthesis: 'anthropic/claude-opus-5.5' } } })
    expect(refused?.ok).toBe(false)
  })
})

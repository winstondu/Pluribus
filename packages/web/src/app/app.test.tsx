import { DEFAULT_SETTINGS, WORDING } from '@committee/protocol'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test } from 'vitest'
import { createKeyValidator, keyFormatProblem, type KeyValidator } from '@/app/key-validation'
import { KeyPrompt } from '@/app/key-prompt'
import { Shell } from '@/app/shell'
import { CHAIN_COLOR_LIMIT, chainColor, chainSegments, chainTint } from '@/design/chains'
import { getFixture } from '@/fixtures'
import { renderWithBackend } from '@/test/render'

const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef'
const valid: KeyValidator = async () => ({ status: 'valid', label: null, remaining: 12.4 })

function fixture(id: string) {
  const found = getFixture(id)
  if (!found) throw new Error(`missing fixture ${id}`)
  return found
}

describe('key prompt', () => {
  test('opens by itself on first run, explains itself, and has no environment shortcut outside the dev server', async () => {
    const { ready } = renderWithBackend(<Shell />, { fixture: fixture('no-key') })
    await act(() => ready)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/kept in\s+this browser/)).toBeInTheDocument()
    expect(within(dialog).getByRole('link', { name: /Create a key/ })).toHaveAttribute('href', expect.stringContaining('openrouter.ai'))
    expect(within(dialog).queryByText(/key from this environment/)).not.toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Save key' })).toBeDisabled()
  })

  test('checks the format, validates live, saves, and never keeps or records the key', async () => {
    const user = userEvent.setup()
    const { ready, backend, ui, store } = renderWithBackend(<KeyPrompt validate={valid} />, { fixture: fixture('no-key') })
    await act(() => ready)
    act(() => ui.getState().openKeyPrompt())
    const input = await screen.findByLabelText('API key')
    expect(input).toHaveAttribute('type', 'password')

    await user.type(input, 'my-key')
    expect(await screen.findByText(/start with “sk-or-”/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save key' })).toBeDisabled()

    await user.clear(input)
    await user.type(input, KEY)
    expect(await screen.findByText(/Key works/)).toBeInTheDocument()
    expect(screen.getByText('$12.40')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Show key' }))
    expect(input).toHaveAttribute('type', 'text')

    await user.click(screen.getByRole('button', { name: 'Save key' }))
    await waitFor(() => expect(store.getState().app?.key.configured).toBe(true))
    // The first-run prompt keeps its own words while it confirms the save.
    expect(screen.getByRole('dialog', { name: 'Bring your own OpenRouter key' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Not now' })).toBeInTheDocument()
    expect(input).toHaveValue('')
    expect(backend?.sent.at(-1)).toEqual({ type: 'change-settings', openRouterKey: { action: 'set', key: '[redacted]' } })
    expect(JSON.stringify(store.getState())).not.toContain(KEY)
    expect(JSON.stringify(ui.getState())).not.toContain(KEY)
    expect(document.body.innerHTML).not.toContain(KEY)
    await waitFor(() => expect(ui.getState().keyPromptOpen).toBe(false), { timeout: 2000 })
  })

  test('an invalid key cannot be saved; an unreachable OpenRouter can', async () => {
    const user = userEvent.setup()
    let result: Awaited<ReturnType<KeyValidator>> = { status: 'invalid' }
    const { ready, ui } = renderWithBackend(<KeyPrompt validate={async () => result} />, { fixture: fixture('no-key') })
    await act(() => ready)
    act(() => ui.getState().openKeyPrompt())
    const input = await screen.findByLabelText('API key')
    await user.type(input, KEY)
    expect(await screen.findByText(/does not recognize this key/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save key' })).toBeDisabled()
    result = { status: 'offline' }
    await user.type(input, 'ff')
    expect(await screen.findByText(/Could not reach OpenRouter/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save key' })).toBeEnabled()
  })

  test('the live validator maps OpenRouter answers and sends the key only as a bearer header', async () => {
    const calls: { url: string; auth: string | null }[] = []
    const answer = (status: number, body: unknown) =>
      createKeyValidator(async (input, init) => {
        calls.push({ url: String(input), auth: new Headers(init?.headers).get('Authorization') })
        return new Response(JSON.stringify(body), { status })
      })
    const signal = new AbortController().signal
    expect(await answer(200, { data: { label: 'k', limit_remaining: 3.5 } })(KEY, signal)).toEqual({ status: 'valid', label: 'k', remaining: 3.5 })
    expect(await answer(200, { data: { label: 'k', limit_remaining: null } })(KEY, signal)).toEqual({ status: 'valid', label: 'k', remaining: null })
    expect(await answer(401, { error: { message: 'User not found.' } })(KEY, signal)).toEqual({ status: 'invalid' })
    expect(await answer(503, {})(KEY, signal)).toEqual({ status: 'unverified', httpStatus: 503 })
    const offline = createKeyValidator(async () => {
      throw new TypeError('Failed to fetch')
    })
    expect(await offline(KEY, signal)).toEqual({ status: 'offline' })
    expect(calls[0]).toEqual({ url: 'https://openrouter.ai/api/v1/key', auth: `Bearer ${KEY}` })
    expect(keyFormatProblem(KEY)).toBeNull()
    expect(keyFormatProblem('sk-or-short')).toMatch(/too short/)
    expect(keyFormatProblem('sk-or-v1 0123456789abcdef0123')).toMatch(/no spaces/)
  })
})

describe('shell', () => {
  test('lists conversations, opens one, creates one and deletes one', async () => {
    const user = userEvent.setup()
    const { ready, backend, store } = renderWithBackend(<Shell />, { fixture: fixture('trip') })
    await act(() => ready)
    const list = screen.getByRole('navigation', { name: 'Conversations' })
    expect(within(list).getByRole('button', { name: /^Kyoto in November/ })).toHaveAttribute('aria-current', 'page')

    await user.click(within(list).getByRole('button', { name: /^Weekend sourdough/ }))
    await waitFor(() => expect(store.getState().conversation?.conversationId).toBe('cnv_sourdough'))

    await user.click(screen.getByRole('button', { name: 'New conversation' }))
    await waitFor(() => expect(store.getState().app?.conversations).toHaveLength(3))
    await waitFor(() => expect(store.getState().activeConversationId).toBe('cnv_new-1'))

    await user.click(within(list).getByRole('button', { name: 'Options for Weekend sourdough' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(store.getState().app?.conversations).toHaveLength(2))
    expect(backend?.sent.map((command) => command.type)).toEqual(['create-conversation', 'delete-conversation'])
  })

  test('the empty state’s New conversation button creates a conversation and opens it', async () => {
    const user = userEvent.setup()
    const { ready, store } = renderWithBackend(<Shell />, { fixture: fixture('empty') })
    await act(() => ready)
    const list = screen.getByRole('navigation', { name: 'Conversations' })
    await user.click(within(list).getByRole('button', { name: /^Options for / }))
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }))
    const main = screen.getByRole('main')
    await within(main).findByRole('heading', { name: 'Start the first conversation' })

    await user.click(within(main).getByRole('button', { name: 'New conversation' }))
    await waitFor(() => expect(store.getState().activeConversationId).toBe('cnv_new-1'))
    await waitFor(() => expect(within(main).queryByRole('heading', { name: /conversation/ })).toBeNull())
    expect(store.getState().app?.conversations).toHaveLength(1)
    expect(await within(main).findByRole('textbox', { name: 'Message' })).toBeInTheDocument()
  })

  // A long walk through every row: past the default 5 s when the whole suite runs at once.
  test('settings show every row, send each change, and show only whether a key is configured', { timeout: 20_000 }, async () => {
    const user = userEvent.setup()
    const { ready, backend, store } = renderWithBackend(<Shell />, { fixture: fixture('trip') })
    await act(() => ready)
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    const dialog = await screen.findByRole('dialog')

    expect(within(dialog).getByRole('radio', { name: /Standard/ })).toBeChecked()
    await user.click(within(dialog).getByRole('radio', { name: /Manual/ }))
    await waitFor(() => expect(store.getState().app?.settings.retryPolicy).toBe('manual'))
    expect(within(dialog).getByText('Wait before a default choice runs')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Increase' }))
    await waitFor(() => expect(store.getState().app?.settings.concurrencyLimit).toBe(5))

    await user.click(within(dialog).getByRole('tab', { name: 'Models' }))
    for (const role of ['Answers', 'Synthesis', 'Decomposition', 'Decisions']) {
      expect(within(dialog).getByRole('button', { name: new RegExp(`^${role} model`) })).toBeInTheDocument()
    }
    await user.click(within(dialog).getByRole('button', { name: /^Decomposition model/ }))
    await user.click(await screen.findByRole('option', { name: /Claude Opus 5.5/ }))
    await waitFor(() => expect(store.getState().app?.settings.models.decomposition).toBe('anthropic/claude-opus-5.5'))
    // Ordered-message decomposition, a decomposer option beside the decomposition model (Q104): decompose by default.
    expect(within(dialog).getByRole('radio', { name: /^Decompose/ })).toBeChecked()
    await user.click(within(dialog).getByRole('radio', { name: /Keep atomic/ }))
    await waitFor(() => expect(store.getState().app?.settings.routing.orderedMessages).toBe('atomic'))
    expect(within(dialog).getByText(/A combined limit like “under 100 words total” always keeps a message as one request/)).toBeInTheDocument()

    await user.click(within(dialog).getByRole('tab', { name: 'Routing' }))
    // Five thresholds and the decision token budget's value.
    expect(within(dialog).getAllByRole('slider')).toHaveLength(6)
    // The token budget: a share of the conversation by default, or a fixed number; one setting, the mode and its value.
    expect(within(dialog).getByRole('radio', { name: /Share of the conversation/ })).toBeChecked()
    expect(within(dialog).getByText(/Never fewer than 16,000 tokens.*never more than 40,000/)).toBeInTheDocument()
    expect(within(dialog).getByText('2.0%')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('radio', { name: /Fixed/ }))
    await waitFor(() => expect(store.getState().app?.settings.routing.tokenBudget).toEqual({ mode: 'absolute', inputTokens: 16_000 }))
    expect(await within(dialog).findByText('16,000')).toBeInTheDocument()
    expect(within(dialog).getByText('Tokens per message')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('radio', { name: /Share of the conversation/ }))
    await waitFor(() => expect(store.getState().app?.settings.routing.tokenBudget).toEqual({ mode: 'relative', fraction: 0.02, floor: 16_000, ceiling: 40_000 }))
    // Strategy selection: by the rules unless changed; the decision model, or the strategy as set below.
    expect(within(dialog).getByRole('radio', { name: /By rules/ })).toBeChecked()
    expect(within(dialog).getByText(/the ones set below are not used/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('radio', { name: /By the decision model/ }))
    await waitFor(() => expect(store.getState().app?.settings.routing.strategySelection).toBe('decision-model'))
    expect(await within(dialog).findByText(/the ones set below are not used/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('radio', { name: /By rules/ }))
    await waitFor(() => expect(store.getState().app?.settings.routing.strategySelection).toBe('rules'))
    await user.click(within(dialog).getByRole('radio', { name: /As set here/ }))
    await waitFor(() => expect(store.getState().app?.settings.routing.strategySelection).toBe('off'))
    await waitFor(() => expect(within(dialog).queryByText(/the ones set below are not used/)).not.toBeInTheDocument())
    // The candidate source: seed hints for the tree walk, from the word index or from nothing.
    expect(within(dialog).getByText(/Seed hints only: each is still asked about by itself/)).toBeInTheDocument()
    expect(within(dialog).getByRole('radio', { name: DEFAULT_SETTINGS.routing.candidateSource === 'lexical' ? /Word index/ : /^None/ })).toBeChecked()
    await user.click(within(dialog).getByRole('radio', { name: /Word index/ }))
    await waitFor(() => expect(store.getState().app?.settings.routing.candidateSource).toBe('lexical'))
    await user.click(within(dialog).getByRole('radio', { name: /^None/ }))
    await waitFor(() => expect(store.getState().app?.settings.routing.candidateSource).toBe('none'))
    // The tree walk's two switches sit under the strategy, are independent, and are shown only for the tree walk.
    expect(within(dialog).getByRole('radio', { name: /Tree walk/ })).toBeChecked()
    expect(within(dialog).getAllByRole('switch')).toHaveLength(4)
    expect(within(dialog).getByRole('switch', { name: 'Start at the trunk base' })).not.toBeChecked()
    await user.click(within(dialog).getByRole('switch', { name: 'Hop between branch points' }))
    await waitFor(() => expect(store.getState().app?.settings.routing.treeWalk).toEqual({ startAtTrunkBase: false, hopBetweenBranchPoints: true, searchRunsOverTokens: 1_500 }))
    await user.click(within(dialog).getByRole('switch', { name: 'Start at the trunk base' }))
    await waitFor(() => expect(store.getState().app?.settings.routing.treeWalk.startAtTrunkBase).toBe(true))
    expect(store.getState().app?.settings.routing.treeWalk.hopBetweenBranchPoints).toBe(true)
    // The hop's wording says what it trades: fewer decision tokens for an answer that reads the rest of the run.
    expect(within(dialog).getByText(/continues from the run’s last answer.*Saves decision tokens; the answer then reads everything after the part of the run the message is about/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('radio', { name: /One pass/ }))
    await waitFor(() => expect(within(dialog).queryAllByRole('switch')).toHaveLength(2))
    // A selector may choose the tree walk whatever is configured, and the hop is never the selector's: its switch is in reach, still on.
    await user.click(within(dialog).getByRole('radio', { name: /By rules/ }))
    await waitFor(() => expect(within(dialog).getByRole('switch', { name: 'Hop between branch points' })).toBeChecked())
    expect(within(dialog).queryByRole('switch', { name: 'Start at the trunk base' })).not.toBeInTheDocument()
    expect(within(dialog).getByText(/“Hop between branch points” is used as set/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('radio', { name: /As set here/ }))
    await waitFor(() => expect(within(dialog).queryAllByRole('switch')).toHaveLength(2))
    // Context summaries apply to either strategy, and say that nothing generates them yet.
    expect(within(dialog).getAllByText(/Summaries are not generated yet/)).toHaveLength(2)
    await user.click(within(dialog).getByRole('switch', { name: 'Use context summaries when available' }))
    await waitFor(() => expect(store.getState().app?.settings.routing.useSummaryIfAvailable).toBe(true))
    expect(store.getState().app?.settings.routing.backgroundSummaries).toBe(false)
    await user.click(within(dialog).getByRole('switch', { name: 'Summarise context in the background' }))
    await waitFor(() => expect(store.getState().app?.settings.routing.backgroundSummaries).toBe(true))
    expect(store.getState().app?.settings.routing.treeWalk.startAtTrunkBase).toBe(true)

    await user.click(within(dialog).getByRole('tab', { name: 'Debug views' }))
    expect(within(dialog).getAllByRole('switch')).toHaveLength(4)
    await user.click(within(dialog).getByRole('switch', { name: 'Mini-map' }))
    await waitFor(() => expect(store.getState().app?.settings.debug.miniMap).toBe(true))

    await user.click(within(dialog).getByRole('tab', { name: 'Key' }))
    expect(within(dialog).getByTestId('key-status')).toHaveTextContent('Key configured')
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }))
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(within(dialog).getByTestId('key-status')).toHaveTextContent('No key'))
    expect(backend?.sent.at(-1)).toEqual({ type: 'change-settings', openRouterKey: { action: 'clear' } })
  })

  test('shows the standby notice while another tab runs the backend, then the app', async () => {
    const { ready, store } = renderWithBackend(<Shell />, { fixture: fixture('empty') })
    await act(() => ready)
    act(() => store.setStatus('standby', 'another-tab'))
    expect(screen.getByRole('status')).toHaveTextContent(WORDING.openInAnotherTab)
    expect(screen.queryByRole('navigation', { name: 'Conversations' })).not.toBeInTheDocument()
    act(() => store.setStatus('ready'))
    expect(screen.getByRole('navigation', { name: 'Conversations' })).toBeInTheDocument()
  })
})

describe('chain colors', () => {
  test('a chain color is its token; several chains are hard segments, never a blend', () => {
    expect(chainColor(3)).toBe('var(--chain-3)')
    // 01 · Chain colors: every chain has its own. Past the eight tokens a color is derived from one, never repeated.
    expect(chainColor(9)).toContain('from var(--chain-1)')
    const colors = Array.from({ length: CHAIN_COLOR_LIMIT }, (_, index) => chainColor(index))
    expect(new Set(colors).size).toBe(CHAIN_COLOR_LIMIT)
    expect(CHAIN_COLOR_LIMIT).toBeGreaterThanOrEqual(32)
    expect(new Set(colors.map((_, index) => chainTint(index))).size).toBe(CHAIN_COLOR_LIMIT)
    expect(chainSegments([0, 1])).toBe(
      'linear-gradient(to bottom, var(--chain-0) 0.000% 50.000%, var(--chain-1) 50.000% 100.000%)',
    )
  })
})

# @pluribus/web

The Pluribus client: Vite, React 19, Tailwind v4. It renders the four projections and sends commands; it never decides placement, ordering, dependencies or context. This file is the guide to the foundation the features are built in: the shell, the design system, the client store, fixtures and tests.

```sh
pnpm dev                                        # http://localhost:5173
pnpm --filter @pluribus/web typecheck
pnpm vitest run --project web packages/web
```

| URL | Shows |
|---|---|
| `/` | The app on the Worker backend: core, the OpenRouter providers and IndexedDB storage in a Web Worker (`src/worker/`) |
| `/?fixtures` | The fixture gallery: every fixture in the real shell, with a stepper, a phone-width frame and the theme switch |
| `/?fixture=<id>` | One fixture, playing its steps on timers |
| `/?fixture=<id>&manual` | One fixture, steps played by hand: `window.__pluribusFixture.step()` |

Fixtures are available on the dev server, and in a build made with `VITE_FIXTURES=1`.

## Where things are

| Path | Contents | Owner |
|---|---|---|
| `src/index.css` | Every design token | ui-foundation |
| `src/design/chains.ts` | `chainColor`, `chainTint`, `chainSegments` | ui-foundation |
| `src/backend/` | The client store, the hooks, `connect` | ui-foundation |
| `src/app/` | Shell, sidebar, header, key prompt, settings, theme, UI state, standby notice, gallery, stand-ins | ui-foundation |
| `src/components/ui/`, `src/components/ai-elements/` | shadcn (Radix) and AI Elements, restyled to the tokens | ui-foundation |
| `src/fixtures/` | Fixture types, builder, scripted backend, registry; `cases/<id>.ts` belong to the author named in PLAN section 4 | shared by case |
| `src/test/` | `setup.ts` (jsdom polyfills), `render.tsx` (`renderWithBackend`) | ui-foundation |
| `src/features/transcript`, `composer`, `association` | Transcript, composer dock, rails and Focus | ui-transcript |
| `src/worker/` | `backend.worker.ts` (the Worker: takes the `pluribus-backend` lock, opens storage, builds and serves the backend), `client.ts` (one Worker per page, `connectWorker`), `system.ts` (clock, timers, IDs) | integration |
| `e2e/` | End-to-end flows in Chromium over the Worker with live OpenRouter (`pnpm e2e`, not part of `pnpm test`) | integration |

## How a feature plugs in

The shell finds entry components by glob (`src/app/features.ts`), so nobody edits a file outside their directory. Export exactly these names from the feature's `index.ts`; each takes no props and reads the store.

| File | Export | Where the shell puts it |
|---|---|---|
| `src/features/transcript/index.ts` | `TranscriptPane` | The transcript region. Give it `min-h-0 flex-1` and its own scrolling; the region is a flex column |
| `src/features/composer/index.ts` | `ComposerDock` | Under the transcript, not scrolling with it |
| `src/features/association/index.ts` | `FocusBar` | In the header, after the title. `ChainRail` is yours to use inside the transcript |

Until `TranscriptPane` and `ComposerDock` exist, `src/app/stand-ins.tsx` renders the projections plainly so the shell and the gallery are usable. They disappear as soon as the feature exports its component; do not edit or import them.

The shell already handles: the conversation list, the header title, the debug-view toggles (settings), the key prompt, settings, the theme, the standby and failure notices, and clearing `ui-state` when another conversation is opened.

## The client store (`@/backend`)

`createBackendStore(client)` subscribes to the stream, loads the app snapshot, opens the newest (or last used) conversation, and keeps its snapshot current with `reconcileFrame`. Records keep their identity as `applyPatches` returns them, so a hook on one record re-renders only when that record changed: a streaming section re-renders alone.

```ts
useBackend(): BackendClient
useBackendStatus(): 'connecting' | 'standby' | 'ready' | 'failed'
useSend(): <C extends Command>(command: C) => Promise<CommandResult<C['type']>>
useApp(): AppSnapshot | null                    // conversations, settings, key status
useActiveConversationId(): ConversationId | null
useOpenConversation(): (id: ConversationId | null) => void

// one record by ID
useTranscriptOrder()  useMessage(id)  useResponse(id)  useSection(id)  useAttempt(id)
useChain(id)  useSplit(originalMessageId)  useOperation(id)

// whole projections (EMPTY_* while no conversation is open)
useTranscript()  useQueue()  useGenealogy()  useOperationGraph()

useRunInspection(directiveId | null, attemptId | null): RunInspection | null
```

Also exported: `useBackendStore()` (for `getState()` and `onConversationFrame`), `useBackendStatusDetail()`, `useConversationLoading()`, `BackendProvider`, `connect`.

- Render a list by mapping `useTranscriptOrder()` to components that each call `useMessage(id)` or `useResponse(id)`. Do not select a whole projection where one record will do.
- A hook that takes an ID needs a real ID. Split a component in two when the ID comes from a record that may be missing.
- `useRunInspection` refetches after a frame that patches the queue, the operation graph, or that directive's section or attempts. Streamed text does not refetch.
- `useSend()` resolves with the backend's verdict. A rejected command is `{ ok: false, error }`; show `error.message` (the shell uses `toast.error` from `sonner`).

## UI state (`@/app/ui-state`)

Client-only state shared between features: what the user is pointing at and which panels are open. `useUiState(selector)`; actions are selected the same way and are stable.

```ts
replyTargets: SectionId[]            toggleReplyTarget(id)  clearReplyTargets()
focus: { pinned, preview }           previewFocus(chainId | null)  pinFocus(chainId | null)
inspected: { directiveId, attemptId } | null    inspect(target | null)
compare: MessageId | null            openCompare(messageId | null)
selectedOperation: OperationId | null           selectOperation(id | null)
reveal: { sectionId, nonce } | null  revealSection(sectionId)
keyPromptOpen                        openKeyPrompt()  closeKeyPrompt()
settingsOpen                         openSettings()  closeSettings()
sidebarOpen                          setSidebarOpen(open)
resetForConversation()               // the shell calls it when the open conversation changes
```

Without a key the composer shows "Add an OpenRouter key to send messages" with a button that calls `openKeyPrompt()`; read `useApp()?.key.configured`.

## Design system (`src/index.css`)

Quiet and typographic: warm paper neutrals, one deep green for the few primary things, and eight chain colors that mean a chain and nothing else. Both themes are defined for every token. No hex value appears in a component.

| Kind | Tokens (as Tailwind classes) |
|---|---|
| Surfaces | `bg-background` (page), `bg-surface` (cards, inputs), `bg-surface-raised` (popovers), `bg-muted`, `bg-accent`, `bg-sidebar` |
| Ink | `text-foreground`, `text-muted-foreground`, `text-faint-foreground` (timestamps, eyebrows) |
| Lines | `border-border`, `border-border-strong` |
| Primary | `bg-primary text-primary-foreground`, `text-primary` for links |
| States | `text-destructive` / `bg-destructive-tint`, `text-success` / `bg-success-tint`, `text-warning` / `bg-warning-tint` |
| Chains | `bg-chain-0` … `bg-chain-7` (also `text-`, `border-`); normally through `chainColor()` |
| Type | Tailwind's `text-xs` … `text-2xl`, plus `text-2xs` (11 px), `text-prose` (15 px, transcript text), `font-serif` and the `display` utility for display lines, `font-mono` for IDs and model names |
| Radii | `rounded-sm` … `rounded-4xl`, all from `--radius` (10 px) |
| Elevation | `shadow-raised`, `shadow-overlay` |
| Layout | `max-w-(--spacing-transcript)` (760 px), `w-(--spacing-sidebar)`, `shell:` variant (900 px and up) |
| Utilities | `eyebrow`, `display`, `tabular` (numbers that change in place), `pressable`, `chain-rail`, `scroll-quiet`, `animate-pending`, `animate-spin-fast` |

### Chain colors

`chainColor(colorIndex)` returns `var(--chain-${colorIndex % 8})`. The backend assigns `colorIndex`; the client never chooses or reorders. Order: blue, clay, violet, teal, rose, ochre, green, sky. Each is at least 3:1 against the page in both themes (measured: 3.4 to 5.6 in light, 8.7 to 11.5 in dark) and stays clear of the destructive red.

A mark for several chains is hard segments: `chainSegments([0, 1])` gives a `background` with hard stops. Never use a gradient that blends two chain colors, and never use a chain color for anything that is not that chain. `chainTint(colorIndex)` is the quiet background for chain-colored content.

```tsx
<span aria-hidden className="chain-rail" style={{ background: chainColor(chain.colorIndex) }} />
```

### Motion

Tokens: `ease-out` (entering and exiting), `ease-in-out` (moving on screen), `ease-drawer` (sheets), all strong custom curves; durations `--duration-press` 140 ms, `--duration-fast` 160 ms, `--duration-base` 200 ms, `--duration-slow` 260 ms. Use them as `duration-(--duration-fast) ease-out`.

Rules, from the `animate` skill (load it before writing motion, and `review-animations` before calling it done):

- Transform and opacity only. Name the properties; never `transition-all`.
- Under 300 ms. Exits faster than entrances.
- Nothing animates that the keyboard triggers many times a day. Streaming text and Focus changes do not animate layout.
- Every pressable thing answers a press: shadcn `Button` scales to 0.97; use `pressable` on anything else.
- Popovers, menus and tooltips grow from their trigger (already set in the components). Dialogs stay centered.
- Reduced motion keeps fades and drops movement. CSS is covered in `index.css`; with Motion, read `useReducedMotion()`.
- Hover effects that move go behind `@media (hover: hover) and (pointer: fine)`.

What the foundation animates: the key prompt's status line and button label (a 180 ms fade with a slight blur and rise, so one thing reads as changing), dialogs and sheets (shadcn, retimed), the responding dot (`animate-pending`, opacity only). The theme switch is a cut with transitions suppressed.

### Components

`src/components/ui` has: alert, badge, button, button-group, checkbox, code-block, collapsible, command, dialog, dropdown-menu, hover-card, input, input-group, label, message-scroller, popover, radio-group, scroll-area, select, separator, sheet, skeleton, slider, sonner, spinner, switch, tabs, textarea, tooltip, trace. `src/components/ai-elements` has: confirmation, conversation, message, model-selector, prompt-input, queue, reasoning, shimmer, suggestion, task.

Only ui-foundation runs the shadcn or AI Elements CLI or edits these. If you need a variant, copy the component into your feature directory and adapt the copy. If you need one that is not installed, say so in `requestsForOthers`.

`DialogContent` takes `overlayClassName` for a dialog opened over another dialog.

### Theme

`src/app/theme.tsx` provides `useTheme()` (`theme`, `resolvedTheme`, `setTheme`) with the next-themes contract: a `dark` class on `<html>`, default `system`, stored under `theme` in localStorage. It is local because next-themes renders a `<script>` from a component, which React 19 reports as an error on every load of a client-rendered app. Style dark mode with tokens; reach for the `dark:` variant only where a token cannot express it.

## Fixtures (`@/fixtures`)

The app runs on `FixtureBackend`, an in-memory `BackendClient`, wherever the Worker is not wanted: tests, the gallery, `?fixture=<id>`. A case is one file, `src/fixtures/cases/<id>.ts`, that default-exports a `Fixture` whose `id` is the file name. The registry finds it by glob.

```ts
import { fx, type Fixture } from '@/fixtures'   // always from '@/fixtures', never from a case file

const initial = fx
  .conversation('my-case')                        // cnv_my-case
  .chain('sky', { label: 'why the sky is blue' }) // colorIndex is the order of declaration
  .message('ask', 'Why is the sky blue?')
  .response('ask', { message: 'ask' })
  .section('sky', { response: 'ask', chain: 'sky', state: 'pending', title: 'why the sky is blue' })
  .attempt('sky-1', { section: 'sky', state: 'running' })
  .build()

const fixture: Fixture = {
  id: 'my-case',
  title: 'What it shows',
  covers: ['P1', 'responding bubble'],
  initial,
  steps: [
    {
      label: 'First text arrives',
      delayMs: 800,
      next: (previous) =>
        fx.from(previous)
          .patch('section', 'sky', { state: 'streaming', status: null })
          .patch('attempt', 'sky-1', { state: 'streaming', text: 'Sunlight ' })
          .build(),
    },
  ],
}
export default fixture
```

The builder:

- **Names are handles.** `fx.id('section', 'A')` is `sec_A`. Every reference is by name, and `build()` throws on a dangling one. A section's directive is named after the section unless you pass `directive`.
- **It derives** a message's `responseIds`, `chainIds` and actions; a response's `sectionIds`, placement and header count; a section's `attemptIds`, `messageId`, status, `directiveState` and actions; an attempt's number, mark and result status; a node's state and label; operation `depth`, `active` and `retired`; a chain's Focus `own`. State only what the case shows; anything derived can be overridden by passing it.
- **Order follows the one rule.** An item keeps the position at which it was first fixed; pending responses are the tail. So a step that gives a pending section text places it where the rule says. `.order(...)` states the order in which earlier items were fixed, when that differs from the order of declaration.
- **Steps continue from a snapshot.** `fx.from(previous)` returns a builder with everything `previous` had. Declaring a name again merges; `.patch(kind, name, options)` changes a record and throws if it does not exist; `.remove(kind, name)` drops one; `.appendText(attempt, text)` streams; `.resolveElicitation(name)` removes an answered elicitation.
- **Helpers.** `fx.error(code, message, httpStatus?)` for a failure; `fx.note.supersededInput(label, directive)`, `fx.note.redoneByDefault(label, elicitation)`, `fx.note.contextNearLimit(inputTokens, tokenLimit)` for section notes in the fixed wording; `.splitSet(original, …)` for split messages; `decomposition` on a message, with source spans found from substrings of the original.
- Kinds for `patch` and `remove`: `chain`, `message`, `response`, `section`, `attempt`, `queueItem`, `node`, `group`, `joinBack`, `operation`, `focus`, `splitSet`.

The backend:

- Each step is one `ConversationFrame` with `diffSnapshots(previous, next)`, no events, and the next `throughSeq`.
- It answers `change-settings`, `create-conversation`, `list-conversations` and `delete-conversation` itself, each with an `AppFrame`. A key sets `key.configured` and is dropped; `sent` records it as `'[redacted]'`.
- `submit-message` adds the message and its provisional "Routing…" bubble, then a short scripted reply, unless `respond` handles it.
- `fixture.respond(command, current)` is asked first. Return `{ result }` to reject a command, `{ steps }` to script what follows it, `{ app }` to change app state, or `null` to fall through. Every other command is accepted with an empty output.
- `fixture.runs` answers `run` queries, by directive and then attempt.

Cases in the tree from ui-foundation: `empty`, `no-key`, `routing`, `pending`, `streaming`, `overtaking`, `reply-group-mixed`, `trip`. From ui-transcript: `failed-retry`, `stopped`, `interrupted`, `cancelled`, `superseded`, `section-notes`, `queue-waiting`, `queue-paused`, `barrier-ordered-group`, `modal-target-ambiguity`, `modal-choice-default`, `split-messages`, `clarification`, `group-first-output`, `plain-text`.

## Tests

`src/test/setup.ts` polyfills what jsdom lacks (`ResizeObserver`, `IntersectionObserver`, `matchMedia`, `scrollIntoView`, `scrollTo`, pointer capture, `getAnimations`) and cleans up after each test.

```tsx
import { act, screen } from '@testing-library/react'
import { getFixture } from '@/fixtures'
import { renderWithBackend } from '@/test/render'

test('P1 (web) · B appears ahead of A’s pending bubble', async () => {
  const { backend, ready, ui, store } = renderWithBackend(<TranscriptPane />, { fixture: getFixture('overtaking') })
  await act(() => ready)                 // app snapshot and conversation are in the store
  act(() => { backend?.step() })         // play one step; timers are off in tests
  // assert on the screen; assert on backend.sent for commands
})
```

`renderWithBackend` mounts inside `BackendProvider`, a fresh ui-state and a `TooltipProvider`, and returns the Testing Library result plus `backend` (the `FixtureBackend`, or null when you passed `client`), `store`, `ui` (the ui-state store) and `ready`. The default fixture is `empty`.

`matchMedia` never matches in jsdom, so the shell renders its narrow layout in tests: the sidebar column is in the DOM but hidden by CSS, and the side panel is a sheet.

Network: nothing in a test or a fixture reaches the network. The key check and the model list go through `AppEnvironment` (`src/app/environment.tsx`), whose default is offline; `App` provides the live one only on the Worker backend.

## The OpenRouter key

A key is in three places only: the key prompt's input, one request to the deployment's key provision (`src/backend/key-provision.ts`; embedded, the backend Worker over `src/worker/key-channel.ts`), and the secrets store behind the backend. It is never part of a backend command. `src/app/key-prompt.tsx` is the only file that reads `__DEV_OPENROUTER_KEY__`. It checks the format, asks the key provision to check the key (valid with remaining credit, invalid, offline, or unverified), hands the key over, and clears its state whatever the outcome. Settings → Keys show "Key configured" or "No key", with Replace and Remove; a key is never displayed again. Where keys are not the client's to provide (`canProvideKeys` false) there is no prompt and the settings say "Configured on the server".

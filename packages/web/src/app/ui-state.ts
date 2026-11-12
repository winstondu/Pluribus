import type { AttemptId, ChainId, DirectiveId, MessageId, OperationId, SectionId } from '@committee/protocol'
import { createContext, createElement, useContext, type ReactNode } from 'react'
import { useStore } from 'zustand'
import { createStore, type StoreApi } from 'zustand/vanilla'

/**
 * Client-only state shared between features. Nothing here is a domain
 * decision: it is what the user is pointing at (a reply target, a focused
 * chain, an inspected run) and which panels are open.
 */
export interface UiState {
  /** Set by "Reply to this", cleared on send. */
  readonly replyTargets: readonly SectionId[]
  /** Focus (09 §2): hover or keyboard focus previews, click or Enter pins. */
  readonly focus: { readonly pinned: ChainId | null; readonly preview: ChainId | null }
  /** The run shown in the run inspector. */
  readonly inspected: { readonly directiveId: DirectiveId; readonly attemptId: AttemptId | null } | null
  /** The original message whose decomposition is open in Compare. */
  readonly compare: MessageId | null
  /**
   * The transcript messages showing their decomposition card, when Compare
   * is placed on the message (`debug.comparePlacement` is `inline`). Each is
   * the message the card sits on: the decomposed message, or the split
   * message whose "split from one message" link opened it.
   */
  readonly inlineCompare: readonly MessageId[]
  readonly selectedOperation: OperationId | null
  /** Asks the transcript to scroll a section into view (Q81). `nonce` changes on every request. */
  readonly reveal: { readonly sectionId: SectionId; readonly nonce: number } | null
  readonly keyPromptOpen: boolean
  readonly settingsOpen: boolean
  /** The conversation list as a sheet, under 900 px. */
  readonly sidebarOpen: boolean

  toggleReplyTarget(id: SectionId): void
  clearReplyTargets(): void
  previewFocus(chainId: ChainId | null): void
  pinFocus(chainId: ChainId | null): void
  inspect(target: { directiveId: DirectiveId; attemptId: AttemptId | null } | null): void
  openCompare(messageId: MessageId | null): void
  toggleInlineCompare(messageId: MessageId): void
  selectOperation(id: OperationId | null): void
  revealSection(sectionId: SectionId): void
  openKeyPrompt(): void
  closeKeyPrompt(): void
  openSettings(): void
  closeSettings(): void
  setSidebarOpen(open: boolean): void
  /** Drops everything that points into a conversation; called when another one is opened. */
  resetForConversation(): void
}

export type UiStore = StoreApi<UiState>

export function createUiStore(): UiStore {
  return createStore<UiState>()((set) => ({
    replyTargets: [],
    focus: { pinned: null, preview: null },
    inspected: null,
    compare: null,
    inlineCompare: [],
    selectedOperation: null,
    reveal: null,
    keyPromptOpen: false,
    settingsOpen: false,
    sidebarOpen: false,

    toggleReplyTarget: (id) =>
      set((state) => ({
        replyTargets: state.replyTargets.includes(id)
          ? state.replyTargets.filter((target) => target !== id)
          : [...state.replyTargets, id],
      })),
    clearReplyTargets: () => set((state) => (state.replyTargets.length === 0 ? state : { replyTargets: [] })),
    previewFocus: (chainId) =>
      set((state) => (state.focus.preview === chainId ? state : { focus: { ...state.focus, preview: chainId } })),
    pinFocus: (chainId) =>
      set((state) => (state.focus.pinned === chainId ? state : { focus: { ...state.focus, pinned: chainId } })),
    inspect: (target) => set({ inspected: target }),
    openCompare: (messageId) => set({ compare: messageId }),
    toggleInlineCompare: (messageId) =>
      set((state) => ({
        inlineCompare: state.inlineCompare.includes(messageId)
          ? state.inlineCompare.filter((id) => id !== messageId)
          : [...state.inlineCompare, messageId],
      })),
    selectOperation: (id) => set({ selectedOperation: id }),
    revealSection: (sectionId) =>
      set((state) => ({ reveal: { sectionId, nonce: (state.reveal?.nonce ?? 0) + 1 } })),
    openKeyPrompt: () => set({ keyPromptOpen: true }),
    closeKeyPrompt: () => set({ keyPromptOpen: false }),
    openSettings: () => set({ settingsOpen: true }),
    closeSettings: () => set({ settingsOpen: false }),
    setSidebarOpen: (open) => set({ sidebarOpen: open }),
    resetForConversation: () =>
      set({
        replyTargets: [],
        focus: { pinned: null, preview: null },
        inspected: null,
        compare: null,
        inlineCompare: [],
        selectedOperation: null,
        reveal: null,
      }),
  }))
}

/** Used when no provider is mounted. The app and `renderWithBackend` always mount one. */
const defaultStore = createUiStore()
const UiStateContext = createContext<UiStore>(defaultStore)

export function UiStateProvider(props: { store?: UiStore; children: ReactNode }) {
  return createElement(UiStateContext.Provider, { value: props.store ?? defaultStore }, props.children)
}

/** The store itself, for reading or acting outside a render (`useUiStore().getState()`). */
export function useUiStore(): UiStore {
  return useContext(UiStateContext)
}

/** `const pinned = useUiState((s) => s.focus.pinned)`; actions are stable and can be selected the same way. */
export function useUiState<T>(selector: (state: UiState) => T): T {
  return useStore(useContext(UiStateContext), selector)
}

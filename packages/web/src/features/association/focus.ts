import type { ChainId, FocusSet, MessageId, SectionId } from '@committee/protocol'
import { useStore } from 'zustand'
import { useUiState } from '@/app/ui-state'
import { useBackendStore } from '@/backend'

/**
 * How one transcript item relates to the focused chain (09 §2).
 *
 * - `none`: no chain is focused; the item is shown as usual.
 * - `own`: the focused chain handled it.
 * - `inherited`: it is in the exact ancestry the focused chain's runs
 *   consumed. It keeps its own chain's color.
 * - `dimmed`: neither, even when it shares a chain with something inherited.
 *
 * The sets come from the transcript projection (`ChainAssociation.focus`);
 * nothing here is worked out from chain IDs or from positions in the chat.
 */
export type FocusRelation = 'none' | 'own' | 'inherited' | 'dimmed'

/** The chain Focus is showing: a preview (hover or keyboard focus) wins over the pin while it lasts. */
export function useFocusedChainId(): ChainId | null {
  return useUiState((state) => state.focus.preview ?? state.focus.pinned)
}

function relationOf(focus: FocusSet | undefined, kind: 'message' | 'section', id: string): FocusRelation {
  if (!focus) return 'dimmed'
  const own: readonly string[] = kind === 'message' ? focus.own.messageIds : focus.own.sectionIds
  if (own.includes(id)) return 'own'
  const inherited: readonly string[] = kind === 'message' ? focus.inherited.messageIds : focus.inherited.sectionIds
  return inherited.includes(id) ? 'inherited' : 'dimmed'
}

function useRelation(kind: 'message' | 'section', id: string): FocusRelation {
  const focused = useFocusedChainId()
  return useStore(useBackendStore(), (state): FocusRelation => {
    if (focused === null) return 'none'
    return relationOf(state.conversation?.transcript.chains[focused]?.focus, kind, id)
  })
}

export function useMessageFocus(id: MessageId): FocusRelation {
  return useRelation('message', id)
}

export function useSectionFocus(id: SectionId): FocusRelation {
  return useRelation('section', id)
}

/**
 * For something that stands for several sections (a reply's header): `none`
 * without Focus, `dimmed` when no section is own or inherited, else `own`.
 */
export function useSectionsFocus(ids: readonly SectionId[]): FocusRelation {
  const focused = useFocusedChainId()
  return useStore(useBackendStore(), (state): FocusRelation => {
    if (focused === null) return 'none'
    const focus = state.conversation?.transcript.chains[focused]?.focus
    return ids.some((id) => relationOf(focus, 'section', id) !== 'dimmed') ? 'own' : 'dimmed'
  })
}

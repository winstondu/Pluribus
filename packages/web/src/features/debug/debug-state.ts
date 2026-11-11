import type { NodeId } from '@committee/protocol'
import { create } from 'zustand'

export type DebugTab = 'mini-map' | 'run' | 'compare'

/**
 * Client-only state of the debug views that the rest of the app does not
 * need: which tab of the side panel is in front and which mini-map node is
 * selected. What other features read (the inspected run, the open
 * decomposition, the selected operation, Focus) is in `@/app/ui-state`.
 */
interface DebugState {
  readonly tab: DebugTab | null
  readonly selectedNodeId: NodeId | null
  /**
   * Set while the mini-map itself is asking for a run to be inspected, so
   * that the panel does not leave the map the user is working in.
   */
  readonly keepTab: boolean
  /** The conversation this state belongs to, and the requests already answered by bringing a tab forward. */
  readonly seen: { conversationId: string | null; compare: unknown; inspected: unknown }
  setTab(tab: DebugTab): void
  selectNode(id: NodeId | null): void
  setKeepTab(keep: boolean): void
  /** Records what the panel has reacted to. The panel may be unmounted (a closed sheet) while requests arrive. */
  markSeen(seen: Partial<DebugState['seen']>): void
  reset(conversationId: string | null): void
}

export const useDebugState = create<DebugState>()((set) => ({
  tab: null,
  selectedNodeId: null,
  keepTab: false,
  seen: { conversationId: null, compare: null, inspected: null },
  setTab: (tab) => set({ tab }),
  selectNode: (id) => set({ selectedNodeId: id }),
  setKeepTab: (keep) => set({ keepTab: keep }),
  markSeen: (seen) => set((state) => ({ seen: { ...state.seen, ...seen } })),
  reset: (conversationId) =>
    set({ tab: null, selectedNodeId: null, keepTab: false, seen: { conversationId, compare: null, inspected: null } }),
}))

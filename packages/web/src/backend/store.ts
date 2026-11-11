import {
  reconcileFrame,
  type AppSnapshot,
  type BackendClient,
  type ConversationFrame,
  type ConversationId,
  type ConversationSnapshot,
  type StreamFrame,
} from '@committee/protocol'
import { createStore, type StoreApi } from 'zustand/vanilla'

/** Where the connection to the backend stands. */
export type BackendStatus = 'connecting' | 'standby' | 'ready' | 'failed'

export interface BackendState {
  readonly status: BackendStatus
  /** Why the status is `failed` or `standby`, for the notice. Never contains the key. */
  readonly statusDetail: string | null
  /** Conversation list, settings and key status. Null until first loaded. */
  readonly app: AppSnapshot | null
  readonly activeConversationId: ConversationId | null
  /** The open conversation's four projections. Null while none is open or while it loads. */
  readonly conversation: ConversationSnapshot | null
}

export type ConversationFrameListener = (frame: ConversationFrame, snapshot: ConversationSnapshot) => void

/**
 * A zustand store over a {@link BackendClient}. It subscribes to the stream,
 * loads the app snapshot, and keeps the open conversation's snapshot current
 * with `reconcileFrame`. Records keep their identity as `applyPatches`
 * returns them, so a selector on one record re-renders only when that record
 * changed.
 */
export interface BackendStore extends StoreApi<BackendState> {
  readonly client: BackendClient
  /** Opens a conversation (subscribe is already in place; snapshot, then frames). Null closes. */
  openConversation(id: ConversationId | null): void
  /** Set by `connect.ts` from the transport: standby, ready, failed. */
  setStatus(status: BackendStatus, detail?: string | null): void
  /** Called after each frame applied to the open conversation. Returns an unsubscribe. */
  onConversationFrame(listener: ConversationFrameListener): () => void
  /** Reads the app snapshot again. Resolves when it is in the store. */
  refreshApp(): Promise<void>
  /** Unsubscribes from the stream. */
  dispose(): void
}

export interface BackendStoreOptions {
  /**
   * When given, the store stays `connecting` until it resolves and turns
   * `failed` if it rejects (the Worker transport's `ready`). Without it the
   * client is taken to be ready at once.
   */
  readonly ready?: Promise<void>
  /** Open the newest conversation once the app snapshot has loaded. Default true. */
  readonly openFirst?: boolean
}

const LAST_CONVERSATION_KEY = 'committee:last-conversation'

function rememberedConversation(): string | null {
  try {
    return globalThis.localStorage?.getItem(LAST_CONVERSATION_KEY) ?? null
  } catch {
    return null
  }
}

function rememberConversation(id: ConversationId | null): void {
  try {
    if (id === null) globalThis.localStorage?.removeItem(LAST_CONVERSATION_KEY)
    else globalThis.localStorage?.setItem(LAST_CONVERSATION_KEY, id)
  } catch {
    // Storage may be unavailable (private mode); remembering is a convenience only.
  }
}

export function createBackendStore(client: BackendClient, options: BackendStoreOptions = {}): BackendStore {
  const base = createStore<BackendState>()(() => ({
    status: 'connecting',
    statusDetail: null,
    app: null,
    activeConversationId: null,
    conversation: null,
  }))

  const frameListeners = new Set<ConversationFrameListener>()
  /** Frames that arrived for the conversation being opened, before its snapshot did. */
  let pending: ConversationFrame[] = []
  /** Changes on every open, so a late snapshot of a conversation no longer wanted is dropped. */
  let openToken = 0
  let loading = false
  let disposed = false

  function applyFrame(frame: ConversationFrame): void {
    const snapshot = base.getState().conversation
    if (!snapshot) return
    const result = reconcileFrame(snapshot, frame)
    if (result.status === 'applied') {
      base.setState({ conversation: result.snapshot })
      for (const listener of [...frameListeners]) listener(frame, result.snapshot)
    } else if (result.status === 'gap') {
      void loadConversation(snapshot.conversationId)
    }
  }

  async function loadConversation(id: ConversationId): Promise<void> {
    const token = ++openToken
    loading = true
    pending = []
    const result = await client.snapshot({ kind: 'conversation', conversationId: id })
    if (disposed || token !== openToken) return
    loading = false
    if (!result.ok) {
      // The conversation is gone (deleted elsewhere): fall back to no conversation.
      pending = []
      base.setState({ activeConversationId: null, conversation: null })
      rememberConversation(null)
      return
    }
    base.setState({ conversation: result.value })
    const buffered = pending
    pending = []
    for (const frame of buffered) applyFrame(frame)
  }

  function openConversation(id: ConversationId | null): void {
    if (id === base.getState().activeConversationId && (id === null || base.getState().conversation || loading)) {
      return
    }
    rememberConversation(id)
    if (id === null) {
      openToken++
      loading = false
      pending = []
      base.setState({ activeConversationId: null, conversation: null })
      return
    }
    base.setState({ activeConversationId: id, conversation: null })
    void loadConversation(id)
  }

  function onAppSnapshot(app: AppSnapshot): void {
    base.setState({ app })
    const active = base.getState().activeConversationId
    if (active !== null && !app.conversations.some((conversation) => conversation.id === active)) {
      // The open conversation was deleted: show the newest remaining one.
      openConversation(app.conversations[0]?.id ?? null)
    }
  }

  function onFrame(frame: StreamFrame): void {
    if (disposed) return
    if (frame.kind === 'app') {
      onAppSnapshot(frame.app)
      return
    }
    if (frame.conversationId !== base.getState().activeConversationId) return
    if (loading) pending.push(frame)
    else applyFrame(frame)
  }

  const unsubscribe = client.subscribe(onFrame)

  async function refreshApp(): Promise<void> {
    const result = await client.snapshot({ kind: 'app' })
    if (disposed) return
    if (!result.ok) {
      base.setState({ status: 'failed', statusDetail: result.error.message })
      return
    }
    onAppSnapshot(result.value)
  }

  async function start(): Promise<void> {
    if (options.ready) {
      try {
        await options.ready
      } catch (error) {
        if (!disposed) {
          base.setState({ status: 'failed', statusDetail: error instanceof Error ? error.message : String(error) })
        }
        return
      }
    }
    await refreshApp()
    if (disposed || base.getState().status === 'failed') return
    base.setState({ status: 'ready', statusDetail: null })
    const app = base.getState().app
    if (app && options.openFirst !== false && base.getState().activeConversationId === null) {
      const remembered = rememberedConversation()
      const target = app.conversations.find((conversation) => conversation.id === remembered) ?? app.conversations[0]
      if (target) openConversation(target.id)
    }
  }
  void start()

  return Object.assign(base, {
    client,
    openConversation,
    setStatus(status: BackendStatus, detail: string | null = null) {
      if (!disposed) base.setState({ status, statusDetail: detail })
    },
    onConversationFrame(listener: ConversationFrameListener) {
      frameListeners.add(listener)
      return () => {
        frameListeners.delete(listener)
      }
    },
    refreshApp,
    dispose() {
      disposed = true
      frameListeners.clear()
      unsubscribe()
    },
  })
}

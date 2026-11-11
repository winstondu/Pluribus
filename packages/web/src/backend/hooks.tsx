import {
  EMPTY_GENEALOGY,
  EMPTY_OPERATION_GRAPH,
  EMPTY_QUEUE,
  EMPTY_TRANSCRIPT,
  type AppSnapshot,
  type AttemptId,
  type AttemptView,
  type BackendClient,
  type ChainAssociation,
  type ChainId,
  type Command,
  type CommandResult,
  type ConversationFrame,
  type ConversationId,
  type DirectiveId,
  type GenealogyProjection,
  type MessageId,
  type MessageView,
  type OperationGraphProjection,
  type OperationId,
  type OperationView,
  type QueueProjection,
  type ResponseId,
  type ResponseView,
  type RunInspection,
  type SectionId,
  type SectionView,
  type SplitView,
  type TranscriptItemRef,
  type TranscriptProjection,
} from '@committee/protocol'
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useStore } from 'zustand'
import type { BackendState, BackendStatus, BackendStore } from './store'

const BackendContext = createContext<BackendStore | null>(null)

export function BackendProvider(props: { store: BackendStore; children: ReactNode }) {
  return <BackendContext.Provider value={props.store}>{props.children}</BackendContext.Provider>
}

/** The store itself, for code that needs `getState()` or `onConversationFrame` outside a render. */
export function useBackendStore(): BackendStore {
  const store = useContext(BackendContext)
  if (!store) throw new Error('No BackendProvider above this component')
  return store
}

function useBackendState<T>(selector: (state: BackendState) => T): T {
  return useStore(useBackendStore(), selector)
}

export function useBackend(): BackendClient {
  return useBackendStore().client
}

export function useBackendStatus(): BackendStatus {
  return useBackendState((state) => state.status)
}

/** Why the backend is `failed` or `standby`, when it said. */
export function useBackendStatusDetail(): string | null {
  return useBackendState((state) => state.statusDetail)
}

/** Sends a command. The function is stable across renders. */
export function useSend(): <C extends Command>(command: C) => Promise<CommandResult<C['type']>> {
  const client = useBackend()
  return useCallback(<C extends Command>(command: C) => client.send(command), [client])
}

/** Conversations, settings, key status. Null until loaded. */
export function useApp(): AppSnapshot | null {
  return useBackendState((state) => state.app)
}

export function useActiveConversationId(): ConversationId | null {
  return useBackendState((state) => state.activeConversationId)
}

/** True while a conversation is selected and its snapshot has not arrived. */
export function useConversationLoading(): boolean {
  return useBackendState((state) => state.activeConversationId !== null && state.conversation === null)
}

export function useOpenConversation(): (id: ConversationId | null) => void {
  return useBackendStore().openConversation
}

// ── one record by ID: a streaming section re-renders alone ──

const EMPTY_ORDER: readonly TranscriptItemRef[] = EMPTY_TRANSCRIPT.order

export function useTranscriptOrder(): readonly TranscriptItemRef[] {
  return useBackendState((state) => state.conversation?.transcript.order ?? EMPTY_ORDER)
}

export function useMessage(id: MessageId): MessageView | undefined {
  return useBackendState((state) => state.conversation?.transcript.messages[id])
}

export function useResponse(id: ResponseId): ResponseView | undefined {
  return useBackendState((state) => state.conversation?.transcript.responses[id])
}

export function useSection(id: SectionId): SectionView | undefined {
  return useBackendState((state) => state.conversation?.transcript.sections[id])
}

export function useAttempt(id: AttemptId): AttemptView | undefined {
  return useBackendState((state) => state.conversation?.transcript.attempts[id])
}

export function useChain(id: ChainId): ChainAssociation | undefined {
  return useBackendState((state) => state.conversation?.transcript.chains[id])
}

export function useSplit(originalMessageId: MessageId): SplitView | undefined {
  return useBackendState((state) => state.conversation?.transcript.splits[originalMessageId])
}

export function useOperation(id: OperationId): OperationView | undefined {
  return useBackendState((state) => state.conversation?.operationGraph.operations[id])
}

// ── whole projections, for views that need all of one ──

export function useTranscript(): TranscriptProjection {
  return useBackendState((state) => state.conversation?.transcript ?? EMPTY_TRANSCRIPT)
}

export function useQueue(): QueueProjection {
  return useBackendState((state) => state.conversation?.queue ?? EMPTY_QUEUE)
}

export function useGenealogy(): GenealogyProjection {
  return useBackendState((state) => state.conversation?.genealogy ?? EMPTY_GENEALOGY)
}

export function useOperationGraph(): OperationGraphProjection {
  return useBackendState((state) => state.conversation?.operationGraph ?? EMPTY_OPERATION_GRAPH)
}

/** Whether a frame can have changed what the run inspector shows for a directive. A text append cannot. */
function frameTouchesRun(frame: ConversationFrame, directiveId: DirectiveId, before: RunInspection | null): boolean {
  for (const patch of frame.patches) {
    switch (patch.target) {
      case 'queue':
      case 'operation-graph':
        return true
      case 'transcript.section':
        if (patch.value === null) {
          if (before?.section?.sectionId === patch.id) return true
          if (before?.attempts.some((attempt) => attempt.sectionId === patch.id)) return true
        } else if (patch.value.directiveId === directiveId) return true
        break
      case 'transcript.attempt':
        if (patch.value === null) {
          if (before?.attempts.some((attempt) => attempt.attemptId === patch.id)) return true
        } else if (patch.value.directiveId === directiveId) return true
        break
      default:
        break
    }
  }
  return false
}

/**
 * The run inspector's record for one directive and one of its attempts
 * (`attemptId` null: the latest, or the directive before it started).
 *
 * Takes a `run` snapshot when its arguments change, and again after every
 * frame of the open conversation that patches the queue, the operation
 * graph, or that directive's section or attempts, with at most one request
 * in flight. Streaming text does not refetch.
 */
export function useRunInspection(directiveId: DirectiveId | null, attemptId: AttemptId | null): RunInspection | null {
  const store = useBackendStore()
  const conversationId = useActiveConversationId()
  const [inspection, setInspection] = useState<RunInspection | null>(null)
  const latest = useRef<RunInspection | null>(null)

  useEffect(() => {
    latest.current = null
    setInspection(null)
    if (directiveId === null || conversationId === null) return

    let cancelled = false
    let inFlight = false
    let again = false

    async function fetchRun(): Promise<void> {
      if (directiveId === null || conversationId === null) return
      if (inFlight) {
        again = true
        return
      }
      inFlight = true
      try {
        const result = await store.client.snapshot({ kind: 'run', conversationId, directiveId, attemptId })
        if (cancelled) return
        latest.current = result.ok ? result.value : null
        setInspection(latest.current)
      } finally {
        inFlight = false
        if (again && !cancelled) {
          again = false
          void fetchRun()
        }
      }
    }

    void fetchRun()
    const unsubscribe = store.onConversationFrame((frame) => {
      if (frameTouchesRun(frame, directiveId, latest.current)) void fetchRun()
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [store, conversationId, directiveId, attemptId])

  return inspection
}

import type { Command, CommandError, CommandResult } from './commands'
import type { AppEvent, ConversationEvent } from './events'
import type { AttemptId, ConversationId, DirectiveId } from './ids'
import type { ProjectionPatch } from './patches'
import { applyPatches } from './patches'
import type { AppSnapshot, ConversationSnapshot, RunInspection } from './projections'

/**
 * The interface between the client and the Committee backend (10 · Part 2,
 * Q55, Q62). The same three operations serve a backend embedded in a Web
 * Worker now and one behind a network later:
 *
 * - the client sends commands;
 * - the backend sends an ordered stream of domain events and projection updates;
 * - the client can read the backend's current state at any time.
 *
 * Everything that crosses it is plain JSON data from this package.
 */

/** Version of this interface. Both ends announce it when a transport connects. */
export const PROTOCOL_VERSION = 1

// ═══════════════════════════ stream ═══════════════════════════

/**
 * One step of one conversation: the events appended in that step and the
 * projection patches they caused, delivered together so the client never
 * sees a half-applied step.
 *
 * Frames for a conversation arrive in order and cover its log without gaps:
 * each frame's `fromSeq` is the previous frame's `throughSeq + 1`.
 */
export interface ConversationFrame {
  readonly kind: 'conversation'
  readonly conversationId: ConversationId
  /** Sequence number of the first event in `events`. */
  readonly fromSeq: number
  /** Sequence number of the last event in `events`: what a snapshot has after applying `patches`. */
  readonly throughSeq: number
  /** At least one event, in sequence order. */
  readonly events: readonly ConversationEvent[]
  /** Apply with `applyPatches(snapshot, patches, throughSeq)`. May be empty. */
  readonly patches: readonly ProjectionPatch[]
}

/**
 * App-wide state changed: the conversation list, the settings, or whether a
 * key is configured. Carries the whole new app state, which is small.
 */
export interface AppFrame {
  readonly kind: 'app'
  readonly events: readonly AppEvent[]
  readonly app: AppSnapshot
}

export type StreamFrame = ConversationFrame | AppFrame

export interface SubscriptionFilter {
  /**
   * Deliver conversation frames for this conversation only. App frames are
   * always delivered. Omit to receive every conversation's frames. Work in
   * other conversations keeps running either way.
   */
  readonly conversationId?: ConversationId
}

export type Unsubscribe = () => void

// ═══════════════════════════ snapshots ═══════════════════════════

/** What the client can ask for on demand. */
export type SnapshotQuery =
  /** Conversation list, settings and key status. */
  | { readonly kind: 'app' }
  /** The four projections of one conversation (10 · "What the client reads"). */
  | { readonly kind: 'conversation'; readonly conversationId: ConversationId }
  /**
   * The run inspector's record for one directive (09 §5). `attemptId` picks
   * an attempt; null means the latest, or the not-yet-started directive.
   */
  | {
      readonly kind: 'run'
      readonly conversationId: ConversationId
      readonly directiveId: DirectiveId
      readonly attemptId: AttemptId | null
    }
  /** The conversation's events after a sequence number, for tools and tests. */
  | { readonly kind: 'events'; readonly conversationId: ConversationId; readonly afterSeq: number }

export interface SnapshotValues {
  app: AppSnapshot
  conversation: ConversationSnapshot
  run: RunInspection
  events: { readonly events: readonly ConversationEvent[] }
}

export type SnapshotResult<K extends SnapshotQuery['kind'] = SnapshotQuery['kind']> =
  | { readonly ok: true; readonly value: SnapshotValues[K] }
  | { readonly ok: false; readonly error: CommandError }

// ═══════════════════════════ the interface ═══════════════════════════

/**
 * The backend as the client sees it. Core implements it directly; the Worker
 * transport and, later, a network transport implement it by forwarding.
 * Web code depends on this interface only, never on a concrete backend.
 */
export interface BackendClient {
  /**
   * Sends a command. Resolves once the backend has accepted or rejected it;
   * never rejects for a domain reason. What the command causes arrives on
   * the stream, usually before this resolves.
   */
  send<C extends Command>(command: C): Promise<CommandResult<C['type']>>

  /**
   * Subscribes to the ordered stream. The listener is called once per frame,
   * in order, never re-entrantly. Frames start with the first step after
   * the subscription was registered, so to load a conversation: subscribe
   * first, then take a snapshot, then feed both to {@link reconcileFrame}.
   */
  subscribe(listener: (frame: StreamFrame) => void, filter?: SubscriptionFilter): Unsubscribe

  /** Reads current state, for example on load or reconnect. */
  snapshot<Q extends SnapshotQuery>(query: Q): Promise<SnapshotResult<Q['kind']>>
}

/**
 * Folds a frame into a snapshot of the same conversation. Pure.
 *
 * - `applied`: the frame followed the snapshot directly.
 * - `stale`: the snapshot already reflects the frame (it was taken after the
 *   frame was produced). Nothing to do.
 * - `gap`: frames were missed. Take a new snapshot.
 */
export function reconcileFrame(
  snapshot: ConversationSnapshot,
  frame: ConversationFrame,
): { readonly status: 'applied' | 'stale' | 'gap'; readonly snapshot: ConversationSnapshot } {
  if (frame.conversationId !== snapshot.conversationId) return { status: 'stale', snapshot }
  if (frame.throughSeq <= snapshot.throughSeq) return { status: 'stale', snapshot }
  if (frame.fromSeq !== snapshot.throughSeq + 1) return { status: 'gap', snapshot }
  return { status: 'applied', snapshot: applyPatches(snapshot, frame.patches, frame.throughSeq) }
}

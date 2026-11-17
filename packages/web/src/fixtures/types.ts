import type {
  AppSnapshot,
  BackendClient,
  Command,
  CommandResult,
  KeyProviderName,
  ConversationSnapshot,
  RunInspection,
} from '@pluribus/protocol'

/**
 * A scripted state of the app: the projections of one open conversation,
 * optionally played forward in steps. Web code is built and tested against
 * fixtures until (and after) the Worker backend exists.
 */
export interface Fixture {
  /** kebab-case, unique, equal to the case file's name; used in `?fixture=<id>`. */
  readonly id: string
  readonly title: string
  /** States and acceptance IDs it shows: `['P1', 'P2', 'overtaking']`. */
  readonly covers: readonly string[]
  /** Default: the fixture's conversations, `DEFAULT_SETTINGS`, key configured. */
  readonly app?: Partial<Omit<AppSnapshot, 'modelRoles'>>
  /** False to show a deployment whose models are set by the server: no role is editable. Default true. */
  readonly modelsEditable?: boolean
  /** The open conversation. */
  readonly initial: ConversationSnapshot
  /** Further conversations in the list. */
  readonly others?: readonly ConversationSnapshot[]
  /** Titles for the conversation list, by conversation ID. Default: "<fixture title>" for `initial`. */
  readonly titles?: { readonly [conversationId: string]: string }
  /** Scripted playback, in order. */
  readonly steps?: readonly FixtureStep[]
  /** Answers to `run` queries: `byAttempt[attemptId]` when asked for one, else `latest`. */
  readonly runs?: {
    readonly [directiveId: string]: {
      readonly latest: RunInspection
      readonly byAttempt?: { readonly [attemptId: string]: RunInspection }
    }
  }
  /** Optional interactivity. Asked before the built-in handling; null falls through to it. */
  respond?(command: Command, current: ConversationSnapshot): FixtureResponse | null
}

export interface FixtureStep {
  /** Shown in the fixture gallery's stepper. */
  readonly label: string
  /** After the previous step. */
  readonly delayMs: number
  readonly next: ConversationSnapshot | ((previous: ConversationSnapshot) => ConversationSnapshot)
}

export interface FixtureResponse {
  /** Default: ok with an empty output. Give an error to show a rejected command. */
  readonly result?: CommandResult
  /** Played after the command. */
  readonly steps?: readonly FixtureStep[]
  /** Replaces the app state and emits an `AppFrame`. */
  readonly app?: AppSnapshot
}

/** An in-memory `BackendClient` that replays a {@link Fixture}. */
export interface FixtureBackend extends BackendClient {
  readonly fixture: Fixture
  /** Every command received. A key is never part of one. */
  readonly sent: readonly Command[]
  /** What the deployment's key provision tells the backend: a key was stored or removed. Only its presence is known here. */
  setKeyConfigured(provider: KeyProviderName, configured: boolean): void
  /** The fixture conversation as it stands. */
  readonly current: ConversationSnapshot
  readonly app: AppSnapshot
  /** Steps not played yet, in order. */
  readonly remaining: readonly FixtureStep[]
  /** How many steps have been played. */
  readonly played: number
  /** Play the next step now; false when none is left. */
  step(): boolean
  playAll(): void
  /** Called whenever a step was played or queued, for the gallery's stepper. Returns an unsubscribe. */
  onProgress(listener: () => void): () => void
  /** Stops timers. */
  dispose(): void
}

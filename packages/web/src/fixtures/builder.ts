import {
  ID_PREFIX,
  WORDING,
  asId,
  groupCountText,
  pausedText,
  providerError,
  recoveryLabels,
  redoneByDefaultText,
  supersededInputText,
  waitingText,
  type AttemptId,
  type AttemptOrigin,
  type AttemptResultStatus,
  type AttemptState,
  type AttemptView,
  type ChainAssociation,
  type ChainId,
  type ChainKind,
  type ChainView,
  type ConversationSnapshot,
  type DecompositionView,
  type DirectiveId,
  type DirectiveKind,
  type DirectiveState,
  type ElicitationView,
  type ExchangeNodeView,
  type FragmentView,
  type IdKind,
  type IdTypes,
  type JoinBackMember,
  type JoinBackNodeView,
  type MessageId,
  type MessageRoutingState,
  type MessageView,
  type NodeId,
  type NodeReason,
  type NodeState,
  type NodeView,
  type OperationId,
  type OperationStatus,
  type OperationView,
  type ProviderError,
  type ProviderErrorCode,
  type QueueItemView,
  type Requirement,
  type RequirementScope,
  type ResponseReason,
  type ResponseView,
  type RoutingStatusView,
  type SectionCounts,
  type SectionId,
  type SectionNote,
  type SectionState,
  type SectionStatus,
  type SectionStatusKind,
  type SectionView,
  type SiblingGroupView,
  type SplitView,
  type TextSpan,
  type TranscriptItemRef,
  type UnfinishedOutcome,
  type WaitTargetView,
  type WholeRequestBarrier,
} from '@committee/protocol'

/**
 * Readable construction of projection snapshots for fixtures.
 *
 * Names are local handles: `fx.id('section', 'A')` is `sec_A`, and every
 * reference between records is by name. `build()` throws on a dangling one.
 * The builder fills in what can be derived (a message's `responseIds`, a
 * response's `sectionIds`, a section's `attemptIds` and `messageId`,
 * operation `depth`, default actions for a state), so a case states only
 * what it shows.
 *
 * Declaring a name again merges the new options over the earlier ones, which
 * is how a step changes a record: `fx.from(previous).section('A', { state:
 * 'completed' }).build()`.
 */

// ───────────────────────── option types ─────────────────────────

export interface ChainOptions {
  kind?: ChainKind
  /** The chain it forked or branched from, by name. */
  base?: string
  label?: string
}

export type RoutingOption = 'routing' | 'awaiting-target' | { failed: string; code?: ProviderErrorCode }

export interface RequirementSpec {
  text: string
  shared?: boolean
  scope?: RequirementScope
  /** A substring of the original text this requirement quotes; becomes its provenance span. */
  source?: string
}

export interface FragmentSpec {
  label: string
  /** The rewritten atomic instruction. */
  text: string
  /** Substring(s) of the original text this fragment came from; each becomes a source span. */
  source?: string | string[]
  requirements?: RequirementSpec[]
  /** Directive, by name. */
  directive: string
  chain: string
  section?: string
  /** Its split message, by name, when the message was split. */
  message?: string
  kind?: 'work' | 'revision'
}

export interface DecompositionSpec {
  /** Required for a split set, whose original message is no longer a transcript item. */
  originalText?: string
  presentation?: 'reply-group' | 'split-messages'
  fragments: FragmentSpec[]
  barrier?: WholeRequestBarrier | null
  model?: string
}

export interface MessageOptions {
  /** Margin rail, by chain name. Default: the chains of its sections, in order, without repeats. */
  chains?: string[]
  replyingTo?: { sections: string[]; mode?: 'explicit' | 'inferred' | 'elicited'; note?: string | null }
  /** Default: the state of its provisional response's `routing`, else `routed`. */
  routing?: MessageRoutingState
  split?: { original: string; index: number; count: number }
  actions?: Partial<MessageView['actions']>
  decomposition?: DecompositionSpec
  /** Submission time (ms). Default: one every 45 s from a fixed base. */
  at?: number
}

export interface ResponseOptions {
  /** The user bubble it answers, by name. */
  message: string
  reason?: ResponseReason
  grouped?: boolean
  /** Default: placed once any of its sections is placed. */
  placed?: boolean
  /** Makes it the provisional bubble of a message that is not routed yet. `null` clears it. */
  routing?: RoutingOption | null
  /** Default for a group: counts from its sections and `groupCountText`. */
  header?: { countText?: string | null } | null
  /** An explicit output order (Q18), by section name. Default: placed sections as placed, then pending. */
  sectionOrder?: string[] | null
}

export interface SectionOptions {
  response: string
  chain: string
  state: SectionState
  /** Directive, by name. Default: the section's own name. */
  directive?: string
  /** Default: the section's name. */
  title?: string
  directiveState?: DirectiveState
  /** A kind uses the fixed wording for it; give `{ kind, text }` for wording that names something. */
  status?: SectionStatusKind | SectionStatus | null
  notes?: SectionNote[]
  /** `by`: the replacement section, by name. */
  superseded?: true | { mark?: string; by?: string } | null
  /** The section this one replaces, by name. */
  replaces?: string | null
  kind?: DirectiveKind
  /** For a clarification question: the elicitation it asks, by name. */
  asks?: string | null
  /** Default: placed unless `state` is `pending`. */
  placed?: boolean
  actions?: Partial<SectionView['actions']>
  /** Failure notice for a failed section with no listed attempt. */
  failure?: ProviderError | null
}

export interface AttemptOptions {
  section: string
  state: AttemptState
  text?: string
  /** Default: its position among the directive's attempts, from 1. */
  number?: number
  origin?: AttemptOrigin
  markText?: string | null
  collapsed?: boolean
  failure?: ProviderError | null
  model?: string
  /** Genealogy node it ran on, by name. Default: the directive's latest node. */
  node?: string
}

export interface WaitSpec {
  label: string
  /** The directives still unfinished behind this target, by name. */
  directives: string[]
  /** Set when the wait is on a whole sibling group, by name. */
  group?: string
}

export interface RecoverySpec {
  /** The recovery-choice elicitation, by name. It is added to the queue's elicitations. */
  elicitation: string
  cause: { directive: string; label: string; outcome: UnfinishedOutcome }
  /** The section Retry is sent for, by name. */
  retrySection: string
}

export interface QueueItemOptions {
  directive: string
  message: string
  state: 'waiting' | 'paused'
  /** Default: the fixed wording for its state, labels and `revised`. */
  text?: string
  /** The waiting part. Default: the directive's section title, else the directive's name. */
  label?: string
  waitingFor?: WaitSpec[]
  revised?: boolean
  heldByBarrier?: boolean
  recovery?: RecoverySpec | null
}

export interface NodeOptions {
  chain: string
  directive: string
  /** Parent nodes or join-backs, by name. */
  parents?: string[]
  parentsExact?: boolean
  /** Default: from the directive's section. */
  state?: NodeState
  reason?: NodeReason
  group?: string | null
  /** The node this one stands in for, by name. */
  replaces?: string | null
  label?: string
  /** Default: the directive's current section. */
  section?: string | null
}

export interface GroupOptions {
  start: string
  base: string
  members: string[]
  state?: 'open' | 'closed' | 'dissolved'
  withdrawn?: string[]
}

export interface JoinBackOptions {
  group: string
  /** Default: the group's members that were not withdrawn, outcomes from their nodes. */
  members?: (string | { node: string; outcome: JoinBackMember['outcome'] })[]
  lateRetries?: string[]
  /** A later formation that replaced this one, by name. */
  replacedBy?: string | null
}

export interface OperationOptions {
  /** Default: the section's title. */
  label?: string
  chain: string
  status: OperationStatus
  kind?: 'answer' | 'synthesis' | 'join-back'
  statusText?: string
  dependsOn?: string[]
  waitingFor?: string[]
  heldByBarrier?: boolean
  barrierWaitingFor?: string[]
  section?: string | null
  /** For a join-back operation: its sibling group and join-back, by name. */
  group?: string | null
  joinBack?: string | null
  retired?: boolean
}

export interface FocusOptions {
  inherited: { messages?: string[]; sections?: string[] }
}

export interface SplitSetOptions {
  messages: string[]
  undoAvailable?: boolean
  decomposition: DecompositionSpec
}

interface OptionsByKind {
  chain: ChainOptions
  message: MessageOptions & { text: string }
  response: ResponseOptions
  section: SectionOptions
  attempt: AttemptOptions
  queueItem: QueueItemOptions
  node: NodeOptions
  group: GroupOptions
  joinBack: JoinBackOptions
  operation: OperationOptions
  focus: FocusOptions
  splitSet: SplitSetOptions
}

type RecordKind = keyof OptionsByKind

type Spec = {
  name: string
  /** Declaration order across kinds, for defaults that follow it. */
  sequence: number
  declared: { [K in RecordKind]: Map<string, OptionsByKind[K] & { seq: number }> }
  elicitations: ElicitationView[]
  order: string[] | null
  /** Ordinal at which a message or response became fixed, keyed `m:<name>` / `r:<name>`. */
  fixedItems: Map<string, number>
  /** Ordinal at which a section was placed inside its response. */
  placedSections: Map<string, number>
  nextOrdinal: number
}

const SPECS = new WeakMap<ConversationSnapshot, Spec>()

const BASE_TIME = Date.UTC(2026, 10, 11, 9, 0, 0)

const STATUS_TEXT: { [K in SectionStatusKind]: string } = {
  responding: WORDING.responding,
  retrying: WORDING.retrying,
  'waiting-for-capacity': WORDING.waitingForCapacity,
  'waiting-for-results': 'Waiting for results',
  paused: 'Paused',
  'waiting-for-slot': WORDING.waitingForSlot,
  'awaiting-answer': WORDING.awaitingAnswer,
}

const DIRECTIVE_STATE_FOR_STATUS: { [K in SectionStatusKind]: DirectiveState } = {
  responding: 'running',
  retrying: 'retrying',
  'waiting-for-capacity': 'waiting-for-capacity',
  'waiting-for-results': 'dependency-queued',
  paused: 'paused',
  'waiting-for-slot': 'ready',
  'awaiting-answer': 'awaiting-elicitation',
}

const OPERATION_STATUS_TEXT: { [K in OperationStatus]: string } = {
  'waiting-for-results': 'Waiting for results',
  paused: 'Paused',
  'awaiting-answer': WORDING.awaitingAnswer,
  'waiting-for-slot': WORDING.waitingForSlot,
  'waiting-for-capacity': WORDING.waitingForCapacity,
  retrying: WORDING.retrying,
  running: WORDING.responding,
  streaming: 'Streaming',
  completed: 'Completed',
  failed: WORDING.failed,
  stopped: WORDING.stopped,
  interrupted: WORDING.interrupted,
  cancelled: WORDING.cancelled,
  superseded: WORDING.supersededFinished,
  'group-open': 'Waiting for the group to close',
  formed: 'Formed',
}

function emptySpec(name: string): Spec {
  return {
    name,
    sequence: 0,
    declared: {
      chain: new Map(),
      message: new Map(),
      response: new Map(),
      section: new Map(),
      attempt: new Map(),
      queueItem: new Map(),
      node: new Map(),
      group: new Map(),
      joinBack: new Map(),
      operation: new Map(),
      focus: new Map(),
      splitSet: new Map(),
    },
    elicitations: [],
    order: null,
    fixedItems: new Map(),
    placedSections: new Map(),
    nextOrdinal: 1,
  }
}

function id<K extends IdKind>(kind: K, name: string): IdTypes[K] {
  return asId(kind, `${ID_PREFIX[kind]}_${name}`)
}

function uniq<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}

function spansOf(original: string, source: string | string[] | undefined, what: string): TextSpan[] {
  if (source === undefined) return []
  return (Array.isArray(source) ? source : [source]).map((part) => {
    const start = original.indexOf(part)
    if (start < 0) throw new Error(`${what}: "${part}" is not part of the original text`)
    return { start, end: start + part.length }
  })
}

export class ConversationBuilder {
  private readonly spec: Spec

  constructor(spec: Spec) {
    this.spec = spec
  }

  private declare<K extends RecordKind>(kind: K, name: string, options: Partial<OptionsByKind[K]>): this {
    const records = this.spec.declared[kind] as Map<string, OptionsByKind[K] & { seq: number }>
    const existing = records.get(name)
    if (existing) {
      records.set(name, { ...existing, ...options })
    } else {
      records.set(name, { ...(options as OptionsByKind[K]), seq: this.spec.sequence++ })
    }
    return this
  }

  /** A chain. `colorIndex` is the order of declaration. */
  chain(name: string, options: ChainOptions = {}): this {
    return this.declare('chain', name, options)
  }

  /** A user bubble. Declared again with the same name, `text` and options are merged over the earlier ones. */
  message(name: string, text: string, options: MessageOptions = {}): this {
    return this.declare('message', name, { ...options, text })
  }

  response(name: string, options: ResponseOptions): this {
    return this.declare('response', name, options)
  }

  section(name: string, options: SectionOptions): this {
    return this.declare('section', name, options)
  }

  attempt(name: string, options: AttemptOptions): this {
    return this.declare('attempt', name, options)
  }

  queueItem(name: string, options: QueueItemOptions): this {
    return this.declare('queueItem', name, options)
  }

  /** An elicitation awaiting an answer, as the queue projection carries it. Replaces one with the same ID. */
  elicitation(view: ElicitationView): this {
    this.spec.elicitations = [...this.spec.elicitations.filter((existing) => existing.id !== view.id), view]
    return this
  }

  node(name: string, options: NodeOptions): this {
    return this.declare('node', name, options)
  }

  group(name: string, options: GroupOptions): this {
    return this.declare('group', name, options)
  }

  joinBack(name: string, options: JoinBackOptions): this {
    return this.declare('joinBack', name, options)
  }

  operation(name: string, options: OperationOptions): this {
    return this.declare('operation', name, options)
  }

  /** What Focus highlights for a chain beyond what it handled itself. `own` is derived. */
  focus(chain: string, options: FocusOptions): this {
    return this.declare('focus', chain, options)
  }

  /** The split messages of one sequential composite, keyed by the original message's name. */
  splitSet(original: string, options: SplitSetOptions): this {
    return this.declare('splitSet', original, options)
  }

  /**
   * Transcript order by message and response name, only when the default
   * (items in the order they were fixed, then pending responses) is not
   * wanted. Prefix with `m:` or `r:` when a message and a response share a name.
   */
  order(...names: string[]): this {
    this.spec.order = names.length === 0 ? null : names
    return this
  }

  /** Changes some options of a record declared earlier. Throws when it does not exist. */
  patch<K extends RecordKind>(kind: K, name: string, options: Partial<OptionsByKind[K]>): this {
    if (!this.spec.declared[kind].has(name)) {
      throw new Error(`Fixture "${this.spec.name}": cannot patch unknown ${kind} "${name}"`)
    }
    return this.declare(kind, name, options)
  }

  /** Removes a record: a dropped status-only bubble, a provisional response whose plan opened nothing. */
  remove(kind: RecordKind, name: string): this {
    this.spec.declared[kind].delete(name)
    if (kind === 'message') this.spec.fixedItems.delete(`m:${name}`)
    if (kind === 'response') this.spec.fixedItems.delete(`r:${name}`)
    if (kind === 'section') this.spec.placedSections.delete(name)
    return this
  }

  /** Removes an elicitation that was answered, by name. */
  resolveElicitation(name: string): this {
    const elicitationId = id('elicitation', name)
    this.spec.elicitations = this.spec.elicitations.filter((view) => view.id !== elicitationId)
    return this
  }

  /** Appends streamed answer text to an attempt. */
  appendText(attempt: string, text: string): this {
    const existing = this.spec.declared.attempt.get(attempt)
    if (!existing) throw new Error(`Fixture "${this.spec.name}": cannot append to unknown attempt "${attempt}"`)
    return this.declare('attempt', attempt, { text: (existing.text ?? '') + text })
  }

  build(): ConversationSnapshot {
    const spec = this.spec
    const d = spec.declared
    const fail = (message: string): never => {
      throw new Error(`Fixture "${spec.name}": ${message}`)
    }
    const need = <K extends RecordKind>(kind: K, name: string, from: string): OptionsByKind[K] & { seq: number } => {
      const record = (d[kind] as Map<string, OptionsByKind[K] & { seq: number }>).get(name)
      return record ?? fail(`${from} refers to unknown ${kind} "${name}"`)
    }
    const bySeq = <T extends { seq: number }>(records: Map<string, T>): [string, T][] =>
      [...records.entries()].sort((a, b) => a[1].seq - b[1].seq)

    const chainNames = bySeq(d.chain).map(([name]) => name)
    const colorIndexOf = (name: string): number => chainNames.indexOf(name)

    // ── sections and attempts, by owner ──
    const sectionsOfResponse = new Map<string, string[]>()
    for (const [name, section] of bySeq(d.section)) {
      need('response', section.response, `section "${name}"`)
      need('chain', section.chain, `section "${name}"`)
      sectionsOfResponse.set(section.response, [...(sectionsOfResponse.get(section.response) ?? []), name])
    }
    const directiveOf = (sectionName: string): string => d.section.get(sectionName)?.directive ?? sectionName
    const attemptsOfSection = new Map<string, string[]>()
    const attemptsOfDirective = new Map<string, string[]>()
    for (const [name, attempt] of bySeq(d.attempt)) {
      need('section', attempt.section, `attempt "${name}"`)
      attemptsOfSection.set(attempt.section, [...(attemptsOfSection.get(attempt.section) ?? []), name])
      const directive = directiveOf(attempt.section)
      attemptsOfDirective.set(directive, [...(attemptsOfDirective.get(directive) ?? []), name])
    }
    const sectionsOfDirective = new Map<string, string[]>()
    for (const [name] of bySeq(d.section)) {
      const directive = directiveOf(name)
      sectionsOfDirective.set(directive, [...(sectionsOfDirective.get(directive) ?? []), name])
    }
    /** The directive's current section: its last one that is not superseded, else its last. */
    const currentSectionOf = (directive: string): string | null => {
      const names = sectionsOfDirective.get(directive) ?? []
      const live = names.filter((name) => d.section.get(name)?.state !== 'superseded')
      return live[live.length - 1] ?? names[names.length - 1] ?? null
    }
    const nodesOfDirective = new Map<string, string[]>()
    for (const [name, node] of bySeq(d.node)) {
      need('chain', node.chain, `node "${name}"`)
      nodesOfDirective.set(node.directive, [...(nodesOfDirective.get(node.directive) ?? []), name])
    }
    const nodeExists = (name: string): boolean => d.node.has(name) || d.joinBack.has(name)
    const needNode = (name: string, from: string): NodeId =>
      nodeExists(name) ? id('node', name) : fail(`${from} refers to unknown node "${name}"`)

    const sectionPlaced = (name: string): boolean => {
      const section = d.section.get(name)
      if (!section) return false
      return section.placed ?? section.state !== 'pending'
    }
    const responsePlaced = (name: string): boolean => {
      const response = d.response.get(name)
      if (!response) return false
      if (response.placed !== undefined) return response.placed
      if (response.routing) return false
      return (sectionsOfResponse.get(name) ?? []).some(sectionPlaced)
    }

    // ── placement ordinals: an item keeps the position at which it was first seen fixed ──
    const items = [
      ...bySeq(d.message).map(([name, record]) => ({ key: `m:${name}`, kind: 'message' as const, name, seq: record.seq })),
      ...bySeq(d.response).map(([name, record]) => ({
        key: `r:${name}`,
        kind: 'response' as const,
        name,
        seq: record.seq,
      })),
    ].sort((a, b) => a.seq - b.seq)
    for (const item of items) {
      const fixed = item.kind === 'message' || responsePlaced(item.name)
      if (fixed && !spec.fixedItems.has(item.key)) spec.fixedItems.set(item.key, spec.nextOrdinal++)
      if (!fixed) spec.fixedItems.delete(item.key)
    }
    for (const [name] of bySeq(d.section)) {
      if (sectionPlaced(name)) {
        if (!spec.placedSections.has(name)) spec.placedSections.set(name, spec.nextOrdinal++)
      } else spec.placedSections.delete(name)
    }

    // ── attempts ──
    const attempts: { [id: string]: AttemptView } = {}
    const listedAttempts = new Map<string, string[]>()
    for (const [name, attempt] of bySeq(d.attempt)) {
      const section = need('section', attempt.section, `attempt "${name}"`)
      const directive = directiveOf(attempt.section)
      const text = attempt.text ?? ''
      const inFlight = attempt.state === 'running' || attempt.state === 'streaming'
      const resultStatus: AttemptResultStatus = inFlight
        ? 'in-flight'
        : attempt.state === 'completed'
          ? section.state === 'superseded'
            ? 'superseded'
            : 'current'
          : attempt.state === 'running' || attempt.state === 'streaming'
            ? 'in-flight'
            : attempt.state
      const defaultMark =
        attempt.state === 'failed'
          ? WORDING.failed
          : attempt.state === 'stopped'
            ? text
              ? WORDING.stoppedPartial
              : WORDING.stopped
            : attempt.state === 'interrupted'
              ? WORDING.interrupted
              : attempt.state === 'superseded'
                ? WORDING.supersededPartial
                : null
      const directiveAttempts = attemptsOfDirective.get(directive) ?? []
      const nodeName = attempt.node ?? (nodesOfDirective.get(directive) ?? []).at(-1) ?? directive
      if (attempt.node !== undefined) needNode(attempt.node, `attempt "${name}"`)
      const startedAt = BASE_TIME + attempt.seq * 5_000
      attempts[id('attempt', name)] = {
        id: id('attempt', name),
        sectionId: id('section', attempt.section),
        directiveId: id('directive', directive),
        number: attempt.number ?? directiveAttempts.indexOf(name) + 1,
        origin: attempt.origin ?? 'initial',
        state: attempt.state,
        resultStatus,
        text,
        markText: attempt.markText === undefined ? defaultMark : attempt.markText,
        collapsed: attempt.collapsed ?? false,
        chainId: id('chain', section.chain),
        nodeId: id('node', nodeName),
        model: attempt.model ?? 'anthropic/claude-sonnet-5.5',
        startedAt,
        endedAt: inFlight ? null : startedAt + 4_000,
        failure:
          attempt.failure !== undefined
            ? attempt.failure
            : attempt.state === 'failed'
              ? providerError('provider-error', 'The provider returned an error', { httpStatus: 500 })
              : null,
      }
      // Attempts that ended with no visible output are not listed in the bubble.
      const visible = text !== '' || inFlight || attempt.state === 'completed'
      if (visible) listedAttempts.set(attempt.section, [...(listedAttempts.get(attempt.section) ?? []), name])
    }

    // ── operations (IDs are needed by sections) ──
    const operationOfSection = new Map<string, string>()
    for (const [name, operation] of bySeq(d.operation)) {
      need('chain', operation.chain, `operation "${name}"`)
      if (operation.section) {
        need('section', operation.section, `operation "${name}"`)
        operationOfSection.set(operation.section, name)
      }
    }

    // ── sections ──
    const sections: { [id: string]: SectionView } = {}
    for (const [name, section] of bySeq(d.section)) {
      const response = need('response', section.response, `section "${name}"`)
      need('message', response.message, `response "${section.response}"`)
      const sectionAttempts = attemptsOfSection.get(name) ?? []
      const lastAttempt = sectionAttempts.at(-1)
      const lastAttemptView = lastAttempt ? attempts[id('attempt', lastAttempt)] : undefined
      const status: SectionStatus | null =
        section.status === undefined
          ? section.state === 'pending'
            ? { kind: 'responding', text: STATUS_TEXT.responding }
            : null
          : typeof section.status === 'string'
            ? { kind: section.status, text: STATUS_TEXT[section.status] }
            : section.status
      const directiveState: DirectiveState =
        section.directiveState ??
        (section.state === 'pending'
          ? DIRECTIVE_STATE_FOR_STATUS[status?.kind ?? 'responding']
          : section.state === 'streaming'
            ? 'running'
            : section.state === 'superseded'
              ? 'completed'
              : section.state)
      const notes = section.notes ?? []
      const started = directiveState === 'running' || directiveState === 'retrying' || directiveState === 'waiting-for-capacity'
      let superseded: SectionView['superseded'] = null
      if (section.state === 'superseded' || section.superseded) {
        const given = typeof section.superseded === 'object' && section.superseded !== null ? section.superseded : {}
        const finished = sectionAttempts.some((attempt) => d.attempt.get(attempt)?.state === 'completed')
        const by = given.by ? need('section', given.by, `section "${name}"`) : null
        superseded = {
          markText: given.mark ?? (finished ? WORDING.supersededFinished : WORDING.supersededPartial),
          replacementSectionId: given.by ? id('section', given.by) : null,
          replacementResponseId: by ? id('response', by.response) : null,
        }
      }
      if (section.replaces) need('section', section.replaces, `section "${name}"`)
      sections[id('section', name)] = {
        id: id('section', name),
        directiveId: id('directive', directiveOf(name)),
        responseId: id('response', section.response),
        messageId: id('message', response.message),
        kind: section.kind ?? 'answer',
        title: section.title ?? name,
        state: section.state,
        directiveState,
        placement: sectionPlaced(name) ? 'fixed' : 'pending',
        status,
        chainId: id('chain', section.chain),
        attemptIds: (listedAttempts.get(name) ?? []).map((attempt) => id('attempt', attempt)),
        failure:
          section.failure !== undefined
            ? section.failure
            : section.state === 'failed'
              ? (lastAttemptView?.failure ??
                providerError('provider-error', 'The provider returned an error', { httpStatus: 500 }))
              : null,
        superseded,
        replacesSectionId: section.replaces ? id('section', section.replaces) : null,
        notes,
        asksElicitationId: section.asks ? id('elicitation', section.asks) : null,
        operationId: id('operation', operationOfSection.get(name) ?? name),
        actions: {
          reply: section.state !== 'superseded' && section.state !== 'cancelled' && section.state !== 'pending',
          stop: section.state === 'streaming' || (section.state === 'pending' && started),
          retry:
            section.state === 'failed' ||
            section.state === 'stopped' ||
            section.state === 'interrupted' ||
            section.state === 'cancelled',
          regenerate: notes.some((note) => note.kind === 'superseded-input'),
          ...section.actions,
        },
      }
    }

    // ── responses ──
    const responses: { [id: string]: ResponseView } = {}
    const responsesOfMessage = new Map<string, string[]>()
    for (const [name, response] of bySeq(d.response)) {
      need('message', response.message, `response "${name}"`)
      responsesOfMessage.set(response.message, [...(responsesOfMessage.get(response.message) ?? []), name])
      const own = sectionsOfResponse.get(name) ?? []
      let ordered: string[]
      if (response.sectionOrder) {
        for (const section of response.sectionOrder) {
          if (!own.includes(section)) fail(`response "${name}" orders unknown section "${section}"`)
        }
        ordered = [...response.sectionOrder, ...own.filter((section) => !response.sectionOrder?.includes(section))]
      } else {
        const placed = own
          .filter(sectionPlaced)
          .sort((a, b) => (spec.placedSections.get(a) ?? 0) - (spec.placedSections.get(b) ?? 0))
        ordered = [...placed, ...own.filter((section) => !sectionPlaced(section))]
      }
      const counts: { -readonly [K in keyof SectionCounts]: number } = { done: 0, failed: 0, stopped: 0, interrupted: 0, cancelled: 0, inProgress: 0 }
      for (const section of own) {
        const state = d.section.get(section)?.state
        if (state === 'completed') counts.done++
        else if (state === 'failed') counts.failed++
        else if (state === 'stopped') counts.stopped++
        else if (state === 'interrupted') counts.interrupted++
        else if (state === 'cancelled') counts.cancelled++
        else if (state === 'pending' || state === 'streaming') counts.inProgress++
      }
      const grouped = response.grouped ?? false
      let routing: RoutingStatusView | null = null
      if (response.routing === 'routing') routing = { state: 'routing', text: WORDING.routing, failure: null }
      else if (response.routing === 'awaiting-target') {
        routing = { state: 'awaiting-target', text: WORDING.awaitingAnswer, failure: null }
      } else if (response.routing) {
        routing = {
          state: 'failed',
          text: `${WORDING.routingFailed}: ${response.routing.failed}`,
          failure: providerError(response.routing.code ?? 'provider-error', response.routing.failed),
        }
      }
      responses[id('response', name)] = {
        id: id('response', name),
        messageId: id('message', response.message),
        reason: response.reason ?? 'answer',
        grouped,
        placement: responsePlaced(name) ? 'fixed' : 'pending',
        routing,
        sectionIds: ordered.map((section) => id('section', section)),
        header:
          response.header === null || !grouped
            ? null
            : {
                counts,
                countText: response.header?.countText !== undefined ? response.header.countText : groupCountText(counts),
              },
      }
    }

    // ── decompositions ──
    let requirementCount = 0
    const decompositionOf = (
      original: string,
      originalText: string,
      given: DecompositionSpec,
      what: string,
    ): DecompositionView => ({
      originalMessageId: id('message', original),
      originalText,
      presentation: given.presentation ?? 'reply-group',
      barrier: given.barrier ?? null,
      model: given.model ?? 'anthropic/claude-haiku-5.5',
      fragments: given.fragments.map((fragment, index): FragmentView => {
        need('chain', fragment.chain, `${what} fragment "${fragment.label}"`)
        if (fragment.section) need('section', fragment.section, `${what} fragment "${fragment.label}"`)
        if (fragment.message) need('message', fragment.message, `${what} fragment "${fragment.label}"`)
        return {
          fragmentId: id('fragment', `${original}-${index + 1}`),
          index,
          kind: fragment.kind ?? 'work',
          label: fragment.label,
          sourceSpans: spansOf(originalText, fragment.source, `${what} fragment "${fragment.label}"`),
          rewrittenText: fragment.text,
          requirements: (fragment.requirements ?? []).map(
            (requirement): Requirement => ({
              id: id('requirement', `${original}-${++requirementCount}`),
              text: requirement.text,
              scope: requirement.scope ?? 'local',
              shared: requirement.shared ?? false,
              provenance: {
                messageId: id('message', original),
                span: spansOf(originalText, requirement.source, `${what} requirement "${requirement.text}"`)[0] ?? null,
              },
            }),
          ),
          directiveId: id('directive', fragment.directive),
          chainId: id('chain', fragment.chain),
          sectionId: fragment.section ? id('section', fragment.section) : null,
          messageId: fragment.message ? id('message', fragment.message) : null,
        }
      }),
    })

    // ── messages ──
    const messages: { [id: string]: MessageView } = {}
    const sectionTitle = (section: string): string => d.section.get(section)?.title ?? section
    let messageIndex = 0
    for (const [name, message] of bySeq(d.message)) {
      const own = responsesOfMessage.get(name) ?? []
      const ownSections = own.flatMap((response) => sectionsOfResponse.get(response) ?? [])
      const routingResponse = own.map((response) => d.response.get(response)?.routing).find(Boolean)
      const routing: MessageRoutingState =
        message.routing ??
        (routingResponse === undefined || routingResponse === null
          ? 'routed'
          : typeof routingResponse === 'string'
            ? routingResponse
            : 'failed')
      for (const chain of message.chains ?? []) need('chain', chain, `message "${name}"`)
      const chains = message.chains ?? uniq(ownSections.map((section) => d.section.get(section)?.chain ?? ''))
      const states = ownSections.map((section) => d.section.get(section)?.state)
      if (message.split) {
        if (!d.splitSet.has(message.split.original)) {
          fail(`message "${name}" is a split message of "${message.split.original}", which has no splitSet`)
        }
      }
      messages[id('message', name)] = {
        id: id('message', name),
        kind: message.split ? 'split' : 'original',
        text: message.text,
        submittedAt: message.at ?? BASE_TIME + messageIndex * 45_000,
        routing,
        chainIds: chains.filter(Boolean).map((chain) => id('chain', chain)),
        replyingTo: message.replyingTo
          ? {
              targets: message.replyingTo.sections.map((section) => {
                need('section', section, `message "${name}"`)
                return { sectionId: id('section', section), title: sectionTitle(section) }
              }),
              mode: message.replyingTo.mode ?? 'explicit',
              note: message.replyingTo.note ?? null,
            }
          : null,
        split: message.split
          ? {
              originalMessageId: id('message', message.split.original),
              index: message.split.index,
              count: message.split.count,
            }
          : null,
        decomposition: message.decomposition
          ? decompositionOf(name, message.decomposition.originalText ?? message.text, message.decomposition, `message "${name}"`)
          : null,
        responseIds: own.map((response) => id('response', response)),
        actions: {
          stop: states.some((state) => state === 'pending' || state === 'streaming'),
          retry:
            routing === 'failed' ||
            states.some(
              (state) => state === 'failed' || state === 'stopped' || state === 'interrupted' || state === 'cancelled',
            ),
          ...message.actions,
        },
      }
      messageIndex++
    }

    // ── split sets ──
    const splits: { [id: string]: SplitView } = {}
    for (const [original, split] of bySeq(d.splitSet)) {
      for (const message of split.messages) need('message', message, `split set "${original}"`)
      const originalText =
        split.decomposition.originalText ??
        d.message.get(original)?.text ??
        fail(`split set "${original}" needs decomposition.originalText`)
      splits[id('message', original)] = {
        originalMessageId: id('message', original),
        messageIds: split.messages.map((message) => id('message', message)),
        undoAvailable: split.undoAvailable ?? false,
        decomposition: decompositionOf(
          original,
          originalText,
          { presentation: 'split-messages', ...split.decomposition },
          `split set "${original}"`,
        ),
      }
    }

    // ── transcript order ──
    let order: TranscriptItemRef[]
    if (spec.order) {
      order = spec.order.map((entry): TranscriptItemRef => {
        const [prefix, rest] = entry.includes(':') ? [entry.slice(0, 1), entry.slice(2)] : [null, entry]
        const isMessage = d.message.has(rest)
        const isResponse = d.response.has(rest)
        if (prefix === 'm' || (prefix === null && isMessage && !isResponse)) {
          need('message', rest, 'order')
          return { kind: 'message', id: id('message', rest) }
        }
        if (prefix === 'r' || (prefix === null && isResponse && !isMessage)) {
          need('response', rest, 'order')
          return { kind: 'response', id: id('response', rest) }
        }
        return fail(
          isMessage ? `order entry "${entry}" names both a message and a response; prefix it with m: or r:` : `order refers to unknown item "${entry}"`,
        )
      })
    } else {
      const fixed = items
        .filter((item) => spec.fixedItems.has(item.key))
        .sort((a, b) => (spec.fixedItems.get(a.key) ?? 0) - (spec.fixedItems.get(b.key) ?? 0))
      const pending = items.filter((item) => !spec.fixedItems.has(item.key))
      order = [...fixed, ...pending].map((item) =>
        item.kind === 'message'
          ? { kind: 'message', id: id('message', item.name) }
          : { kind: 'response', id: id('response', item.name) },
      )
    }

    // ── genealogy ──
    const nodeStateFromSection = (directive: string): NodeState => {
      const section = currentSectionOf(directive)
      const view = section ? sections[id('section', section)] : undefined
      if (!view) return 'pending'
      if (view.state === 'streaming') return 'running'
      if (view.state === 'pending') return view.directiveState === 'running' ? 'running' : 'pending'
      return view.state
    }
    const replacedBy = new Map<string, string>()
    for (const [name, node] of bySeq(d.node)) {
      if (node.replaces) {
        needNode(node.replaces, `node "${name}"`)
        replacedBy.set(node.replaces, name)
      }
    }
    const nodes: { [id: string]: NodeView } = {}
    const nodeOrder: { seq: number; nodeId: NodeId; chain: string }[] = []
    const nodeLabel = (name: string): string => {
      const node = d.node.get(name)
      if (!node) return name
      const section = node.section ?? currentSectionOf(node.directive)
      return node.label ?? (section ? sectionTitle(section) : node.directive)
    }
    for (const [name, node] of bySeq(d.node)) {
      const sectionName = node.section === undefined ? currentSectionOf(node.directive) : node.section
      if (sectionName) need('section', sectionName, `node "${name}"`)
      if (node.group) need('group', node.group, `node "${name}"`)
      const section = sectionName ? sections[id('section', sectionName)] : undefined
      const view: ExchangeNodeView = {
        kind: 'exchange',
        id: id('node', name),
        chainId: id('chain', node.chain),
        directiveId: id('directive', node.directive),
        label: nodeLabel(name),
        parents: (node.parents ?? []).map((parent) => needNode(parent, `node "${name}"`)),
        parentsExact: node.parentsExact ?? true,
        state: node.state ?? (replacedBy.has(name) ? 'superseded' : nodeStateFromSection(node.directive)),
        reason: node.reason ?? 'initial',
        groupId: node.group ? id('siblingGroup', node.group) : null,
        replacesNodeId: node.replaces ? id('node', node.replaces) : null,
        replacedByNodeId: replacedBy.has(name) ? id('node', replacedBy.get(name) ?? '') : null,
        messageId: section?.messageId ?? id('message', node.directive),
        sectionId: section?.id ?? null,
        attemptIds: Object.values(attempts)
          .filter((attempt) => attempt.nodeId === id('node', name))
          .map((attempt) => attempt.id),
      }
      if (!section && !d.message.has(node.directive)) {
        fail(`node "${name}" has no section for directive "${node.directive}" to take its message from`)
      }
      nodes[view.id] = view
      nodeOrder.push({ seq: node.seq, nodeId: view.id, chain: node.chain })
    }
    const groups: { [id: string]: SiblingGroupView } = {}
    const joinBackOfGroup = new Map<string, string>()
    for (const [name, joinBack] of bySeq(d.joinBack)) {
      need('group', joinBack.group, `join-back "${name}"`)
      if (!joinBack.replacedBy) joinBackOfGroup.set(joinBack.group, name)
    }
    for (const [name, group] of bySeq(d.group)) {
      need('chain', group.base, `group "${name}"`)
      needNode(group.start, `group "${name}"`)
      groups[id('siblingGroup', name)] = {
        id: id('siblingGroup', name),
        startNodeId: id('node', group.start),
        baseChainId: id('chain', group.base),
        memberNodeIds: group.members.map((member) => needNode(member, `group "${name}"`)),
        withdrawnNodeIds: (group.withdrawn ?? []).map((member) => needNode(member, `group "${name}"`)),
        state: group.state ?? (joinBackOfGroup.has(name) ? 'closed' : 'open'),
        joinBackNodeId: joinBackOfGroup.has(name) ? id('node', joinBackOfGroup.get(name) ?? '') : null,
      }
    }
    for (const [name, joinBack] of bySeq(d.joinBack)) {
      const group = need('group', joinBack.group, `join-back "${name}"`)
      const given = joinBack.members ?? group.members.filter((member) => !(group.withdrawn ?? []).includes(member))
      const members = given.map((entry) => {
        const memberName = typeof entry === 'string' ? entry : entry.node
        const node = need('node', memberName, `join-back "${name}"`)
        const memberView = nodes[id('node', memberName)]
        const state = memberView?.kind === 'exchange' ? memberView.state : undefined
        const outcome: JoinBackMember['outcome'] =
          typeof entry === 'object'
            ? entry.outcome
            : state === 'failed' || state === 'stopped' || state === 'interrupted' || state === 'cancelled'
              ? state
              : 'completed'
        const completedAttempt = (attemptsOfDirective.get(node.directive) ?? [])
          .filter((attempt) => d.attempt.get(attempt)?.state === 'completed')
          .at(-1)
        return {
          directiveId: id('directive', node.directive),
          nodeId: id('node', memberName),
          outcome,
          attemptId: outcome === 'completed' && completedAttempt ? id('attempt', completedAttempt) : null,
          label: nodeLabel(memberName),
        }
      })
      const view: JoinBackNodeView = {
        kind: 'join-back',
        id: id('node', name),
        chainId: id('chain', group.base),
        joinBackId: id('joinBack', name),
        groupId: id('siblingGroup', joinBack.group),
        parents: members.map((member) => member.nodeId),
        members,
        lateRetryNodeIds: (joinBack.lateRetries ?? []).map((node) => needNode(node, `join-back "${name}"`)),
        replacedByNodeId: joinBack.replacedBy ? needNode(joinBack.replacedBy, `join-back "${name}"`) : null,
      }
      nodes[view.id] = view
      nodeOrder.push({ seq: joinBack.seq, nodeId: view.id, chain: group.base })
    }
    nodeOrder.sort((a, b) => a.seq - b.seq)
    const chainViews: { [id: string]: ChainView } = {}
    const chainAssociations: { [id: string]: ChainAssociation } = {}
    for (const [name, chain] of bySeq(d.chain)) {
      if (chain.base) need('chain', chain.base, `chain "${name}"`)
      const chainId: ChainId = id('chain', name)
      const kind = chain.kind ?? 'root'
      const label = chain.label ?? name
      chainViews[chainId] = {
        id: chainId,
        kind,
        colorIndex: colorIndexOf(name),
        label,
        baseChainId: chain.base ? id('chain', chain.base) : null,
        nodeIds: nodeOrder.filter((node) => node.chain === name).map((node) => node.nodeId),
      }
      const focus = d.focus.get(name)
      for (const message of focus?.inherited.messages ?? []) need('message', message, `focus "${name}"`)
      for (const section of focus?.inherited.sections ?? []) need('section', section, `focus "${name}"`)
      chainAssociations[chainId] = {
        id: chainId,
        kind,
        colorIndex: colorIndexOf(name),
        label,
        focus: {
          own: {
            messageIds: Object.values(messages)
              .filter((message) => message.chainIds.includes(chainId))
              .map((message) => message.id),
            sectionIds: Object.values(sections)
              .filter((section) => section.chainId === chainId)
              .map((section) => section.id),
          },
          inherited: {
            messageIds: (focus?.inherited.messages ?? []).map((message): MessageId => id('message', message)),
            sectionIds: (focus?.inherited.sections ?? []).map((section): SectionId => id('section', section)),
          },
        },
      }
    }
    for (const name of d.focus.keys()) need('chain', name, 'focus')

    // ── queue ──
    const queueElicitations = [...spec.elicitations]
    const queueItems = bySeq(d.queueItem).map(([name, item]): QueueItemView => {
      need('message', item.message, `queue item "${name}"`)
      const section = currentSectionOf(item.directive)
      const label = item.label ?? (section ? sectionTitle(section) : item.directive)
      const waitingFor = (item.waitingFor ?? []).map((wait): WaitTargetView => {
        if (wait.group) need('group', wait.group, `queue item "${name}"`)
        const first = wait.directives[0] ?? fail(`queue item "${name}" waits for "${wait.label}" with no directive`)
        return {
          ref: wait.group
            ? { kind: 'sibling-group', groupId: id('siblingGroup', wait.group) }
            : { kind: 'directive', directiveId: id('directive', first) },
          label: wait.label,
          directiveIds: wait.directives.map((directive): DirectiveId => id('directive', directive)),
        }
      })
      let recovery: QueueItemView['recovery'] = null
      if (item.recovery) {
        need('section', item.recovery.retrySection, `queue item "${name}"`)
        const cause = {
          directiveId: id('directive', item.recovery.cause.directive),
          label: item.recovery.cause.label,
          outcome: item.recovery.cause.outcome,
        }
        const labels = recoveryLabels(cause.label, label)
        const elicitationId = id('elicitation', item.recovery.elicitation)
        recovery = {
          elicitationId,
          cause,
          retry: { label: labels.retry, sectionId: id('section', item.recovery.retrySection) },
          continueWithout: { label: labels.continueWithout },
          cancel: { label: labels.cancel },
        }
        if (!queueElicitations.some((view) => view.id === elicitationId)) {
          queueElicitations.push({ kind: 'recovery-choice', id: elicitationId, queueItemId: id('queueItem', name) })
        }
      }
      const revised = item.revised ?? false
      return {
        id: id('queueItem', name),
        directiveId: id('directive', item.directive),
        messageId: id('message', item.message),
        label,
        state: item.state,
        revised,
        heldByBarrier: item.heldByBarrier ?? false,
        waitingFor,
        text:
          item.text ??
          (item.state === 'paused' && recovery
            ? pausedText(recovery.cause)
            : waitingText(
                waitingFor.map((wait) => wait.label),
                revised,
              )),
        recovery,
      }
    })

    // ── operation graph ──
    const operations: { [id: string]: OperationView } = {}
    const operationNames = bySeq(d.operation)
    const depthOf = (name: string, seen: readonly string[]): number => {
      const operation = d.operation.get(name)
      if (!operation) return 0
      if (seen.includes(name)) return fail(`operation "${name}" is part of a dependency cycle`)
      const active = (operation.dependsOn ?? []).filter((dependency) => !d.operation.get(dependency)?.retired)
      return active.length === 0 ? 0 : 1 + Math.max(...active.map((dependency) => depthOf(dependency, [...seen, name])))
    }
    for (const [name, operation] of operationNames) {
      const refs = (names: string[] | undefined): OperationId[] =>
        (names ?? []).map((other) => {
          need('operation', other, `operation "${name}"`)
          return id('operation', other)
        })
      const section = operation.section ? sections[id('section', operation.section)] : undefined
      const directive = operation.section ? directiveOf(operation.section) : null
      const directiveAttempts = directive ? (attemptsOfDirective.get(directive) ?? []) : []
      if (operation.group) need('group', operation.group, `operation "${name}"`)
      if (operation.joinBack) need('joinBack', operation.joinBack, `operation "${name}"`)
      const lastAttempt = directiveAttempts.at(-1)
      operations[id('operation', name)] = {
        id: id('operation', name),
        kind: operation.kind ?? (operation.group ? 'join-back' : 'answer'),
        label: operation.label ?? section?.title ?? name,
        chainId: id('chain', operation.chain),
        status: operation.status,
        statusText: operation.statusText ?? OPERATION_STATUS_TEXT[operation.status],
        dependsOn: refs(operation.dependsOn),
        waitingFor: refs(operation.waitingFor),
        heldByBarrier: operation.heldByBarrier ?? false,
        barrierWaitingFor: refs(operation.barrierWaitingFor),
        depth: operation.retired ? 0 : depthOf(name, []),
        directiveId: section?.directiveId ?? null,
        sectionId: section?.id ?? null,
        messageId: section?.messageId ?? null,
        attemptId: lastAttempt ? (id('attempt', lastAttempt) as AttemptId) : null,
        attemptCount: directiveAttempts.length,
        groupId: operation.group ? id('siblingGroup', operation.group) : null,
        joinBackId: operation.joinBack ? id('joinBack', operation.joinBack) : null,
        retired: operation.retired ?? false,
      }
    }

    const snapshot: ConversationSnapshot = {
      conversationId: id('conversation', spec.name),
      throughSeq: 0,
      transcript: { order, messages, responses, sections, attempts, chains: chainAssociations, splits },
      queue: { items: queueItems, elicitations: queueElicitations },
      genealogy: {
        chains: chainViews,
        chainIds: chainNames.map((name) => id('chain', name)),
        nodes,
        nodeIds: nodeOrder.map((node) => node.nodeId),
        groups,
      },
      operationGraph: {
        operations,
        active: operationNames.filter(([, operation]) => !operation.retired).map(([name]) => id('operation', name)),
        retired: operationNames.filter(([, operation]) => operation.retired).map(([name]) => id('operation', name)),
      },
    }
    SPECS.set(snapshot, cloneSpec(spec))
    return snapshot
  }
}

function cloneSpec(spec: Spec): Spec {
  const declared = {} as Spec['declared']
  for (const kind of Object.keys(spec.declared) as RecordKind[]) {
    const copy = new Map<string, unknown>()
    for (const [name, record] of spec.declared[kind]) copy.set(name, { ...record })
    ;(declared as Record<RecordKind, Map<string, unknown>>)[kind] = copy
  }
  return {
    ...spec,
    declared,
    elicitations: [...spec.elicitations],
    order: spec.order ? [...spec.order] : null,
    fixedItems: new Map(spec.fixedItems),
    placedSections: new Map(spec.placedSections),
  }
}

export const fx = {
  /** `fx.id('section', 'A')` is `sec_A`. */
  id,

  /** A builder for a new conversation. Its ID is `cnv_<name>`. */
  conversation(name = 'fixture'): ConversationBuilder {
    return new ConversationBuilder(emptySpec(name))
  },

  /** A builder continuing from a snapshot that a builder produced, for steps. The snapshot is not modified. */
  from(snapshot: ConversationSnapshot): ConversationBuilder {
    const spec = SPECS.get(snapshot)
    if (!spec) {
      throw new Error('fx.from() needs a snapshot produced by a fixture builder (fx.conversation()…build())')
    }
    return new ConversationBuilder(cloneSpec(spec))
  },

  /** A provider failure, with its class filled in from the code. */
  error(code: ProviderErrorCode, message: string, httpStatus: number | null = null): ProviderError {
    return providerError(code, message, { httpStatus })
  },

  /** Section notes in the fixed wording. */
  note: {
    /** "Based on superseded {label}", for work that read `directive`'s replaced result. */
    supersededInput(label: string, directive: string): SectionNote {
      return {
        kind: 'superseded-input',
        text: supersededInputText([label]),
        inputs: [{ kind: 'result', directiveId: id('directive', directive), label, consumedAttemptId: null }],
      }
    },
    /** "Redid {label} by default". */
    redoneByDefault(label: string, elicitation: string): SectionNote {
      return { kind: 'redone-by-default', text: redoneByDefaultText(label), elicitationId: id('elicitation', elicitation) }
    },
    contextNearLimit(inputTokens: number, tokenLimit: number): SectionNote {
      const percent = Math.round((inputTokens / tokenLimit) * 100)
      return {
        kind: 'context-near-limit',
        text: `This chain is at ${percent}% of the model's context limit`,
        inputTokens,
        tokenLimit,
      }
    },
  },
}

/**
 * The same snapshot at another sequence number, still continuable with
 * `fx.from()`. The fixture backend uses it to number the frames it emits.
 */
export function withThroughSeq(snapshot: ConversationSnapshot, throughSeq: number): ConversationSnapshot {
  const next = { ...snapshot, throughSeq }
  const spec = SPECS.get(snapshot)
  if (spec) SPECS.set(next, spec)
  return next
}

/** True when `fx.from()` can continue from this snapshot. */
export function isBuilt(snapshot: ConversationSnapshot): boolean {
  return SPECS.has(snapshot)
}

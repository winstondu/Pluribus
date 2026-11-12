import {
  LOG_EXPORT_MEDIA_TYPE,
  LOG_EXPORT_SCHEMA,
  LOG_EXPORT_VERSION,
  logExportFilename,
  type AppEvent,
  type AttemptId,
  type ConversationEvent,
  type ConversationSnapshot,
  type ConversationSummary,
  type DirectiveId,
  type ElicitationId,
  type EventRef,
  type LogExportDocument,
  type LogExportFile,
  type LogExportRun,
  type MessageId,
  type RoutingDecisionIndexEntry,
  type RunInspection,
  type Settings,
} from '@pluribus/protocol'

/**
 * Builds the full log export of one conversation (protocol `log-export.ts`).
 * Pure: the backend gathers the inputs from its stores and state, this
 * turns them into the serialized document.
 */

export interface LogExportInput {
  readonly conversation: ConversationSummary
  readonly createdAt: number
  readonly versions: LogExportDocument['versions']
  readonly settings: Settings
  readonly keyConfigured: boolean
  /** The whole app log; only what concerns this conversation is kept. */
  readonly appEvents: readonly AppEvent[]
  /** The conversation's complete log, in sequence order. */
  readonly events: readonly ConversationEvent[]
  readonly projections: ConversationSnapshot
  /** Run inspections, in directive creation order. */
  readonly runs: readonly RunInspection[]
  /**
   * Strings that must never appear in the export: the stored OpenRouter key.
   * When one does, the export fails with {@link LogExportLeakError} rather
   * than emit it.
   */
  readonly secrets: readonly string[]
}

/** Thrown when the serialized export contains a secret. The message never contains the secret. */
export class LogExportLeakError extends Error {
  constructor() {
    super('The export was not produced: it contained the stored OpenRouter key. Nothing was written.')
    this.name = 'LogExportLeakError'
  }
}

/** Secrets shorter than this are not searched for: a short string would match ordinary text. */
export const MIN_GUARDED_SECRET_LENGTH = 8

const CHUNK_TARGET = 256 * 1024

const DERIVED_NOTE =
  'Derived from "events" for convenience; the events are the source of truth. ' +
  'Event refs give "seq": the event is events[seq - 1]. Run inputs\' messages are on the attempt-started event at "inputMessagesAt".'

const TERMINAL_ATTEMPT_TYPES: ReadonlySet<string> = new Set(['attempt-completed', 'attempt-failed', 'attempt-stopped', 'attempt-interrupted'])

/** Keys put first in every object, in this order; the rest follow sorted. */
const LEADING_KEYS = ['schema', 'version', 'id', 'log', 'seq', 'v', 'at', 'type', 'kind']
const LEADING_RANK = new Map(LEADING_KEYS.map((key, index) => [key, index]))

function compareKeys(a: string, b: string): number {
  const ra = LEADING_RANK.get(a)
  const rb = LEADING_RANK.get(b)
  if (ra !== undefined || rb !== undefined) return (ra ?? LEADING_KEYS.length) - (rb ?? LEADING_KEYS.length)
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * JSON text with a fixed key order: the leading keys, then the others
 * sorted by code unit. Same rules as `JSON.stringify` otherwise: undefined
 * members are left out, undefined in arrays and non-finite numbers are null.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'number':
      return Number.isFinite(value) ? String(value) : 'null'
    case 'boolean':
      return value ? 'true' : 'false'
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((item: unknown) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`
      const record = value as Record<string, unknown>
      const keys = Object.keys(record).filter((key) => record[key] !== undefined && typeof record[key] !== 'function').sort(compareKeys)
      return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
    }
    default:
      return 'null'
  }
}

// ───────────────────────────── derived views ─────────────────────────────

/** The app events that concern a conversation: its own, and every settings and key change. */
export function appEventsFor(conversationId: string, appEvents: readonly AppEvent[]): AppEvent[] {
  return appEvents.filter((event) => {
    switch (event.type) {
      case 'settings-changed':
      case 'key-status-changed':
        return true
      default:
        return 'conversationId' in event && event.conversationId === conversationId
    }
  })
}

const MESSAGE_KEYS = ['originalMessageId', 'messageId', 'revisionMessageId', 'answerMessageId'] as const
const WORK_KEYS = [
  'directiveId',
  'questionDirectiveId',
  'pausedDirectiveId',
  'attemptId',
  'elicitationId',
  'sectionId',
  'responseId',
  'queueItemId',
  'nodeId',
  'fragmentId',
] as const

/** The identifiers an event names, at the top level and in a nested record (`elicitation`, `resolution`, …). */
function idsOf(event: ConversationEvent, keys: readonly string[]): string[] {
  const found: string[] = []
  const visit = (record: Record<string, unknown>): void => {
    for (const key of keys) {
      const value = record[key]
      if (typeof value === 'string') found.push(value)
    }
  }
  const top = event as unknown as Record<string, unknown>
  visit(top)
  for (const value of Object.values(top)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) visit(value as Record<string, unknown>)
  }
  return found
}

interface IndexBuilder {
  readonly messageId: MessageId
  readonly submittedSeq: number
  readonly text: string
  routingInForce: EventRef | null
  readonly events: EventRef[]
  readonly directives: Map<DirectiveId, { directiveId: DirectiveId; label: string; attempts: AttemptIndex[] }>
  readonly elicitationIds: Set<ElicitationId>
}

interface AttemptIndex {
  readonly attemptId: AttemptId
  readonly number: number
  readonly model: string
  readonly startedSeq: number
  ended: EventRef | null
  outputChunks: number
}

/**
 * Per message, in submission order, every event about it or its work. An
 * event is attributed by the identifiers it names: a message ID first, then
 * the directive, attempt, elicitation, section, response or node it is
 * about, each of which was first seen on an event of a known message. Any
 * event type, including ones added later, is attributed this way.
 */
export function routingDecisionIndex(events: readonly ConversationEvent[]): RoutingDecisionIndexEntry[] {
  const entries = new Map<MessageId, IndexBuilder>()
  const owner = new Map<string, MessageId>()
  const attempts = new Map<string, { entry: IndexBuilder; attempt: AttemptIndex }>()

  const messageOf = (event: ConversationEvent): MessageId | undefined => {
    for (const id of idsOf(event, MESSAGE_KEYS)) {
      const found = owner.get(id)
      if (found) return found
    }
    for (const id of idsOf(event, WORK_KEYS)) {
      const found = owner.get(id)
      if (found) return found
    }
    return undefined
  }
  const claim = (event: ConversationEvent, messageId: MessageId): void => {
    for (const id of [...idsOf(event, MESSAGE_KEYS), ...idsOf(event, WORK_KEYS)]) if (!owner.has(id)) owner.set(id, messageId)
  }
  // First pass: who owns each identifier. Some events name work before the
  // event that ties it to its message (a node is created before its directive).
  for (const event of events) {
    if (event.type === 'message-submitted') owner.set(event.messageId, event.messageId)
    const messageId = messageOf(event)
    if (messageId) claim(event, messageId)
  }

  for (const event of events) {
    if (event.type === 'message-submitted') {
      entries.set(event.messageId, {
        messageId: event.messageId,
        submittedSeq: event.seq,
        text: event.text.slice(0, 120),
        routingInForce: null,
        events: [],
        directives: new Map(),
        elicitationIds: new Set(),
      })
    }
    const messageId = messageOf(event)
    const entry = messageId ? entries.get(messageId) : undefined
    if (!entry) continue

    const ref: EventRef = { seq: event.seq, type: event.type }
    switch (event.type) {
      case 'attempt-output': {
        const found = attempts.get(event.attemptId)
        if (found) found.attempt.outputChunks += 1
        continue
      }
      case 'routing-decided':
        entry.routingInForce = ref
        break
      case 'directive-created':
        entry.directives.set(event.directiveId, { directiveId: event.directiveId, label: event.label, attempts: [] })
        break
      case 'attempt-started': {
        const attempt: AttemptIndex = {
          attemptId: event.attemptId,
          number: event.number,
          model: event.model,
          startedSeq: event.seq,
          ended: null,
          outputChunks: 0,
        }
        entry.directives.get(event.directiveId)?.attempts.push(attempt)
        attempts.set(event.attemptId, { entry, attempt })
        break
      }
      case 'elicitation-raised':
        entry.elicitationIds.add(event.elicitation.elicitationId)
        break
      default:
        if (TERMINAL_ATTEMPT_TYPES.has(event.type) && 'attemptId' in event) {
          const found = attempts.get(event.attemptId)
          if (found && found.attempt.ended === null) found.attempt.ended = ref
        }
    }
    entry.events.push(ref)
  }

  return [...entries.values()].map((entry) => ({
    messageId: entry.messageId,
    submittedSeq: entry.submittedSeq,
    text: entry.text,
    routingInForce: entry.routingInForce,
    events: entry.events,
    directives: [...entry.directives.values()].map((directive) => ({
      directiveId: directive.directiveId,
      label: directive.label,
      attempts: directive.attempts.map((attempt) => ({ ...attempt })),
    })),
    elicitationIds: [...entry.elicitationIds],
  }))
}

/** A run inspection with its input's messages replaced by a pointer to the event that records them. */
export function exportRun(run: RunInspection, startedAt: ReadonlyMap<string, EventRef>): LogExportRun {
  if (!run.input) return { ...run, input: null }
  const { messages: _messages, ...input } = run.input
  const at = run.attemptId ? (startedAt.get(run.attemptId) ?? null) : null
  return { ...run, input: { ...input, inputMessagesAt: at } }
}

// ───────────────────────────── the document ─────────────────────────────

/** Collects text into chunks of about {@link CHUNK_TARGET} code units. */
class ChunkWriter {
  readonly chunks: string[] = []
  length = 0
  private buffer: string[] = []
  private buffered = 0

  write(text: string): void {
    this.buffer.push(text)
    this.buffered += text.length
    this.length += text.length
    if (this.buffered >= CHUNK_TARGET) this.flush()
  }

  flush(): void {
    if (this.buffered === 0) return
    this.chunks.push(this.buffer.join(''))
    this.buffer = []
    this.buffered = 0
  }
}

function writeArray(out: ChunkWriter, indent: string, items: readonly unknown[]): void {
  if (items.length === 0) {
    out.write('[]')
    return
  }
  out.write('[\n')
  items.forEach((item, index) => {
    out.write(`${indent}  ${canonicalJson(item)}${index < items.length - 1 ? ',' : ''}\n`)
  })
  out.write(`${indent}]`)
}

/**
 * The document as JSON text in chunks. Top-level members one per line, in
 * the order of {@link LogExportDocument}; arrays of events, runs and index
 * entries one element per line (compact, with fixed key order), so the file
 * reads in a text editor, greps by event type, and diffs line by line.
 */
export function serializeLogExport(document: LogExportDocument): ChunkWriter {
  const out = new ChunkWriter()
  out.write('{\n')
  const scalarMembers: readonly (keyof LogExportDocument)[] = [
    'schema',
    'version',
    'exportedAt',
    'exportedAtMs',
    'conversation',
    'versions',
    'settings',
    'keyConfigured',
  ]
  for (const key of scalarMembers) out.write(`  ${JSON.stringify(key)}: ${canonicalJson(document[key])},\n`)
  out.write('  "appEvents": ')
  writeArray(out, '  ', document.appEvents)
  out.write(',\n  "events": ')
  writeArray(out, '  ', document.events)
  const derived = document.derived
  out.write(',\n  "derived": {\n')
  out.write(`    "note": ${JSON.stringify(derived.note)},\n`)
  out.write(`    "throughSeq": ${String(derived.throughSeq)},\n`)
  out.write(`    "projections": ${canonicalJson(derived.projections)},\n`)
  out.write('    "runs": ')
  writeArray(out, '    ', derived.runs)
  out.write(',\n    "routingDecisions": ')
  writeArray(out, '    ', derived.routingDecisions)
  out.write('\n  }\n}\n')
  out.flush()
  return out
}

/** True when `secret` occurs in the text the chunks make, across chunk boundaries too. */
function containsAcross(chunks: readonly string[], secret: string): boolean {
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i] ?? ''
    if (chunk.includes(secret)) return true
    const next = chunks[i + 1]
    if (next !== undefined && (chunk.slice(-(secret.length - 1)) + next.slice(0, secret.length - 1)).includes(secret)) return true
  }
  return false
}

/** Builds and serializes the export. Throws {@link LogExportLeakError} when a secret would be in it. */
export function buildLogExport(input: LogExportInput): LogExportFile {
  const startedAt = new Map<string, EventRef>()
  for (const event of input.events) if (event.type === 'attempt-started') startedAt.set(event.attemptId, { seq: event.seq, type: event.type })
  const document: LogExportDocument = {
    schema: LOG_EXPORT_SCHEMA,
    version: LOG_EXPORT_VERSION,
    exportedAt: new Date(input.createdAt).toISOString(),
    exportedAtMs: input.createdAt,
    conversation: input.conversation,
    versions: input.versions,
    settings: input.settings,
    keyConfigured: input.keyConfigured,
    appEvents: appEventsFor(input.conversation.id, input.appEvents),
    events: input.events,
    derived: {
      note: DERIVED_NOTE,
      throughSeq: input.projections.throughSeq,
      projections: input.projections,
      runs: input.runs.map((run) => exportRun(run, startedAt)),
      routingDecisions: routingDecisionIndex(input.events),
    },
  }
  const out = serializeLogExport(document)
  for (const secret of input.secrets) {
    if (secret.length < MIN_GUARDED_SECRET_LENGTH) continue
    if (containsAcross(out.chunks, secret)) throw new LogExportLeakError()
  }
  return {
    schema: LOG_EXPORT_SCHEMA,
    version: LOG_EXPORT_VERSION,
    conversationId: input.conversation.id,
    createdAt: input.createdAt,
    filename: logExportFilename(input.conversation.id, input.createdAt),
    mediaType: LOG_EXPORT_MEDIA_TYPE,
    chunks: out.chunks,
    length: out.length,
    eventCount: input.events.length,
  }
}

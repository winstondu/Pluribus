import type { AttemptId, ChainId, MessageId, ResponseId, SectionId } from './ids'
import type {
  AttemptView,
  ById,
  ChainAssociation,
  ConversationSnapshot,
  GenealogyProjection,
  MessageView,
  OperationGraphProjection,
  QueueProjection,
  ResponseView,
  SectionView,
  SplitView,
  TranscriptItemRef,
} from './projections'

/**
 * Projection updates: how a conversation snapshot changes from one step to
 * the next. The backend computes them with {@link diffSnapshots}; the client
 * applies them with {@link applyPatches}. Neither side writes merge logic of
 * its own, and
 *
 *     applyPatches(before, diffSnapshots(before, after), after.throughSeq)
 *
 * always deep-equals `after`.
 *
 * The transcript is patched record by record, with streamed text as appends,
 * because it changes many times a second while answers stream. The queue,
 * the genealogy and the operation graph change only on state transitions and
 * are replaced whole.
 */
export type ProjectionPatch =
  | { readonly target: 'transcript.order'; readonly order: readonly TranscriptItemRef[] }
  /** `value: null` removes the record (a dropped bubble, split messages after Undo split). */
  | { readonly target: 'transcript.message'; readonly id: MessageId; readonly value: MessageView | null }
  | { readonly target: 'transcript.response'; readonly id: ResponseId; readonly value: ResponseView | null }
  | { readonly target: 'transcript.section'; readonly id: SectionId; readonly value: SectionView | null }
  | { readonly target: 'transcript.attempt'; readonly id: AttemptId; readonly value: AttemptView | null }
  /** Answer text appended to an attempt that is already in the snapshot. Nothing else about it changed. */
  | { readonly target: 'transcript.attempt-text'; readonly id: AttemptId; readonly append: string }
  | { readonly target: 'transcript.chain'; readonly id: ChainId; readonly value: ChainAssociation | null }
  /** Keyed by the original message's ID. */
  | { readonly target: 'transcript.split'; readonly id: MessageId; readonly value: SplitView | null }
  | { readonly target: 'queue'; readonly value: QueueProjection }
  | { readonly target: 'genealogy'; readonly value: GenealogyProjection }
  | { readonly target: 'operation-graph'; readonly value: OperationGraphProjection }

/**
 * Applies patches in order and returns the new snapshot. Pure: the input is
 * not modified, and records a patch does not touch keep their identity, so a
 * React client re-renders only what changed.
 *
 * @param throughSeq the sequence number the patches bring the snapshot to
 */
export function applyPatches(
  snapshot: ConversationSnapshot,
  patches: readonly ProjectionPatch[],
  throughSeq: number,
): ConversationSnapshot {
  let transcript = snapshot.transcript
  let queue = snapshot.queue
  let genealogy = snapshot.genealogy
  let operationGraph = snapshot.operationGraph

  for (const patch of patches) {
    switch (patch.target) {
      case 'transcript.order':
        transcript = { ...transcript, order: patch.order }
        break
      case 'transcript.message':
        transcript = { ...transcript, messages: put(transcript.messages, patch.id, patch.value) }
        break
      case 'transcript.response':
        transcript = { ...transcript, responses: put(transcript.responses, patch.id, patch.value) }
        break
      case 'transcript.section':
        transcript = { ...transcript, sections: put(transcript.sections, patch.id, patch.value) }
        break
      case 'transcript.attempt':
        transcript = { ...transcript, attempts: put(transcript.attempts, patch.id, patch.value) }
        break
      case 'transcript.attempt-text': {
        const attempt = transcript.attempts[patch.id]
        if (!attempt) {
          throw new Error(`Cannot append text to attempt ${patch.id}: it is not in the snapshot`)
        }
        transcript = {
          ...transcript,
          attempts: { ...transcript.attempts, [patch.id]: { ...attempt, text: attempt.text + patch.append } },
        }
        break
      }
      case 'transcript.chain':
        transcript = { ...transcript, chains: put(transcript.chains, patch.id, patch.value) }
        break
      case 'transcript.split':
        transcript = { ...transcript, splits: put(transcript.splits, patch.id, patch.value) }
        break
      case 'queue':
        queue = patch.value
        break
      case 'genealogy':
        genealogy = patch.value
        break
      case 'operation-graph':
        operationGraph = patch.value
        break
    }
  }

  return { conversationId: snapshot.conversationId, throughSeq, transcript, queue, genealogy, operationGraph }
}

/**
 * The patches that turn `before` into `after`. Pure. Records that are the
 * same object in both are skipped without a deep comparison, so a backend
 * that updates its projections with structural sharing pays only for what
 * changed.
 */
export function diffSnapshots(before: ConversationSnapshot, after: ConversationSnapshot): ProjectionPatch[] {
  const patches: ProjectionPatch[] = []
  const a = before.transcript
  const b = after.transcript

  // Records first, order last: an applied order never names a record that is not there yet.
  diffRecords(a.chains, b.chains, (id, value) => {
    patches.push({ target: 'transcript.chain', id: id as ChainId, value })
  })
  diffRecords(a.messages, b.messages, (id, value) => {
    patches.push({ target: 'transcript.message', id: id as MessageId, value })
  })
  diffRecords(a.splits, b.splits, (id, value) => {
    patches.push({ target: 'transcript.split', id: id as MessageId, value })
  })
  diffRecords(a.responses, b.responses, (id, value) => {
    patches.push({ target: 'transcript.response', id: id as ResponseId, value })
  })
  diffRecords(a.sections, b.sections, (id, value) => {
    patches.push({ target: 'transcript.section', id: id as SectionId, value })
  })
  diffRecords(a.attempts, b.attempts, (id, value) => {
    const previous = a.attempts[id]
    if (previous && value && isTextAppend(previous, value)) {
      patches.push({
        target: 'transcript.attempt-text',
        id: id as AttemptId,
        append: value.text.slice(previous.text.length),
      })
    } else {
      patches.push({ target: 'transcript.attempt', id: id as AttemptId, value })
    }
  })
  if (a.order !== b.order && !deepEqual(a.order, b.order)) {
    patches.push({ target: 'transcript.order', order: b.order })
  }

  if (before.queue !== after.queue && !deepEqual(before.queue, after.queue)) {
    patches.push({ target: 'queue', value: after.queue })
  }
  if (before.genealogy !== after.genealogy && !deepEqual(before.genealogy, after.genealogy)) {
    patches.push({ target: 'genealogy', value: after.genealogy })
  }
  if (before.operationGraph !== after.operationGraph && !deepEqual(before.operationGraph, after.operationGraph)) {
    patches.push({ target: 'operation-graph', value: after.operationGraph })
  }
  return patches
}

/** Structural equality for the JSON data projections are made of. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const aIsArray = Array.isArray(a)
  if (aIsArray !== Array.isArray(b)) return false
  if (aIsArray) {
    const left = a as readonly unknown[]
    const right = b as readonly unknown[]
    if (left.length !== right.length) return false
    for (let i = 0; i < left.length; i++) {
      if (!deepEqual(left[i], right[i])) return false
    }
    return true
  }
  const left = a as { readonly [key: string]: unknown }
  const right = b as { readonly [key: string]: unknown }
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  for (const key of keys) {
    if (!Object.hasOwn(right, key)) return false
    if (!deepEqual(left[key], right[key])) return false
  }
  return true
}

function put<T>(records: ById<T>, id: string, value: T | null): ById<T> {
  if (value === null) {
    if (!Object.hasOwn(records, id)) return records
    const next: { [id: string]: T } = { ...records }
    delete next[id]
    return next
  }
  return { ...records, [id]: value }
}

function diffRecords<T>(before: ById<T>, after: ById<T>, emit: (id: string, value: T | null) => void): void {
  if (before === after) return
  for (const id of Object.keys(after)) {
    const next = after[id]
    if (next === undefined) continue
    const previous = before[id]
    if (previous === next) continue
    if (previous !== undefined && deepEqual(previous, next)) continue
    emit(id, next)
  }
  for (const id of Object.keys(before)) {
    if (!Object.hasOwn(after, id)) emit(id, null)
  }
}

function isTextAppend(previous: AttemptView, next: AttemptView): boolean {
  if (next.text.length <= previous.text.length || !next.text.startsWith(previous.text)) return false
  const { text: _previousText, ...previousRest } = previous
  const { text: _nextText, ...nextRest } = next
  return deepEqual(previousRest, nextRest)
}

/** Narrowing helper for clients that keep the transcript in a store. */
export function isTranscriptPatch(
  patch: ProjectionPatch,
): patch is Exclude<ProjectionPatch, { readonly target: 'queue' | 'genealogy' | 'operation-graph' }> {
  return patch.target.startsWith('transcript.')
}

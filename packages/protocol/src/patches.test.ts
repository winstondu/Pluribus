import { describe, expect, test } from 'vitest'
import { reconcileFrame } from './backend'
import { asId } from './ids'
import { applyPatches, deepEqual, diffSnapshots } from './patches'
import type { AttemptView, ConversationSnapshot, MessageView, ResponseView, SectionView } from './projections'
import { emptyConversationSnapshot } from './projections'

const conversationId = asId('conversation', 'cnv_TEST')
const messageId = asId('message', 'msg_A')
const responseId = asId('response', 'rsp_A')
const sectionId = asId('section', 'sec_A')
const attemptId = asId('attempt', 'att_A1')
const chainId = asId('chain', 'chn_A')

const message: MessageView = {
  id: messageId,
  kind: 'original',
  text: 'Suggest neighborhoods to stay in.',
  submittedAt: 1,
  routing: 'routed',
  chainIds: [chainId],
  replyingTo: null,
  split: null,
  decomposition: null,
  responseIds: [responseId],
  actions: { stop: true, retry: false },
}

const response: ResponseView = {
  id: responseId,
  messageId,
  reason: 'answer',
  grouped: false,
  placement: 'pending',
  routing: null,
  sectionIds: [sectionId],
  header: null,
}

const section: SectionView = {
  id: sectionId,
  directiveId: asId('directive', 'dir_A'),
  responseId,
  messageId,
  kind: 'answer',
  title: 'neighborhoods',
  state: 'pending',
  directiveState: 'running',
  placement: 'pending',
  status: { kind: 'responding', text: 'Responding…' },
  chainId,
  attemptIds: [],
  failure: null,
  superseded: null,
  replacesSectionId: null,
  notes: [],
  asksElicitationId: null,
  operationId: asId('operation', 'opr_A'),
  actions: { reply: true, stop: true, retry: false, regenerate: false },
}

const attempt: AttemptView = {
  id: attemptId,
  sectionId,
  directiveId: section.directiveId,
  number: 1,
  origin: 'initial',
  state: 'streaming',
  resultStatus: 'in-flight',
  text: 'Gion',
  markText: null,
  collapsed: false,
  chainId,
  nodeId: asId('node', 'nod_A'),
  model: 'test/model',
  startedAt: 2,
  endedAt: null,
  failure: null,
}

function pending(): ConversationSnapshot {
  const empty = emptyConversationSnapshot(conversationId)
  return {
    ...empty,
    throughSeq: 4,
    transcript: {
      ...empty.transcript,
      order: [
        { kind: 'message', id: messageId },
        { kind: 'response', id: responseId },
      ],
      messages: { [messageId]: message },
      responses: { [responseId]: response },
      sections: { [sectionId]: section },
    },
  }
}

function streaming(text: string): ConversationSnapshot {
  const before = pending()
  return {
    ...before,
    throughSeq: 6,
    transcript: {
      ...before.transcript,
      responses: { [responseId]: { ...response, placement: 'fixed' } },
      sections: {
        [sectionId]: { ...section, state: 'streaming', placement: 'fixed', status: null, attemptIds: [attemptId] },
      },
      attempts: { [attemptId]: { ...attempt, text } },
    },
  }
}

describe('projection patches', () => {
  test('applying a diff reproduces the target snapshot', () => {
    const before = pending()
    const after = streaming('Gion')
    const patches = diffSnapshots(before, after)
    expect(applyPatches(before, patches, after.throughSeq)).toEqual(after)
  })

  test('streamed text travels as an append, not as the whole attempt', () => {
    const before = streaming('Gion')
    const after = { ...streaming('Gion and Higashiyama'), throughSeq: 7 }
    const patches = diffSnapshots(before, after)
    expect(patches).toEqual([{ target: 'transcript.attempt-text', id: attemptId, append: ' and Higashiyama' }])
    expect(applyPatches(before, patches, 7)).toEqual(after)
  })

  test('a state change on an attempt replaces the record even when text also grew', () => {
    const before = streaming('Gion')
    const done = streaming('Gion.')
    const after: ConversationSnapshot = {
      ...done,
      transcript: {
        ...done.transcript,
        attempts: { [attemptId]: { ...attempt, text: 'Gion.', state: 'completed', resultStatus: 'current', endedAt: 9 } },
      },
    }
    const patches = diffSnapshots(before, after)
    expect(patches.map((patch) => patch.target)).toEqual(['transcript.attempt'])
  })

  test('removed records are patched out and untouched records keep their identity', () => {
    const before = streaming('Gion')
    const after: ConversationSnapshot = {
      ...before,
      throughSeq: 8,
      transcript: { ...before.transcript, order: [{ kind: 'message', id: messageId }], responses: {}, sections: {}, attempts: {} },
    }
    const patches = diffSnapshots(before, after)
    const applied = applyPatches(before, patches, 8)
    expect(applied).toEqual(after)
    expect(applied.transcript.messages[messageId]).toBe(before.transcript.messages[messageId])
    expect(applied.genealogy).toBe(before.genealogy)
  })

  test('equal snapshots produce no patches, whatever their object identity', () => {
    expect(diffSnapshots(pending(), pending())).toEqual([])
  })

  test('whole projections are replaced when they change', () => {
    const before = pending()
    const after: ConversationSnapshot = {
      ...before,
      queue: { items: [], elicitations: [{ kind: 'recovery-choice', id: asId('elicitation', 'eli_1'), queueItemId: asId('queueItem', 'que_1') }] },
    }
    expect(diffSnapshots(before, after).map((patch) => patch.target)).toEqual(['queue'])
  })

  test('appending text to an unknown attempt is an error, not a silent no-op', () => {
    expect(() =>
      applyPatches(pending(), [{ target: 'transcript.attempt-text', id: attemptId, append: 'x' }], 5),
    ).toThrow(/not in the snapshot/)
  })

  test('deepEqual distinguishes arrays from objects and missing keys from null', () => {
    expect(deepEqual({ a: [1, 2] }, { a: [1, 2] })).toBe(true)
    expect(deepEqual({ a: null }, {})).toBe(false)
    expect(deepEqual([], {})).toBe(false)
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true)
  })
})

describe('reconcileFrame', () => {
  const before = pending()
  const after = streaming('Gion')
  const frame = {
    kind: 'conversation' as const,
    conversationId,
    fromSeq: 5,
    throughSeq: 6,
    events: [],
    patches: diffSnapshots(before, after),
  }

  test('applies a frame that directly follows the snapshot', () => {
    const result = reconcileFrame(before, frame)
    expect(result.status).toBe('applied')
    expect(result.snapshot).toEqual(after)
  })

  test('ignores a frame the snapshot already reflects', () => {
    const result = reconcileFrame(after, frame)
    expect(result.status).toBe('stale')
    expect(result.snapshot).toBe(after)
  })

  test('reports a gap when frames were missed', () => {
    expect(reconcileFrame(before, { ...frame, fromSeq: 7, throughSeq: 9 }).status).toBe('gap')
  })
})

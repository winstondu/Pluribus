import { describe, expect, expectTypeOf, test } from 'vitest'
import type { ConversationFrame, StreamedAttemptStarted } from './backend'
import { toStreamedEvent } from './backend'
import type {
  AttemptStarted,
  ConversationEvent,
  DirectiveCancelled,
  DirectiveStopped,
  MessageSubmitted,
  NodeReason,
  ResponseReason,
  RevisionRecorded,
  RevisionTargetState,
  SectionOpened,
  SessionRequirementRecorded,
  SettingsChanged,
  SiblingsWithdrawn,
  SplitUndone,
} from './events'
import { CONVERSATION_EVENT_TYPES } from './events'
import { asId } from './ids'
import type { ConsumedContext, ContextOrigin, FragmentRecord, JoinBackMember, SupersededInput, SupersessionCause } from './model'
import type {
  JoinBackNodeView,
  MessageView,
  OperationView,
  ResponseView,
  RunInspection,
  SiblingGroupView,
} from './projections'
import type { Settings } from './settings'

/**
 * Contracts settled by the first review of the protocol. Each test pins one
 * of them, so a later change that reopens the gap fails here.
 */

type Kind<U> = U extends { readonly kind: infer K } ? K : never

describe('choice with default', () => {
  test('a redo supersession does not claim to know whether the default ran, and a section opens without a note', () => {
    type Redo = Extract<SupersessionCause, { readonly kind: 'redo' }>
    expectTypeOf<keyof Redo>().toEqualTypeOf<'kind' | 'elicitationId'>()
    expectTypeOf<SectionOpened>().not.toHaveProperty('note')
  })
})

describe('stopping', () => {
  test('work stopped between retries has its own event, and a single not-started section can be cancelled by a stop', () => {
    expect(CONVERSATION_EVENT_TYPES).toContain('directive-stopped')
    expectTypeOf<DirectiveStopped['scope']>().toEqualTypeOf<'section' | 'request'>()
    expectTypeOf<DirectiveCancelled['cause']>().toEqualTypeOf<'request-stopped' | 'section-stopped' | 'recovery-cancel'>()
  })
})

describe('superseded inputs', () => {
  test('a corrected input and a replaced session requirement are distinguishable from a replaced result', () => {
    expectTypeOf<Kind<SupersededInput>>().toEqualTypeOf<'result' | 'correction' | 'session-requirement'>()
    expectTypeOf<ConsumedContext>().toHaveProperty('corrections')
    expectTypeOf<ConsumedContext>().toHaveProperty('sessionRequirementIds')
  })
})

describe('undo split', () => {
  test('withdrawn members leave their group by an event, never appear in a join-back record, and the split is restored by routing again', () => {
    expect(CONVERSATION_EVENT_TYPES).toContain('siblings-withdrawn')
    expectTypeOf<SiblingsWithdrawn['dissolved']>().toEqualTypeOf<boolean>()
    expectTypeOf<JoinBackMember['outcome']>().toEqualTypeOf<'completed' | 'failed' | 'stopped' | 'interrupted' | 'cancelled'>()
    expectTypeOf<SiblingGroupView['state']>().toEqualTypeOf<'open' | 'closed' | 'dissolved'>()
    expectTypeOf<SplitUndone>().not.toHaveProperty('restoredDirectiveId')
  })
})

describe('revisions', () => {
  test('a target may have ended without completing, may have no section, and the correction may be one fragment', () => {
    expectTypeOf<RevisionTargetState>().toEqualTypeOf<
      'not-started' | 'running-status-only' | 'running-with-text' | 'finished' | 'ended-unfinished'
    >()
    expectTypeOf<RevisionRecorded['targets'][number]['sectionId']>().toBeNullable()
    expectTypeOf<RevisionRecorded['fragmentId']>().toBeNullable()
    expectTypeOf<FragmentRecord['kind']>().toEqualTypeOf<'work' | 'revision'>()
  })

  test('a dependent restarted for a revised prerequisite has a node reason and a response reason', () => {
    expectTypeOf<'prerequisite-revised'>().toExtend<NodeReason>()
    expectTypeOf<'prerequisite-revised'>().toExtend<ResponseReason>()
  })

  test('a session-wide requirement can be replaced or withdrawn', () => {
    expectTypeOf<SessionRequirementRecorded['replacesRequirementId']>().toBeNullable()
    expect(CONVERSATION_EVENT_TYPES).toContain('session-requirement-withdrawn')
  })
})

describe('context origins', () => {
  test('a clarification question and its answer have origins of their own', () => {
    expectTypeOf<'clarification-question' | 'clarification-answer'>().toExtend<Kind<ContextOrigin>>()
  })
})

describe('routing status', () => {
  test('the pending status of an unrouted message is on its provisional response, not on the message', () => {
    expectTypeOf<MessageSubmitted>().toHaveProperty('responseId')
    expectTypeOf<ResponseView['routing']>().toBeNullable()
    expectTypeOf<MessageView>().not.toHaveProperty('routingFailure')
  })

  test('routing a failed message again is an event, so the log alone says which messages still wait for an outcome', () => {
    expect(CONVERSATION_EVENT_TYPES).toContain('routing-retried')
    expect(CONVERSATION_EVENT_TYPES).toHaveLength(47)
  })
})

describe('inspection', () => {
  test('a whole-request barrier hold is visible beside, not inside, the result dependencies', () => {
    expectTypeOf<OperationView>().toHaveProperty('heldByBarrier')
    expectTypeOf<OperationView>().toHaveProperty('barrierWaitingFor')
    expectTypeOf<RunInspection['barrier']>().toBeNullable()
  })

  test('a join-back names its late-retry tail', () => {
    expectTypeOf<JoinBackNodeView>().toHaveProperty('lateRetryNodeIds')
  })
})

describe('stored records have every key', () => {
  test('settings-changed stores the whole settings, not a patch of optional fields', () => {
    expectTypeOf<SettingsChanged['settings']>().toEqualTypeOf<Settings>()
  })
})

describe('stream', () => {
  const conversationId = asId('conversation', 'cnv_S')
  const started: AttemptStarted = {
    id: 'evt' as AttemptStarted['id'],
    log: conversationId,
    seq: 7,
    v: 1,
    at: 100,
    type: 'attempt-started',
    attemptId: asId('attempt', 'att_1'),
    directiveId: asId('directive', 'dir_1'),
    sectionId: asId('section', 'sec_1'),
    nodeId: asId('node', 'nod_1'),
    chainId: asId('chain', 'chn_1'),
    operationId: asId('operation', 'opr_1'),
    number: 1,
    origin: 'initial',
    modelRole: 'answer',
    model: 'some/model',
    parents: [],
    context: {
      messages: [{ role: 'user', content: 'a long input', origin: { kind: 'preamble' } }],
      nodeIds: [asId('node', 'nod_1')],
      inputs: [],
      corrections: [],
      sessionRequirementIds: [],
      inputTokens: 3,
      tokenLimit: null,
    },
  }

  test('a frame carries attempt-started without the model input', () => {
    const streamed = toStreamedEvent(started)
    expect(streamed.type).toBe('attempt-started')
    expect('messages' in (streamed as StreamedAttemptStarted).context).toBe(false)
    expect((streamed as StreamedAttemptStarted).context.nodeIds).toEqual(started.context.nodeIds)
    // The stored event is untouched: the log keeps the exact input (invariant 2).
    expect(started.context.messages).toHaveLength(1)
    expectTypeOf<ConversationFrame['events'][number]>().not.toEqualTypeOf<ConversationEvent>()
  })

  test('every other event is streamed as stored', () => {
    const output: ConversationEvent = {
      id: 'evt2' as AttemptStarted['id'],
      log: conversationId,
      seq: 8,
      v: 1,
      at: 101,
      type: 'attempt-output',
      attemptId: started.attemptId,
      index: 0,
      text: 'Hello',
    }
    expect(toStreamedEvent(output)).toBe(output)
  })
})

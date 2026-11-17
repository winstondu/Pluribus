import type { ConversationSnapshot } from '@pluribus/protocol'
import type { ConversationState } from '../state'
import { genealogyProjection } from './genealogy'
import { operationGraphProjection } from './operation-graph'
import { queueProjection } from './queue'
import { Projector } from './tracking'
import { transcriptProjection } from './transcript'

export { Projector, shareRecord, type Memo } from './tracking'
export { runInspection } from './run-inspection'
export { undoSplitAvailable, attemptResultStatus } from './transcript'

/**
 * The four projections of a conversation (10 · "What the client reads"),
 * computed by `projector`: incrementally when it memoizes, from scratch
 * when it does not.
 */
export function projectSnapshot(projector: Projector, state: ConversationState): ConversationSnapshot {
  const projections = projector.run(state, 'snapshot', (s, m) => ({
    transcript: m.get('transcript', '', transcriptProjection),
    queue: m.get('queue', '', queueProjection),
    genealogy: m.get('genealogy', '', genealogyProjection),
    operationGraph: m.get('operation-graph', '', operationGraphProjection),
    conversationId: s.conversationId,
  }))
  return {
    conversationId: projections.conversationId,
    throughSeq: state.throughSeq,
    transcript: projections.transcript,
    queue: projections.queue,
    genealogy: projections.genealogy,
    operationGraph: projections.operationGraph,
  }
}

/** The projections rebuilt from scratch, for tests and for checking the incremental ones. */
export function rebuildSnapshot(state: ConversationState): ConversationSnapshot {
  return projectSnapshot(new Projector({ memoize: false }), state)
}

import './debug.css'

/**
 * The debug views of 09: the chain mini-map, the run inspector and the
 * Compare decomposition inspector in the side panel, and the operation
 * graph in its drawer. The shell finds these two names by glob and shows
 * each region behind its debug toggle.
 */
export { DebugSidePanel } from './side-panel'
export { OperationGraphDrawer } from './operation-graph/operation-graph'
/** "Export full logs", in the header's debug menu. */
export { ExportLogsMenuItem } from './log-export/export-logs'
/** Compare as a card on the message, for the transcript (`debug.comparePlacement` is `inline`). */
export { CompareCard } from './compare/compare-card'
export { SourceMarks, useFragmentSelection } from './compare/compare-parts'

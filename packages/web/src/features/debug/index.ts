import './debug.css'

/**
 * The debug views of 09: the chain mini-map, the run inspector and the
 * Compare decomposition inspector in the side panel, and the operation
 * graph in its drawer. The shell finds these two names by glob and shows
 * each region behind its debug toggle.
 */
export { DebugSidePanel } from './side-panel'
export { OperationGraphDrawer } from './operation-graph/operation-graph'

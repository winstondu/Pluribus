import type { StrategyChoice } from '@committee/protocol'
import type { GenealogyShape, StrategySelection, StrategySelector } from '../../ports'

/**
 * The rule-based strategy selector: when each strategy and each tree-walk
 * switch pays, from what was measured (docs/build/dependency-decisioning.md
 * · "Evidence and the default", docs/build/dependency-decisioning.md · "Strategy selection").
 *
 * - **One pass** when every answer is listed in the pipeline's request.
 *   Inside the window the two strategies routed every corpus example the
 *   same; one pass does it in one request.
 * - **One pass** when the routing's token budget is under
 *   `FURTHER_REQUEST_ROOM`: the pipeline's request takes up to 5,400 tokens
 *   with its full window and one level of a walk about 600, so with less
 *   the walk could not descend. It asks only about the roots in the
 *   pipeline's request, and the answers below them, listed or not, would go
 *   unasked; one pass asks about every listed answer in that same request.
 * - **Tree walk** when answers are older than the window: only the walk
 *   reaches them.
 * - **Search long runs**: always. It is the only setting that found a
 *   referent the walk could not find before, and it changes nothing inside
 *   the window.
 * - **Start at the trunk base** when the longest trunk has `TRUNK_SKIP` or
 *   more listed answers before its last and ends where the line splits:
 *   each skipped answer saves about 23 tokens, a reply to one costs a
 *   further request of about 1,900, and a trunk that has split is history
 *   more often than it is the subject. A trunk that never splits is the
 *   conversation itself, where replies to earlier answers are the normal
 *   case: off.
 * - **Hop between branch points** when a run below a split has `HOP_SKIP`
 *   or more answers before its last: each skipped answer saves about 108
 *   tokens, a reply inside the run costs a further request and about 280.
 */
export const TRUNK_SKIP = 12
export const HOP_SKIP = 5
export const FURTHER_REQUEST_ROOM = 6_000

export function chooseByRules(shape: GenealogyShape, tokenBudget: number = Number.POSITIVE_INFINITY): { readonly choice: StrategyChoice; readonly reason: string } {
  if (shape.beyondWindow === 0) {
    return { choice: { strategy: 'one-pass' }, reason: 'Every answer is listed in the routing request, so one pass asks about all of them in that request.' }
  }
  if (tokenBudget < FURTHER_REQUEST_ROOM) {
    return {
      choice: { strategy: 'one-pass' },
      reason: `This routing may use ${Math.max(0, Math.floor(tokenBudget)).toLocaleString('en-US')} decision tokens, too few for a further request after the routing request, so a walk could not descend; one pass asks about every listed answer in that request.`,
    }
  }
  const trunk = shape.longestTrunk
  const startAtTrunkBase = trunk !== null && trunk.endsInSplit && trunk.listedBeforeEnd >= TRUNK_SKIP
  const run = shape.longestBranchRun
  const hopBetweenBranchPoints = run !== null && run.sections - 1 >= HOP_SKIP
  const switches = [
    startAtTrunkBase ? `starting at the trunk base (a trunk with ${trunk?.listedBeforeEnd ?? 0} listed answers before its split)` : null,
    hopBetweenBranchPoints ? `hopping between branch points (a run of ${run?.sections ?? 0} answers below a split)` : null,
  ].filter((text): text is string => text !== null)
  return {
    choice: { strategy: 'tree-walk', startAtTrunkBase, hopBetweenBranchPoints, searchLongRuns: true },
    reason: `${shape.beyondWindow} ${shape.beyondWindow === 1 ? 'answer is' : 'answers are'} older than the routing request lists, which only the tree walk reaches; long runs are searched${switches.length > 0 ? `, ${switches.join(' and ')}` : ''}.`,
  }
}

export const rulesSelector: StrategySelector = {
  name: 'rules',
  reusable: false,
  async select(request): Promise<StrategySelection> {
    return { selector: 'rules', ...chooseByRules(request.shape, request.tokenBudget), scores: null, fallback: null }
  },
}

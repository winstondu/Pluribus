import type { StrategyChoice } from '@pluribus/protocol'
import type { GenealogyShape, StrategySelection, StrategySelector } from '../../ports'

/**
 * The rule-based strategy selector: when each strategy and each tree-walk
 * switch pays, from what was measured.
 *
 * - **One pass** when every answer is listed in the pipeline's request.
 *   Inside the window the two strategies routed every corpus example the
 *   same; one pass does it in one request.
 * - **One pass** when the routing's token budget is under
 *   `FURTHER_REQUEST_ROOM`: the pipeline's request takes up to 5,400 tokens
 *   with its full window and one level of a walk about 600, so with less
 *   the walk could not descend. It asks only about the roots' runs and the
 *   first-pass sections in the pipeline's request, and the other answers
 *   below the first branch points, listed or not, would go unasked; one
 *   pass asks about every listed answer in that same request.
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
 * - **Hop between branch points** is not chosen, by these rules or by any
 *   selector. It places a unit on the last answer of a run it refers to, so
 *   the answer reads everything after the relevant part of the run: a
 *   trade between decision tokens and what an answer reads that the shape
 *   of the genealogy says nothing about. It is used as the user set it.
 *   (The rule that used to turn it on, a run of six or more answers below a
 *   split, was derived for the switch's earlier meaning, in which the
 *   answers skipped were still searched and the placement did not change.)
 */
export const TRUNK_SKIP = 12
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
  const switches = startAtTrunkBase ? `, starting at the trunk base (a trunk with ${trunk?.listedBeforeEnd ?? 0} listed answers before its split)` : ''
  return {
    choice: { strategy: 'tree-walk', startAtTrunkBase, searchLongRuns: true },
    reason: `${shape.beyondWindow} ${shape.beyondWindow === 1 ? 'answer is' : 'answers are'} older than the routing request lists, which only the tree walk reaches; long runs are searched${switches}.`,
  }
}

export const rulesSelector: StrategySelector = {
  name: 'rules',
  reusable: false,
  async select(request): Promise<StrategySelection> {
    return { selector: 'rules', ...chooseByRules(request.shape, request.tokenBudget), scores: null, fallback: null }
  },
}

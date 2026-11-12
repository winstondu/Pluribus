import { describe, expect, test } from 'vitest'
import { DEFAULT_SETTINGS, type CandidateSourceName, type Settings } from '@committee/protocol'
import { estimateRequestTokens } from '@committee/core'
import { corpusThroughMock, type MeasuredExample } from './openrouter/test-support/corpus-through-mock'
import { FITTED_CALIBRATION, calibratedTokens, toPortRequest } from './openrouter/test-support/decisions-api-mock'

/**
 * Hop between branch points on the routing corpus, with decisions as
 * labelled: what it saves and which placements it moves
 * (docs/build/dependency-decisioning.md · "Hop between branch points,
 * redefined"). Deterministic, over the tokenizer-counting Decisions mock.
 * The comparison is asserted, not the figures, which move with the guard's
 * estimate: the size of a part of a run is counted by it.
 */

const treeWalk = (hopBetweenBranchPoints: boolean, candidateSource: CandidateSourceName): Settings => ({
  ...DEFAULT_SETTINGS,
  routing: { ...DEFAULT_SETTINGS.routing, strategySelection: 'off', referentStrategy: 'tree-walk', candidateSource, treeWalk: { ...DEFAULT_SETTINGS.routing.treeWalk, hopBetweenBranchPoints } },
})

interface Totals {
  readonly passed: number
  readonly requests: number
  readonly questions: number
  readonly tokenizer: number
  readonly calibrated: number
  readonly estimate: number
}

function totals(examples: readonly MeasuredExample[]): Totals {
  const calls = examples.flatMap((e) => e.calls)
  const estimate = calls.reduce((s, c) => {
    const r = toPortRequest(c.body)
    return s + estimateRequestTokens(r.state, r.questions)
  }, 0)
  return {
    passed: examples.filter((e) => e.passed).length,
    requests: calls.length,
    questions: calls.reduce((s, c) => s + c.questionCount, 0),
    tokenizer: calls.reduce((s, c) => s + c.contentTokens, 0),
    calibrated: calls.reduce((s, c) => s + calibratedTokens(FITTED_CALIBRATION, c.questionCount, c.contentTokens), 0),
    estimate,
  }
}

const tokens = (e: MeasuredExample): number => e.calls.reduce((s, c) => s + c.contentTokens, 0)

describe('hop between branch points on the corpus, decisions as labelled', () => {
  // The corpus labels a reply to a section inside a run with that section ("not the end of the run"). With the switch on such
  // a reply goes to the run's last section, so these examples are not routed as labelled. Their labels are left as they are.
  // Without a candidate source the two in `deepRuns` are not reached with the switch off either (`below`).
  test.each([
    ['the lexical candidate source (the default)', 'lexical', ['long-chain-old-section', 'deep-run-middle-section', 'deep-run-other-branch']],
    ['no candidate source', 'none', ['long-chain-old-section']],
  ] as const)(
    'hop · with %s: the switch on never costs a routing more requests or tokens, and moves the replies to a section inside a run to the end of the run',
    { timeout: 240_000 },
    async (_name, source, moved) => {
      const off = await corpusThroughMock(treeWalk(false, source))
      const on = await corpusThroughMock(treeWalk(true, source))
      const changed = on.flatMap((e, i) => {
        const before = off[i]
        return before && (before.calls.length !== e.calls.length || tokens(before) !== tokens(e) || before.passed !== e.passed)
          ? [`${e.id}: ${before.passed ? '✓' : '✗'} ${before.calls.length} requests ${tokens(before)} tokens → ${e.passed ? '✓' : '✗'} ${e.calls.length} requests ${tokens(e)} tokens`]
          : []
      })
      console.log([`tree walk, ${source}: off ${JSON.stringify(totals(off))}`, `tree walk, ${source}: on  ${JSON.stringify(totals(on))}`, ...changed.map((line) => `  ${line}`)].join('\n'))
      // No routing costs more with the switch on.
      for (const [i, e] of on.entries()) {
        expect(e.calls.length, e.id).toBeLessThanOrEqual(off[i]?.calls.length ?? 0)
        expect(tokens(e), e.id).toBeLessThanOrEqual(tokens(off[i] as MeasuredExample))
      }
      expect(totals(on).tokenizer).toBeLessThan(totals(off).tokenizer)
      expect(totals(on).requests).toBeLessThan(totals(off).requests)
      const lost = on.filter((e, i) => !e.passed && off[i]?.passed).map((e) => e.id)
      expect(lost).toEqual(moved)
      expect(on.filter((e, i) => e.passed && !off[i]?.passed)).toEqual([])
    },
  )
})

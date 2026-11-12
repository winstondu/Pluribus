import { describe, expect, test } from 'vitest'
import { DEFAULT_SETTINGS, type CandidateSourceName, type Settings } from '@pluribus/protocol'
import { estimateRequestTokens } from '@pluribus/core'
import { ROUTING_CORPUS } from '@pluribus/core/testing'
import { corpusThroughMock, type MeasuredExample } from '../testing/openrouter/corpus-through-mock'
import { FITTED_CALIBRATION, calibratedTokens, toPortRequest } from '../testing/openrouter/decisions-api-mock'

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
  // With the switch on, a reply to a section inside a run goes to the run's last section. The corpus has a second set of
  // expectations for that (`CorpusExample.hop`): with the switch on every routing is scored against it, and the examples the
  // hop moves are routed as it says. Without a candidate source the two in `deepRuns` are not reached with the switch off
  // either (`below`), so only the long chain moves.
  const MOVED = { 'long-chain-old-section': 'E198', 'deep-run-middle-section': 'D5', 'deep-run-other-branch': 'H4' } as const
  test.each([
    ['the lexical candidate source (the default)', 'lexical', ['long-chain-old-section', 'deep-run-middle-section', 'deep-run-other-branch']],
    ['no candidate source', 'none', ['long-chain-old-section']],
  ] as const)(
    'hop · with %s: the switch on never costs a routing more requests or tokens, and moves the replies to a section inside a run to the end of the run, as the hop-on expectations say',
    { timeout: 240_000 },
    async (_name, source, moved) => {
      const off = await corpusThroughMock(treeWalk(false, source))
      const on = await corpusThroughMock(treeWalk(true, source))
      const changed = on.flatMap((e, i) => {
        const before = off[i]
        return before && (before.calls.length !== e.calls.length || tokens(before) !== tokens(e) || before.passed !== e.passed || e.runEnds.length > 0)
          ? [`${e.id}: ${before.passed ? '✓' : '✗'} ${before.calls.length} requests ${tokens(before)} tokens → ${e.passed ? '✓' : '✗'} ${e.calls.length} requests ${tokens(e)} tokens${e.runEnds.length > 0 ? `, run end ${e.runEnds.join(', ')}` : ''}`]
          : []
      })
      console.log([`tree walk, ${source}: off (default expectations) ${JSON.stringify(totals(off))}`, `tree walk, ${source}: on (hop-on expectations) ${JSON.stringify(totals(on))}`, ...changed.map((line) => `  ${line}`)].join('\n'))
      expect(off.every((e) => e.expectations === 'default')).toBe(true)
      expect(on.every((e) => e.expectations === 'hop')).toBe(true)
      // No routing costs more with the switch on.
      for (const [i, e] of on.entries()) {
        expect(e.calls.length, e.id).toBeLessThanOrEqual(off[i]?.calls.length ?? 0)
        expect(tokens(e), e.id).toBeLessThanOrEqual(tokens(off[i] as MeasuredExample))
      }
      expect(totals(on).tokenizer).toBeLessThan(totals(off).tokenizer)
      expect(totals(on).requests).toBeLessThan(totals(off).requests)
      // Each set of expectations is met by the same examples: the hop costs no example its expected placement.
      expect(on.map((e) => [e.id, e.passed])).toEqual(off.map((e) => [e.id, e.passed]))
      // The examples the hop moves: placed on the last section of their run, which is their hop-on expectation.
      const hopped = Object.fromEntries(on.filter((e) => e.runEnds.length > 0).map((e) => [e.id, e.runEnds]))
      expect(hopped).toEqual(Object.fromEntries(moved.map((id) => [id, [`sec_${MOVED[id]}`]])))
      for (const id of moved) {
        expect(on.find((e) => e.id === id)?.passed, id).toBe(true)
        const example = ROUTING_CORPUS.find((e) => e.id === id)
        expect(example?.hop?.parts, id).toEqual([{ kind: 'unit', targets: [MOVED[id]], placement: { continue: MOVED[id] } }])
      }
    },
  )
})

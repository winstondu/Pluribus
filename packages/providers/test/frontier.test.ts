import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DecisionProvider, DecisionQuestions, DecisionRequest, DecisionResult } from '@pluribus/core/ports'
import { NEVER_CANCELLED } from '@pluribus/core/ports'
import { DEFAULT_ARM, frontierCases, frontierOf, openReplayCache, paired, runArm, summarize, thresholdArm } from '../testing/frontier'

/** Answers every yes/no at `p`, and every choice with its first option. Counts the calls. */
function constant(p: number): DecisionProvider & { calls: () => number } {
  let calls = 0
  return {
    async decide<Q extends DecisionQuestions>(request: DecisionRequest<Q>): Promise<DecisionResult<Q>> {
      calls += 1
      const answers: { [id: string]: unknown } = {}
      for (const [id, q] of Object.entries(request.questions)) {
        if (q.type === 'choice') {
          const options = Object.keys(q.options)
          answers[id] = { type: 'choice', choice: options[0] ?? '', confidence: 0.9, probabilities: Object.fromEntries(options.map((o, i) => [o, i === 0 ? 0.9 : 0])) }
        } else answers[id] = { type: 'noul', probability: p }
      }
      return { ok: true, model: 'constant', answers: answers as never, usage: { inputTokens: 100, outputTokens: 1 } }
    },
    calls: () => calls,
  }
}

const dirs: string[] = []
const scratch = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'frontier-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const request: DecisionRequest<DecisionQuestions> = { model: 'm', state: 'S1. "a"', questions: { q: { type: 'noul', instructions: 'yes?' } } }

describe('referent frontier harness', () => {
  it('records a request once per replica and replays it, also after reopening', async () => {
    const dir = scratch()
    const live = constant(0.7)
    const provider = openReplayCache({ dir, replica: 0, live }).provider()
    await provider.decide(request, NEVER_CANCELLED)
    await provider.decide(request, NEVER_CANCELLED)
    expect(live.calls()).toBe(1)
    expect(provider.stats()).toEqual({ replayed: 1, recorded: 1, failed: 0 })
    // Another replica is another live answer.
    await openReplayCache({ dir, replica: 1, live }).provider().decide(request, NEVER_CANCELLED)
    expect(live.calls()).toBe(2)
    // Reopened with no live provider, the replica still answers.
    const again = await openReplayCache({ dir, replica: 0, live: null }).provider().decide(request, NEVER_CANCELLED)
    expect(again.ok).toBe(true)
    // No credential or header is in the file: only the key, the wire body and the result.
    const line = JSON.parse(readFileSync(path.join(dir, 'replica-0.jsonl'), 'utf8').trim()) as Record<string, unknown>
    expect(Object.keys(line).sort()).toEqual(['body', 'key', 'result'])
  })

  it('a threshold arm over a full replica sends nothing live and every arm sees the same answers', async () => {
    const dir = scratch()
    const cases = frontierCases(['routing']).slice(0, 12)
    const live = constant(0.6)
    const cache = openReplayCache({ dir, replica: 0, live })
    const first = await runArm(DEFAULT_ARM, cases, cache.provider())
    expect(first.replay.recorded).toBeGreaterThan(0)
    const replayOnly = openReplayCache({ dir, replica: 0, live: null }).provider()
    const again = await runArm(DEFAULT_ARM, cases, replayOnly)
    expect(again.replay).toEqual({ replayed: first.replay.recorded + first.replay.replayed, recorded: 0, failed: 0 })
    expect(again.cases.map((c) => c.passed)).toEqual(first.cases.map((c) => c.passed))
    // 0.6 is below the target-choice threshold and above 0.55: lowering the threshold changes outcomes, not requests.
    const lower = await runArm(thresholdArm('targetChoice', 0.55), cases, replayOnly)
    expect(lower.cases.every((c) => !c.failed)).toBe(true)
    const summaries = [summarize([again]), summarize([lower])]
    expect(summaries[0]?.passed.all?.total).toBe(12)
    expect(paired([lower], [again]).delta.min).toBe(summaries[1] && summaries[0] ? (summaries[1].passed.all?.mean ?? 0) - (summaries[0].passed.all?.mean ?? 0) : 0)
    expect(frontierOf(summaries).size).toBeGreaterThan(0)
  })

  it('splits the cases into the routing corpus and the two partitions, and long conversations from short', () => {
    const tune = frontierCases(['routing', 'conv-tune'])
    const heldOut = frontierCases(['conv-held-out'])
    expect(tune.some((c) => c.set === 'conv-held-out')).toBe(false)
    expect(heldOut.every((c) => c.set === 'conv-held-out')).toBe(true)
    expect(tune.filter((c) => c.size === 'long').every((c) => c.sections > 24)).toBe(true)
    expect(tune.some((c) => c.size === 'long')).toBe(true)
  })
})

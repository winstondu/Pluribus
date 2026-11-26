import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@pluribus/protocol'
import { createOpenRouterDecisionProvider } from '@pluribus/providers'
import {
  BUDGET_ARMS,
  DEFAULT_ARM,
  FLOOR_VALUES,
  HELD_OUT_ARMS,
  JOINT_ARMS,
  RECOMMENDED_ARM,
  STATED_AMBIGUITY_FLOOR,
  STRATEGY_ARMS,
  THRESHOLD_NAMES,
  THRESHOLD_VALUES,
  floorArm,
  floorIsSettable,
  formatArmTable,
  formatChanges,
  formatScaling,
  formatSweep,
  frontierCases,
  openReplayCache,
  passList,
  patchText,
  runArm,
  scalingCells,
  summarize,
  thresholdArm,
  type Arm,
  type ArmRun,
  type ArmSummary,
  type CaseSet,
} from '../../testing/frontier'

/**
 * The accuracy and spend frontier of the existing referent settings
 * (docs/build/referent-frontier.md). Skipped unless both OPENROUTER_KEY and
 * FRONTIER_CACHE_DIR are set; the key reaches the provider through `getKey`
 * only, and the cache directory must be outside the repository.
 *
 *   FRONTIER_CACHE_DIR=/tmp/…/frontier \
 *     pnpm vitest run --config packages/providers/testing/frontier/vitest.config.ts --reporter=verbose --silent=false
 *
 * Under that config the ambiguity floor is swept too; under `pnpm smoke` it
 * stays at 0.25 and its rows are left out.
 *
 * - FRONTIER_PHASE: `tune` (default) routes the routing corpus and the
 *   conversation corpus's `tune` partition; `held-out` routes the
 *   `held-out` partition under the default, the recommended arm and the
 *   tune-best arm (`HELD_OUT_ARMS`), and is to be run once, after the
 *   recommendation is fixed in `arms.ts`.
 * - FRONTIER_REPLICAS: live answers per request (default 3).
 * - FRONTIER_GROUPS: which parts to run, of
 *   `strategy,budget,threshold,floor,joint,scaling` (default all).
 *
 * Every request is answered from the replica's cache when it holds it, and
 * sent live and recorded when not: a rerun over a full cache sends nothing.
 * The tables are printed, and the summaries written to the cache directory.
 */

const key = process.env['OPENROUTER_KEY'] ?? ''
const getKey = async () => (key === '' ? null : key)
const dir = process.env['FRONTIER_CACHE_DIR'] ?? ''
const phase = process.env['FRONTIER_PHASE'] ?? 'tune'
const replicas = Number(process.env['FRONTIER_REPLICAS'] ?? 3)
const groups = new Set((process.env['FRONTIER_GROUPS'] ?? 'strategy,budget,threshold,floor,joint,scaling').split(',').map((g) => g.trim()))

function setup(sets: readonly CaseSet[]) {
  const live = createOpenRouterDecisionProvider({ getKey })
  const providers = Array.from({ length: replicas }, (_, replica) => openReplayCache({ dir, replica, live }).provider())
  const cases = frontierCases(sets)
  const runs = new Map<string, ArmRun[]>()
  const summaries = new Map<string, ArmSummary>()
  const run = async (arms: readonly Arm[]): Promise<ArmSummary[]> => {
    const out: ArmSummary[] = []
    for (const arm of arms) {
      // Replicas of one arm run side by side: they share the arm's floor and nothing else.
      const armRuns = await Promise.all(providers.map((provider, replica) => runArm(arm, cases, provider, { replica })))
      runs.set(arm.name, armRuns)
      const summary = summarize(armRuns)
      summaries.set(arm.name, summary)
      out.push(summary)
    }
    return out
  }
  return { cases, runs, summaries, run, providers }
}

function record(name: string, summaries: ReadonlyMap<string, ArmSummary>, runs: ReadonlyMap<string, readonly ArmRun[]>): void {
  const body = [...summaries.values()].map((s) => ({
    arm: s.arm.name,
    group: s.arm.group,
    patch: patchText(s.arm),
    passed: s.passed,
    spend: s.spend,
    recorded: s.recorded,
    failedRoutings: s.failedRoutings,
    budgetStops: s.budgetStops,
    misses: (runs.get(s.arm.name) ?? []).map((r) => ({ replica: r.replica, missed: r.cases.filter((c) => !c.passed).map((c) => c.id) })),
    perCase: (runs.get(s.arm.name) ?? []).map((r) => ({ replica: r.replica, cases: r.cases.map((c) => [c.id, c.passed ? 1 : 0, c.requests, c.questions, c.inputTokens]) })),
  }))
  writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(body, null, 1))
}

describe.skipIf(key === '' || dir === '')('referent frontier, live with a replay cache', () => {
  it.runIf(phase === 'tune')('maps accuracy against spend on the tune cases: routing corpus and conversation tune partition', { timeout: 7_200_000 }, async () => {
    const { cases, runs, summaries, run } = setup(['routing', 'conv-tune'])
    console.log(`tune cases: ${cases.length} (${cases.filter((c) => c.size === 'long').length} long), ${replicas} replicas, cache ${dir}`)
    const reference = DEFAULT_ARM.name

    if (groups.has('strategy') || groups.has('budget')) {
      const arms = [...(groups.has('strategy') ? STRATEGY_ARMS : [DEFAULT_ARM]), ...(groups.has('budget') ? BUDGET_ARMS : [])]
      const out = await run(arms)
      console.log(`\nstrategy and budget arms (F: on the frontier by all tune cases; L: by long-conversation spend; †: scored against the hop-on expectations)\n${formatArmTable(out, runs, reference)}`)
      console.log(`\ncases that changed sides against the default, any replica (+ passed only under the arm)\n${formatChanges(out, runs, reference)}`)
      for (const r of runs.get(reference) ?? []) console.log(`default, replica ${r.replica}: missed ${passList(r)}`)
    }

    if (groups.has('threshold') || groups.has('floor')) {
      if (!summaries.has(reference)) await run([DEFAULT_ARM])
      const rows: { name: string; cells: { value: number; summary: ArmSummary }[]; stated: number }[] = []
      const sweepArms: ArmSummary[] = []
      if (groups.has('threshold')) {
        for (const name of THRESHOLD_NAMES) {
          const cells: { value: number; summary: ArmSummary }[] = []
          for (const value of THRESHOLD_VALUES[name]) {
            const stated = DEFAULT_SETTINGS.thresholds[name]
            const [summary] = value === stated ? [summaries.get(reference)] : await run([thresholdArm(name, value)])
            if (summary) cells.push({ value, summary })
            if (summary && value !== stated) sweepArms.push(summary)
          }
          rows.push({ name, cells, stated: DEFAULT_SETTINGS.thresholds[name] })
        }
      }
      if (groups.has('floor') && floorIsSettable()) {
        const cells: { value: number; summary: ArmSummary }[] = []
        for (const value of FLOOR_VALUES) {
          const [summary] = value === STATED_AMBIGUITY_FLOOR ? [summaries.get(reference)] : await run([floorArm(value)])
          if (summary) cells.push({ value, summary })
          if (summary && value !== STATED_AMBIGUITY_FLOOR) sweepArms.push(summary)
        }
        rows.push({ name: 'AMBIGUITY_FLOOR', cells, stated: STATED_AMBIGUITY_FLOOR })
      } else if (groups.has('floor')) console.log('\nThe ambiguity floor is fixed under this config: run under testing/frontier/vitest.config.ts to sweep it.')
      console.log(`\none at a time from the defaults: all tune cases passed, mean (min–max over replicas)\n${formatSweep(rows)}`)
      const withDefault = [summaries.get(reference), ...sweepArms].filter((s): s is ArmSummary => s !== undefined)
      console.log(`\nthe same arms with their spend\n${formatArmTable(withDefault, runs, reference)}`)
      console.log(`\ncases that changed sides against the default\n${formatChanges(withDefault, runs, reference)}`)
    }

    if (groups.has('joint') && JOINT_ARMS.length > 0) {
      if (!summaries.has(reference)) await run([DEFAULT_ARM])
      const out = await run([...JOINT_ARMS])
      const withDefault = [summaries.get(reference), ...out].filter((s): s is ArmSummary => s !== undefined)
      console.log(`\njoint arms\n${withDefault.map((s) => `- ${s.arm.name}: ${patchText(s.arm)}`).join('\n')}\n${formatArmTable(withDefault, runs, reference)}`)
      console.log(`\ncases that changed sides against the default\n${formatChanges(withDefault, runs, reference)}`)
    }

    if (groups.has('scaling')) {
      const arms = [...STRATEGY_ARMS, ...BUDGET_ARMS, ...JOINT_ARMS.filter((a) => a.name !== RECOMMENDED_ARM.name), RECOMMENDED_ARM]
      const rows = []
      for (const arm of arms) rows.push({ arm, cells: await scalingCells(arm) })
      console.log(`\nthe costliest message by size (sections × tokens per exchange), every yes/no answered 0.5: requests / calibrated tokens (÷ its answer on the cheapest answer model)\n${formatScaling(rows)}`)
      writeFileSync(path.join(dir, 'frontier-scaling.json'), JSON.stringify(rows.map((r) => ({ arm: r.arm.name, cells: r.cells })), null, 1))
    }

    record('frontier-tune', summaries, runs)
    for (const s of summaries.values()) expect(s.failedRoutings, `${s.arm.name}: routings that failed`).toBe(0)
  })

  it.runIf(phase === 'held-out')('evaluates the default, the recommended and the tune-best arm on the held-out partition, once', { timeout: 3_600_000 }, async () => {
    const { cases, runs, summaries, run } = setup(['conv-held-out'])
    const out = await run(HELD_OUT_ARMS)
    console.log(`held-out cases: ${cases.length}, ${replicas} replicas\nrecommended: ${patchText(RECOMMENDED_ARM)}\n${HELD_OUT_ARMS.map((a) => `- ${a.name}: ${patchText(a)}`).join('\n')}\n${formatArmTable(out, runs, DEFAULT_ARM.name)}`)
    console.log(`\ncases that changed sides\n${formatChanges(out, runs, DEFAULT_ARM.name)}`)
    for (const [name, armRuns] of runs) for (const r of armRuns) console.log(`${name}, replica ${r.replica}: missed ${passList(r)}`)
    record('frontier-held-out', summaries, runs)
    for (const s of summaries.values()) expect(s.failedRoutings).toBe(0)
  })
})

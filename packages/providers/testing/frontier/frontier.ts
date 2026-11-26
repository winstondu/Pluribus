import { MAX_SECTIONS_LISTED, decisionDollarsPerToken } from './prices'
import { CONVERSATION_CORPUS, ROUTING_CORPUS, evaluateCorpus, partitionOf, type CorpusExample } from '@pluribus/core/testing'
import type { DecisionProvider } from '@pluribus/core/ports'
import type { Arm } from './arms'
import { currentAmbiguityFloor, setAmbiguityFloor, STATED_AMBIGUITY_FLOOR } from './floor'
import type { ReplayStats } from './replay'

/**
 * Test-only: one arm of the frontier over a set of corpus cases, and what
 * the runs of several arms and replicas come to.
 *
 * Cases come from the routing corpus (`routing`, the set the thresholds were
 * first tuned on, including its long conversations) and the conversation
 * corpus, split by `partitionOf` into `conv-tune` and `conv-held-out`. A
 * case is `long` when its conversation has more answer sections than the
 * routing request lists (24): that is where spend is decided.
 */

export type CaseSet = 'routing' | 'conv-tune' | 'conv-held-out'
export type CaseSize = 'short' | 'long'

export interface FrontierCase {
  readonly example: CorpusExample
  readonly set: CaseSet
  readonly size: CaseSize
  readonly sections: number
}

/** The cases of the named sets, routing corpus first. */
export function frontierCases(sets: readonly CaseSet[]): FrontierCase[] {
  const partition = partitionOf(CONVERSATION_CORPUS)
  const all: FrontierCase[] = [
    ...ROUTING_CORPUS.map((example) => ({ example, set: 'routing' as const })),
    ...CONVERSATION_CORPUS.map((example) => ({ example, set: partition.get(example.id) === 'held-out' ? ('conv-held-out' as const) : ('conv-tune' as const) })),
  ].map((c) => {
    const sections = c.example.scene.candidates.sections.length
    return { ...c, sections, size: sections > MAX_SECTIONS_LISTED ? ('long' as const) : ('short' as const) }
  })
  return all.filter((c) => sets.includes(c.set))
}

export interface CaseOutcome {
  readonly id: string
  readonly set: CaseSet
  readonly size: CaseSize
  readonly passed: boolean
  /** The routing failed (a provider error or a refused plan), which is not a wrong answer. */
  readonly failed: boolean
  readonly expectations: 'default' | 'hop'
  readonly requests: number
  readonly questions: number
  /** Input tokens as the decision model reported them (replayed with the answer). */
  readonly inputTokens: number
  readonly budgetStop: boolean
  readonly mismatches: readonly string[]
}

export interface ArmRun {
  readonly arm: Arm
  readonly replica: number
  readonly cases: readonly CaseOutcome[]
  readonly replay: ReplayStats
}

async function pool<T, R>(items: readonly T[], concurrency: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      const item = items[i]
      if (item !== undefined) out[i] = await work(item)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker))
  return out
}

/** Routes every case under an arm. The ambiguity floor is moved for the arm and put back after. */
export async function runArm(arm: Arm, cases: readonly FrontierCase[], provider: DecisionProvider & { stats(): ReplayStats }, options: { readonly concurrency?: number; readonly replica?: number } = {}): Promise<ArmRun> {
  const before = provider.stats()
  setAmbiguityFloor(arm.floor)
  try {
    const outcomes = await pool(cases, options.concurrency ?? 6, async (c): Promise<CaseOutcome> => {
      const report = await evaluateCorpus({ decisionProvider: provider, settings: arm.settings, examples: [c.example] })
      const r = report.results[0]
      if (r === undefined) throw new Error(`no result for ${c.example.id}`)
      return {
        id: r.id,
        set: c.set,
        size: c.size,
        passed: r.passed,
        failed: r.outcome === 'failed',
        expectations: r.expectations,
        requests: r.decisions.requests,
        questions: r.decisions.questions,
        inputTokens: r.decisions.inputTokens,
        budgetStop: r.budgetStop !== null,
        mismatches: r.mismatches,
      }
    })
    const after = provider.stats()
    return {
      arm,
      replica: options.replica ?? 0,
      cases: outcomes,
      replay: { replayed: after.replayed - before.replayed, recorded: after.recorded - before.recorded, failed: after.failed - before.failed },
    }
  } finally {
    setAmbiguityFloor(STATED_AMBIGUITY_FLOOR)
    if (currentAmbiguityFloor() !== STATED_AMBIGUITY_FLOOR) throw new Error('the ambiguity floor was not put back')
  }
}

// ───────────────────────────── summaries ─────────────────────────────

export interface Range {
  readonly mean: number
  readonly min: number
  readonly max: number
}

export interface SpendSummary {
  readonly routings: number
  readonly requests: number
  readonly questions: number
  readonly tokensMean: number
  readonly tokensP95: number
  readonly tokensMax: number
  /** Mean tokens per routing, one figure per replica: the spread live answers give the spend. */
  readonly tokensMeanRange: Range
  readonly dollarsPerRouting: number
}

export type Slice = 'all' | 'short' | 'long' | CaseSet

export interface ArmSummary {
  readonly arm: Arm
  readonly replicas: number
  /** Cases passed, one figure per replica, by slice. `total` is the slice's size. */
  readonly passed: { readonly [S in Slice]?: Range & { readonly total: number } }
  readonly spend: { readonly all: SpendSummary; readonly short: SpendSummary; readonly long: SpendSummary | null }
  readonly recorded: number
  readonly failedRoutings: number
  readonly budgetStops: number
  readonly hopExpectations: boolean
}

const range = (values: readonly number[]): Range => ({
  mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0,
  min: values.length ? Math.min(...values) : 0,
  max: values.length ? Math.max(...values) : 0,
})

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] ?? 0
}

function inSlice(c: CaseOutcome, slice: Slice): boolean {
  if (slice === 'all') return true
  if (slice === 'short' || slice === 'long') return c.size === slice
  return c.set === slice
}

function spendOf(runs: readonly ArmRun[], slice: Slice): SpendSummary | null {
  const per = runs.map((run) => run.cases.filter((c) => inSlice(c, slice)))
  const all = per.flat()
  if (all.length === 0) return null
  const tokens = all.map((c) => c.inputTokens)
  const n = all.length
  const tokensMean = tokens.reduce((a, b) => a + b, 0) / n
  return {
    routings: per[0]?.length ?? 0,
    requests: all.reduce((a, c) => a + c.requests, 0) / n,
    questions: all.reduce((a, c) => a + c.questions, 0) / n,
    tokensMean,
    tokensP95: percentile(tokens, 0.95),
    tokensMax: Math.max(...tokens),
    tokensMeanRange: range(per.map((cases) => (cases.length ? cases.reduce((a, c) => a + c.inputTokens, 0) / cases.length : 0))),
    dollarsPerRouting: tokensMean * decisionDollarsPerToken(),
  }
}

/** One arm over its replicas. */
export function summarize(runs: readonly ArmRun[]): ArmSummary {
  const first = runs[0]
  if (first === undefined) throw new Error('no runs to summarize')
  const slices: Slice[] = ['all', 'short', 'long', 'routing', 'conv-tune', 'conv-held-out']
  const passed: { [S in Slice]?: Range & { total: number } } = {}
  for (const slice of slices) {
    const total = first.cases.filter((c) => inSlice(c, slice)).length
    if (total === 0) continue
    passed[slice] = { ...range(runs.map((run) => run.cases.filter((c) => inSlice(c, slice) && c.passed).length)), total }
  }
  const short = spendOf(runs, 'short')
  const all = spendOf(runs, 'all')
  if (all === null || short === null) throw new Error('an arm with no short cases')
  return {
    arm: first.arm,
    replicas: runs.length,
    passed,
    spend: { all, short, long: spendOf(runs, 'long') },
    recorded: runs.reduce((a, r) => a + r.replay.recorded, 0),
    failedRoutings: runs.reduce((a, r) => a + r.cases.filter((c) => c.failed).length, 0),
    budgetStops: runs.reduce((a, r) => a + r.cases.filter((c) => c.budgetStop).length, 0) / runs.length,
    hopExpectations: runs.some((r) => r.cases.some((c) => c.expectations === 'hop')),
  }
}

/**
 * An arm against a reference, replica by replica on the same answers:
 * the difference in cases passed per replica, and every case that came
 * out differently in any replica (`+` passed only under the arm).
 */
export function paired(arm: readonly ArmRun[], reference: readonly ArmRun[]): { readonly delta: Range; readonly changed: readonly string[] } {
  const deltas: number[] = []
  const changed = new Map<string, Set<string>>()
  for (const run of arm) {
    const ref = reference.find((r) => r.replica === run.replica)
    if (!ref) continue
    const refPassed = new Map(ref.cases.map((c) => [c.id, c.passed]))
    deltas.push(run.cases.filter((c) => c.passed).length - ref.cases.filter((c) => c.passed).length)
    for (const c of run.cases) {
      const was = refPassed.get(c.id)
      if (was === undefined || was === c.passed) continue
      const signs = changed.get(c.id) ?? new Set<string>()
      signs.add(c.passed ? '+' : '−')
      changed.set(c.id, signs)
    }
  }
  return { delta: range(deltas), changed: [...changed].map(([id, signs]) => `${[...signs].join('')}${id}`) }
}

/**
 * Which arms no other arm beats on both axes: cases passed (mean over
 * replicas) and mean input tokens per routing of a slice. An arm is
 * dominated when another passes at least as many for at most as many
 * tokens, and is better on one of the two.
 */
export function frontierOf(summaries: readonly ArmSummary[], slice: 'all' | 'short' | 'long' = 'all'): Set<string> {
  const point = (s: ArmSummary): { readonly score: number; readonly tokens: number } => ({
    score: s.passed.all?.mean ?? 0,
    tokens: slice === 'long' ? (s.spend.long?.tokensMean ?? 0) : s.spend[slice].tokensMean,
  })
  const out = new Set<string>()
  for (const a of summaries) {
    const pa = point(a)
    const dominated = summaries.some((b) => {
      if (b === a) return false
      const pb = point(b)
      return pb.score >= pa.score && pb.tokens <= pa.tokens && (pb.score > pa.score || pb.tokens < pa.tokens)
    })
    if (!dominated) out.add(a.arm.name)
  }
  return out
}

// ───────────────────────────── tables ─────────────────────────────

const fmtRange = (r: Range | undefined, total?: number): string => {
  if (!r) return '–'
  const mean = Number.isInteger(r.mean) ? String(r.mean) : r.mean.toFixed(1)
  const spread = r.min === r.max ? '' : ` (${r.min}–${r.max})`
  return `${mean}${spread}${total !== undefined ? `/${total}` : ''}`
}
const int = (n: number): string => Math.round(n).toLocaleString('en-US')
const signed = (r: Range): string => {
  const s = (n: number): string => (n > 0 ? `+${n}` : String(n))
  return r.min === r.max ? s(r.min) : `${s(r.min)} to ${s(r.max)}`
}

/** The main table: accuracy by slice and spend for short and long conversations, with the frontier marked. */
export function formatArmTable(summaries: readonly ArmSummary[], runs: ReadonlyMap<string, readonly ArmRun[]>, reference: string): string {
  const frontier = frontierOf(summaries, 'all')
  const longFrontier = frontierOf(summaries, 'long')
  const ref = runs.get(reference) ?? []
  const rows = summaries.map((s) => {
    const p = s.passed
    const pair = paired(runs.get(s.arm.name) ?? [], ref)
    const long = s.spend.long
    const mark = [frontier.has(s.arm.name) ? 'F' : '', longFrontier.has(s.arm.name) ? 'L' : ''].join('')
    return [
      `${s.arm.name}${s.hopExpectations ? ' †' : ''}`,
      fmtRange(p.routing, p.routing?.total),
      fmtRange(p['conv-tune'], p['conv-tune']?.total),
      fmtRange(p.long, p.long?.total),
      fmtRange(p.all, p.all?.total),
      s.arm.name === reference ? '–' : signed(pair.delta),
      `${s.spend.short.requests.toFixed(2)} / ${s.spend.short.questions.toFixed(1)} / ${int(s.spend.short.tokensMean)} / ${int(s.spend.short.tokensP95)} / ${int(s.spend.short.tokensMax)}`,
      long ? `${long.requests.toFixed(2)} / ${long.questions.toFixed(1)} / ${int(long.tokensMean)} / ${int(long.tokensP95)} / ${int(long.tokensMax)}` : '–',
      `$${(s.spend.all.dollarsPerRouting * 1000).toFixed(4)}`,
      `${s.recorded}${s.failedRoutings ? `, ${s.failedRoutings} failed` : ''}`,
      mark || ' ',
    ]
  })
  return [
    '| Arm | Routing corpus | Conv. tune | Long (>24 sections) | All cases | Δ vs default, per replica | Short: req / q / tokens mean / p95 / max | Long: req / q / tokens mean / p95 / max | $ per 1,000 routings | Sent live | Frontier |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n')
}

/** Cases that changed sides against the reference, per arm (only arms with any). */
export function formatChanges(summaries: readonly ArmSummary[], runs: ReadonlyMap<string, readonly ArmRun[]>, reference: string): string {
  const ref = runs.get(reference) ?? []
  const lines: string[] = []
  for (const s of summaries) {
    if (s.arm.name === reference) continue
    const pair = paired(runs.get(s.arm.name) ?? [], ref)
    if (pair.changed.length) lines.push(`- ${s.arm.name}: ${pair.changed.join(', ')}`)
  }
  return lines.join('\n')
}

/** A one-at-a-time sweep in the shape of PLAN §7: one row per threshold, all tune cases passed per value. */
export function formatSweep(rows: readonly { readonly name: string; readonly cells: readonly { readonly value: number; readonly summary: ArmSummary }[]; readonly stated: number }[]): string {
  const values = [...new Set(rows.flatMap((r) => r.cells.map((c) => c.value)))].sort((a, b) => a - b)
  return [
    `| Threshold | ${values.join(' | ')} | Default |`,
    `|---|${values.map(() => '---').join('|')}|---|`,
    ...rows.map((r) => {
      const cells = values.map((v) => {
        const cell = r.cells.find((c) => c.value === v)
        if (!cell) return ''
        const text = fmtRange(cell.summary.passed.all)
        return v === r.stated ? `**${text}**` : text
      })
      return `| \`${r.name}\` | ${cells.join(' | ')} | ${r.stated} |`
    }),
  ].join('\n')
}

/** Per replica, the per-case pass list of one arm, so two arms can be read case by case. */
export function passList(run: ArmRun): string {
  return run.cases.filter((c) => !c.passed).map((c) => `${c.id}${c.failed ? ' (failed)' : ''}`).join(', ')
}

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, createSeededRandom } from '@pluribus/protocol'
import type { CancelSignal, DecisionProvider, DecisionQuestions, DecisionRequest, DecisionResult, RoutingOutcome } from '@pluribus/core/ports'
import {
  CONVERSATION_CORPUS,
  DIRECTIONS,
  READING_NAMES,
  baseVariant,
  compareWithLabel as compare,
  fingerprint,
  meteredDecisionProvider,
  partitionOf,
  readingVariant,
  routeVariant,
  withFreshIds,
  type ConversationCase,
  type Variant,
} from '@pluribus/core/testing'
import { createOpenRouterDecisionProvider } from '@pluribus/providers'

/**
 * The metamorphic transformations of the conversation corpus
 * (`packages/core/testing/routing/conversations/metamorphic.ts`) against the
 * live decision model. The deterministic suite routes every variant with
 * decisions as labelled, which tests the pipeline; this asks whether the
 * model's answers hold when what it reads changes in a way that should
 * not matter, and how they change when it should. Run with `pnpm smoke`;
 * skipped when OPENROUTER_KEY is absent. The key reaches the provider
 * through `getKey` only.
 *
 * For every sampled case: the case as it is, routed `REPEATS` times (the
 * noise floor: the same requests, answered again), then each reading
 * transformation that applies to it (`READINGS`: the decision model reads
 * other text) and each directional transformation. A variant flips when
 * its routing's fingerprint (`fingerprint`, everything a routing
 * concludes) differs from the first routing of the case as it is; it flips
 * beyond the noise when it differs from every one of them. It is routed as
 * labelled when it meets its own label. Every routing has IDs of its own
 * (`withFreshIds`): the model is shown the same requests (the rename test
 * in the deterministic suite), and no two routings share a section ID.
 *
 * The sample is the `tune` partition only, so that nothing here reads a
 * held-out case; `METAMORPHIC_LIVE_HELD_OUT=1` runs the held-out partition
 * instead, once, for the final record. Other knobs: `METAMORPHIC_SEED`,
 * `METAMORPHIC_LIVE_REPEATS` (default 3), `METAMORPHIC_LIVE_SAMPLE` (cases,
 * default all of the partition), `METAMORPHIC_LIVE_CACHE` (a directory
 * outside the repository where the answers are kept, so a second run reads
 * the same answers: keyed by the request and by how many times the same
 * request was sent before in the run), `METAMORPHIC_LIVE_OUT` (a file for
 * every routing's record).
 *
 * Nothing about the model's robustness is asserted: these are
 * measurements, printed for the build record. What is asserted is that the
 * run measured something: no routing failed for a provider error, every
 * variant is routable as labelled with decisions as labelled, and the
 * noise floor was measured.
 */

const key = process.env['OPENROUTER_KEY'] ?? ''
const getKey = async () => (key === '' ? null : key)
const env = process.env
const SEED = Number(env['METAMORPHIC_SEED'] ?? 20261126)
const REPEATS = Math.max(2, Number(env['METAMORPHIC_LIVE_REPEATS'] ?? 3))
const HELD_OUT = env['METAMORPHIC_LIVE_HELD_OUT'] === '1'
const SAMPLE = env['METAMORPHIC_LIVE_SAMPLE'] ? Number(env['METAMORPHIC_LIVE_SAMPLE']) : Infinity
const CACHE = env['METAMORPHIC_LIVE_CACHE'] ?? ''
const OUT = env['METAMORPHIC_LIVE_OUT'] ?? ''
/** Cases routed at once; one case's routings are always sequential. */
const CONCURRENCY = 4

/** The settings as they ship. */
const SETTINGS = { models: DEFAULT_SETTINGS.models, thresholds: DEFAULT_SETTINGS.thresholds, routing: DEFAULT_SETTINGS.routing }

function hashOf(text: string): number {
  let h = SEED >>> 0
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0
  return h
}
const randomFor = (id: string, purpose: string): (() => number) => createSeededRandom(hashOf(`${purpose}:${id}`))

// ───────────────────────────── the live provider, cached and retried ─────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The live decision provider, retried on a transient error and, with a
 * cache directory, answered from it where the same request was answered
 * before. The n-th sending of a request in a run reads the n-th answer kept
 * for it, so a repeat is answered again and a second run sees what the
 * first saw. Only answers are kept, never the key.
 */
function liveProvider(): DecisionProvider {
  const live = createOpenRouterDecisionProvider({ getKey })
  const sent = new Map<string, number>()
  if (CACHE !== '') mkdirSync(CACHE, { recursive: true })
  return {
    async decide<Q extends DecisionQuestions>(request: DecisionRequest<Q>, signal: CancelSignal): Promise<DecisionResult<Q>> {
      const body = JSON.stringify({ model: request.model, state: request.state, questions: request.questions })
      const hash = createHash('sha256').update(body).digest('hex').slice(0, 32)
      const n = sent.get(hash) ?? 0
      sent.set(hash, n + 1)
      const file = CACHE === '' ? '' : join(CACHE, `${hash}-${n}.json`)
      if (file !== '' && existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as DecisionResult<Q>
      let result = await live.decide(request, signal)
      for (let attempt = 1; !result.ok && result.error.class !== 'non-retryable' && attempt <= 3; attempt++) {
        await sleep(result.error.retryAfterMs ?? 1000 * attempt)
        result = await live.decide(request, signal)
      }
      if (result.ok && file !== '') writeFileSync(file, JSON.stringify(result))
      return result
    },
  }
}

// ───────────────────────────── one routing, read ─────────────────────────────

interface Routed {
  readonly caseId: string
  readonly name: string
  readonly kind: Variant['kind']
  readonly outcome: RoutingOutcome['kind']
  /** `fingerprint`, as JSON: compared whole. */
  readonly print: string
  readonly labelled: boolean
  readonly mismatches: readonly string[]
  readonly requests: number
  readonly questions: number
  readonly inputTokens: number
}

async function routeLive(c: ConversationCase, variant: Variant, provider: DecisionProvider, seed: number): Promise<Routed> {
  const v = withFreshIds(variant, seed)
  const metered = meteredDecisionProvider(provider)
  const outcome = await routeVariant(v, metered)
  const mismatches = compare(v.example, outcome)
  const spent = metered.spent()
  return {
    caseId: c.id,
    name: variant.name,
    kind: variant.kind,
    outcome: outcome.kind,
    print: JSON.stringify(fingerprint(v.example, outcome, v.back, v.quote)),
    labelled: mismatches.length === 0,
    mismatches,
    ...spent,
  }
}

/** A fingerprint in a few words: what was concluded, by handle. */
function summary(print: string): string {
  const f = JSON.parse(print) as {
    kind: string
    composition?: string
    decomposed?: boolean
    candidates?: string[]
    answers?: string | null
    units?: { relation: string; targets: string[]; placement: string; prerequisites: string[] }[]
    revisions?: { scope: string; targets: string[] }[]
    clarifications?: { reason: string }[]
    sessionRequirements?: unknown[]
  }
  if (f.kind === 'target-ambiguity') return `ask ${(f.candidates ?? []).join('|')}`
  if (f.kind !== 'plan') return f.kind
  const parts = [
    ...(f.answers ? [`answers ${f.answers}`] : []),
    ...(f.units ?? []).map((u) => `${u.relation}[${u.targets.join(',')}] ${u.placement}${u.prerequisites.length > 0 ? ` after ${u.prerequisites.join(',')}` : ''}`),
    ...(f.revisions ?? []).map((r) => `revise ${r.scope}[${r.targets.join(',')}]`),
    ...(f.clarifications ?? []).map((x) => `clarify ${x.reason}`),
    ...((f.sessionRequirements ?? []).length > 0 ? ['session-wide'] : []),
  ]
  return `${f.composition ?? ''}${f.decomposed ? ', decomposed' : ''}: ${parts.join('; ')}`
}

/** Where a routing of a variant with a newer unrelated answer went, for "that" and "your last answer". */
function newerOutcome(r: Routed): string {
  if (r.labelled) return 'as labelled'
  const s = summary(r.print)
  if (s.startsWith('ask ')) return s.includes('zz_n0') ? 'asks, the newer answer among the candidates' : 'asks, without the newer answer'
  if (s.includes('zz_n0')) return 'took the newer answer as its target'
  return 'other'
}

// ───────────────────────────── reading the run ─────────────────────────────

const pct = (part: number, whole: number): string => (whole === 0 ? '–' : `${((100 * part) / whole).toFixed(1)}%`)

interface CaseRun {
  readonly c: ConversationCase
  readonly bases: readonly Routed[]
  readonly variants: readonly Routed[]
}

interface Flip {
  readonly n: number
  readonly flipped: number
  readonly beyond: number
  readonly labelled: number
  /** Variants of cases whose first routing as it is was as labelled, and of those the ones still routed as labelled. */
  readonly baseRight: number
  readonly stillRight: number
}

function flips(runs: readonly CaseRun[], keep: (r: Routed) => boolean): Flip {
  let n = 0
  let flipped = 0
  let beyond = 0
  let labelled = 0
  let baseRight = 0
  let stillRight = 0
  for (const run of runs) {
    const first = run.bases[0]
    if (!first) continue
    const seen = new Set(run.bases.map((b) => b.print))
    for (const v of run.variants.filter(keep)) {
      n += 1
      if (v.print !== first.print) flipped += 1
      if (!seen.has(v.print)) beyond += 1
      if (v.labelled) labelled += 1
      if (first.labelled) {
        baseRight += 1
        if (v.labelled) stillRight += 1
      }
    }
  }
  return { n, flipped, beyond, labelled, baseRight, stillRight }
}

/** The noise floor: how often a repeat of a case as it is differs from its first routing. */
function noise(runs: readonly CaseRun[]): { readonly pairs: number; readonly differing: number; readonly cases: number; readonly noisy: number; readonly labelled: number; readonly routings: number } {
  let pairs = 0
  let differing = 0
  let noisy = 0
  let labelled = 0
  let routings = 0
  for (const run of runs) {
    const [first, ...rest] = run.bases
    if (!first) continue
    pairs += rest.length
    const d = rest.filter((r) => r.print !== first.print).length
    differing += d
    if (d > 0) noisy += 1
    labelled += run.bases.filter((b) => b.labelled).length
    routings += run.bases.length
  }
  return { pairs, differing, cases: runs.length, noisy, labelled, routings }
}

const flipRow = (label: string, f: Flip): string =>
  `  ${label.padEnd(34)} ${String(f.n).padStart(4)}  flips ${pct(f.flipped, f.n).padStart(6)}  beyond noise ${pct(f.beyond, f.n).padStart(6)}  as labelled ${pct(f.labelled, f.n).padStart(6)}  (of base-right: ${pct(f.stillRight, f.baseRight)})`

function report(runs: readonly CaseRun[]): string {
  const lines: string[] = []
  const floor = noise(runs)
  lines.push(
    `Noise floor: ${floor.cases} cases, each routed ${REPEATS} times as it is; ${floor.differing} of ${floor.pairs} repeats differ from the first routing (${pct(floor.differing, floor.pairs)}), in ${floor.noisy} cases; as labelled ${floor.labelled}/${floor.routings} (${pct(floor.labelled, floor.routings)})`,
  )
  const invariant = (r: Routed): boolean => r.kind === 'invariant'
  lines.push('', 'By transformation (flips: differs from the first routing as it is; beyond noise: from every routing as it is):')
  const names = [...new Set(runs.flatMap((r) => r.variants.map((v) => `${v.kind === 'unlabelled' ? `${v.name} (unlabelled)` : v.name}`)))]
  for (const name of [...READING_NAMES.flatMap((n) => [n, `${n} (unlabelled)`]), ...names.filter((n) => !READING_NAMES.some((r) => n === r || n === `${r} (unlabelled)`)).sort()]) {
    if (!names.includes(name)) continue
    lines.push(flipRow(name, flips(runs, (r) => (r.kind === 'unlabelled' ? `${r.name} (unlabelled)` : r.name) === name)))
  }
  lines.push(flipRow('every invariant reading', flips(runs, invariant)))
  for (const [axis, of] of [['behavior', (c: ConversationCase) => c.behavior], ['register', (c: ConversationCase) => c.register], ['reference', (c: ConversationCase) => c.reference]] as const) {
    lines.push('', `Invariant readings by ${axis} (noise floor of the group in brackets):`)
    const values = [...new Set(runs.map((r) => of(r.c)))]
    for (const value of values) {
      const group = runs.filter((r) => of(r.c) === value)
      const f = noise(group)
      lines.push(`${flipRow(value, flips(group, invariant))}  [${pct(f.differing, f.pairs)}]`)
    }
  }
  const newer = runs.flatMap((r) => r.variants.filter((v) => v.name === 'newer' && v.kind === 'unlabelled').map((v) => [r.c, v] as const))
  if (newer.length > 0) {
    lines.push('', `A newer unrelated answer, for "that" and "your last answer" (${newer.length} variants): where the routing went`)
    const counts = new Map<string, number>()
    for (const [, v] of newer) counts.set(newerOutcome(v), (counts.get(newerOutcome(v)) ?? 0) + 1)
    for (const [k, n] of counts) lines.push(`  ${k}: ${n}`)
    for (const [c, v] of newer) lines.push(`    ${c.id} (${c.reference}): ${newerOutcome(v)} — ${summary(v.print)}`)
  }
  lines.push('', 'Invariant variants that flip beyond the noise, and directional ones not routed as labelled (case · transformation: the routings as it is → the variant):')
  for (const run of runs) {
    const seen = new Set(run.bases.map((b) => b.print))
    for (const v of run.variants) {
      // A directional variant is expected to change: listed only when it is not routed as its label says.
      if (v.kind === 'unlabelled' || (v.kind === 'invariant' ? seen.has(v.print) : v.labelled)) continue
      const bases = [...new Set(run.bases.map((b) => `${b.labelled ? '✓' : '✗'} ${summary(b.print)}`))].join(' / ')
      lines.push(`  ${run.c.id} · ${v.name} [${v.kind}]: ${bases} → ${v.labelled ? '✓' : '✗'} ${summary(v.print)}`)
    }
  }
  const all = runs.flatMap((r) => [...r.bases, ...r.variants])
  const spent = all.reduce((a, r) => ({ requests: a.requests + r.requests, questions: a.questions + r.questions, inputTokens: a.inputTokens + r.inputTokens }), { requests: 0, questions: 0, inputTokens: 0 })
  lines.push('', `Spent: ${all.length} routings, ${spent.requests} decision requests, ${spent.questions} questions, ${spent.inputTokens} input tokens reported ($${(spent.inputTokens * 0.042e-6).toFixed(4)})`)
  return lines.join('\n')
}

// ───────────────────────────── the run ─────────────────────────────

async function pool<T, R>(items: readonly T[], size: number, f: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        const item = items[i]
        if (item !== undefined) out[i] = await f(item)
      }
    }),
  )
  return out
}

/** Every variant of a case the live run routes: each reading transformation that applies, and each directional one, in the settings as they ship. */
function variantsOf(c: ConversationCase): Variant[] {
  const readings = READING_NAMES.flatMap((name) => {
    const v = readingVariant(c, name, randomFor(c.id, `live:${name}`), SETTINGS)
    return v ? [v] : []
  })
  const directions = (Object.keys(DIRECTIONS) as (keyof typeof DIRECTIONS)[]).flatMap((name) => {
    const v = DIRECTIONS[name](c, randomFor(c.id, `live:${name}`))
    return v ? [{ ...v, name: name === 'pin' ? 'pin' : v.name, settings: { ...v.settings, routing: SETTINGS.routing } }] : []
  })
  return [...readings, ...directions]
}

describe.skipIf(key === '')('conversation corpus, metamorphic, live', () => {
  it('routes the conversation corpus and its variants with the live decision model, against the noise floor', { timeout: 3_600_000 }, async () => {
    const side = partitionOf(CONVERSATION_CORPUS)
    const partition = HELD_OUT ? 'held-out' : 'tune'
    const order = randomFor('sample', 'sample')
    const sample = CONVERSATION_CORPUS.filter((c) => side.get(c.id) === partition)
      .map((c) => [order(), c] as const)
      .sort((a, b) => a[0] - b[0])
      .slice(0, SAMPLE)
      .map(([, c]) => c)
    // With decisions as labelled, every variant is routed as its label says (the deterministic suite checks this in
    // other settings): a live result is read against a label the pipeline can meet.
    const unroutable: string[] = []
    for (const c of sample) {
      for (const v of variantsOf(c)) {
        if (v.kind === 'unlabelled') continue
        const routed = await routeVariant(withFreshIds(v, 1))
        if (compare(withFreshIds(v, 1).example, routed).length > 0) unroutable.push(`${c.id} · ${v.name}`)
      }
    }
    expect(unroutable).toEqual([])

    const provider = liveProvider()
    const runs = await pool(sample, CONCURRENCY, async (c): Promise<CaseRun> => {
      const bases: Routed[] = []
      for (let k = 0; k < REPEATS; k++) bases.push(await routeLive(c, baseVariant(c, SETTINGS), provider, hashOf(`${c.id}:base:${k}`)))
      const variants: Routed[] = []
      for (const v of variantsOf(c)) variants.push(await routeLive(c, v, provider, hashOf(`${c.id}:${v.name}`)))
      return { c, bases, variants }
    })
    if (OUT !== '') writeFileSync(OUT, JSON.stringify(runs.map((r) => ({ id: r.c.id, behavior: r.c.behavior, register: r.c.register, reference: r.c.reference, bases: r.bases, variants: r.variants })), null, 1))
    console.log(`Conversation corpus, metamorphic, live: ${partition} partition, ${sample.length} cases, seed ${SEED}, ${REPEATS} routings of each case as it is\n${report(runs)}`)

    const all = runs.flatMap((r) => [...r.bases, ...r.variants])
    // A routing that failed is a provider error, not an answer.
    expect(all.filter((r) => r.outcome === 'failed').map((r) => `${r.caseId} · ${r.name}`)).toEqual([])
    expect(noise(runs).pairs).toBe(sample.length * (REPEATS - 1))
    expect(runs.every((r) => r.variants.length > 0)).toBe(true)
  })
})

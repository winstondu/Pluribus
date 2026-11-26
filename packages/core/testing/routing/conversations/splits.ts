import { IN_FLIGHT_STATES } from '@pluribus/protocol'
import type { CorpusReport, CorpusResult, DecisionSpend } from '../corpus/evaluate'
import { ids, type Scene } from '../corpus/scene'
import type { CorpusTopic, PartExpectation, UnitExpectation } from '../corpus/types'
import { BEHAVIORS, DOMAINS, PARTITIONS, REFERENCES, REGISTERS, ROLES, SHAPES, type Behavior, type ConversationCase, type Partition, type Shape } from './types'

/** What the conversation looks like when the message arrives, read from the scene. The first that applies. */
export function shapeOf(scene: Scene): Shape {
  const c = scene.candidates
  if (c.work.length === 0) return 'empty'
  if (c.sections.some((s) => s.asksElicitationId !== null)) return 'open-question'
  if (c.groups.some((g) => g.open)) return 'open-group'
  if (c.work.some((w) => IN_FLIGHT_STATES.includes(w.state))) return 'in-flight'
  if (c.groups.length > 0 || c.chains.some((chain) => chain.kind !== 'root')) return 'branched'
  return c.chains.length === 1 ? 'single-line' : 'parallel-lines'
}

/** FNV-1a: a stable order for families that owes nothing to the order the cases were written in. */
function hash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0
  return h
}

/**
 * The tuning boundary. Thresholds and prompts may be chosen on the `tune`
 * cases; a `held-out` result is reported and never tuned on.
 *
 * The unit is the family, so no variant of a prompt sits on both sides.
 * Families are stratified by behavior (a family is counted under the
 * behavior most of its cases show, the earlier of `BEHAVIORS` on a tie) and
 * ordered by a hash of their name; of every three in a stratum the second
 * is held out. A behavior with two families of its own is therefore on
 * both sides, adding a case moves no family of another behavior across the
 * boundary, and the order the cases are written in decides nothing.
 */
export function partitionOf(cases: readonly ConversationCase[]): ReadonlyMap<string, Partition> {
  const families = new Map<string, Behavior>()
  for (const family of new Set(cases.map((c) => c.family))) {
    const of = cases.filter((c) => c.family === family)
    const count = (b: Behavior): number => of.filter((c) => c.behavior === b).length
    families.set(family, [...BEHAVIORS].sort((a, b) => count(b) - count(a) || BEHAVIORS.indexOf(a) - BEHAVIORS.indexOf(b))[0] ?? of[0]?.behavior ?? 'new-chain')
  }
  const side = new Map<string, Partition>()
  for (const behavior of BEHAVIORS) {
    const stratum = [...families].filter(([, b]) => b === behavior).map(([family]) => family)
    stratum.sort((a, b) => hash(a) - hash(b) || a.localeCompare(b))
    stratum.forEach((family, i) => side.set(family, i % 3 === 1 ? 'held-out' : 'tune'))
  }
  return new Map(cases.map((c) => [c.id, side.get(c.family) ?? 'tune']))
}

// ───────────────────────────── a label agrees with its behavior ─────────────────────────────

const units = (parts: readonly PartExpectation[]): UnitExpectation[] => parts.filter((p): p is UnitExpectation => p.kind === 'unit')
const continued = (u: UnitExpectation | undefined): string | null => (u?.placement !== undefined && typeof u.placement === 'object' && 'continue' in u.placement ? u.placement.continue : null)
const joined = (u: UnitExpectation | undefined): readonly string[] | null => (u?.placement !== undefined && typeof u.placement === 'object' && 'join' in u.placement ? u.placement.join : null)

/** Whether nothing in the scene was built on this node, and it is not one of several siblings: continuing it extends its line. */
function isTip(scene: Scene, handle: string): boolean {
  const nodeId = ids.node(handle)
  const work = scene.candidates.work.find((w) => w.nodeId === nodeId)
  return work !== undefined && work.groupId === null && !scene.candidates.work.some((w) => w.startNodeId === nodeId)
}

/**
 * What is wrong with a case's label for the behavior it is filed under;
 * empty when they agree. The behavior tag is how results are read, so a
 * case filed under the wrong one corrupts every per-behavior number: this
 * is checked for every case, from the label and the scene alone.
 */
export function behaviorProblems(c: ConversationCase): string[] {
  const e = c.expect
  const parts = e.parts ?? []
  const us = units(parts)
  const only = parts.length === 1 ? us[0] : undefined
  const inFlight = c.scene.candidates.work.some((w) => IN_FLIGHT_STATES.includes(w.state))
  const out: string[] = []
  const need = (ok: boolean, what: string): void => {
    if (!ok) out.push(`${c.behavior}: ${what}`)
  }
  const plan = (e.outcome ?? 'plan') === 'plan'
  if (c.behavior !== 'ask-target') need(plan, 'the outcome is a plan')
  if (c.behavior !== 'answer-question') need(e.answers === undefined, 'it answers no clarification question')
  if (!c.behavior.startsWith('revise-') && !c.behavior.startsWith('split-')) need(parts.every((p) => p.kind === 'unit'), 'nothing is revised')
  if (!c.behavior.startsWith('split-') && c.behavior !== 'clarify') need(e.composition !== 'independent-composite' && e.composition !== 'sequential-composite', 'the message is not split')
  switch (c.behavior) {
    case 'new-chain':
      need(only?.relation === 'new' && only.placement === 'new-chain', 'one unit, new, on a new chain')
      break
    case 'continue': {
      const on = continued(only)
      need(on !== null && only?.targets?.length === 1 && only.targets[0] === on, 'one unit that continues its one target')
      need(on !== null && isTip(c.scene, on), 'the target has nothing built on it and no siblings')
      need((only?.prerequisites ?? []).length === 0, 'it waits for nothing')
      break
    }
    case 'branch': {
      const on = continued(only)
      need(on !== null && only?.targets?.length === 1 && only.targets[0] === on, 'one unit that continues its one target')
      need(on !== null && !isTip(c.scene, on), 'the target has work built on it, or is one of several siblings')
      break
    }
    case 'fork':
      need(inFlight, 'work is in flight')
      need(only !== undefined && only.relation !== 'result-dependent' && (only.targets ?? []).length === 0, 'one unit that refers to no answer')
      // A trap may leave open where the work goes: what it states is that nothing waits.
      need(c.role === 'trap' || (only?.relation === 'addition' && only.chain !== undefined), 'placed by its line of work')
      need(only?.prerequisites?.length === 0, 'it waits for nothing')
      break
    case 'wait':
      need(only?.relation === 'result-dependent' && only.prerequisites?.length === 1 && !(only.prerequisites[0] ?? '').includes(':'), 'one unit that waits for one piece of work')
      break
    case 'wait-group':
      need(only?.relation === 'result-dependent' && only.prerequisites?.length === 1 && (only.prerequisites[0] ?? '').startsWith('group:'), 'one unit that waits for one sibling group')
      need(continued(only) === only?.prerequisites?.[0], 'it continues from that group’s join-back')
      break
    case 'join-back':
      need((continued(only) ?? '').startsWith('group:') && (only?.targets ?? []).length >= 2, 'one unit that continues from a join-back and refers to two or more members')
      need(only?.prerequisites?.length === 0 && !inFlight, 'the group is closed and nothing is waited for')
      break
    case 'join-chain':
      need((joined(only) ?? []).length >= 2 && e.joinsLines === undefined, 'one unit on a join chain whose targets are clear')
      break
    case 'join-lines':
      need((joined(only) ?? []).length >= 2 && e.joinsLines === true, 'one unit on a join chain, with no clear target')
      break
    case 'ask-target':
      need(e.outcome === 'target-ambiguity' && (e.ambiguous ?? []).length >= 2, 'the user is asked to choose among two or more sections')
      break
    case 'revise-work':
      need(parts.length === 1 && parts[0]?.kind === 'revision' && parts[0].scope === 'work' && parts[0].targets.length === 1, 'one revision of one piece of work')
      break
    case 'revise-shared':
      need(parts.length === 1 && parts[0]?.kind === 'revision' && parts[0].scope === 'shared-requirement', 'one revision of a shared requirement')
      break
    case 'answer-question':
      need(e.answers !== undefined && parts.length === 0, 'it answers the open question and plans no work')
      need(c.scene.candidates.sections.some((s) => s.asksElicitationId === ids.elicitation(e.answers ?? '')), 'that question is open in the scene')
      break
    case 'clarify':
      need(us.some((u) => u.clarification !== undefined), 'a unit says whether it needs a clarification')
      need(us.some((u) => u.clarification !== undefined && u.clarification !== false) === (c.role !== 'trap'), 'a clarification is needed, unless the case is the trap where none is')
      break
    case 'split-independent':
      need(e.composition === 'independent-composite' && parts.length >= 2, 'two or more parts')
      need(us.every((u) => (u.after ?? []).length === 0), 'no part needs another')
      break
    case 'split-sequential':
      need(e.composition === 'sequential-composite' && us.some((u) => (u.after ?? []).length > 0), 'a part needs an earlier part')
      need(e.order !== undefined && e.order.length === parts.length, 'the order of the split messages is labelled')
      break
    case 'keep-atomic':
      need(e.composition === 'atomic' && parts.length === 1, 'one atomic request')
      break
    case 'session-requirement':
      need(e.sessionWide !== undefined, 'the label says whether a requirement became conversation-wide')
      need((e.sessionWide === true) === (c.role !== 'trap'), 'it does, unless the case is the trap where it stays local')
      break
  }
  need((c.trap !== undefined) === (c.role === 'trap'), 'a trap, and only a trap, says which cue points the wrong way')
  return out
}

// ───────────────────────────── reading a result by split ─────────────────────────────

export const SPLIT_AXES = {
  behavior: BEHAVIORS,
  reference: REFERENCES,
  register: REGISTERS,
  role: ROLES,
  domain: DOMAINS,
  shape: SHAPES,
  partition: PARTITIONS,
} as const
export type SplitAxis = keyof typeof SPLIT_AXES

/** Where every case sits on every axis. */
export function splitsOf(cases: readonly ConversationCase[]): ReadonlyMap<string, { readonly [A in SplitAxis]: string }> {
  const partition = partitionOf(cases)
  return new Map(
    cases.map((c) => [
      c.id,
      { behavior: c.behavior, reference: c.reference, register: c.register, role: c.role, domain: c.domain, shape: shapeOf(c.scene), partition: partition.get(c.id) ?? 'tune' },
    ]),
  )
}

/** How many cases each value of an axis has, in the axis's own order, values with none included. */
export function countBy(cases: readonly ConversationCase[], axis: SplitAxis): { readonly [value: string]: number } {
  const splits = splitsOf(cases)
  const out: { [value: string]: number } = Object.fromEntries(SPLIT_AXES[axis].map((value) => [value, 0]))
  for (const c of cases) {
    const value = splits.get(c.id)?.[axis] ?? ''
    out[value] = (out[value] ?? 0) + 1
  }
  return out
}

export interface SplitScore {
  readonly passed: number
  readonly total: number
}

/** A corpus report read by split: passed and total for every value of every axis. Cases the report does not hold are left out. */
export function scoreBySplit(report: CorpusReport, cases: readonly ConversationCase[]): { readonly [A in SplitAxis]: { readonly [value: string]: SplitScore } } {
  const splits = splitsOf(cases)
  const passed = new Map(report.results.map((r) => [r.id, r.passed]))
  const axis = (name: SplitAxis): { [value: string]: SplitScore } => {
    const out: { [value: string]: SplitScore } = {}
    for (const c of cases) {
      const ok = passed.get(c.id)
      if (ok === undefined) continue
      const value = splits.get(c.id)?.[name] ?? ''
      const at = out[value] ?? { passed: 0, total: 0 }
      out[value] = { passed: at.passed + (ok ? 1 : 0), total: at.total + 1 }
    }
    return out
  }
  return { behavior: axis('behavior'), reference: axis('reference'), register: axis('register'), role: axis('role'), domain: axis('domain'), shape: axis('shape'), partition: axis('partition') }
}

/**
 * Contrast families read as a whole: a family passes only when every one
 * of its cases does. A model that answers every variant the same way gets
 * half of a pair right case by case, and none of it here.
 */
export function scoreFamilies(report: CorpusReport, cases: readonly ConversationCase[]): { readonly passed: number; readonly total: number; readonly failed: readonly string[] } {
  const ok = new Map(report.results.map((r) => [r.id, r.passed]))
  const families = new Map<string, boolean>()
  for (const c of cases) {
    if (c.role !== 'contrast' || !ok.has(c.id)) continue
    families.set(c.family, (families.get(c.family) ?? true) && ok.get(c.id) === true)
  }
  const failed = [...families].filter(([, pass]) => !pass).map(([family]) => family)
  return { passed: families.size - failed.length, total: families.size, failed }
}

// ───────────────────────────── what a result cost ─────────────────────────────

/** What routings cost in decision calls: the mean per routing, and the most any one of them cost, each measure on its own. */
export interface SpendSummary {
  readonly routings: number
  readonly mean: DecisionSpend
  readonly worst: DecisionSpend
}

const NOTHING: DecisionSpend = { requests: 0, questions: 0, inputTokens: 0 }
const plus = (a: DecisionSpend, b: DecisionSpend): DecisionSpend => ({ requests: a.requests + b.requests, questions: a.questions + b.questions, inputTokens: a.inputTokens + b.inputTokens })

/** The spend of some routings: requests, questions and the input tokens the provider reported (0 where it reported none). */
export function spendOf(results: readonly Pick<CorpusResult, 'decisions'>[]): SpendSummary {
  const n = results.length
  const sum = results.reduce<DecisionSpend>((a, r) => plus(a, r.decisions), NOTHING)
  const worst = results.reduce<DecisionSpend>(
    (a, r) => ({ requests: Math.max(a.requests, r.decisions.requests), questions: Math.max(a.questions, r.decisions.questions), inputTokens: Math.max(a.inputTokens, r.decisions.inputTokens) }),
    NOTHING,
  )
  const mean = n === 0 ? NOTHING : { requests: sum.requests / n, questions: sum.questions / n, inputTokens: sum.inputTokens / n }
  return { routings: n, mean, worst }
}

/** A corpus report's spend read by split: every value of every axis that has a routing in the report, in the axis's own order. */
export function spendBySplit(report: CorpusReport, cases: readonly ConversationCase[]): { readonly [A in SplitAxis]: { readonly [value: string]: SpendSummary } } {
  const splits = splitsOf(cases)
  const axis = (name: SplitAxis): { [value: string]: SpendSummary } => {
    const by = new Map<string, CorpusResult[]>()
    for (const r of report.results) {
      const value = splits.get(r.id)?.[name]
      if (value !== undefined) by.set(value, [...(by.get(value) ?? []), r])
    }
    return Object.fromEntries(
      SPLIT_AXES[name].flatMap((value) => {
        const results = by.get(value)
        return results ? [[value, spendOf(results)] as const] : []
      }),
    )
  }
  return { behavior: axis('behavior'), reference: axis('reference'), register: axis('register'), role: axis('role'), domain: axis('domain'), shape: axis('shape'), partition: axis('partition') }
}

/**
 * The figure of merit for spend: the input tokens spent per routing right
 * (what one right routing costs, the spend on the wrong ones included),
 * and its reciprocal, routings right per 1,000 input tokens. Null where the
 * provider reported no tokens: the oracle reports none, so route through
 * the token-counting Decisions mock (`packages/providers/testing/openrouter/`)
 * to count them.
 */
export function efficiencyOf(report: Pick<CorpusReport, 'passed' | 'decisions'>): { readonly rightPerThousandTokens: number; readonly tokensPerRight: number | null } | null {
  if (report.decisions.inputTokens === 0) return null
  return { rightPerThousandTokens: (1000 * report.passed) / report.decisions.inputTokens, tokensPerRight: report.passed === 0 ? null : report.decisions.inputTokens / report.passed }
}

/** Several reports as one, in order: for a corpus routed one case at a time (one Decisions mock per case). */
export function combineReports(reports: readonly CorpusReport[]): CorpusReport {
  const results = reports.flatMap((r) => r.results)
  const byTopic: { [T in CorpusTopic]?: { passed: number; total: number } } = {}
  for (const r of reports) {
    for (const [topic, score] of Object.entries(r.byTopic) as [CorpusTopic, { readonly passed: number; readonly total: number }][]) {
      const at = byTopic[topic] ?? { passed: 0, total: 0 }
      byTopic[topic] = { passed: at.passed + score.passed, total: at.total + score.total }
    }
  }
  return {
    results,
    passed: results.filter((r) => r.passed).length,
    total: results.length,
    expectations: reports.reduce((a, r) => ({ default: a.default + r.expectations.default, hop: a.hop + r.expectations.hop, hopDiffering: a.hopDiffering + r.expectations.hopDiffering }), { default: 0, hop: 0, hopDiffering: 0 }),
    decisions: reports.reduce<DecisionSpend>((a, r) => plus(a, r.decisions), NOTHING),
    byTopic,
  }
}

const fixed = (x: number, digits: number): string => x.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })

/** Mean and, in brackets, worst requests, questions and input tokens of one routing. */
function spendText(s: SpendSummary, tokens: boolean): string {
  const t = tokens ? ` · ${fixed(s.mean.inputTokens, 0)} (${fixed(s.worst.inputTokens, 0)}) tokens` : ''
  return `${fixed(s.mean.requests, 2)} (${s.worst.requests}) requests · ${fixed(s.mean.questions, 1)} (${s.worst.questions}) questions${t}`
}

export function formatSplitReport(report: CorpusReport, cases: readonly ConversationCase[]): string {
  const scores = scoreBySplit(report, cases)
  const lines = [`Conversation corpus: ${report.passed}/${report.total} cases as labelled`]
  for (const name of Object.keys(SPLIT_AXES) as SplitAxis[]) {
    const row = SPLIT_AXES[name].flatMap((value) => {
      const s = scores[name][value]
      return s ? [`${value} ${s.passed}/${s.total}`] : []
    })
    lines.push(`  by ${name}: ${row.join(' · ')}`)
  }
  const families = scoreFamilies(report, cases)
  lines.push(`  contrast families with every case right: ${families.passed}/${families.total}${families.failed.length > 0 ? ` (not: ${families.failed.join(', ')})` : ''}`)
  const tokens = report.decisions.inputTokens > 0
  const spend = spendBySplit(report, cases)
  lines.push(`Decision spend per routing, mean (worst)${tokens ? '' : ', no input tokens reported'}: ${spendText(spendOf(report.results), tokens)}`)
  for (const name of Object.keys(SPLIT_AXES) as SplitAxis[]) {
    lines.push(`  by ${name}:`)
    for (const [value, s] of Object.entries(spend[name])) lines.push(`    ${value} (${s.routings}): ${spendText(s, tokens)}`)
  }
  const efficiency = efficiencyOf(report)
  const right = `${report.passed}/${report.total} right`
  lines.push(
    efficiency
      ? `Efficiency: ${right} for ${fixed(report.decisions.inputTokens, 0)} input tokens: ${efficiency.tokensPerRight === null ? 'none right' : `${fixed(efficiency.tokensPerRight, 0)} tokens per routing right`}, ${fixed(efficiency.rightPerThousandTokens, 3)} right per 1,000 tokens`
      : `Efficiency: ${right} for ${report.decisions.requests} requests and ${report.decisions.questions} questions; no input tokens reported`,
  )
  for (const r of report.results) {
    if (r.passed) continue
    lines.push(`✗ ${r.id} (${r.outcome})`)
    for (const m of r.mismatches) lines.push(`    ${m}`)
  }
  return lines.join('\n')
}

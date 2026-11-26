import { IN_FLIGHT_STATES } from '@pluribus/protocol'
import type { CorpusReport } from '../corpus/evaluate'
import { ids, type Scene } from '../corpus/scene'
import type { PartExpectation, UnitExpectation } from '../corpus/types'
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
  for (const r of report.results) {
    if (r.passed) continue
    lines.push(`✗ ${r.id} (${r.outcome})`)
    for (const m of r.mismatches) lines.push(`    ${m}`)
  }
  return lines.join('\n')
}

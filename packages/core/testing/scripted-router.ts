import {
  provisionalLabel,
  type DirectiveId,
  type FragmentId,
  type Placement,
  type PrerequisiteRef,
  type ReplyRelation,
  type Requirement,
  type RoutingDecision,
  type SectionId,
  type TextSpan,
  type UnitRoutingDecision,
  type WholeRequestBarrier,
} from '@committee/protocol'
import type {
  CancelSignal,
  PlannedClarification,
  PlannedRevision,
  PlannedSessionRequirement,
  PlannedUnit,
  Router,
  RoutingInput,
  RoutingOutcome,
  RoutingPlan,
} from '../src/ports'

type OutcomeFor = (input: RoutingInput) => RoutingOutcome | Promise<RoutingOutcome>

interface Rule {
  readonly match: (input: RoutingInput) => boolean
  readonly outcome: OutcomeFor
  readonly repeat: boolean
  used: boolean
}

/**
 * Returns the routing outcome a test supplies for each message
 * (milestones 1–3, before the routing pipeline exists). A string matches
 * the message text exactly. Without a matching rule a message is atomic,
 * on a new chain. Every input is recorded.
 */
export class ScriptedRouter implements Router {
  readonly inputs: RoutingInput[] = []
  private readonly rules: Rule[] = []
  private fallback: OutcomeFor = (input) => atomic(input, {})
  /** When set, `route` waits for the promise before answering: lets a test hold routing in flight. */
  gate: Promise<void> | null = null

  when(match: string | ((input: RoutingInput) => boolean), outcome: OutcomeFor, options: { readonly repeat?: boolean } = {}): this {
    const test = typeof match === 'string' ? (input: RoutingInput) => input.text === match : match
    this.rules.push({ match: test, outcome, repeat: options.repeat ?? false, used: false })
    return this
  }

  otherwise(outcome: OutcomeFor): this {
    this.fallback = outcome
    return this
  }

  async route(input: RoutingInput, signal: CancelSignal): Promise<RoutingOutcome> {
    void signal
    this.inputs.push(input)
    if (this.gate) await this.gate
    const rule = this.rules.find((r) => (r.repeat || !r.used) && r.match(input))
    if (rule && !rule.repeat) rule.used = true
    return (rule ?? { outcome: this.fallback }).outcome(input)
  }
}

/** One unit as a test states it; everything else is filled in. */
export interface UnitSpec {
  readonly placement?: Placement
  readonly prerequisites?: readonly PrerequisiteRef[]
  /** The instruction; defaults to the message text, or the fragment's source text. */
  readonly instruction?: string
  readonly label?: string
  readonly relation?: Exclude<ReplyRelation, 'revision'>
  readonly targets?: readonly SectionId[]
  readonly requirements?: readonly Requirement[]
  /** For a fragment of a composite: its spans in the message text. */
  readonly spans?: readonly TextSpan[]
  /** Use this directive ID instead of minting one. */
  readonly directiveId?: DirectiveId
}

export interface PlanExtras {
  readonly barrier?: WholeRequestBarrier | null
  /** Indexes of `units` in the explicit output order. */
  readonly outputOrder?: readonly number[] | null
  readonly sessionRequirements?: readonly PlannedSessionRequirement[]
  readonly withdrawnSessionRequirementIds?: RoutingPlan['withdrawnSessionRequirementIds']
  readonly clarifications?: (units: readonly PlannedUnit[]) => readonly PlannedClarification[]
  readonly revisions?: readonly PlannedRevision[]
  readonly answersElicitationId?: RoutingPlan['answersElicitationId']
}

function unitFrom(input: RoutingInput, spec: UnitSpec, composite: boolean): PlannedUnit {
  const directiveId = spec.directiveId ?? input.ids.next('directive')
  const fragment =
    composite && spec.spans
      ? {
          fragmentId: input.ids.next('fragment') as FragmentId,
          sourceSpans: spec.spans,
          rewrittenText: spec.instruction ?? spec.spans.map((s) => input.text.slice(s.start, s.end)).join(' '),
        }
      : null
  const instruction = spec.instruction ?? fragment?.rewrittenText ?? input.text
  return {
    directiveId,
    fragment,
    instruction,
    label: spec.label ?? provisionalLabel(instruction),
    labelIsProvisional: spec.label === undefined,
    requirements: spec.requirements ?? [],
    relation: spec.relation ?? (spec.placement === undefined || spec.placement.kind === 'new-chain' ? 'new' : 'addition'),
    targets: spec.targets ?? input.explicitTargets,
    placement: spec.placement ?? { kind: 'new-chain' },
    prerequisites: spec.prerequisites ?? [],
  }
}

function decisionFor(input: RoutingInput, composition: 'atomic' | 'composite', units: readonly PlannedUnit[]): RoutingDecision {
  return {
    source: 'supplied',
    model: null,
    composition: { value: composition, confidence: null },
    units: units.map(
      (u): UnitRoutingDecision => ({
        key: u.fragment ? u.fragment.fragmentId : 'message',
        fragmentId: u.fragment?.fragmentId ?? null,
        relation: { value: u.relation, confidence: null },
        correctiveConfidence: null,
        targets: {
          sectionIds: u.targets,
          mode: u.targets.length === 0 ? 'none' : input.explicitTargets.length > 0 ? 'explicit' : 'inferred',
          candidates: [],
          redirected: input.redirects.filter((r) => u.targets.includes(r.to)),
        },
        placement: { value: u.placement, confidence: null },
        prerequisites: { value: u.prerequisites, confidence: null },
        needsClarification: null,
        explanation: 'Supplied by the test.',
      }),
    ),
    thresholds: { ...input.settings.thresholds },
    explanation: 'Supplied by the test.',
    questions: [],
  }
}

function planOf(
  input: RoutingInput,
  composition: RoutingPlan['composition'],
  units: readonly PlannedUnit[],
  extras: PlanExtras,
): RoutingOutcome {
  return {
    kind: 'plan',
    plan: {
      decision: decisionFor(input, composition === 'atomic' ? 'atomic' : 'composite', units),
      composition,
      units,
      barrier: extras.barrier ?? null,
      outputOrder: extras.outputOrder ? extras.outputOrder.map((i) => units[i]?.directiveId).filter((id): id is DirectiveId => id !== undefined) : null,
      sessionRequirements: extras.sessionRequirements ?? [],
      withdrawnSessionRequirementIds: extras.withdrawnSessionRequirementIds ?? [],
      clarifications: extras.clarifications ? extras.clarifications(units) : [],
      revisions: extras.revisions ?? [],
      answersElicitationId: extras.answersElicitationId ?? null,
      decompositionModel: composition === 'atomic' ? null : 'test/decomposer',
    },
  }
}

/** An atomic plan with one unit (defaults: the whole message, on a new chain). */
export function atomic(input: RoutingInput, spec: UnitSpec = {}, extras: PlanExtras = {}): RoutingOutcome {
  return planOf(input, 'atomic', [unitFrom(input, spec, false)], extras)
}

/** A plan with no units (a message that only revises, or only answers a clarification). */
export function noUnits(input: RoutingInput, extras: PlanExtras = {}): RoutingOutcome {
  return planOf(input, 'atomic', [], extras)
}

/** An independent composite: one user message, one reply group (Q9, Q18). */
export function independent(input: RoutingInput, specs: readonly UnitSpec[], extras: PlanExtras = {}): RoutingOutcome {
  return planOf(input, 'independent-composite', specs.map((s) => unitFrom(input, s, true)), extras)
}

/** A sequential composite: split messages in the order of `specs`, which must be topological (Q53). */
export function sequential(input: RoutingInput, specs: readonly UnitSpec[], extras: PlanExtras = {}): RoutingOutcome {
  return planOf(input, 'sequential-composite', specs.map((s) => unitFrom(input, s, true)), extras)
}

/** Spans for the occurrence of `part` in `text`. */
export function spanOf(text: string, part: string): TextSpan[] {
  const start = text.indexOf(part)
  if (start < 0) throw new Error(`"${part}" is not in "${text}"`)
  return [{ start, end: start + part.length }]
}

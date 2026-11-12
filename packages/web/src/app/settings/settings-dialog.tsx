import {
  DEFAULT_ABSOLUTE_TOKEN_BUDGET,
  DEFAULT_RELATIVE_TOKEN_BUDGET,
  DEFAULT_SETTINGS,
  RETRY_POLICIES,
  type CandidateSourceName,
  type ComparePlacement,
  type DebugViewToggle,
  type DecisionThresholds,
  type DecisionTokenBudget,
  type KeyProviderName,
  type ModelRoleChoice,
  type ReferentStrategyName,
  type RetryPolicy,
  type Settings,
  type SettingsPatch,
  type StrategySelectionMode,
} from '@pluribus/protocol'
import { CheckIcon, KeyRoundIcon, MinusIcon, PlusIcon } from 'lucide-react'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { useApp, useSend } from '@/backend'
import { useKeyProvision } from '../environment'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { MODEL_ROLES } from '../models'
import { useUiState } from '../ui-state'
import { ModelPicker } from './model-picker'

/**
 * Settings: every row of 10 · "User settings". Each change is sent at once
 * as a `change-settings` command; what the dialog shows is the settings the
 * backend reports, so a rejected change snaps back and says why.
 */

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'models', label: 'Models' },
  { id: 'routing', label: 'Routing' },
  { id: 'key', label: 'Keys' },
  { id: 'debug', label: 'Debug views' },
] as const

type TabId = (typeof TABS)[number]['id']

export function SettingsDialog() {
  const open = useUiState((state) => state.settingsOpen)
  const closeSettings = useUiState((state) => state.closeSettings)
  const app = useApp()
  const [tab, setTab] = useState<TabId>('general')

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : closeSettings())}>
      <DialogContent className="flex h-[min(38rem,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[46rem]">
        <div className="border-b border-border px-5 py-4">
          <DialogTitle className="text-base font-medium">Settings</DialogTitle>
          <DialogDescription className="mt-0.5 text-xs text-muted-foreground">
            These apply to every conversation in this browser.
          </DialogDescription>
        </div>
        {app ? (
          <Tabs
            value={tab}
            onValueChange={(next) => setTab(next as TabId)}
            orientation="vertical"
            className="min-h-0 flex-1 gap-0 max-sm:flex-col"
          >
            <TabsList
              variant="line"
              aria-label="Settings sections"
              className="scroll-quiet shrink-0 items-stretch justify-start gap-0.5 border-border p-2 max-sm:w-full max-sm:flex-row max-sm:overflow-x-auto max-sm:border-b sm:w-40 sm:border-r sm:p-3"
            >
              {TABS.map((entry) => (
                <TabsTrigger
                  key={entry.id}
                  value={entry.id}
                  className="h-8 flex-none justify-start rounded-md px-2.5 text-[0.8125rem] after:hidden data-active:bg-accent! data-active:text-accent-foreground max-sm:w-auto!"
                >
                  {entry.label}
                </TabsTrigger>
              ))}
            </TabsList>
            <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
              <TabsContent value="general">
                <GeneralSettings settings={app.settings} />
              </TabsContent>
              <TabsContent value="models">
                <ModelSettingsPanel roles={app.modelRoles} />
              </TabsContent>
              <TabsContent value="routing">
                <div className="grid gap-8">
                  <ReferentSettings settings={app.settings} />
                  <DecisionBudgetSettings settings={app.settings} />
                  <ThresholdSettings settings={app.settings} />
                </div>
              </TabsContent>
              <TabsContent value="key">
                <KeySettings openRouter={app.key.configured} />
              </TabsContent>
              <TabsContent value="debug">
                <DebugSettings settings={app.settings} />
              </TabsContent>
            </div>
          </Tabs>
        ) : (
          <p className="p-6 text-sm text-muted-foreground">Settings are not loaded yet.</p>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Sends one settings change and reports a rejection. Resolves to whether it was accepted. */
export function useChangeSettings(): (changes: SettingsPatch) => Promise<boolean> {
  const send = useSend()
  return async (changes) => {
    const result = await send({ type: 'change-settings', changes })
    if (!result.ok) toast.error('That setting was not changed', { description: result.error.message })
    return result.ok
  }
}

// ───────────────────────── layout pieces ─────────────────────────

function Panel({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted-foreground">{description}</p>
      <div className="mt-5 flex flex-col divide-y divide-border">{children}</div>
    </section>
  )
}

function Row({
  label,
  description,
  htmlFor,
  labelId,
  stacked = false,
  children,
}: {
  label: string
  description?: ReactNode
  htmlFor?: string
  labelId?: string
  /** Put the control under the label instead of beside it. */
  stacked?: boolean
  children: ReactNode
}) {
  return (
    <div className={cn('flex gap-x-6 gap-y-2.5 py-3.5 first:pt-0 last:pb-0', stacked ? 'flex-col' : 'items-start justify-between')}>
      <div className="min-w-0">
        <label id={labelId} htmlFor={htmlFor} className="text-[0.8125rem] font-medium text-foreground">
          {label}
        </label>
        {description ? <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p> : null}
      </div>
      <div className={cn(stacked ? 'w-full' : 'shrink-0')}>{children}</div>
    </div>
  )
}

/** One of a few named options, each with a line saying what it does. */
function ChoiceCards<T extends string>({
  labelledBy,
  options,
  value,
  onChoose,
  className,
}: {
  labelledBy: string
  options: readonly { value: T; label: string; description: string }[]
  value: T
  onChoose: (value: T) => void
  className?: string
}) {
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className={cn('grid gap-2', className)}>
      {options.map((option) => {
        const selected = value === option.value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => (selected ? undefined : onChoose(option.value))}
            className={cn(
              'pressable relative rounded-lg border border-border bg-surface p-3 text-left hover:border-border-strong',
              selected && 'border-primary/60 bg-accent/60 hover:border-primary/60',
            )}
          >
            <span className="flex items-center justify-between gap-2 text-[0.8125rem] font-medium">
              {option.label}
              <CheckIcon
                aria-hidden
                className={cn('size-3.5 text-primary transition-opacity duration-(--duration-fast)', selected ? 'opacity-100' : 'opacity-0')}
              />
            </span>
            <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{option.description}</span>
          </button>
        )
      })}
    </div>
  )
}

// ───────────────────────── general ─────────────────────────

const POLICIES: readonly { value: RetryPolicy; label: string; description: string }[] = [
  {
    value: 'standard',
    label: 'Standard',
    description: `Retries a transient failure up to ${RETRY_POLICIES.standard.maxAutomaticRetries} times, then marks the section failed.`,
  },
  {
    value: 'persistent',
    label: 'Persistent',
    description: `Up to ${RETRY_POLICIES.persistent.maxAutomaticRetries} retries, and waits longer when a provider is rate-limited.`,
  },
  { value: 'manual', label: 'Manual', description: 'No automatic retries. Every failure goes straight to Retry.' },
]

function GeneralSettings({ settings }: { settings: Settings }) {
  const change = useChangeSettings()
  const policyLabel = useId()
  const waitLabel = useId()
  const concurrencyLabel = useId()
  return (
    <Panel title="General" description="How Pluribus retries failed work, how long it waits before acting on a default, and how much runs at once.">
      <Row label="Retry policy" labelId={policyLabel} stacked>
        <ChoiceCards
          labelledBy={policyLabel}
          options={POLICIES}
          value={settings.retryPolicy}
          onChoose={(value) => void change({ retryPolicy: value })}
          className="sm:grid-cols-3"
        />
      </Row>
      <Row
        label="Wait before a default choice runs"
        labelId={waitLabel}
        description="When a correction affects finished work, Pluribus pre-selects what to redo and carries it out after this wait unless you choose first."
        stacked
      >
        <CommittedSlider
          labelledBy={waitLabel}
          value={Math.round(settings.defaultChoiceWaitMs / 1000)}
          min={5}
          max={120}
          step={5}
          format={(seconds) => `${seconds} s`}
          onCommit={(seconds) => change({ defaultChoiceWaitMs: seconds * 1000 })}
        />
      </Row>
      <Row
        label="Concurrency limit"
        labelId={concurrencyLabel}
        description="Answer and synthesis runs in flight at once. Work beyond it waits for a free slot."
      >
        <Stepper
          labelledBy={concurrencyLabel}
          value={settings.concurrencyLimit}
          min={1}
          max={16}
          onChange={(concurrencyLimit) => void change({ concurrencyLimit })}
        />
      </Row>
    </Panel>
  )
}

function Stepper(props: { labelledBy: string; value: number; min: number; max: number; onChange(value: number): void }) {
  return (
    <div role="group" aria-labelledby={props.labelledBy} className="inline-flex items-center rounded-lg border border-border bg-surface">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Decrease"
        disabled={props.value <= props.min}
        onClick={() => props.onChange(props.value - 1)}
        className="rounded-r-none"
      >
        <MinusIcon />
      </Button>
      <output aria-live="polite" className="tabular w-8 text-center text-[0.8125rem] font-medium">
        {props.value}
      </output>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Increase"
        disabled={props.value >= props.max}
        onClick={() => props.onChange(props.value + 1)}
        className="rounded-l-none"
      >
        <PlusIcon />
      </Button>
    </div>
  )
}

/** A slider that shows its value while dragged and sends it once, on release. */
function CommittedSlider(props: {
  labelledBy: string
  value: number
  min: number
  max: number
  step: number
  format(value: number): string
  onCommit(value: number): Promise<boolean>
}) {
  const [dragging, setDragging] = useState<number | null>(null)
  // Follow the backend's value whenever it changes (a reset, or another tab).
  useEffect(() => setDragging(null), [props.value])
  const shown = dragging ?? props.value
  return (
    <div className="flex items-center gap-4">
      <Slider
        aria-labelledby={props.labelledBy}
        value={[shown]}
        min={props.min}
        max={props.max}
        step={props.step}
        onValueChange={([next]) => (next === undefined ? undefined : setDragging(next))}
        onValueCommit={([next]) => {
          // Show the backend's value again once it has answered, accepted or not.
          if (next !== undefined && next !== props.value) void props.onCommit(next).then(() => setDragging(null))
          else setDragging(null)
        }}
        className="flex-1"
      />
      <output className="tabular w-12 text-right text-[0.8125rem] font-medium">{props.format(shown)}</output>
    </div>
  )
}

// ───────────────────────── models ─────────────────────────

/**
 * The Models section renders what the backend reports for each role
 * (`AppSnapshot.modelRoles`): the providers the role can run on, the
 * models each offers, and whether this client may change anything. It
 * decides none of that itself; a change is a `change-settings` command the
 * backend validates.
 */
function ModelSettingsPanel({ roles }: { roles: readonly ModelRoleChoice[] }) {
  const change = useChangeSettings()
  const serverSet = roles.length > 0 && roles.every((role) => !role.editable)
  return (
    <Panel
      title="Models"
      description={
        serverSet
          ? 'One model per role, set by the server. They cannot be changed from here.'
          : 'One model per role. A change applies to runs that start after it.'
      }
    >
      {roles.map((choice) => {
        const entry = MODEL_ROLES.find((role) => role.role === choice.role)
        if (!entry) return null
        return <ModelRoleRow key={choice.role} choice={choice} label={entry.label} description={entry.description} change={change} />
      })}
    </Panel>
  )
}

function ModelRoleRow(props: {
  choice: ModelRoleChoice
  label: string
  description: string
  change: (changes: SettingsPatch) => Promise<boolean>
}) {
  const { choice, label } = props
  const current = choice.providers[0]
  if (!current) return null
  return (
    <Row label={label} description={props.description} stacked>
      <div className="flex flex-col gap-2" data-model-role={choice.role}>
        <ModelPicker
          label={label}
          value={choice.model}
          choice={current}
          disabled={!choice.editable}
          onChange={(model) => void props.change({ models: { [choice.role]: model } })}
        />
        {choice.note !== null ? (
          <p data-slot="model-role-note" className="text-xs leading-relaxed text-muted-foreground">
            {choice.note}
          </p>
        ) : null}
      </div>
    </Row>
  )
}

// ───────────────────────── routing thresholds ─────────────────────────

const THRESHOLDS: readonly { key: keyof DecisionThresholds; label: string; description: string }[] = [
  {
    key: 'targetChoice',
    label: 'Target choice',
    description: 'Below this confidence in the best target, Pluribus asks which section a reply addresses.',
  },
  {
    key: 'clearlyCorrective',
    label: 'Clearly corrective',
    description: 'Below this, a reply is treated as additional work, not as a revision.',
  },
  { key: 'composite', label: 'Composite', description: 'At or above this, a message is split into independent fragments.' },
  {
    key: 'dependency',
    label: 'Result dependency',
    description: 'At or above this, work waits for a result. Shared subject matter alone should stay below it.',
  },
  {
    key: 'clarification',
    label: 'Clarification',
    description: 'At or above this, work is held until you answer a clarification question.',
  },
]

const REFERENT_STRATEGIES: readonly { value: ReferentStrategyName; label: string; description: string }[] = [
  {
    value: 'tree-walk',
    label: 'Tree walk',
    description: 'Follows the lines of work a message is about, level by level. Reaches answers however old; one more decision request per branching level.',
  },
  {
    value: 'one-pass',
    label: 'One pass',
    description: 'Asks about the most recent answers in the routing request itself. No further request; older answers are out of reach.',
  },
]

/** Whether the strategy and the tree walk's switches are chosen for each message from the shape of the conversation. */
const STRATEGY_SELECTION: readonly { value: StrategySelectionMode; label: string; description: string }[] = [
  { value: 'off', label: 'As set here', description: 'Every message uses the strategy and switches chosen below.' },
  { value: 'rules', label: 'By rules', description: 'Chosen for each message from the shape of the conversation. No extra request. The default.' },
  {
    value: 'decision-model',
    label: 'By the decision model',
    description: 'One small request about the shape, reused until the shape changes. The rules when it fails or is unsure.',
  },
]

/**
 * Where the tree walk gets candidate sections from: seed hints for its search. A candidate is a place to start, never
 * a target; it is asked about by itself like any other answer.
 */
const CANDIDATE_SOURCES: readonly { value: CandidateSourceName; label: string; description: string }[] = [
  { value: 'none', label: 'None', description: 'The tree walk starts at the roots of the conversation and follows the lines a message is about.' },
  {
    value: 'lexical',
    label: 'Word index',
    description:
      'Answers that share words with the message are handed to the tree walk as further places to start. Seed hints only: each is still asked about by itself. The index costs no decision tokens; each hint may add questions, within the decision budget.',
  },
]

/**
 * The tree walk's two switches. The trunk base is chosen for each message while a strategy selector is on; hop between
 * branch points changes where a message is placed, so it is never chosen and is used as set whenever the tree walk runs.
 */
const TREE_WALK_SWITCHES: readonly { key: 'startAtTrunkBase' | 'hopBetweenBranchPoints'; label: string; description: string }[] = [
  {
    key: 'startAtTrunkBase',
    label: 'Start at the trunk base',
    description:
      'Asks about a line of work where it first splits, not about every answer before that. Fewer questions; a reply to an earlier answer of the trunk takes one more decision request.',
  },
  {
    key: 'hopBetweenBranchPoints',
    label: 'Hop between branch points',
    description:
      'A message about an answer inside a run (a line of work between two splits) continues from the run’s last answer: routing asks only whether the run is meant, not which answer in it. Saves decision tokens; the answer then reads everything after the part of the run the message is about. A correction is still matched to the exact answer it revises.',
  },
]

/** Context summaries for routing decisions. Nothing produces a summary yet, and the wording says so. */
const SUMMARY_SWITCHES: readonly { key: 'useSummaryIfAvailable' | 'backgroundSummaries'; label: string; description: string }[] = [
  {
    key: 'useSummaryIfAvailable',
    label: 'Use context summaries when available',
    description:
      'Routing reads a summary of the earlier work and the answer’s own content, not the answer’s usual line. Answers are still written from the full context. Summaries are not generated yet, so this changes nothing for now.',
  },
  {
    key: 'backgroundSummaries',
    label: 'Summarise context in the background',
    description: 'Offers finished work to the summariser after each run. Summaries are not generated yet: turning this on has no effect for now.',
  },
]

function ReferentSettings({ settings }: { settings: Settings }) {
  const change = useChangeSettings()
  const label = useId()
  const selectionLabel = useId()
  const candidatesLabel = useId()
  const selecting = settings.routing.strategySelection !== 'off'
  return (
    <Panel title="Referents" description="How routing decides which earlier answers a message refers to and waits for.">
      <Row
        label="Choosing the strategy"
        labelId={selectionLabel}
        description={selecting ? 'While this is on, the strategy and “Start at the trunk base” are chosen for each message; the ones set below are not used. “Hop between branch points” is used as set.' : undefined}
        stacked
      >
        <ChoiceCards
          labelledBy={selectionLabel}
          options={STRATEGY_SELECTION}
          value={settings.routing.strategySelection}
          onChoose={(value) => void change({ routing: { strategySelection: value } })}
          className="sm:grid-cols-3"
        />
      </Row>
      <Row label="Strategy" labelId={label} stacked>
        <ChoiceCards
          labelledBy={label}
          options={REFERENT_STRATEGIES}
          value={settings.routing.referentStrategy}
          onChoose={(value) => void change({ routing: { referentStrategy: value } })}
          className="sm:grid-cols-2"
        />
      </Row>
      {/* A selector may choose the tree walk whatever is set here, and the hop then applies: its switch stays in reach. */}
      {TREE_WALK_SWITCHES.filter((entry) => settings.routing.referentStrategy === 'tree-walk' || (selecting && entry.key === 'hopBetweenBranchPoints')).map((entry) => (
            <DebugRow
              key={entry.key}
              label={entry.label}
              description={entry.description}
              checked={settings.routing.treeWalk[entry.key]}
              onChange={(checked) => void change({ routing: { treeWalk: { [entry.key]: checked } } })}
            />
          ))}
      <Row
        label="Candidate sections"
        labelId={candidatesLabel}
        description="Hints for the tree walk about where an older answer a message refers to may be. One pass does not search and does not use them."
        stacked
      >
        <ChoiceCards
          labelledBy={candidatesLabel}
          options={CANDIDATE_SOURCES}
          value={settings.routing.candidateSource}
          onChoose={(value) => void change({ routing: { candidateSource: value } })}
          className="sm:grid-cols-2"
        />
      </Row>
      {SUMMARY_SWITCHES.map((entry) => (
        <DebugRow
          key={entry.key}
          label={entry.label}
          description={entry.description}
          checked={settings.routing[entry.key]}
          onChange={(checked) => void change({ routing: { [entry.key]: checked } })}
        />
      ))}
    </Panel>
  )
}

// ───────────────────────── decision budget ─────────────────────────

const wholeNumber = new Intl.NumberFormat('en-US')

const TOKEN_BUDGET_MODES: readonly { value: DecisionTokenBudget['mode']; label: string; description: string }[] = [
  {
    value: 'relative',
    label: 'Share of the conversation',
    description: 'Grows with everything recorded in the conversation, so a long one can be searched further back for what a message refers to.',
  },
  {
    value: 'absolute',
    label: 'Fixed',
    description: 'The same number of tokens for every message, however long the conversation is. Predictable; in a very long conversation an old answer may be out of reach.',
  },
]

/** The decision input tokens routing one message may use: a share of the conversation's log, or a fixed number. */
function DecisionBudgetSettings({ settings }: { settings: Settings }) {
  const change = useChangeSettings()
  const modeLabel = useId()
  const valueLabel = useId()
  const budget = settings.routing.tokenBudget
  const setBudget = (tokenBudget: DecisionTokenBudget): Promise<boolean> => change({ routing: { tokenBudget } })
  return (
    <Panel
      title="Decision budget"
      description="The most decision-model input routing one message may use, in tokens. Whatever is set here, routing is also held to twice the cost of the answer it routes; the smaller limit applies."
    >
      <Row label="Token budget" labelId={modeLabel} stacked>
        <ChoiceCards
          labelledBy={modeLabel}
          options={TOKEN_BUDGET_MODES}
          value={budget.mode}
          onChoose={(mode) => void setBudget(mode === 'relative' ? DEFAULT_RELATIVE_TOKEN_BUDGET : DEFAULT_ABSOLUTE_TOKEN_BUDGET)}
          className="sm:grid-cols-2"
        />
      </Row>
      {budget.mode === 'relative' ? (
        <Row
          label="Share of the conversation"
          labelId={valueLabel}
          description={`Of the tokens in every message and every answer attempt recorded so far. Never fewer than ${wholeNumber.format(budget.floor)} tokens, so a new conversation is not starved, and never more than ${wholeNumber.format(budget.ceiling)}.`}
          stacked
        >
          <CommittedSlider
            labelledBy={valueLabel}
            value={Math.round(budget.fraction * 1000)}
            min={5}
            max={100}
            step={5}
            format={(perMille) => `${(perMille / 10).toFixed(1)}%`}
            onCommit={(perMille) => setBudget({ ...budget, fraction: perMille / 1000 })}
          />
        </Row>
      ) : (
        <Row label="Tokens per message" labelId={valueLabel} description="Counts every decision request made to route one message." stacked>
          <CommittedSlider
            labelledBy={valueLabel}
            value={budget.inputTokens}
            min={2_000}
            max={40_000}
            step={1_000}
            format={(tokens) => wholeNumber.format(tokens)}
            onCommit={(inputTokens) => setBudget({ mode: 'absolute', inputTokens })}
          />
        </Row>
      )}
    </Panel>
  )
}

function ThresholdSettings({ settings }: { settings: Settings }) {
  const change = useChangeSettings()
  const isDefault = THRESHOLDS.every((entry) => settings.thresholds[entry.key] === DEFAULT_SETTINGS.thresholds[entry.key])
  return (
    <Panel
      title="Decision confidence thresholds"
      description="Routing asks a decision model bounded questions and compares its confidence with these. They are sent to the backend with every change."
    >
      {THRESHOLDS.map((entry) => (
        <ThresholdRow
          key={entry.key}
          label={entry.label}
          description={entry.description}
          value={settings.thresholds[entry.key]}
          onCommit={(value) => change({ thresholds: { [entry.key]: value } })}
        />
      ))}
      <div className="flex items-center justify-between gap-4 py-3.5 last:pb-0">
        <p className="text-xs text-muted-foreground">
          {isDefault ? 'These are the initial values.' : 'Changed from the initial values.'}
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={isDefault}
          onClick={() => void change({ thresholds: DEFAULT_SETTINGS.thresholds })}
        >
          Reset to defaults
        </Button>
      </div>
    </Panel>
  )
}

function ThresholdRow(props: {
  label: string
  description: string
  value: number
  onCommit(value: number): Promise<boolean>
}) {
  const labelId = useId()
  return (
    <Row label={props.label} labelId={labelId} description={props.description} stacked>
      <CommittedSlider
        labelledBy={labelId}
        value={Math.round(props.value * 100)}
        min={0}
        max={100}
        step={5}
        format={(percent) => (percent / 100).toFixed(2)}
        onCommit={(percent) => props.onCommit(percent / 100)}
      />
    </Row>
  )
}

// ───────────────────────── key ─────────────────────────

/**
 * The keys this deployment uses. What is shown is what the backend reports
 * (configured or not, never a value); adding, replacing and removing go
 * through the deployment's key provision. Where keys are not the client's
 * to provide, the cards only say whether the server has each.
 */
function KeySettings({ openRouter }: { openRouter: boolean }) {
  const keys = useKeyProvision()
  return (
    <Panel
      title="Keys"
      description={
        keys.canProvideKeys
          ? "Keys are kept in this browser's local secrets store, apart from your conversations, and each is sent only to its own provider. A key is never shown again after it is saved."
          : 'Keys are configured on the server. They cannot be seen or changed from here.'
      }
    >
      <KeyCard
        provider="openrouter"
        configured={openRouter}
        testId="key-status"
        configuredNote="Messages are sent with this key."
        missingNote="Messages cannot be sent until a key is added."
      />
    </Panel>
  )
}

function KeyCard(props: {
  provider: KeyProviderName
  configured: boolean
  testId: string
  configuredNote: string
  missingNote: string
}) {
  const keys = useKeyProvision()
  const openKeyPrompt = useUiState((state) => state.openKeyPrompt)
  const closeSettings = useUiState((state) => state.closeSettings)
  const [confirming, setConfirming] = useState(false)
  const name = 'OpenRouter'
  const { configured } = props

  function replace(): void {
    // One dialog at a time: the key prompt takes over from the settings.
    closeSettings()
    openKeyPrompt()
  }

  function remove(): void {
    setConfirming(false)
    void keys.remove(props.provider).then((result) => {
      if (!result.ok) toast.error('The key was not removed', { description: result.message })
    })
  }

  return (
    <div className="py-3.5 first:pt-0 last:pb-0" data-key-card={props.provider}>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface p-3.5">
        <div className="flex items-center gap-3">
          <span
            className={cn(
              'grid size-9 place-items-center rounded-full',
              configured ? 'bg-success-tint text-success' : 'bg-muted text-muted-foreground',
            )}
          >
            <KeyRoundIcon aria-hidden className="size-4" />
          </span>
          <div>
            <p className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">{name}</p>
            <p data-testid={props.testId} className="text-[0.8125rem] font-medium">
              {keys.canProvideKeys ? (configured ? 'Key configured' : 'No key') : configured ? 'Configured on the server' : 'Not configured on the server'}
            </p>
            <p className="text-xs text-muted-foreground">{configured ? props.configuredNote : props.missingNote}</p>
          </div>
        </div>
        {keys.canProvideKeys ? (
          <div className="ml-auto flex items-center gap-2">
            {configured ? (
              confirming ? (
                <>
                  <span className="text-xs text-muted-foreground">Remove the key?</span>
                  <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                    Keep
                  </Button>
                  <Button variant="destructive" size="sm" onClick={remove}>
                    Remove
                  </Button>
                </>
              ) : (
                <>
                  <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
                    Remove
                  </Button>
                  <Button variant="outline" size="sm" onClick={replace}>
                    Replace
                  </Button>
                </>
              )
            ) : (
              <Button size="sm" variant={props.provider === 'openrouter' ? 'default' : 'outline'} onClick={replace}>
                Add key
              </Button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

// ───────────────────────── debug views ─────────────────────────

export const DEBUG_VIEWS: readonly { key: DebugViewToggle; label: string; description: string }[] = [
  { key: 'miniMap', label: 'Mini-map', description: 'The genealogy of chains: what each run could read.' },
  {
    key: 'operationGraph',
    label: 'Operation graph',
    description: 'Live work and its result dependencies: what waits for what.',
  },
  {
    key: 'runInspector',
    label: 'Run inspector',
    description: 'For one run: its source, exact input, what it waits for, and the routing decision.',
  },
  {
    key: 'compareIndependent',
    label: 'Compare for independent composites',
    description: 'The original message beside each fragment. Compare for split messages is always available.',
  },
]

const COMPARE_PLACEMENT_OPTIONS: readonly { value: ComparePlacement; label: string; description: string }[] = [
  { value: 'sidebar', label: 'In the side panel', description: 'Compare opens beside the conversation.' },
  {
    value: 'inline',
    label: 'On the message',
    description: 'A card under the decomposed message, opened with “Show decomposition”. The side panel has no Compare tab.',
  },
]

function DebugSettings({ settings }: { settings: Settings }) {
  const change = useChangeSettings()
  const placementLabel = useId()
  return (
    <Panel
      title="Debug views"
      description="Inspection views for seeing how Pluribus handled a conversation. Margin rails, Focus and the split link are always on."
    >
      {DEBUG_VIEWS.map((view) => (
        <DebugRow
          key={view.key}
          label={view.label}
          description={view.description}
          checked={settings.debug[view.key]}
          onChange={(checked) => void change({ debug: { [view.key]: checked } })}
        />
      ))}
      <Row
        label="Where Compare is shown"
        labelId={placementLabel}
        description="For split messages, and for independent composites while their Compare is on."
        stacked
      >
        <ChoiceCards
          labelledBy={placementLabel}
          options={COMPARE_PLACEMENT_OPTIONS}
          value={settings.debug.comparePlacement}
          onChoose={(value) => void change({ debug: { comparePlacement: value } })}
          className="sm:grid-cols-2"
        />
      </Row>
    </Panel>
  )
}

function DebugRow(props: { label: string; description: string; checked: boolean; onChange(checked: boolean): void }) {
  const id = useId()
  return (
    <Row label={props.label} description={props.description} htmlFor={id}>
      <Switch id={id} checked={props.checked} onCheckedChange={props.onChange} className="mt-0.5" />
    </Row>
  )
}

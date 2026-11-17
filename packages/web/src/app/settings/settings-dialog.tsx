import {
  DEFAULT_SETTINGS,
  RETRY_POLICIES,
  type DebugToggles,
  type DecisionThresholds,
  type KeyProviderName,
  type ModelRoleChoice,
  type RetryPolicy,
  type Settings,
  type SettingsPatch,
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
                <ThresholdSettings settings={app.settings} />
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

export const DEBUG_VIEWS: readonly { key: keyof DebugToggles; label: string; description: string }[] = [
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

function DebugSettings({ settings }: { settings: Settings }) {
  const change = useChangeSettings()
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

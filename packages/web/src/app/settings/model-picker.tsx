import type { ModelRole } from '@committee/protocol'
import { ChevronsUpDownIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorName,
  ModelSelectorTrigger,
} from '@/components/ai-elements/model-selector'
import { Button } from '@/components/ui/button'
import { useAppEnvironment } from '../environment'
import { BUILT_IN_MODELS, formatContextLength, modelsForRole, type ModelOption } from '../models'

/**
 * The model for one role: a button showing the current model, opening the AI
 * Elements model selector over OpenRouter's model list. A model ID that is
 * not in the list can be typed and used as it is.
 */
export function ModelPicker(props: { role: ModelRole; label: string; value: string; onChange(model: string): void }) {
  const { loadModels } = useAppEnvironment()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [models, setModels] = useState<readonly ModelOption[]>(BUILT_IN_MODELS)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void loadModels().then((loaded) => {
      if (!cancelled) setModels(loaded)
    })
    return () => {
      cancelled = true
    }
  }, [open, loadModels])

  const groups = useMemo(() => {
    const byProvider = new Map<string, ModelOption[]>()
    for (const model of modelsForRole(props.role, models)) {
      byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), model])
    }
    // The current model's provider first, then alphabetically.
    const currentProvider = props.value.slice(0, props.value.indexOf('/'))
    return [...byProvider.entries()].sort(([a], [b]) =>
      a === currentProvider ? -1 : b === currentProvider ? 1 : a.localeCompare(b),
    )
  }, [models, props.role, props.value])

  const typed = query.trim()
  const typedIsNew = typed.includes('/') && !/\s/.test(typed) && !models.some((model) => model.id === typed)

  function choose(model: string): void {
    setOpen(false)
    setQuery('')
    if (model !== props.value) props.onChange(model)
  }

  return (
    <ModelSelector
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery('')
      }}
    >
      <ModelSelectorTrigger asChild>
        <Button
          variant="outline"
          aria-label={`${props.label} model: ${props.value}`}
          className="h-9 w-full justify-between gap-2 px-3 font-normal"
        >
          <span className="truncate font-mono text-[0.8125rem] tracking-tight">{props.value}</span>
          <ChevronsUpDownIcon className="size-3.5 text-faint-foreground" />
        </Button>
      </ModelSelectorTrigger>
      <ModelSelectorContent title={`Model for ${props.label.toLowerCase()}`} className="sm:max-w-md"
        overlayClassName="bg-black/10 supports-backdrop-filter:backdrop-blur-none dark:bg-black/20"
      >
        <ModelSelectorInput placeholder="Search models, or type an OpenRouter model ID…" value={query} onValueChange={setQuery} />
        <ModelSelectorList className="scroll-quiet max-h-80 p-1">
          <ModelSelectorEmpty>No model matches. Type a full ID such as provider/model to use it.</ModelSelectorEmpty>
          {typedIsNew ? (
            <ModelSelectorGroup heading="Use this ID">
              <ModelSelectorItem value={`use ${typed}`} onSelect={() => choose(typed)}>
                <ModelSelectorName className="font-mono text-[0.8125rem]">{typed}</ModelSelectorName>
              </ModelSelectorItem>
            </ModelSelectorGroup>
          ) : null}
          {groups.map(([provider, options]) => (
            <ModelSelectorGroup key={provider} heading={provider}>
              {options.map((model) => (
                <ModelSelectorItem
                  key={model.id}
                  value={`${model.id} ${model.name}`}
                  data-checked={model.id === props.value}
                  onSelect={() => choose(model.id)}
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <ModelSelectorName>{model.name}</ModelSelectorName>
                    <span className="truncate font-mono text-2xs text-muted-foreground">{model.id}</span>
                  </span>
                  {model.contextLength !== null ? (
                    <span className="tabular shrink-0 text-2xs text-faint-foreground">
                      {formatContextLength(model.contextLength)}
                    </span>
                  ) : null}
                </ModelSelectorItem>
              ))}
            </ModelSelectorGroup>
          ))}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  )
}

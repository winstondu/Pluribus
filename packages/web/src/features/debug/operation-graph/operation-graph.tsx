import type { OperationGraphProjection, OperationId, OperationStatus, OperationView } from '@committee/protocol'
import {
  BanIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleDashedIcon,
  CircleXIcon,
  GaugeIcon,
  GitMergeIcon,
  HourglassIcon,
  MessageCircleQuestionMarkIcon,
  PauseIcon,
  ReplaceIcon,
  RotateCwIcon,
  SquareIcon,
  UnplugIcon,
  type LucideIcon,
} from 'lucide-react'
import { useReducedMotion } from 'motion/react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useUiState } from '@/app/ui-state'
import { useApp, useChain, useOperationGraph } from '@/backend'
import { Button } from '@/components/ui/button'
import { chainColor } from '@/design/chains'
import { cn } from '@/lib/utils'
import { ChainName, Id, Row } from '../parts'
import { CARD, cubicBezier, edgePath, layoutOperations, type GraphEdge, type Point } from './layout'

/** Reflow: 240 ms on the app's ease-in-out curve (things moving on screen). The fade of a leaving card is 180 ms. */
const REFLOW_MS = 240
const LEAVE_MS = 180
const easeInOut = cubicBezier(0.77, 0, 0.175, 1)

/**
 * The operation graph (09 §4): live work and what it waits for. A column is
 * a dependency depth. Operations that complete fade out where they stood
 * while the rest move to their new places; every one that has left stays
 * inspectable from "Left the graph". The view never scrolls by itself.
 */
export function OperationGraphDrawer() {
  const graph = useOperationGraph()
  const selectedId = useUiState((state) => state.selectedOperation)
  const selectOperation = useUiState((state) => state.selectOperation)
  const [historyOpen, setHistoryOpen] = useState(false)
  const selected = selectedId ? graph.operations[selectedId] : undefined

  return (
    <div className="flex max-h-[48dvh] flex-col shell:max-h-[40dvh]" data-testid="operation-graph">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pt-2.5 pb-1.5">
        <h2 className="eyebrow">Operation graph</h2>
        <p className="tabular text-xs text-muted-foreground">
          {graph.active.length} live · left to right by what must finish first
        </p>
        <Legend />
        <button
          type="button"
          aria-expanded={historyOpen}
          aria-controls="operation-history"
          onClick={() => setHistoryOpen((open) => !open)}
          className="pressable ml-auto inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <span className="tabular">Left the graph · {graph.retired.length}</span>
          <ChevronDownIcon className={cn('size-3.5', historyOpen && 'rotate-180')} aria-hidden />
        </button>
      </div>
      {historyOpen ? (
        <ul
          id="operation-history"
          aria-label="Operations that left the graph"
          className="scroll-quiet flex max-h-[4.75rem] shrink-0 flex-wrap gap-1.5 overflow-y-auto px-4 pb-2.5"
        >
          {graph.retired.length === 0 ? <li className="text-xs text-muted-foreground">Nothing has left yet.</li> : null}
          {graph.retired.map((id) => {
            const operation = graph.operations[id]
            if (!operation) return null
            return (
              <li key={id} className="flex">
                <button
                  type="button"
                  aria-pressed={selectedId === id}
                  aria-label={`${operation.label}, ${operation.statusText.toLowerCase()}`}
                  data-operation-id={id}
                  onClick={() => selectOperation(selectedId === id ? null : id)}
                  className={cn(
                    'pressable inline-flex h-6 max-w-56 items-center gap-1.5 rounded-full border px-2 text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                    selectedId === id ? 'border-border-strong bg-background' : 'border-border text-muted-foreground hover:text-foreground',
                  )}
                >
                  <ChainDot operation={operation} />
                  <span className="truncate">{operation.label}</span>
                  <span className="shrink-0 text-faint-foreground">{operation.statusText.toLowerCase()}</span>
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col border-t border-border shell:flex-row">
        <GraphCanvas graph={graph} selectedId={selectedId} onSelect={(id) => selectOperation(selectedId === id ? null : id)} />
        <div className="scroll-quiet max-h-36 min-h-0 shrink overflow-y-auto border-t border-border shell:max-h-none shell:w-[19rem] shell:border-t-0 shell:border-l">
          {selected ? (
            <OperationDetail operation={selected} graph={graph} />
          ) : (
            <p className="px-4 py-3 text-xs leading-relaxed text-muted-foreground">
              Select an operation to see what it needs and what it is still waiting for.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function Legend() {
  return (
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground" aria-label="Legend">
      <li className="inline-flex items-center gap-1.5">
        <svg width="22" height="8" aria-hidden>
          <line x1="1" y1="4" x2="21" y2="4" strokeWidth="1.5" className="stroke-muted-foreground" />
        </svg>
        needs its result
      </li>
      <li className="inline-flex items-center gap-1.5">
        <svg width="22" height="8" aria-hidden>
          <line x1="1" y1="4" x2="21" y2="4" strokeWidth="1.5" strokeDasharray="1 4" strokeLinecap="round" className="stroke-muted-foreground" />
        </svg>
        held by its message’s barrier
      </li>
    </ul>
  )
}

function ChainDot({ operation }: { operation: OperationView }) {
  const color = useOperationChainColor(operation)
  return <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: color }} />
}

/** The operation's chain color. The chain association carries the same color index as the genealogy. */
function useOperationChainColor(operation: OperationView): string {
  return chainColor(useChain(operation.chainId)?.colorIndex ?? 0)
}

// ───────────────────────── status ─────────────────────────

/**
 * How each status reads on a card. A dependency wait, a rate limit
 * ("Waiting for capacity"), the concurrency limit and a pause each have
 * their own icon and tone, so one is never taken for another (Q47, Q60).
 */
const STATUS: Record<OperationStatus, { icon: LucideIcon | 'live'; tone: string }> = {
  'waiting-for-results': { icon: HourglassIcon, tone: 'text-muted-foreground' },
  paused: { icon: PauseIcon, tone: 'text-foreground' },
  'awaiting-answer': { icon: MessageCircleQuestionMarkIcon, tone: 'text-foreground' },
  'waiting-for-slot': { icon: CircleDashedIcon, tone: 'text-muted-foreground' },
  'waiting-for-capacity': { icon: GaugeIcon, tone: 'text-warning' },
  retrying: { icon: RotateCwIcon, tone: 'text-warning' },
  running: { icon: 'live', tone: 'text-foreground' },
  streaming: { icon: 'live', tone: 'text-foreground' },
  completed: { icon: CheckIcon, tone: 'text-success' },
  failed: { icon: CircleXIcon, tone: 'text-destructive' },
  stopped: { icon: SquareIcon, tone: 'text-foreground' },
  interrupted: { icon: UnplugIcon, tone: 'text-warning' },
  cancelled: { icon: BanIcon, tone: 'text-muted-foreground' },
  superseded: { icon: ReplaceIcon, tone: 'text-muted-foreground' },
  'group-open': { icon: GitMergeIcon, tone: 'text-muted-foreground' },
  formed: { icon: CheckIcon, tone: 'text-success' },
}

function StatusLine({ operation }: { operation: OperationView }) {
  const { icon: Icon, tone } = STATUS[operation.status]
  return (
    <span className={cn('flex min-w-0 items-center gap-1.5 text-2xs', tone)} data-status={operation.status}>
      {Icon === 'live' ? (
        <span aria-hidden className="mx-0.5 size-1.5 shrink-0 animate-pending rounded-full bg-current" />
      ) : (
        <Icon aria-hidden className="size-3 shrink-0" />
      )}
      <span className="truncate">{operation.statusText}</span>
    </span>
  )
}

const KIND_WORD = { answer: null, synthesis: 'synthesis', 'join-back': 'join-back' } as const

// ───────────────────────── canvas ─────────────────────────

interface Leaving {
  readonly operation: OperationView
  readonly edges: readonly GraphEdge[]
  /** Where it stood in the layout it left. */
  readonly at: Point | null
}

function GraphCanvas(props: {
  graph: OperationGraphProjection
  selectedId: OperationId | null
  onSelect(id: OperationId): void
}) {
  const { graph, selectedId } = props
  const layout = useMemo(() => layoutOperations(graph), [graph])
  const reduce = useReducedMotion() === true
  const cardEls = useRef(new Map<OperationId, HTMLElement>())
  const edgeEls = useRef(new Map<string, SVGPathElement>())
  /** Where each card is drawn right now, mid-flight included: a reflow that is interrupted carries on from here. */
  const shown = useRef(new Map<OperationId, Point>())
  const frame = useRef<number | null>(null)

  // Operations that just left the live graph stay drawn where they stood while they fade.
  const [previous, setPrevious] = useState(graph)
  const [leaving, setLeaving] = useState<readonly Leaving[]>([])
  if (previous !== graph) {
    setPrevious(graph)
    const gone = previous.active.filter((id) => !graph.active.includes(id))
    const before = gone.length > 0 ? layoutOperations(previous) : null
    setLeaving((current) => [
      ...current.filter((entry) => !graph.active.includes(entry.operation.id) && !gone.includes(entry.operation.id)),
      ...gone.flatMap((id) => {
        const operation = graph.operations[id] ?? previous.operations[id]
        if (!operation) return []
        const edges = (before?.edges ?? []).filter((edge) => edge.from === id || edge.to === id)
        return [{ operation, edges, at: before?.positions.get(id) ?? null }]
      }),
    ])
  }
  const removeLeaving = useCallback((id: OperationId) => {
    shown.current.delete(id)
    setLeaving((current) => current.filter((entry) => entry.operation.id !== id))
  }, [])
  useEffect(() => {
    if (leaving.length === 0) return
    // The fade's own end removes a card; this covers a browser that never reports it.
    const timer = window.setTimeout(() => {
      for (const entry of leaving) shown.current.delete(entry.operation.id)
      setLeaving((current) => current.filter((entry) => !leaving.includes(entry)))
    }, LEAVE_MS + 220)
    return () => window.clearTimeout(timer)
  }, [leaving])

  const leavingIds = leaving.map((entry) => entry.operation.id)
  const leavingEdges = leaving
    .flatMap((entry) => entry.edges)
    .filter((edge, index, all) => all.findIndex((other) => other.key === edge.key) === index)
    .filter((edge) => !layout.edges.some((live) => live.key === edge.key))
  const allEdges = [...layout.edges, ...leavingEdges]
  const edgeKeys = allEdges.map((edge) => edge.key).join('|')

  useLayoutEffect(() => {
    const edges = allEdges
    const draw = () => {
      for (const [id, point] of shown.current) {
        const element = cardEls.current.get(id)
        if (element) element.style.transform = `translate3d(${point.x}px, ${point.y}px, 0)`
      }
      for (const edge of edges) {
        const from = shown.current.get(edge.from)
        const to = shown.current.get(edge.to)
        const element = edgeEls.current.get(edge.key)
        if (from && to && element) element.setAttribute('d', edgePath(from, to))
      }
    }
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null

    const starts = new Map(shown.current)
    const moving =
      !reduce &&
      [...layout.positions].some(([id, target]) => {
        const start = starts.get(id)
        return start !== undefined && (start.x !== target.x || start.y !== target.y)
      })
    if (!moving) {
      for (const [id, target] of layout.positions) shown.current.set(id, target)
      draw()
      return
    }

    // A card that is new is drawn at its place at once; only cards already on screen travel.
    for (const [id, target] of layout.positions) {
      if (!starts.has(id)) shown.current.set(id, target)
    }
    draw()
    const began = performance.now()
    const tick = (now: number) => {
      const progress = Math.min(1, (now - began) / REFLOW_MS)
      const eased = easeInOut(progress)
      for (const [id, target] of layout.positions) {
        const start = starts.get(id)
        if (!start) continue
        shown.current.set(id, {
          x: start.x + (target.x - start.x) * eased,
          y: start.y + (target.y - start.y) * eased,
        })
      }
      // Cards and connectors are written in the same frame, so an edge never leaves its cards.
      draw()
      frame.current = progress < 1 ? requestAnimationFrame(tick) : null
    }
    frame.current = requestAnimationFrame(tick)
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current)
      frame.current = null
    }
    // `allEdges` is rebuilt every render; its keys say when it changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, edgeKeys, reduce])

  // Room for cards that are still fading beyond the new extent, so the scroll position is not pulled in under the reader.
  let width = layout.width
  let height = layout.height
  for (const { at } of leaving) {
    if (!at) continue
    width = Math.max(width, at.x + CARD.width + CARD.padding)
    height = Math.max(height, at.y + CARD.height + CARD.padding)
  }

  if (graph.active.length === 0 && leaving.length === 0) {
    return (
      <div className="grid min-h-24 flex-1 place-items-center px-4 py-5 text-xs text-muted-foreground">
        No live work. Everything that ran is under “Left the graph”.
      </div>
    )
  }

  return (
    <div
      className="scroll-quiet min-h-32 min-w-0 flex-1 overflow-auto"
      role="group"
      aria-label="Live operations by dependency depth"
      tabIndex={0}
    >
      <div className="relative" style={{ width, height }}>
        <svg width={width} height={height} className="pointer-events-none absolute inset-0" aria-hidden>
          <defs>
            <marker id="op-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M 1 1 L 7 4 L 1 7" fill="none" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className="stroke-muted-foreground" />
            </marker>
          </defs>
          {allEdges.map((edge) => {
            const fading = leavingIds.includes(edge.from) || leavingIds.includes(edge.to)
            return (
              <path
                key={edge.key}
                ref={(element) => {
                  if (element) edgeEls.current.set(edge.key, element)
                  else edgeEls.current.delete(edge.key)
                }}
                data-edge={edge.kind}
                data-from={edge.from}
                data-to={edge.to}
                data-unsatisfied={edge.unsatisfied}
                fill="none"
                strokeWidth={edge.kind === 'needs' && edge.unsatisfied ? 1.6 : 1.3}
                strokeLinecap="round"
                strokeDasharray={edge.kind === 'barrier' ? '1 5' : undefined}
                markerEnd="url(#op-arrow)"
                className={cn(
                  edge.kind === 'needs' && edge.unsatisfied ? 'stroke-muted-foreground' : 'stroke-border-strong',
                  edge.kind === 'barrier' && 'stroke-muted-foreground',
                  fading && 'debug-fade-out',
                )}
              />
            )
          })}
        </svg>
        {graph.active.map((id) => {
          const operation = graph.operations[id]
          if (!operation) return null
          return (
            <OperationCard
              key={id}
              operation={operation}
              selected={selectedId === id}
              onSelect={() => props.onSelect(id)}
              register={(element) => {
                if (element) cardEls.current.set(id, element)
                else cardEls.current.delete(id)
              }}
            />
          )
        })}
        {leaving.map(({ operation }) => (
          <OperationCard
            key={operation.id}
            operation={operation}
            selected={selectedId === operation.id}
            leaving
            onLeft={() => removeLeaving(operation.id)}
            register={(element) => {
              if (element) cardEls.current.set(operation.id, element)
              else cardEls.current.delete(operation.id)
            }}
          />
        ))}
      </div>
    </div>
  )
}

function OperationCard(props: {
  operation: OperationView
  selected: boolean
  leaving?: boolean
  onSelect?(): void
  onLeft?(): void
  register(element: HTMLElement | null): void
}) {
  const { operation, selected, leaving = false } = props
  const color = useOperationChainColor(operation)
  const kind = KIND_WORD[operation.kind]
  return (
    <button
      type="button"
      ref={props.register}
      aria-pressed={selected}
      aria-hidden={leaving || undefined}
      tabIndex={leaving ? -1 : undefined}
      data-operation-id={operation.id}
      data-leaving={leaving || undefined}
      data-held-by-barrier={operation.heldByBarrier || undefined}
      onClick={leaving ? undefined : props.onSelect}
      onAnimationEnd={leaving ? props.onLeft : undefined}
      style={{ width: CARD.width, height: CARD.height, borderLeftColor: color }}
      className={cn(
        'absolute top-0 left-0 flex flex-col justify-center gap-0.5 rounded-md border border-l-[3px] border-border bg-background px-2.5 text-left',
        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        leaving
          ? 'debug-fade-out pointer-events-none'
          : 'debug-fade-in hover:border-border-strong',
        selected && 'border-border-strong shadow-raised ring-1 ring-foreground/25',
        operation.kind === 'join-back' && 'border-dashed',
      )}
    >
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className={cn('truncate text-xs font-medium', operation.status === 'superseded' && 'line-through')}>
          {operation.label}
        </span>
        {kind ? <span className="shrink-0 text-2xs text-faint-foreground">{kind}</span> : null}
      </span>
      <StatusLine operation={operation} />
    </button>
  )
}

// ───────────────────────── detail ─────────────────────────

function OperationDetail({ operation, graph }: { operation: OperationView; graph: OperationGraphProjection }) {
  const debug = useApp()?.settings.debug
  const revealSection = useUiState((state) => state.revealSection)
  const inspect = useUiState((state) => state.inspect)
  const selectOperation = useUiState((state) => state.selectOperation)
  const neededBy = graph.active.filter((id) => graph.operations[id]?.dependsOn.includes(operation.id))
  const link = (id: OperationId) => {
    const other = graph.operations[id]
    return (
      <button
        key={id}
        type="button"
        onClick={() => selectOperation(id)}
        className="rounded-sm text-left underline decoration-border-strong underline-offset-2 hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {other?.label ?? id}
      </button>
    )
  }

  return (
    <div className="px-4 py-3" data-testid="operation-detail" data-operation-id={operation.id}>
      <h3 className="text-sm font-medium">{operation.label}</h3>
      <div className="mt-1">
        <StatusLine operation={operation} />
      </div>
      {operation.retired ? (
        <p className="mt-1 text-2xs text-muted-foreground">Left the live graph. Kept here for inspection.</p>
      ) : null}
      <dl className="mt-2">
        <Row label="Chain">
          <ChainName chainId={operation.chainId} />
        </Row>
        <Row label="Kind">
          {operation.kind === 'join-back'
            ? 'Join-back: bookkeeping, no model call, no slot'
            : operation.kind === 'synthesis'
              ? 'Synthesis run'
              : 'Answer run'}
        </Row>
        {operation.kind !== 'join-back' ? (
          <Row label="Attempts">
            <span className="tabular">{operation.attemptCount === 0 ? 'none yet' : operation.attemptCount}</span>
          </Row>
        ) : null}
        <Row label="Needs">
          {operation.dependsOn.length === 0 ? (
            'No other result'
          ) : (
            <ul data-testid="needs">
              {operation.dependsOn.map((id) => (
                <li key={id}>
                  {link(id)}{' '}
                  <span className="text-muted-foreground">
                    {operation.waitingFor.includes(id) ? '· not finished' : '· available'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Row>
        <Row label="Waiting for">
          {operation.waitingFor.length === 0 ? (
            operation.status === 'waiting-for-capacity' ? (
              'No result. Held by the provider’s rate limit'
            ) : operation.status === 'waiting-for-slot' ? (
              'No result. Held by the concurrency limit'
            ) : (
              'Nothing'
            )
          ) : (
            <ul data-testid="waiting-for">
              {operation.waitingFor.map((id) => (
                <li key={id}>{link(id)}</li>
              ))}
            </ul>
          )}
        </Row>
        {operation.heldByBarrier ? (
          <Row label="Barrier">
            <span data-testid="barrier-hold">
              Needs nothing itself. Held with the rest of its message, which waits for{' '}
              {operation.barrierWaitingFor.length === 0
                ? 'other work'
                : operation.barrierWaitingFor.map((id, index) => (
                    <span key={id}>
                      {index > 0 ? ', ' : ''}
                      {link(id)}
                    </span>
                  ))}
              .
            </span>
          </Row>
        ) : null}
        {neededBy.length > 0 ? (
          <Row label="Needed by">
            {neededBy.map((id, index) => (
              <span key={id}>
                {index > 0 ? ', ' : ''}
                {link(id)}
              </span>
            ))}
          </Row>
        ) : null}
        <Row label="ID">
          <Id>{operation.id}</Id>
        </Row>
      </dl>
      <div className="mt-2 flex flex-wrap gap-2">
        {operation.sectionId ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (operation.sectionId) revealSection(operation.sectionId)
            }}
          >
            Show in transcript
          </Button>
        ) : null}
        {debug?.runInspector && operation.directiveId ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (operation.directiveId) inspect({ directiveId: operation.directiveId, attemptId: operation.attemptId })
            }}
          >
            Inspect run
          </Button>
        ) : null}
      </div>
    </div>
  )
}

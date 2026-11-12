import type { ExchangeNodeView, GenealogyProjection, JoinBackNodeView, NodeId, NodeState, NodeView } from '@pluribus/protocol'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useUiState } from '@/app/ui-state'
import { useApp, useGenealogy } from '@/backend'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { chainColor } from '@/design/chains'
import { cn } from '@/lib/utils'
import { useDebugState } from '../debug-state'
import { CHAIN_KIND_WORD, ChainName, EmptyState, Id, Row } from '../parts'
import { ancestorsOf, chainRelations, laterOnSourceChains } from './ancestry'
import { MAP, layoutGenealogy, type PlacedNode } from './layout'

/**
 * The chain mini-map in the Genealogy layout (09 §1): one node per exchange,
 * an edge to each exact parent, context flowing downward. It answers "what
 * could this run read?" and nothing else: no edge here means waiting, and no
 * position here means order in the chat.
 */
export function MiniMap() {
  const genealogy = useGenealogy()
  const layout = useMemo(() => layoutGenealogy(genealogy), [genealogy])
  const selectedId = useDebugState((state) => state.selectedNodeId)
  const selectNode = useDebugState((state) => state.selectNode)
  const setKeepTab = useDebugState((state) => state.setKeepTab)
  const focus = useUiState((state) => state.focus)
  const previewFocus = useUiState((state) => state.previewFocus)
  const pinFocus = useUiState((state) => state.pinFocus)
  const inspect = useUiState((state) => state.inspect)

  const overflow = useSidewaysOverflow(layout.width)

  const selected = selectedId ? genealogy.nodes[selectedId] : undefined
  const activeChain = focus.preview ?? focus.pinned

  // What is brought forward: the selected node and its exact ancestry, or the focused chain and what its runs could read.
  const relation = useMemo(() => {
    if (selected && (activeChain === null || activeChain === selected.chainId)) {
      return { own: new Set<NodeId>([selected.id]), ancestors: new Set<NodeId>(ancestorsOf(genealogy, selected.id)) }
    }
    if (activeChain !== null) return chainRelations(genealogy, activeChain)
    return null
  }, [genealogy, selected, activeChain])
  const relationOf = (id: NodeId): 'own' | 'ancestor' | 'other' | 'none' =>
    relation === null ? 'none' : relation.own.has(id) ? 'own' : relation.ancestors.has(id) ? 'ancestor' : 'other'

  if (layout.nodes.length === 0) {
    return <EmptyState title="Nothing to map yet">Each exchange appears here once its request is placed on a chain.</EmptyState>
  }

  const select = (node: NodeView) => {
    if (selectedId === node.id) {
      selectNode(null)
      pinFocus(null)
      return
    }
    selectNode(node.id)
    pinFocus(node.chainId)
    if (node.kind === 'exchange') {
      // The run behind the node becomes the inspected run, without leaving the map.
      setKeepTab(true)
      inspect({ directiveId: node.directiveId, attemptId: node.attemptIds.at(-1) ?? null })
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-baseline justify-between gap-3 px-4 pt-3">
        <p className="text-xs text-muted-foreground">Context flows downward. An edge means “could read”.</p>
      </div>
      <div className="relative flex max-h-[58%] min-h-0 shrink-0 flex-col">
      <div ref={overflow.scroller} onScroll={overflow.measure} data-slot="mini-map-scroller" className="scroll-quiet min-h-0 overflow-auto px-2 pb-1">
        <svg
          role="group"
          aria-label="Genealogy of this conversation’s chains"
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          // Drawn at its own size where there is room; a little smaller before it has to scroll sideways.
          style={{ width: '100%', minWidth: Math.round(layout.width * 0.85), maxWidth: layout.width }}
          className="mx-auto block h-auto"
        >
          {layout.groups.map((group) => (
            <rect
              key={group.id}
              data-sibling-group={group.id}
              x={group.x}
              y={group.y}
              width={group.width}
              height={group.height}
              rx={Math.min(group.height, group.width) / 2}
              fill="none"
              strokeWidth={1.25}
              strokeDasharray="1.5 4.5"
              strokeLinecap="round"
              className="stroke-muted-foreground"
            >
              <title>Sibling group: these ran in parallel from the same starting context</title>
            </rect>
          ))}
          {layout.edges.map((edge) => {
            const dim = relation !== null && (relationOf(edge.from) === 'other' || relationOf(edge.to) === 'other')
            return (
              <EdgeMark
                key={edge.key}
                data={{ 'data-edge': edge.key, 'data-exact': edge.exact }}
                path={edge.path}
                tip={edge.tip}
                dashed={!edge.exact}
                dim={dim}
                color={chainColor(genealogy.chains[edge.chainId]?.colorIndex ?? 0)}
              />
            )
          })}
          {/* Planned on a group that has not joined back: from its oval, dashed, never a new root. */}
          {layout.plannedEdges.map((edge) => (
            <EdgeMark
              key={edge.key}
              data={{ 'data-planned-edge': edge.key, 'data-group': edge.groupId }}
              path={edge.path}
              tip={edge.tip}
              dashed
              dim={relation !== null && relationOf(edge.to) === 'other'}
              color={chainColor(genealogy.chains[edge.chainId]?.colorIndex ?? 0)}
            />
          ))}
          {layout.nodes.map((placed) => (
            <MapNode
              key={placed.node.id}
              placed={placed}
              genealogy={genealogy}
              relation={relationOf(placed.node.id)}
              selected={selectedId === placed.node.id}
              onSelect={() => select(placed.node)}
              onPreview={(on) => previewFocus(on ? placed.node.chainId : null)}
            />
          ))}
        </svg>
      </div>
        {/* The map is wider than the panel: a fade on the side where more of it lies. */}
        <OverflowFade side="left" shown={overflow.left} />
        <OverflowFade side="right" shown={overflow.right} />
      </div>
      <Legend />
      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto border-t border-border">
        {selected ? (
          <NodeDetail node={selected} genealogy={genealogy} />
        ) : (
          <p className="px-4 py-4 text-xs leading-relaxed text-muted-foreground">
            Select a node to see what its run could read. Hover or focus one for its IDs.
          </p>
        )}
      </div>
    </div>
  )
}

/** One edge with its arrowhead at the child, in the child's chain color. Dashed while nothing has been read along it. */
function EdgeMark(props: {
  data: Record<`data-${string}`, string | boolean>
  path: string
  tip: { x: number; y: number }
  dashed: boolean
  dim: boolean
  color: string
}) {
  const { tip } = props
  return (
    <g {...props.data} opacity={props.dim ? 0.22 : 1} style={{ color: props.color }}>
      <path
        d={props.path}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeDasharray={props.dashed ? '4 4' : undefined}
      />
      <path
        d={`M ${tip.x - 3.5} ${tip.y - 5} L ${tip.x} ${tip.y} L ${tip.x + 3.5} ${tip.y - 5}`}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
  )
}

/** Whether a sideways scroller has more to show on each side. Measured on scroll, on resize and when the content changes. */
function useSidewaysOverflow(contentKey: number) {
  const scroller = useRef<HTMLDivElement>(null)
  const [sides, setSides] = useState({ left: false, right: false })
  const measure = () => {
    const element = scroller.current
    if (!element) return
    const left = element.scrollLeft > 1
    const right = element.scrollLeft + element.clientWidth < element.scrollWidth - 1
    setSides((current) => (current.left === left && current.right === right ? current : { left, right }))
  }
  useEffect(() => {
    measure()
    const element = scroller.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [contentKey])
  return { scroller, measure, ...sides }
}

function OverflowFade({ side, shown }: { side: 'left' | 'right'; shown: boolean }) {
  return (
    <span
      aria-hidden
      data-slot="overflow-fade"
      data-side={side}
      data-shown={shown ? '' : undefined}
      className={cn(
        'pointer-events-none absolute inset-y-0 w-7 from-surface to-transparent opacity-0 transition-opacity duration-(--duration-fast) data-[shown]:opacity-100',
        side === 'left' ? 'left-0 bg-linear-to-r' : 'right-0 bg-linear-to-l',
      )}
    />
  )
}

/** Width of a label's backing, from its length: the map's type is set in px, so an estimate is steady. */
function labelWidth(text: string, perCharacter: number): number {
  return Math.ceil(text.length * perCharacter) + 8
}

const STATE_WORD: Record<NodeState, string> = {
  pending: 'not started',
  running: 'running',
  paused: 'paused for your answer',
  completed: 'completed',
  failed: 'failed',
  stopped: 'stopped',
  interrupted: 'interrupted',
  cancelled: 'cancelled',
  superseded: 'superseded',
}

const REASON_WORD: Record<ExchangeNodeView['reason'], string | null> = {
  initial: null,
  revision: 'replacement after a revision',
  'prerequisite-revised': 'restart after its prerequisite was revised',
  'retry-after-closure': 'retry after its group closed',
  regenerate: 'regenerated',
  redo: 'redone',
}

function nodeTitle(node: NodeView): string {
  return node.kind === 'join-back' ? 'join-back' : node.label
}

function clip(text: string, max = 12): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

function MapNode(props: {
  placed: PlacedNode
  genealogy: GenealogyProjection
  relation: 'own' | 'ancestor' | 'other' | 'none'
  selected: boolean
  onSelect(): void
  onPreview(on: boolean): void
}) {
  const { placed, genealogy, relation, selected } = props
  const { node, x, y } = placed
  const chain = genealogy.chains[node.chainId]
  const color = chainColor(chain?.colorIndex ?? 0)
  const state: NodeState | 'join-back' = node.kind === 'exchange' ? node.state : 'join-back'
  const replaced = node.replacedByNodeId !== null
  const faded = relation === 'other' ? 0.3 : 1
  const withdrawn =
    node.kind === 'exchange' && node.groupId !== null
      ? (genealogy.groups[node.groupId]?.withdrawnNodeIds.includes(node.id) ?? false)
      : false
  const second =
    node.kind === 'join-back'
      ? replaced
        ? 'replaced'
        : 'bookkeeping'
      : node.state === 'completed'
        ? null
        : withdrawn
          ? 'withdrawn'
          : STATE_WORD[node.state]
  const title = clip(nodeTitle(node))
  const backing = Math.max(labelWidth(title, 6.1), second ? labelWidth(second, 5.4) : 0)
  const name = `${nodeTitle(node)} · ${chain?.label ?? node.chainId} · ${
    node.kind === 'join-back' ? 'join-back, no model call' : STATE_WORD[node.state]
  }`

  const onKeyDown = (event: KeyboardEvent<SVGGElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      props.onSelect()
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <g
          role="button"
          tabIndex={0}
          aria-label={name}
          aria-pressed={selected}
          data-node-id={node.id}
          data-kind={node.kind}
          data-state={state}
          data-chain={node.chainId}
          data-relation={relation}
          data-replaced={replaced || undefined}
          className="group cursor-pointer outline-none"
          opacity={faded}
          style={{ color }}
          onClick={props.onSelect}
          onKeyDown={onKeyDown}
          onPointerEnter={() => props.onPreview(true)}
          onPointerLeave={() => props.onPreview(false)}
          onFocus={() => props.onPreview(true)}
          onBlur={() => props.onPreview(false)}
        >
          {/* A generous target; the mark itself is small. */}
          <rect x={x - 38} y={y - 16} width={76} height={58} fill="transparent" />
          <circle
            cx={x}
            cy={y}
            r={MAP.radius + 5}
            fill="none"
            strokeWidth={1.5}
            className={cn(
              'stroke-foreground opacity-0 group-focus-visible:opacity-100',
              selected && 'opacity-100',
              relation === 'ancestor' && !selected && 'stroke-border-strong opacity-100',
            )}
            strokeDasharray={selected ? undefined : relation === 'ancestor' ? '2 3' : undefined}
          />
          {node.kind === 'join-back' ? (
            <JoinBackMark x={x} y={y} replaced={replaced} />
          ) : (
            <ExchangeMark x={x} y={y} state={node.state} />
          )}
          {/*
            Labels are drawn over the edges, on a backing in the panel's color, so an edge that passes behind a
            label is interrupted by it instead of running through the letters.
          */}
          <rect
            data-slot="label-backing"
            x={x - backing / 2}
            y={y + MAP.radius + 5}
            width={backing}
            height={second ? 27 : 14}
            rx={3}
            className="fill-surface"
          />
          <text
            x={x}
            y={y + MAP.radius + MAP.label.first}
            textAnchor="middle"
            className={cn('fill-foreground stroke-surface text-[11px]', node.kind === 'exchange' && node.state === 'superseded' && 'line-through')}
            strokeWidth={3}
            strokeLinejoin="round"
            style={{ paintOrder: 'stroke' }}
          >
            {title}
          </text>
          {second ? (
            <text
              x={x}
              y={y + MAP.radius + MAP.label.second}
              textAnchor="middle"
              className="fill-muted-foreground stroke-surface text-[10px]"
              strokeWidth={3}
              strokeLinejoin="round"
              style={{ paintOrder: 'stroke' }}
            >
              {second}
            </text>
          ) : null}
        </g>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-64">
        <NodeIds node={node} />
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * The mark of an exchange. The fill is the chain's color and means only the
 * chain; how the work stands is said by shape, in ink, and in words under
 * the node. History is kept: nothing here is ever left out for having
 * failed, been stopped, been interrupted or been superseded.
 */
function ExchangeMark({ x, y, state }: { x: number; y: number; state: NodeState }) {
  const r = MAP.radius
  if (state === 'completed') return <circle cx={x} cy={y} r={r} fill="currentColor" />
  if (state === 'superseded') {
    return (
      <>
        <circle cx={x} cy={y} r={r} fill="currentColor" opacity={0.35} />
        <line x1={x - r - 3} y1={y + r + 3} x2={x + r + 3} y2={y - r - 3} strokeWidth={1.75} strokeLinecap="round" className="stroke-foreground" />
      </>
    )
  }
  if (state === 'pending') {
    return <circle cx={x} cy={y} r={r - 0.75} strokeWidth={1.5} stroke="currentColor" strokeDasharray="3 3" className="fill-surface" />
  }
  return (
    <>
      <circle cx={x} cy={y} r={r - 1} strokeWidth={2} stroke="currentColor" className="fill-surface" />
      {state === 'running' ? <circle cx={x} cy={y} r={4} fill="currentColor" className="animate-pending" /> : null}
      {state === 'failed' ? (
        <path
          d={`M ${x - 4} ${y - 4} L ${x + 4} ${y + 4} M ${x + 4} ${y - 4} L ${x - 4} ${y + 4}`}
          strokeWidth={2}
          strokeLinecap="round"
          className="stroke-destructive"
        />
      ) : null}
      {state === 'stopped' ? <rect x={x - 3.5} y={y - 3.5} width={7} height={7} rx={1} className="fill-foreground" /> : null}
      {state === 'interrupted' ? (
        <path
          d={`M ${x - 5} ${y + 2} L ${x - 1.5} ${y - 3} L ${x + 1.5} ${y + 3} L ${x + 5} ${y - 2}`}
          fill="none"
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="stroke-foreground"
        />
      ) : null}
      {state === 'cancelled' ? (
        <line x1={x - 4.5} y1={y} x2={x + 4.5} y2={y} strokeWidth={2} strokeLinecap="round" className="stroke-foreground" />
      ) : null}
    </>
  )
}

/** A join-back is bookkeeping on the chain the siblings forked from: a small open diamond in that chain's color. */
function JoinBackMark({ x, y, replaced }: { x: number; y: number; replaced: boolean }) {
  const s = 8
  return (
    <path
      d={`M ${x} ${y - s} L ${x + s} ${y} L ${x} ${y + s} L ${x - s} ${y} Z`}
      strokeWidth={2}
      stroke="currentColor"
      strokeLinejoin="round"
      className="fill-surface"
      opacity={replaced ? 0.4 : 1}
    />
  )
}

function NodeIds({ node }: { node: NodeView }) {
  const planned = node.kind === 'exchange' ? (node.plannedGroupIds ?? []) : []
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 font-mono text-2xs">
      <dt className="opacity-70">node</dt>
      <dd>{node.id}</dd>
      <dt className="opacity-70">chain</dt>
      <dd>{node.chainId}</dd>
      {node.kind === 'exchange' ? (
        <>
          <dt className="opacity-70">directive</dt>
          <dd>{node.directiveId}</dd>
        </>
      ) : (
        <>
          <dt className="opacity-70">join-back</dt>
          <dd>{node.joinBackId}</dd>
        </>
      )}
      <dt className="opacity-70">parents</dt>
      <dd>{node.parents.length > 0 ? node.parents.join(', ') : planned.length > 0 ? 'none yet' : 'none (a root)'}</dd>
      {planned.length > 0 ? (
        <>
          <dt className="opacity-70">planned on</dt>
          <dd>{planned.join(', ')}</dd>
        </>
      ) : null}
    </dl>
  )
}

function Legend() {
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 px-4 pb-2.5 text-2xs text-muted-foreground" aria-label="Legend">
      <li className="inline-flex items-center gap-1">
        <svg width="10" height="10" aria-hidden>
          <circle cx="5" cy="5" r="4.5" className="fill-muted-foreground" />
        </svg>
        exchange
      </li>
      <li className="inline-flex items-center gap-1">
        <svg width="10" height="10" aria-hidden>
          <path d="M5 0.8 L9.2 5 L5 9.2 L0.8 5 Z" fill="none" strokeWidth="1.5" className="stroke-muted-foreground" />
        </svg>
        join-back
      </li>
      <li className="inline-flex items-center gap-1">
        <svg width="16" height="10" aria-hidden>
          <rect x="1" y="1" width="14" height="8" rx="4" fill="none" strokeWidth="1.25" strokeDasharray="1.5 3" strokeLinecap="round" className="stroke-muted-foreground" />
        </svg>
        ran in parallel
      </li>
      <li className="inline-flex items-center gap-1">
        <svg width="14" height="10" aria-hidden>
          <line x1="1" y1="5" x2="13" y2="5" strokeWidth="1.5" strokeDasharray="3 3" className="stroke-muted-foreground" />
        </svg>
        planned, not started
      </li>
    </ul>
  )
}

/** Names of nodes, root first. An exchange that did not finish is named with what was read of it: never its text. */
function labels(genealogy: GenealogyProjection, ids: readonly NodeId[]): string {
  return ids
    .map((id) => {
      const node = genealogy.nodes[id]
      if (!node) return id
      if (node.kind === 'exchange' && UNFINISHED.includes(node.state)) {
        return `${nodeTitle(node)} (${node.state}: request and marker only)`
      }
      return nodeTitle(node)
    })
    .join(' → ')
}

const UNFINISHED: readonly NodeState[] = ['failed', 'stopped', 'interrupted', 'cancelled']

function NodeDetail({ node, genealogy }: { node: NodeView; genealogy: GenealogyProjection }) {
  const debug = useApp()?.settings.debug
  const inspect = useUiState((state) => state.inspect)
  const revealSection = useUiState((state) => state.revealSection)
  const setTab = useDebugState((state) => state.setTab)
  const chain = genealogy.chains[node.chainId]
  const ancestors = ancestorsOf(genealogy, node.id)
  const later = laterOnSourceChains(genealogy, node.id)

  return (
    <div className="px-4 py-3" data-testid="node-detail">
      <h3 className="text-sm font-medium">{nodeTitle(node)}</h3>
      <p className="mt-0.5 text-xs text-muted-foreground">
        <ChainName chainId={node.chainId} />
      </p>
      <dl className="mt-2">
        {node.kind === 'exchange' ? (
          <ExchangeRows node={node} genealogy={genealogy} ancestors={ancestors} later={later} />
        ) : (
          <JoinBackRows node={node} genealogy={genealogy} />
        )}
        <Row label="IDs">
          <span className="flex flex-col gap-0.5">
            <Id>{node.id}</Id>
            <Id>{node.chainId}</Id>
            {node.kind === 'exchange' ? <Id>{node.directiveId}</Id> : <Id>{node.joinBackId}</Id>}
          </span>
        </Row>
      </dl>
      {node.kind === 'exchange' ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {node.sectionId ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (node.sectionId) revealSection(node.sectionId)
              }}
            >
              Show in transcript
            </Button>
          ) : null}
          {debug?.runInspector ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                inspect({ directiveId: node.directiveId, attemptId: node.attemptIds.at(-1) ?? null })
                setTab('run')
              }}
            >
              Inspect run
            </Button>
          ) : null}
        </div>
      ) : null}
      {chain?.kind === 'join' && node.kind === 'exchange' && node.parents.length > 1 ? (
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          A join chain reads the exact nodes it was created from. Its source chains carry on independently, and what it
          inherited does not grow when they do.
        </p>
      ) : null}
    </div>
  )
}

function ExchangeRows(props: {
  node: ExchangeNodeView
  genealogy: GenealogyProjection
  ancestors: readonly NodeId[]
  later: readonly NodeId[]
}) {
  const { node, genealogy, ancestors, later } = props
  const chain = genealogy.chains[node.chainId]
  const group = node.groupId ? genealogy.groups[node.groupId] : undefined
  const siblings = group ? group.memberNodeIds.filter((id) => id !== node.id && id !== node.replacesNodeId && id !== node.replacedByNodeId) : []
  const reason = REASON_WORD[node.reason]
  // Retries that ran after a group closed are read with the join-back's record, when they had completed in time.
  const tails = ancestors.flatMap((id) => {
    const ancestor = genealogy.nodes[id]
    return ancestor?.kind === 'join-back' ? ancestor.lateRetryNodeIds.filter((tail) => tail !== node.id) : []
  })
  const notRead = later.filter((id) => !tails.includes(id))
  const started = node.parentsExact
  // Open groups it is planned on: their join-back, which does not exist yet, will be read.
  const plannedOn = (node.plannedGroupIds ?? []).flatMap((groupId) => {
    const planned = genealogy.groups[groupId]
    if (!planned) return []
    const members = planned.memberNodeIds.filter((id) => !planned.withdrawnNodeIds.includes(id))
    return [`the join-back of ${members.map((id) => nodeTitle(genealogy.nodes[id] ?? node)).join(' + ')}`]
  })

  return (
    <>
      <Row label="Work">
        {STATE_WORD[node.state]}
        {reason ? ` · ${reason}` : ''}
        {chain ? ` · on a ${CHAIN_KIND_WORD[chain.kind]}` : ''}
      </Row>
      <Row label={started ? 'Could read' : 'Will read'}>
        <span data-testid="could-read">
          {plannedOn.length > 0
            ? [...(ancestors.length > 0 ? [labels(genealogy, ancestors)] : []), ...plannedOn].join(', then ')
            : ancestors.length > 0
              ? labels(genealogy, ancestors)
              : 'Nothing before it: this is the start of a chain.'}
        </span>
        {plannedOn.length > 0 ? (
          <span className="mt-0.5 block text-muted-foreground">
            Its group is still running. The join-back forms when every member has finished.
          </span>
        ) : null}
        {!started ? (
          <span className="mt-0.5 block text-muted-foreground">
            Planned. Its exact context is recorded when its run starts, and it reads no answer that has not finished.
          </span>
        ) : null}
      </Row>
      {siblings.length > 0 ? (
        <Row label="In parallel with">
          <span data-testid="parallel-with">{siblings.map((id) => nodeTitle(genealogy.nodes[id] ?? node)).join(', ')}</span>
          <span className="mt-0.5 block text-muted-foreground">
            Same starting context. None of them read another’s answer.
          </span>
        </Row>
      ) : null}
      {tails.length > 0 ? (
        <Row label="After the record">
          {labels(genealogy, tails)}
          <span className="mt-0.5 block text-muted-foreground">
            A retry that finished after its group closed is read after the join-back’s record, if it had completed when
            this run started. The run inspector shows the exact input.
          </span>
        </Row>
      ) : null}
      {notRead.length > 0 ? (
        <Row label="Did not read">
          <span data-testid="did-not-read">{notRead.map((id) => nodeTitle(genealogy.nodes[id] ?? node)).join(', ')}</span>
          <span className="mt-0.5 block text-muted-foreground">Added to a chain it read from, outside what it read.</span>
        </Row>
      ) : null}
      {node.replacedByNodeId ? (
        <Row label="Replaced by">{nodeTitle(genealogy.nodes[node.replacedByNodeId] ?? node)} · kept as history</Row>
      ) : null}
      {node.replacesNodeId ? <Row label="Replaces">{nodeTitle(genealogy.nodes[node.replacesNodeId] ?? node)}</Row> : null}
      {node.attemptIds.length > 0 ? (
        <Row label="Attempts">
          {node.attemptIds.length === 1 ? '1 ran on this node' : `${node.attemptIds.length} ran on this node`}
        </Row>
      ) : null}
    </>
  )
}

const OUTCOME_WORD = {
  completed: 'its exchange',
  failed: 'its request and a “failed” marker',
  stopped: 'its request and a “stopped” marker',
  interrupted: 'its request and an “interrupted” marker',
  cancelled: 'its request and a “cancelled” marker',
} as const

function JoinBackRows({ node, genealogy }: { node: JoinBackNodeView; genealogy: GenealogyProjection }) {
  return (
    <>
      <Row label="What it is">
        Bookkeeping, not a model call. It records the parallel exchanges, in the order they were sent, for work that
        continues this chain.
      </Row>
      <Row label="Record">
        <ol className="list-decimal pl-4" data-testid="join-back-record">
          {node.members.map((member) => (
            <li key={member.nodeId}>
              {member.label}: {OUTCOME_WORD[member.outcome]}
            </li>
          ))}
        </ol>
      </Row>
      {node.lateRetryNodeIds.length > 0 ? (
        <Row label="Read after it">
          {labels(genealogy, node.lateRetryNodeIds)}
          <span className="mt-0.5 block text-muted-foreground">Retries that ran after the group closed.</span>
        </Row>
      ) : null}
      {node.replacedByNodeId ? <Row label="Replaced">A later record for the same group stands in for this one.</Row> : null}
    </>
  )
}

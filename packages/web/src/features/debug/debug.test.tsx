import { DEFAULT_SETTINGS, WORDING, type OperationStatus } from '@pluribus/protocol'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { fx, getFixture, type Fixture } from '@/fixtures'
import { renderWithBackend } from '@/test/render'
import { listDecompositions } from './compare/compare'
import { segmentText } from './compare/spans'
import { useDebugState } from './debug-state'
import { debugApp } from './fixture-support'
import { DebugSidePanel, OperationGraphDrawer } from './index'
import { ancestorsOf, laterOnSourceChains } from './mini-map/ancestry'
import { layoutGenealogy } from './mini-map/layout'
import { MiniMap } from './mini-map/mini-map'
import { layoutOperations } from './operation-graph/layout'
import { RunInspector } from './run-inspector/run-inspector'

function fixture(id: string): Fixture {
  const found = getFixture(id)
  if (!found) throw new Error(`missing fixture ${id}`)
  return found
}

const node = (name: string) => `[data-node-id="${fx.id('node', name)}"]`
const operation = (name: string) => `[data-operation-id="${fx.id('operation', name)}"]`
const one = (container: ParentNode, selector: string): Element => {
  const found = container.querySelector(selector)
  if (!found) throw new Error(`nothing matches ${selector}`)
  return found
}

beforeEach(() => useDebugState.getState().reset(null))
afterEach(() => vi.restoreAllMocks())

describe('chain mini-map', () => {
  test('C3 (web) · no view claims a fork consumed its sibling’s unfinished answer', async () => {
    // The abstract is running and the bio is between retries: two forks from the talk brief.
    const map = renderWithBackend(<MiniMap />, { fixture: fixture('operation-states') })
    await act(() => map.ready)
    fireEvent.click(one(map.container, node('bio')))
    expect(screen.getByTestId('could-read')).toHaveTextContent(/^talk brief$/)
    expect(screen.getByTestId('parallel-with')).toHaveTextContent('abstract')
    expect(screen.getByText(/None of them read another’s answer/)).toBeInTheDocument()
    // Edges are exactly the projected parents: brief → abstract and brief → bio, and nothing between the siblings.
    const edges = [...map.container.querySelectorAll('[data-edge]')].map((edge) => edge.getAttribute('data-edge'))
    expect(edges.sort()).toEqual([`${fx.id('node', 'brief')}>${fx.id('node', 'abstract')}`, `${fx.id('node', 'brief')}>${fx.id('node', 'bio')}`].sort())
    expect(one(map.container, node('abstract'))).toHaveAttribute('data-relation', 'other')
    map.unmount()

    // The operation graph draws no dependency between them either.
    const graph = renderWithBackend(<OperationGraphDrawer />, { fixture: fixture('operation-states') })
    await act(() => graph.ready)
    expect(graph.container.querySelector(`[data-edge][data-from="${fx.id('operation', 'abstract')}"][data-to="${fx.id('operation', 'bio')}"]`)).toBeNull()
    expect(graph.container.querySelector(`[data-edge][data-from="${fx.id('operation', 'bio')}"][data-to="${fx.id('operation', 'abstract')}"]`)).toBeNull()
    graph.unmount()

    // And a fork's recorded input holds the brief and its own request: nothing of its sibling.
    const run = renderWithBackend(<RunInspector />, { fixture: fixture('run-inspection') })
    await act(() => run.ready)
    act(() => run.ui.getState().inspect({ directiveId: fx.id('directive', 'stay'), attemptId: null }))
    const input = await screen.findByTestId('model-input')
    expect(within(input).getAllByRole('listitem')).toHaveLength(4)
    expect(input).not.toHaveTextContent('Cervejaria Ramiro')
    expect(input).not.toHaveTextContent('Which seafood places')
    expect(within(screen.getByTestId('ancestry')).getAllByRole('listitem')).toHaveLength(1)
  })

  test('ancestry is the exact parents: later continuations of a source chain are not shown as read', async () => {
    const { ready, container } = renderWithBackend(<MiniMap />, { fixture: fixture('genealogy-marks') })
    await act(() => ready)
    fireEvent.click(one(container, node('announcement')))

    // A join chain with three parents, each drawn as a real edge to the exact leaf.
    const into = [...container.querySelectorAll('[data-edge]')]
      .map((edge) => edge.getAttribute('data-edge') ?? '')
      .filter((key) => key.endsWith(`>${fx.id('node', 'announcement')}`))
    expect(into.sort()).toEqual(
      ['plan-revised', 'faq', 'audience'].map((name) => `${fx.id('node', name)}>${fx.id('node', 'announcement')}`).sort(),
    )
    expect(container.querySelector(`[data-edge="${fx.id('node', 'personas')}>${fx.id('node', 'announcement')}"]`)).toBeNull()

    // The audience answer is ancestry; what the audience chain did afterwards is not.
    expect(one(container, node('audience'))).toHaveAttribute('data-relation', 'ancestor')
    expect(one(container, node('personas'))).toHaveAttribute('data-relation', 'other')
    expect(one(container, node('channels'))).toHaveAttribute('data-relation', 'other')
    expect(screen.getByTestId('could-read')).not.toHaveTextContent('personas')
    expect(screen.getByTestId('did-not-read')).toHaveTextContent('personas, channels')
    // The superseded plan is not in what the join chain reads; its replacement is.
    expect(one(container, node('plan'))).toHaveAttribute('data-relation', 'other')
    expect(one(container, node('plan-revised'))).toHaveAttribute('data-relation', 'ancestor')
    // Members that did not finish were read as a request and a marker, never as text.
    expect(screen.getByTestId('could-read')).toHaveTextContent('pricing (failed: request and marker only)')
  })

  test('a reply to one sibling does not inherit the other', async () => {
    const snapshot = fixture('trip').initial
    const ancestors = ancestorsOf(snapshot.genealogy, fx.id('node', 'B2'))
    expect(ancestors).toEqual([fx.id('node', 'brief'), fx.id('node', 'B')])
    // J, added to the trip chain after the brief, is a later continuation of a chain B2 read from.
    expect(laterOnSourceChains(snapshot.genealogy, fx.id('node', 'B2'))).toContain(fx.id('node', 'J'))
    expect(ancestorsOf(snapshot.genealogy, fx.id('node', 'J'))).toEqual(
      ['brief', 'A', 'B', 'join-back'].map((name) => fx.id('node', name)),
    )
  })

  test('history is retained: failed, stopped, interrupted, cancelled and superseded nodes stay, marked', async () => {
    const { ready, container } = renderWithBackend(<MiniMap />, { fixture: fixture('genealogy-marks') })
    await act(() => ready)
    const snapshot = fixture('genealogy-marks').initial
    // One node per node of the projection: nothing is left out for how it ended.
    expect(container.querySelectorAll('[data-node-id]')).toHaveLength(snapshot.genealogy.nodeIds.length)
    const states: [string, string][] = [
      ['pricing', 'failed'],
      ['risks', 'stopped'],
      ['personas', 'interrupted'],
      ['channels', 'cancelled'],
      ['plan', 'superseded'],
      ['announcement', 'running'],
      ['checklist', 'pending'],
    ]
    for (const [name, state] of states) {
      const element = one(container, node(name))
      expect(element).toHaveAttribute('data-state', state)
      expect(element).toHaveAccessibleName(expect.stringContaining(state === 'pending' ? 'not started' : state))
    }
    // The siblings stay inside one dotted, unfilled oval after joining back.
    const oval = one(container, '[data-sibling-group]')
    expect(oval).toHaveAttribute('fill', 'none')
    expect(oval).toHaveAttribute('stroke-dasharray')
    // The join-back is bookkeeping on the chain the siblings forked from, in that chain's color.
    const joinBack = one(container, node('join-back')) as HTMLElement
    expect(joinBack).toHaveAttribute('data-chain', fx.id('chain', 'launch'))
    expect(joinBack.style.color).toBe((one(container, node('brief')) as HTMLElement).style.color)
    expect((one(container, node('announcement')) as HTMLElement).style.color).not.toBe(joinBack.style.color)
    fireEvent.click(joinBack)
    const record = within(screen.getByTestId('join-back-record')).getAllByRole('listitem')
    expect(record.map((item) => item.textContent)).toEqual([
      'tagline: its exchange',
      'pricing: its request and a “failed” marker',
      'risks: its request and a “stopped” marker',
    ])
    expect(screen.getByText(/not a model call/)).toBeInTheDocument()
  })

  test('selecting a node pins Focus on its chain and inspects its run without leaving the map; IDs show on focus', async () => {
    const user = userEvent.setup()
    const { ready, container, ui } = renderWithBackend(<DebugSidePanel />, { fixture: fixture('genealogy-marks') })
    await act(() => ready)
    const faq = one(container, node('faq')) as HTMLElement
    await user.click(faq)
    expect(ui.getState().focus.pinned).toBe(fx.id('chain', 'faq'))
    expect(ui.getState().inspected).toEqual({ directiveId: fx.id('directive', 'faq'), attemptId: fx.id('attempt', 'faq-1') })
    expect(screen.getByRole('tab', { name: 'Mini-map' })).toHaveAttribute('aria-selected', 'true')
    expect(faq).toHaveAttribute('aria-pressed', 'true')

    // Focus pinned from the transcript brings the same chain forward here, once the pointer's own preview is over.
    await user.unhover(faq)
    act(() => ui.getState().pinFocus(fx.id('chain', 'audience')))
    expect(one(container, node('personas'))).toHaveAttribute('data-relation', 'own')
    expect(one(container, node('faq'))).toHaveAttribute('data-relation', 'other')

    // Exact IDs on keyboard focus, not only on hover.
    act(() => (one(container, node('pricing')) as HTMLElement).focus())
    const tip = await screen.findByRole('tooltip')
    expect(tip).toHaveTextContent(fx.id('node', 'pricing'))
    expect(tip).toHaveTextContent(fx.id('chain', 'pricing'))
    expect(ui.getState().focus.preview).toBe(fx.id('chain', 'pricing'))

    // From the map to the run inspector.
    await user.click(faq)
    await user.click(faq)
    await user.click(screen.getByRole('button', { name: 'Inspect run' }))
    expect(screen.getByRole('tab', { name: 'Run' })).toHaveAttribute('aria-selected', 'true')
  })

  test('09 §1 · work planned on an open group is drawn below it with a dashed edge from its oval, never as a root', async () => {
    const { ready, container, backend } = renderWithBackend(<MiniMap />, { fixture: fixture('planned-on-group') })
    await act(() => ready)
    const group = fx.id('siblingGroup', 'forks')
    const page = fx.id('node', 'page')
    const joinBack = fx.id('node', 'join-back')
    const plannedEdges = () => [...container.querySelectorAll('[data-planned-edge]')]
    const edgesInto = (id: string) =>
      [...container.querySelectorAll('[data-edge]')].filter((edge) => edge.getAttribute('data-edge')?.endsWith(`>${id}`))

    // The group is open: one dashed edge from its oval to the page, and no node edge into the page.
    expect(plannedEdges().map((edge) => edge.getAttribute('data-planned-edge'))).toEqual([`${group}>${page}`])
    expect(one(plannedEdges()[0] as Element, 'path')).toHaveAttribute('stroke-dasharray')
    expect(edgesInto(page)).toEqual([])

    // Not a root: below the siblings, with the row where the join-back will form left free.
    const layout = layoutGenealogy(fixture('planned-on-group').initial.genealogy)
    const row = (name: string) => layout.byId.get(fx.id('node', name))?.row ?? -1
    expect(row('page')).toBe(Math.max(row('abstract'), row('bio')) + 2)
    expect(layout.byId.get(page)?.column).toBe(layout.byId.get(fx.id('node', 'brief'))?.column)

    // The detail says what it will read without inventing a parent.
    fireEvent.click(one(container, node('page')))
    expect(screen.getByTestId('could-read')).toHaveTextContent('the join-back of abstract + speaker bio')

    // The group closes: the join-back is the page's parent, and the planned edge is gone, with no duplicate.
    act(() => {
      backend?.step()
    })
    expect(plannedEdges()).toHaveLength(0)
    expect(edgesInto(page).map((edge) => edge.getAttribute('data-edge'))).toEqual([`${joinBack}>${page}`])
    expect(one(container, `[data-edge="${joinBack}>${page}"]`)).toHaveAttribute('data-exact', 'false')
    const closed = layoutGenealogy(backend?.current.genealogy ?? fixture('planned-on-group').initial.genealogy)
    expect(closed.byId.get(page)?.row).toBe(row('page'))
    expect(closed.byId.get(joinBack)?.row).toBe(row('page') - 1)

    // The page starts: the one edge into it is solid.
    act(() => {
      backend?.step()
    })
    expect(plannedEdges()).toHaveLength(0)
    expect(edgesInto(page)).toHaveLength(1)
    const solid = one(container, `[data-edge="${joinBack}>${page}"]`)
    expect(solid).toHaveAttribute('data-exact', 'true')
    expect(one(solid, 'path')).not.toHaveAttribute('stroke-dasharray')
  })

  test('layout: every node has its own place, a chain keeps its column, and the join-back sits on the base chain', () => {
    for (const id of ['trip', 'genealogy-marks', 'run-inspection', 'planned-on-group']) {
      const { genealogy } = fixture(id).initial
      const layout = layoutGenealogy(genealogy)
      const cells = layout.nodes.map((placed) => `${placed.column}:${placed.row}`)
      expect(new Set(cells).size).toBe(cells.length)
      for (const placed of layout.nodes) {
        for (const parent of placed.node.parents) {
          expect(layout.byId.get(parent)?.row).toBeLessThan(placed.row)
        }
      }
      expect(layout.edges).toHaveLength(Object.values(genealogy.nodes).reduce((sum, entry) => sum + entry.parents.length, 0))
    }
    const layout = layoutGenealogy(fixture('trip').initial.genealogy)
    const column = (name: string) => layout.byId.get(fx.id('node', name))?.column
    expect(column('join-back')).toBe(column('brief'))
    expect(column('J')).toBe(column('brief'))
    expect(column('A')).not.toBe(column('B'))
  })
})

describe('debug toggles', () => {
  test('each view exists only behind its toggle; Compare also whenever a decomposition is open', async () => {
    const off: Fixture = { ...fixture('compare'), app: debugApp({}) }
    const { ready, backend, ui, container } = renderWithBackend(<DebugSidePanel />, { fixture: off })
    await act(() => ready)
    expect(container).toBeEmptyDOMElement()

    await act(async () => {
      await backend?.send({ type: 'change-settings', changes: { debug: { miniMap: true } } })
    })
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Mini-map'])

    await act(async () => {
      await backend?.send({ type: 'change-settings', changes: { debug: { miniMap: false, runInspector: true } } })
    })
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Run'])

    // The split link opens Compare whatever the toggles say.
    act(() => ui.getState().openCompare(fx.id('message', 'newsletter')))
    expect(screen.getByRole('tab', { name: 'Compare' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('compare')).toBeInTheDocument()
    expect(DEFAULT_SETTINGS.debug).toEqual({ miniMap: false, operationGraph: false, runInspector: false, compareIndependent: false, comparePlacement: 'sidebar' })
  })

  test('an independent composite is offered for Compare only behind its toggle', () => {
    const { transcript } = fixture('compare').initial
    expect(listDecompositions(transcript, false)).toEqual([])
    expect(listDecompositions(transcript, true).map((entry) => entry.messageId)).toEqual([fx.id('message', 'newsletter')])
  })
})

describe('Compare decomposition inspector', () => {
  test('the exact source beside each rewritten instruction, the span marked, requirements with provenance and scope', async () => {
    const user = userEvent.setup()
    const { ready, ui } = renderWithBackend(<DebugSidePanel />, { fixture: fixture('compare') })
    await act(() => ready)
    const message = fixture('compare').initial.transcript.messages[fx.id('message', 'newsletter')]
    if (!message) throw new Error('fixture message missing')
    act(() => ui.getState().openCompare(message.id))

    // The source is the message exactly as sent, whatever is marked on it.
    const original = screen.getByTestId('compare-original')
    expect(original.textContent).toBe(message.text)
    const marked = () => [...original.querySelectorAll('mark[data-selected]')].map((mark) => mark.textContent).join('')
    expect(marked()).toBe('write the welcome paragraph')
    expect(screen.getByLabelText('Source of this part')).toHaveTextContent('write the welcome paragraph')
    expect(screen.getByLabelText('Rewritten instruction').textContent).toBe(
      'Write the welcome paragraph of the spring newsletter. Keep it under 120 words. Use British spelling.',
    )

    // Inherited requirements: where each came from, and how far it reaches.
    const requirements = within(screen.getByTestId('requirements')).getAllByRole('listitem')
    expect(requirements).toHaveLength(2)
    expect(requirements[0]).toHaveTextContent('Local')
    expect(requirements[0]).toHaveTextContent('Shared')
    expect(requirements[0]).toHaveTextContent('From the source: “Keep each piece under 120 words.”')
    expect(requirements[0]).toHaveTextContent('Also applies to workshop dates, volunteer call.')
    expect(requirements[1]).toHaveTextContent('Session-wide')
    expect(requirements[1]).toHaveTextContent('From the source: “From now on, use British spelling.”')
    expect([...original.querySelectorAll('mark[data-requirement]')].map((mark) => mark.textContent).join('')).toBe(
      'Keep each piece under 120 words.From now on, use British spelling.',
    )

    // The corrective part is shown as a correction that started no work.
    await user.click(screen.getByRole('tab', { name: /volunteer call/ }))
    expect(marked()).toBe('actually the volunteer call should ask for weekend help, not weekday help')
    expect(screen.getByText(/It started no new work of its own/)).toBeInTheDocument()
    expect(original.textContent).toBe(message.text)
    // The rewrite is credited to the decomposition model, never the decision model.
    expect(screen.getByText(/Rewritten by the decomposition model/)).toHaveTextContent(DEFAULT_SETTINGS.models.decomposition)

    await user.click(screen.getByRole('button', { name: 'Show its answer' }))
    expect(ui.getState().reveal?.sectionId).toBe(fx.id('section', 'volunteer-revised'))
    await user.click(screen.getByRole('button', { name: 'Close Compare' }))
    expect(ui.getState().compare).toBeNull()
  })

  test('segments of overlapping spans always join back to the untouched text', () => {
    const text = 'Plan the trip, and keep it cheap.'
    const segments = segmentText(text, [
      { span: { start: 0, end: 13 }, mark: 'a' },
      { span: { start: 9, end: 40 }, mark: 'b' },
      { span: { start: 5, end: 5 }, mark: 'empty' },
    ])
    expect(segments.map((segment) => segment.text).join('')).toBe(text)
    expect(segments.find((segment) => segment.text === 'trip')?.marks).toEqual(['a', 'b'])
    expect(segments.flatMap((segment) => segment.marks)).not.toContain('empty')
  })
})

describe('operation graph', () => {
  test('operation graph · retired operations stay inspectable; a barrier hold is drawn apart from a dependency', async () => {
    const user = userEvent.setup()
    const { ready, backend, container, ui } = renderWithBackend(<OperationGraphDrawer />, { fixture: fixture('operation-states') })
    await act(() => ready)
    const edge = (kind: string, from: string, to: string) =>
      container.querySelector(`[data-edge="${kind}"][data-from="${fx.id('operation', from)}"][data-to="${fx.id('operation', to)}"]`)

    // The timing plan needs nothing itself: its hold is a barrier edge, never a dependency edge.
    expect(edge('barrier', 'page', 'timing')).not.toBeNull()
    expect(edge('needs', 'page', 'timing')).toBeNull()
    expect(edge('barrier', 'page', 'timing')).toHaveAttribute('stroke-dasharray')
    expect(edge('needs', 'page', 'qa-prep')).not.toBeNull()
    expect(edge('needs', 'page', 'qa-prep')).not.toHaveAttribute('stroke-dasharray')
    await user.click(one(container, `button${operation('timing')}`))
    const detail = screen.getByTestId('operation-detail')
    expect(within(detail).getByTestId('barrier-hold')).toHaveTextContent('Needs nothing itself')
    expect(within(detail).getByTestId('barrier-hold')).toHaveTextContent('speaker page')
    expect(within(detail).queryByTestId('needs')).toBeNull()

    // Every operation that left the graph is still there to inspect, not only the latest.
    await user.click(screen.getByRole('button', { name: /Left the graph · 5/ }))
    const history = screen.getByRole('list', { name: 'Operations that left the graph' })
    expect(within(history).getAllByRole('button')).toHaveLength(5)
    await user.click(within(history).getByRole('button', { name: 'opening hook, superseded' }))
    expect(screen.getByTestId('operation-detail')).toHaveTextContent('Left the live graph. Kept here for inspection.')
    expect(ui.getState().selectedOperation).toBe(fx.id('operation', 'hook'))

    // An operation that completes leaves the live graph and joins the history.
    act(() => {
      backend?.step()
    })
    const live = screen.getByRole('group', { name: 'Live operations by dependency depth' })
    expect(live.querySelector(`button${operation('abstract')}:not([data-leaving])`)).toBeNull()
    expect(live.querySelector(`button${operation('bio')}:not([data-leaving])`)).not.toBeNull()
    expect(screen.getByRole('button', { name: /Left the graph · 6/ })).toBeInTheDocument()
    expect(within(screen.getByRole('list', { name: 'Operations that left the graph' })).getByRole('button', { name: 'abstract, completed' })).toBeInTheDocument()
  })

  test('every status of 08 is shown under its own name; a rate limit is “Waiting for capacity”, never a dependency wait', async () => {
    const user = userEvent.setup()
    const { ready, container } = renderWithBackend(<OperationGraphDrawer />, { fixture: fixture('operation-states') })
    await act(() => ready)
    await user.click(screen.getByRole('button', { name: /Left the graph/ }))
    const { operationGraph } = fixture('operation-states').initial
    const all: OperationStatus[] = [
      'waiting-for-results', 'paused', 'awaiting-answer', 'waiting-for-slot', 'waiting-for-capacity', 'retrying', 'running', 'streaming',
      'completed', 'failed', 'stopped', 'interrupted', 'cancelled', 'superseded', 'group-open', 'formed',
    ]
    expect(new Set(Object.values(operationGraph.operations).map((entry) => entry.status))).toEqual(new Set(all))
    // Each live card says its status in the projection's own words.
    for (const id of operationGraph.active) {
      const view = operationGraph.operations[id]
      if (!view) continue
      const card = one(container, `button[data-operation-id="${id}"]`)
      expect(one(card, '[data-status]')).toHaveAttribute('data-status', view.status)
      expect(card).toHaveTextContent(view.statusText)
    }
    const slides = one(container, `button${operation('slides')}`)
    expect(slides).toHaveTextContent(WORDING.waitingForCapacity)
    // No edge reaches it: nothing it needs is missing.
    expect(container.querySelector(`[data-edge][data-to="${fx.id('operation', 'slides')}"]`)).toBeNull()
    await user.click(slides)
    expect(screen.getByTestId('operation-detail')).toHaveTextContent('No result. Held by the provider’s rate limit')
    await user.click(one(container, `button${operation('titles')}`))
    expect(screen.getByTestId('operation-detail')).toHaveTextContent(WORDING.waitingForSlot)
    expect(screen.getByTestId('operation-detail')).toHaveTextContent('Held by the concurrency limit')
    // A dependency wait names what it waits for, and a pause names what did not finish.
    await user.click(one(container, `button${operation('rehearsal')}`))
    expect(within(screen.getByTestId('waiting-for')).getByRole('button', { name: 'demo script' })).toBeInTheDocument()
    expect(screen.getByTestId('operation-detail')).toHaveTextContent('Paused — demo script failed')
  })

  test('a pending section inside a placed group is reached from its operation; the run inspector too', async () => {
    const user = userEvent.setup()
    const { ready, container, ui } = renderWithBackend(<OperationGraphDrawer />, { fixture: fixture('operation-states') })
    await act(() => ready)
    await user.click(one(container, `button${operation('slides')}`))
    await user.click(screen.getByRole('button', { name: 'Show in transcript' }))
    expect(ui.getState().reveal?.sectionId).toBe(fx.id('section', 'slides'))
    await user.click(screen.getByRole('button', { name: 'Inspect run' }))
    expect(ui.getState().inspected).toEqual({ directiveId: fx.id('directive', 'slides'), attemptId: null })
    // A join-back is bookkeeping: there is no run to inspect and no section to show.
    await user.click(one(container, `button${operation('forks')}`))
    expect(screen.getByTestId('operation-detail')).toHaveTextContent('bookkeeping, no model call')
    expect(screen.queryByRole('button', { name: 'Inspect run' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Show in transcript' })).toBeNull()
  })

  test('completion and new work never scroll the view, and the selected operation’s details stay in place', async () => {
    const user = userEvent.setup()
    const { ready, backend, container, ui } = renderWithBackend(<OperationGraphDrawer />, { fixture: fixture('operation-states') })
    await act(() => ready)
    await user.click(one(container, `button${operation('abstract')}`))
    const scroller = screen.getByRole('group', { name: 'Live operations by dependency depth' })
    scroller.scrollLeft = 120
    const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView')
    const scrollTo = vi.spyOn(Element.prototype, 'scrollTo')
    let moved = 0
    scroller.addEventListener('scroll', () => (moved += 1))

    act(() => {
      backend?.playAll()
    })
    await waitFor(() => expect(container.querySelector(`button${operation('poster')}`)).not.toBeNull())
    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(scrollTo).not.toHaveBeenCalled()
    expect(moved).toBe(0)
    expect(scroller.scrollLeft).toBe(120)
    // The abstract completed and left the graph; it is still the selection, and its details are still shown.
    expect(ui.getState().selectedOperation).toBe(fx.id('operation', 'abstract'))
    expect(screen.getByTestId('operation-detail')).toHaveAttribute('data-operation-id', fx.id('operation', 'abstract'))
    expect(screen.getByTestId('operation-detail')).toHaveTextContent('Left the live graph')
  })

  test('layout: a column is a dependency depth, and an edge is one projected dependency', () => {
    const { operationGraph } = fixture('operation-states').initial
    const layout = layoutOperations(operationGraph)
    const x = (name: string) => layout.positions.get(fx.id('operation', name))?.x ?? -1
    expect(x('abstract')).toBe(x('outline'))
    expect(x('forks')).toBeGreaterThan(x('abstract'))
    expect(x('page')).toBeGreaterThan(x('forks'))
    expect(x('qa-prep')).toBeGreaterThan(x('page'))
    // Held by the barrier, the timing plan needs nothing: depth 0, although what it is held for is three columns on.
    expect(x('timing')).toBe(x('outline'))
    expect([...layout.positions.keys()]).toEqual(operationGraph.active)
    const places = [...layout.positions.values()].map((point) => `${point.x}:${point.y}`)
    expect(new Set(places).size).toBe(places.length)
    expect(layout.edges.filter((edge) => edge.kind === 'barrier')).toHaveLength(1)
  })
})

describe('run inspector', () => {
  test('a question card keeps its header and opens what was sent for its section in a dialog; Escape closes it and returns focus', async () => {
    const user = userEvent.setup()
    const { ready, ui } = renderWithBackend(<RunInspector />, { fixture: fixture('run-inspection') })
    await act(() => ready)
    act(() => ui.getState().inspect({ directiveId: fx.id('directive', 'itinerary'), attemptId: fx.id('attempt', 'itinerary-1') }))
    await user.click(await screen.findByText(/Questions put to the decision model \(5\)/))
    const card = one(document.body, '[data-question="m_s3"]') as HTMLElement
    // The card still shows the question header as asked, and nothing of the answer.
    expect(card).toHaveTextContent('Does the new message refer to answer section S3 ("seafood places")')
    expect(card).not.toHaveTextContent('Walking between them')
    // Questions that recorded nothing have no button.
    expect(within(one(document.body, '[data-question="q-composite"]') as HTMLElement).queryByRole('button')).toBeNull()
    expect(screen.queryByTestId('shown-not-recorded')).toBeNull()

    const trigger = within(card).getByRole('button', { name: 'Show what was sent' })
    await user.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: 'What the decision model was given' })
    expect(dialog).toHaveAccessibleDescription(/exactly as sent/)
    expect(within(dialog).getByText('Opening and matching passages')).toBeInTheDocument()
    expect(dialog).toHaveTextContent('Does the new message refer to answer section S3 ("seafood places")')
    const text = within(dialog).getByLabelText('Text shown: Opening and matching passages')
    expect(text.textContent).toContain('S3. "seafood places": request "Which seafood places should we try?"; answer, its opening and the passages')
    expect(text.textContent).toContain('## Walking between them')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(trigger).toHaveFocus()

    // The whole answer, labelled as such; the explicit close button closes it too.
    await user.click(within(one(document.body, '[data-question="m_s2"]') as HTMLElement).getByRole('button', { name: 'Show what was sent' }))
    const whole = await screen.findByRole('dialog')
    expect(within(whole).getByText('Whole answer')).toBeInTheDocument()
    await user.click(within(whole).getAllByRole('button', { name: 'Close' })[0] as HTMLElement)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  test('a decision recorded before the shown text was kept shows the questions only, with a note', async () => {
    const user = userEvent.setup()
    const { ready, ui } = renderWithBackend(<RunInspector />, { fixture: fixture('run-inspection') })
    await act(() => ready)
    act(() => ui.getState().inspect({ directiveId: fx.id('directive', 'packing'), attemptId: null }))
    await user.click(await screen.findByText(/Questions put to the decision model \(1\)/))
    expect(screen.getByTestId('shown-not-recorded')).toHaveTextContent('only the questions are shown')
    expect(screen.queryByRole('button', { name: 'Show what was sent' })).toBeNull()
  })

  test('C10 (web) · inspection keeps the ancestry and input each historical run consumed', async () => {
    const user = userEvent.setup()
    const { ready, ui } = renderWithBackend(<RunInspector />, { fixture: fixture('run-inspection') })
    await act(() => ready)
    const directiveId = fx.id('directive', 'itinerary')
    act(() => ui.getState().inspect({ directiveId, attemptId: fx.id('attempt', 'itinerary-1') }))

    // Attempt 1 was superseded by a revision. Its record is unchanged: what it read then, verbatim.
    const input = await screen.findByTestId('model-input')
    const recorded = fixture('run-inspection').runs?.[directiveId]?.byAttempt?.[fx.id('attempt', 'itinerary-1')]?.input
    if (!recorded) throw new Error('fixture run missing')
    const shown = within(input).getAllByRole('listitem')
    expect(shown.map((item) => item.querySelector('pre')?.textContent)).toEqual(recorded.messages.map((message) => message.content))
    expect(shown.map((item) => item.getAttribute('data-role'))).toEqual(recorded.messages.map((message) => message.role))
    expect(shown.at(-1)?.querySelector('pre')?.textContent).toBe(
      'Use both to plan the four days.\n\nRequirements:\n- Keep each day under ten kilometres on foot.',
    )
    expect(input).not.toHaveTextContent('Sintra')
    expect(within(screen.getByTestId('ancestry')).getAllByRole('listitem').map((item) => item.getAttribute('data-node-id'))).toEqual(
      recorded.nodeIds,
    )
    const attempt = screen.getByRole('region', { name: 'Attempt' })
    expect(attempt).toHaveTextContent('Attempt 1 of 2')
    expect(attempt).toHaveTextContent('Superseded')
    expect(attempt).toHaveTextContent('Kept as it was')

    // Attempt 2, the replacement of finished work, read the old answer and then the correction.
    await user.click(screen.getByRole('button', { name: /Attempt 2/ }))
    await waitFor(() => expect(screen.getByRole('region', { name: 'Attempt' })).toHaveTextContent('Attempt 2 of 2'))
    const second = within(screen.getByTestId('model-input')).getAllByRole('listitem')
    expect(second.at(-1)?.querySelector('pre')?.textContent).toBe('Actually swap Belém for a day trip to Sintra.')
    expect(second.at(-1)).toHaveAttribute('data-origin', 'correction')
    expect(second.at(-2)?.querySelector('pre')?.textContent).toContain('Day 3: Belém by tram.')
    expect(screen.getByRole('region', { name: 'Attempt' })).toHaveTextContent('In flight')
  })

  test('the seven items; waiting is shown apart from context; routing is a record, not a verdict', async () => {
    const user = userEvent.setup()
    const { ready, ui } = renderWithBackend(<RunInspector />, { fixture: fixture('run-inspection') })
    await act(() => ready)
    expect(screen.getByText('No run selected')).toBeInTheDocument()
    act(() => ui.getState().inspect({ directiveId: fx.id('directive', 'packing'), attemptId: null }))
    await screen.findByTestId('run-inspector')
    expect(screen.getAllByRole('region').map((region) => region.getAttribute('aria-label'))).toEqual([
      'Original message and source fragment',
      'Instruction and requirements',
      'Exact model input',
      'Still waiting for',
      'Routing decision',
      'Attempt',
      'Answer section',
    ])
    // Queued: nothing was sent, so nothing is shown as input; what it waits for is its own item.
    const input = screen.getByRole('region', { name: 'Exact model input' })
    expect(input).toHaveTextContent('Not started, so nothing has been sent')
    expect(within(input).queryByTestId('model-input')).toBeNull()
    expect(input).not.toHaveTextContent('itinerary')
    expect(screen.getByTestId('waiting-for')).toHaveTextContent('itinerary')
    expect(screen.getByTestId('waiting-for')).toHaveTextContent('separate from the context a run reads')
    expect(screen.getByRole('region', { name: 'Attempt' })).toHaveTextContent('No attempt yet')
    const routing = screen.getByTestId('routing')
    expect(routing).toHaveTextContent('not a judgement that it was right')
    expect(routing).toHaveTextContent('confidence 0.89')
    expect(routing).toHaveTextContent(DEFAULT_SETTINGS.models.decision)
    // A strategy selector was on for this routing: what ran, who chose it, why the rules stood in, and the model's confidence.
    const selection = within(routing).getByTestId('strategy-selection')
    expect(selection).toHaveTextContent('Tree walk (long runs searched) · chosen by the rules')
    expect(selection).toHaveTextContent('the decision model was not confident')
    expect(selection).toHaveTextContent('9 answers are older than the routing request lists')
    expect(selection).toHaveTextContent('strategy 0.58')
    // The candidate source: which one ran, the sections it handed the walk with its scores, and that they are only hints.
    const seeds = within(routing).getByTestId('candidate-source')
    expect(seeds).toHaveTextContent('2 · from the word index')
    expect(seeds).toHaveTextContent('6.4')
    expect(seeds).toHaveTextContent('3.9')
    expect(seeds).toHaveTextContent('none is a target because it is listed here')
    // The decision budget stopped the search: which limit, what was done instead, and that the user was not asked.
    const stop = within(routing).getByTestId('budget-stop')
    expect(stop).toHaveTextContent('Reached the token budget · the remaining listed sections were asked about in one request')
    expect(stop).toHaveTextContent('The best node found so far was not needed for this work.')
    // Hop between branch points: which section was taken for which run, that it was not asked about by itself, and on what evidence.
    const hop = within(routing).getByTestId('run-ends')
    expect(hop).toHaveTextContent('Placed on itinerary, the last answer of a run of 2 · confidence 0.84')
    expect(hop).toHaveTextContent('No answer inside the run was searched for, and this one was not asked about by itself: its context holds the whole run.')
    expect(hop).toHaveTextContent('The run is trip brief to itinerary; the score is that of a question about 2 of its answers together, trip brief to itinerary.')

    await user.click(screen.getByRole('button', { name: 'Show in transcript' }))
    expect(ui.getState().reveal?.sectionId).toBe(fx.id('section', 'packing'))
  })
})

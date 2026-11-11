import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import './operation-graph.css';

type Operation = { id: string; name: string; chain: string; color: string; kind: string; row: number; deps: string[]; message: string; inputs: string; section: string; state?: 'failed' | 'paused' | 'capacity' };
const initial: Operation[] = [
  { id: 'a', name: 'Explore neighborhoods', chain: 'Neighborhood fork', color: 'fork', kind: 'Model call · fork', row: 0, deps: [], message: 'Message 12 · attempt 1', inputs: 'Request + recorded conversation context', section: 'Neighborhoods' },
  { id: 'b', name: 'Find activities', chain: 'Activities fork', color: 'b', kind: 'Model call · fork', row: 1, deps: [], message: 'Message 12 · attempt 1', inputs: 'Request + recorded conversation context', section: 'Activities' },
  { id: 'c', name: 'Draft travel notes', chain: 'Planning', color: 'a', kind: 'Model call', row: 2, deps: [], message: 'Message 11 · attempt 2', inputs: 'Request + recorded conversation context', section: 'Travel notes' },
  { id: 'd', name: 'Check availability', chain: 'Planning', color: 'a', kind: 'Model call', row: 3, deps: [], message: 'Message 10 · attempt 1', inputs: 'Request + recorded conversation context', section: 'Availability', state: 'capacity' },
  { id: 'e', name: 'Join sibling results', chain: 'Planning', color: 'a', kind: 'Join-back · bookkeeping', row: 0, deps: ['a', 'b'], message: 'Message 12 · join-back', inputs: 'Sibling exchanges in submission order; no model call', section: 'Neighborhoods + activities' },
  { id: 'f', name: 'Compose itinerary', chain: 'Planning', color: 'a', kind: 'Model call', row: 1, deps: ['e', 'c'], message: 'Message 13 · attempt 1', inputs: 'Join-back + travel notes', section: 'Itinerary' },
  { id: 'g', name: 'Review budget', chain: 'Budget', color: 'j', kind: 'Model call', row: 3, deps: [], message: 'Message 14 · attempt 1', inputs: 'Budget request', section: 'Budget', state: 'failed' },
  { id: 'h', name: 'Finalize budget', chain: 'Budget', color: 'j', kind: 'Model call', row: 3, deps: ['g'], message: 'Message 15 · attempt 1', inputs: 'Budget review', section: 'Final budget', state: 'paused' },
];
const CARD_W = 170, CARD_H = 72, X = 230, Y = 76;

export function OperationGraphPrototype({ onOpenSection }: { onOpenSection?: (section: string) => void } = {}) {
  const [tasks, setTasks] = useState(initial);
  const [done, setDone] = useState<string[]>([]);
  const [selected, setSelected] = useState('a');
  const [retiring, setRetiring] = useState<string | null>(null);
  const [edges, setEdges] = useState<{ id: string; d: string }[]>([]);
  const scroll = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const nodes = useRef<Record<string, HTMLButtonElement | null>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frame = useRef(0);
  const serial = useRef(0);
  const get = (id: string) => tasks.find(t => t.id === id);
  const alive = tasks.filter(t => !done.includes(t.id));
  const depth: Record<string, number> = {};
  for (const task of alive) {
    const active = task.deps.filter(id => !done.includes(id));
    depth[task.id] = active.length ? 1 + Math.max(...active.map(id => depth[id] ?? 0)) : 0;
  }
  const width = Math.max(720, (Math.max(0, ...Object.values(depth)) + 1) * X + 32);
  const ready = alive.filter(t => !t.state && t.deps.every(id => done.includes(id)));
  // Join-back bookkeeping is not a provider model slot.
  const running = ready.filter(t => t.kind.startsWith('Model')).slice(0, 4).map(t => t.id);
  const status = (t: Operation) => done.includes(t.id) ? 'Completed' : t.state === 'failed' ? 'Failed' : t.state === 'paused' ? 'Paused · budget review failed' : t.state === 'capacity' ? 'Waiting for capacity' : !t.deps.every(id => done.includes(id)) ? 'Waiting for dependencies' : t.kind.startsWith('Join') ? 'Ready · bookkeeping' : running.includes(t.id) ? 'Generating reply' : 'Waiting for capacity';
  const canComplete = (t: Operation) => !done.includes(t.id) && !t.state && (running.includes(t.id) || (t.kind.startsWith('Join') && t.deps.every(id => done.includes(id))));
  const chosen = get(selected);

  const draw = useCallback(() => {
    const root = canvas.current;
    if (!root) return;
    const rootRect = root.getBoundingClientRect();
    const next: { id: string; d: string }[] = [];
    for (const task of alive) for (const dep of task.deps) {
      const from = nodes.current[dep], to = nodes.current[task.id];
      if (!from || !to || done.includes(dep)) continue;
      const a = from.getBoundingClientRect(), b = to.getBoundingClientRect();
      const x1 = a.right - rootRect.left, y1 = a.top - rootRect.top + a.height / 2;
      const x2 = b.left - rootRect.left, y2 = b.top - rootRect.top + b.height / 2;
      const mid = (x1 + x2) / 2;
      next.push({ id: `${dep}-${task.id}`, d: `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}` });
    }
    setEdges(next);
  }, [tasks, done]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    cancelAnimationFrame(frame.current);
    draw();
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const start = performance.now();
    const tick = (now: number) => { draw(); if (now - start < 280) frame.current = requestAnimationFrame(tick); };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [draw]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); cancelAnimationFrame(frame.current); }, []);
  function complete() {
    if (!chosen || !canComplete(chosen) || retiring) return;
    const id = chosen.id, token = ++serial.current;
    setRetiring(id);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    timer.current = setTimeout(() => { if (serial.current !== token) return; setDone(old => [...old, id]); setRetiring(null); }, reduced ? 0 : 180);
  }
  function reset() {
    serial.current++; if (timer.current) clearTimeout(timer.current);
    setTasks(initial); setDone([]); setSelected('a'); setRetiring(null);
    if (scroll.current) scroll.current.scrollLeft = 0;
  }
  function append() {
    setTasks(old => {
      const n = old.filter(t => t.id.startsWith('extra')).length + 1;
      const previous = old[old.length - 1];
      return [...old, { id: `extra${n}`, name: `Follow-up ${n}`, chain: 'Budget', color: 'j', kind: 'Model call', row: 3, deps: [previous.id], message: `Demo follow-up ${n} · attempt 1`, inputs: `Result of ${previous.name}`, section: `Follow-up ${n}` }];
    });
  }
  return <section className="op-explorer" aria-label="Operation graph prototype">
    <header className="op-head"><div><div className="op-eyebrow">DEBUG VIEW <span> / </span> LIVE WORK</div><h2>Operation graph</h2><p>Dependency depth, not elapsed time · deterministic demo</p></div><div className="op-actions"><button onClick={append}>+ Add demo work</button><button onClick={reset}>Reset</button></div></header>
    <div className="op-bar"><div><span className="op-live-dot" /> <strong>{running.length} / 4</strong> model slots in use <span className="op-divider">·</span> {alive.length} operations remaining</div><div className="op-scroll-hint">← Scroll to explore dependencies →</div><div className="op-actions"><button aria-label="Scroll graph left" onClick={() => scroll.current?.scrollBy({ left: -300, behavior: 'smooth' })}>←</button><button aria-label="Scroll graph right" onClick={() => scroll.current?.scrollBy({ left: 300, behavior: 'smooth' })}>→</button></div></div>
    <div className="op-scroll" ref={scroll} tabIndex={0} aria-label="Scrollable dependency network"><div className="op-canvas" ref={canvas} style={{ width }}><svg className="op-links" aria-hidden="true">{edges.map(edge => <path key={edge.id} d={edge.d} />)}</svg>{alive.map(t => <button key={t.id} ref={el => { nodes.current[t.id] = el; }} className={`op-node op-color-${t.color}${selected === t.id ? ' op-selected' : ''}${retiring === t.id ? ' op-retiring' : ''}`} style={{ transform: `translate(${24 + depth[t.id] * X}px, ${20 + t.row * Y}px)` }} onClick={() => setSelected(t.id)} aria-pressed={selected === t.id}><span className="op-node-kind">{t.kind}</span><strong>{t.name}</strong><span className={`op-node-status op-status-${t.state ?? (running.includes(t.id) ? 'running' : 'waiting')}`}>{status(t)}</span></button>)}</div></div>
    <div className="op-detail" aria-live="polite">{chosen && <><div className="op-detail-main"><div className="op-detail-top"><span className={`op-chain-dot op-color-${chosen.color}`} /><strong>{chosen.name}</strong><span className="op-detail-status">{status(chosen)}</span></div><p>{chosen.chain} <span>·</span> {chosen.message} <span>·</span> {chosen.kind}</p><p><b>Inputs</b> {chosen.inputs}</p><p><b>Dependencies</b> {chosen.deps.length ? chosen.deps.map(id => get(id)?.name).join(' + ') : 'None'}{chosen.deps.some(id => !done.includes(id)) ? ` · Waiting for ${chosen.deps.filter(id => !done.includes(id)).map(id => get(id)?.name).join(', ')}` : ''}</p><p className="op-section-link">{onOpenSection ? <button onClick={() => onOpenSection(chosen.section)}>Open pending section ↗</button> : <>Reply section: <strong>{chosen.section}</strong></>}</p>{chosen.state === 'paused' && <p className="op-recovery">Recovery needed: retry budget review, continue without it, or cancel the final budget.</p>}</div><button className="op-primary" onClick={complete} disabled={!canComplete(chosen) || !!retiring}>Complete selected</button></>}</div>
    <div className="op-history"><div><strong>Operation history</strong><span>Completed work remains inspectable</span></div>{done.length ? <div className="op-history-list">{done.map(id => <button key={id} onClick={() => setSelected(id)} aria-pressed={selected === id}>{get(id)?.name} <span>✓</span></button>)}</div> : <p>No completed operations yet.</p>}</div>
  </section>;
}

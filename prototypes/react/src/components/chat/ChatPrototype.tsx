import { useState } from 'react';
import './chat.css';

type Section = 'Sky' | 'Menu';
type Entry = { text: string; target: string };

export function ChatPrototype() {
  const [view, setView] = useState<'Sections' | 'Flow' | 'Activity'>('Sections');
  const [step, setStep] = useState(0);
  const [failed, setFailed] = useState(false);
  const [target, setTarget] = useState('');
  const [draft, setDraft] = useState('');
  const [ambiguous, setAmbiguous] = useState(false);
  const [sent, setSent] = useState<Entry[]>([]);
  const [focus, setFocus] = useState<Section | ''>('');
  const [inspect, setInspect] = useState(false);
  const [debug, setDebug] = useState(false);
  const [selected, setSelected] = useState<Section>('Sky');
  const send = (chosen = target) => {
    if (!draft.trim()) return;
    if (!chosen && /\b(that|it|this|those|them)\b/i.test(draft)) { setAmbiguous(true); return; }
    setSent(old => [...old, { text: draft.trim(), target: chosen || 'New request' }]);
    setDraft(''); setTarget(''); setAmbiguous(false);
  };
  const order: Section[] = step === 0 ? ['Sky', 'Menu'] : ['Menu', 'Sky'];
  const isVisible = (s: Section) => s === 'Menu' ? step >= 1 : step >= 2;
  return <div className="chat-shell">
    <header className="chat-bar"><div><strong>Pluribus</strong><span className="chat-muted"> / Simulated conversation</span></div><button className="chat-link" aria-pressed={debug} onClick={() => setDebug(!debug)}>Debug {debug ? 'on' : 'off'}</button></header>
    <div className="chat-toolbar"><div className="chat-tabs" aria-label="Conversation layout">{(['Sections', 'Flow', 'Activity'] as const).map(v => <button key={v} aria-pressed={view === v} onClick={() => setView(v)}>{v}</button>)}</div><button className="chat-outline" onClick={() => { if (step >= 2) { setStep(0); setFailed(false); } else setStep(step + 1); }}>{step === 0 ? 'Advance demo: Menu responds' : step === 1 ? 'Advance demo: Sky responds' : 'Reset demo'}</button></div>
    <div className="chat-layout">{view === 'Activity' && <aside className="chat-activity"><span className="chat-eyebrow">Activity</span><p><b>Sky + menu</b><br/><span className="chat-muted">{step === 2 ? 'Complete' : 'In progress · 2 parts'}</span></p><p><b>Weekend packing</b><br/><span className="chat-muted">Complete</span></p></aside>}
    <div className="chat-thread">
      <div className="chat-focus"><span>Focus chain</span>{(['Sky','Menu'] as const).map(s => <button key={s} aria-pressed={focus === s} onClick={() => setFocus(focus === s ? '' : s)}>{s}</button>)}{focus && <button onClick={() => setFocus('')}>Clear</button>}</div>
      <article className="chat-message chat-both"><div className="chat-meta"><b>You</b><span>10:41</span>{debug && <button className="chat-link" onClick={() => setInspect(!inspect)}>{inspect ? 'Hide decomposition' : 'Inspect decomposition'}</button>}</div><p>Why is the sky blue? Also, translate “sopa de verduras” into English. Keep both answers brief.</p>{debug && inspect && <div className="chat-inspect"><b>Compare decomposition</b><div className="chat-tabs">{(['Sky','Menu'] as const).map(s => <button key={s} aria-pressed={selected === s} onClick={() => setSelected(s)}>{s}</button>)}</div><p><span className="chat-muted">Source: </span>{selected === 'Sky' ? 'Why is the sky blue?' : 'Also, translate “sopa de verduras” into English.'}</p><p><span className="chat-muted">Rewrite: </span>{selected === 'Sky' ? 'Explain why the sky is blue.' : 'Translate “sopa de verduras” into English.'}</p><small>Inherited from source: Keep both answers brief.</small></div>}</article>
      <article className="chat-message chat-packing"><div className="chat-meta"><b>You</b><span>10:42</span></div><p>What should I pack for a weekend hike?</p></article><article className="chat-message chat-packing"><div className="chat-meta"><b>Pluribus</b><span>Complete</span><button className="chat-reply" onClick={() => {setTarget('Weekend packing'); setAmbiguous(false);}}>↩ Reply to packing</button></div><p>Pack water, weather-ready layers, sturdy shoes, snacks, a map, and a small first-aid kit.</p></article>

      <article className="chat-message chat-group"><div className="chat-meta"><b>Pluribus</b><span>{failed ? (step >= 1 ? '1 done · 1 failed' : '1 failed · 1 pending') : step === 2 ? '2 done' : step === 1 ? '1 done · 1 pending' : 'Responding'}</span></div>
        <div className={view === 'Flow' ? 'chat-flow' : ''}>{order.map(s => <section key={s} className={`chat-answer chat-${s.toLowerCase()} ${focus && focus !== s ? 'chat-dim' : ''}`}><div className="chat-answer-head"><strong>{s === 'Sky' ? 'Why the sky is blue' : 'Menu translation'}</strong><button className="chat-reply" onClick={() => { setTarget(s); setAmbiguous(false); }}>↩ Reply to {s}</button></div>{failed && s === 'Sky' ? <p>Failed before output. <button className="chat-link" onClick={() => setFailed(false)}>Retry</button></p> : isVisible(s) ? <p>{s === 'Sky' ? 'Air molecules scatter shorter blue wavelengths more strongly than red light.' : '“Sopa de verduras” means vegetable soup.'}</p> : <p className="chat-muted">Responding… {s === 'Sky' && <button className="chat-link" onClick={() => setFailed(true)}>Simulate failure</button>}</p>}</section>)}</div></article>
      {sent.map((entry, i) => <article className="chat-message chat-packing" key={i}><div className="chat-meta"><b>You</b><span>{entry.target === 'New request' ? 'Processing' : `Reply to ${entry.target}`}</span></div><p>{entry.text}</p></article>)}
      {sent.some(e => e.target === 'Sky' && (step < 2 || failed)) && <div className="chat-queue" role="status"><b>Queued</b> · Reply to Sky is waiting for the Sky answer.</div>}
      <div className="chat-composer">{target && <div className="chat-target">Replying to {target} <button aria-label="Clear reply target" onClick={() => setTarget('')}>×</button></div>}<label className="chat-sr" htmlFor="chat-message">Message</label><textarea id="chat-message" value={draft} onChange={e => setDraft(e.target.value)} placeholder="Ask a follow-up…"/><div className="chat-compose-foot"><span className="chat-muted">{target ? 'Target selected' : 'No reply target selected'}</span><button className="chat-send" onClick={() => send()}>Send ↑</button></div>{ambiguous && <div className="chat-ambiguity"><b>Which response is this about?</b><p>Demo routing: choose a target for this follow-up.</p><div>{['Sky','Menu','Weekend packing'].map(s => <button key={s} onClick={() => send(s)}>{s}</button>)}</div></div>}</div>
    </div></div>
  </div>;
}

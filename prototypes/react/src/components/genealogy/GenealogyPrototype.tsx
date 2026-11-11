import { useState } from 'react';
import './genealogy.css';

type Id = 'A1' | 'A2' | 'A3' | 'B1' | 'B2' | 'B3' | 'J1' | 'P1' | 'P2' | 'A4';
type Node = { id: Id; title: string; chain: string; parents: Id[]; detail: string; color: string };
const nodes: Record<Id, Node> = {
  A1: { id:'A1', title:'Start', chain:'A', parents:[], detail:'Initial prompt on chain A.', color:'a' },
  A2: { id:'A2', title:'Continue', chain:'A', parents:['A1'], detail:'Continues from A1. A2 was a leaf when J1 was created.', color:'a' },
  A3: { id:'A3', title:'Later continuation', chain:'A', parents:['A2'], detail:'Continues A after J1 was created. J1 did not consume A3.', color:'a' },
  B1: { id:'B1', title:'Start', chain:'B', parents:[], detail:'Initial prompt on chain B.', color:'b' },
  B2: { id:'B2', title:'Continue', chain:'B', parents:['B1'], detail:'Continues from B1. B2 was a leaf when J1 was created.', color:'b' },
  B3: { id:'B3', title:'Later continuation', chain:'B', parents:['B2'], detail:'Continues B after J1 was created. J1 did not consume B3.', color:'b' },
  J1: { id:'J1', title:'New synthesis chain', chain:'J', parents:['A2','B2'], detail:'A new chain reads the exact A2 and B2 leaves and their ancestry. Later source continuations are excluded.', color:'j' },
  P1: { id:'P1', title:'Parallel request', chain:'Fork P1', parents:['A3'], detail:'Reads the A3 snapshot. It did not see P2’s result.', color:'fork' },
  P2: { id:'P2', title:'Parallel request', chain:'Fork P2', parents:['A3'], detail:'Reads the A3 snapshot. It did not see P1’s result.', color:'fork2' },
  A4: { id:'A4', title:'Bookkeeping join-back', chain:'A', parents:['P1','P2'], detail:'Records completed exchanges in submission order. No model call or synthesis produced this node.', color:'a' },
};
export function GenealogyPrototype() {
  const [debug, setDebug] = useState(true);
  const [selected, setSelected] = useState<Id>('J1');
  const [preview, setPreview] = useState<Id | null>(null);
  const active = preview ?? selected;
  const node = (id: Id) => { const n = nodes[id]; return <button type="button" className={`gene-node gene-${n.color}`} aria-pressed={selected === id} title={`Node ${id} · chain ${n.chain}`} onMouseEnter={() => setPreview(id)} onMouseLeave={() => setPreview(null)} onFocus={() => setPreview(id)} onBlur={() => setPreview(null)} onClick={() => setSelected(id)}><span>{id} · {n.title}</span><small>Parents: {n.parents.join(' + ') || 'none'}</small></button>; };
  return <section className="gene-stage" aria-label="Chain genealogy prototype">
    <header className="gene-top"><div><h2>Chain map</h2><p>Genealogy · exact context ancestry</p></div><label><input type="checkbox" checked={debug} onChange={e => setDebug(e.target.checked)} /> Debug map</label></header>
    {debug ? <><div className="gene-legend"><span><i className="gene-swatch gene-a" />Chain A</span><span><i className="gene-swatch gene-b" />Chain B</span><span><i className="gene-swatch gene-j" />Join chain J</span><span><i className="gene-swatch gene-fork" />Fork P1</span><span><i className="gene-swatch gene-fork2" />Fork P2</span><span><i className="gene-oval-key" />Parallel siblings</span></div>
      <div className="gene-map"><div className="gene-sources"><div className="gene-path"><div className="gene-label">Chain A</div>{node('A1')}<div className="gene-arrow">↓</div>{node('A2')}</div><div className="gene-path"><div className="gene-label">Chain B</div>{node('B1')}<div className="gene-arrow">↓</div>{node('B2')}</div></div>
      <div className="gene-join"><div className="gene-arrow">↘ &nbsp;&nbsp;&nbsp; ↙</div>{node('J1')}<p>Exact parents: A2 + B2</p></div>
      <div className="gene-later"><div><div className="gene-label">A continues independently from A2</div>{node('A3')}</div><div><div className="gene-label">B continues independently from B2</div>{node('B3')}</div></div>
      <div className="gene-fork-area"><div className="gene-label">Parallel siblings from A3</div><div className="gene-arrow">↙ &nbsp;&nbsp;&nbsp; ↘</div><div className="gene-parallel">{node('P1')}{node('P2')}</div><div className="gene-arrow">↘ &nbsp;&nbsp;&nbsp; ↙</div>{node('A4')}</div></div>
      <div className="gene-detail" aria-live="polite"><strong>{active} · {nodes[active].title}</strong><p>{nodes[active].detail}</p><small>Chain {nodes[active].chain} · Parent IDs: {nodes[active].parents.join(', ') || 'none'}</small></div></> : <p className="gene-off">Turn on Debug map to inspect the genealogy.</p>}
  </section>;
}

import { useState } from 'react';
import './association.css';

type Selection = 'A' | 'B' | 'J' | 'AB' | 'A3' | 'B3';
type Item = { id:string; who:string; title?:string; text:string; chains:('A'|'B'|'J')[]; select:Selection; node:string; ancestry?:string };
const items: Item[] = [
  {id:'U1',who:'You',text:'Outline the benefits of a local-first app.',chains:['A'],select:'A',node:'A1'},
  {id:'U2',who:'You',text:'Outline the benefits of a hosted app.',chains:['B'],select:'B',node:'B1'},
  {id:'U3',who:'You',text:'For local-first, explain sync complexity; for hosted, explain network dependence.',chains:['A','B'],select:'AB',node:'A2 B2'},
  {id:'F-A',who:'Committee',title:'Local-first',text:'Fast offline access and user control, with sync complexity.',chains:['A'],select:'A',node:'A2'},
  {id:'F-B',who:'Committee',title:'Hosted',text:'Simple shared access and operations, with a network dependency.',chains:['B'],select:'B',node:'B2'},
  {id:'U4',who:'You',text:'Bring those perspectives together.',chains:['J'],select:'J',node:'J1',ancestry:'Reads A2 + B2'},
  {id:'F-J',who:'Committee',title:'Synthesis',text:'A hybrid can keep core work local while using a service for sharing.',chains:['J'],select:'J',node:'J1',ancestry:'Reads A2 + B2'},
  {id:'F-A3',who:'Committee',title:'Later on A',text:'Consider conflict resolution for offline edits.',chains:['A'],select:'A3',node:'A3'},
  {id:'F-B3',who:'Committee',title:'Later on B',text:'Consider hosted service operating costs.',chains:['B'],select:'B3',node:'B3'},
];
const included:Record<Selection,string[]> = {
 A:['U1','U3','F-A','F-A3'], B:['U2','U3','F-B','F-B3'], J:['U1','U2','U3','F-A','F-B','U4','F-J'], AB:['U1','U2','U3','F-A','F-B','F-A3','F-B3'], A3:['U1','U3','F-A','F-A3'], B3:['U2','U3','F-B','F-B3']
};
const descriptions:Record<Selection,string> = {
 A:'Chain A and its continuation.', B:'Chain B and its continuation.', J:'J reads A2 and B2. Later A3 and B3 were not consumed.', AB:'The two independent follow-ups in U3 are handled by A and B.', A3:'A3 continues A after J was created.', B3:'B3 continues B after J was created.'
};
export function ChainAssociationPrototype() {
 const [debug,setDebug]=useState(true);
 const [pinned,setPinned]=useState<Selection>('J');
 const [hover,setHover]=useState<Selection|null>(null);
 const [focused,setFocused]=useState<Selection|null>(null);
 const active=hover ?? focused ?? pinned;
 const interactions=(value:Selection)=>({onMouseEnter:()=>setHover(value),onMouseLeave:()=>setHover(null),onFocus:()=>setFocused(value),onBlur:()=>setFocused(null),onClick:()=>setPinned(value)});
 const mapButton=(value:Selection,label:string,chain:string)=> <button type="button" className={`assoc-map-node assoc-${chain}`} aria-pressed={pinned===value} title={`Node ${label}`} {...interactions(value)}>{label}</button>;
 return <section className="assoc-stage" aria-label="Message to chain association prototype">
  <header className="assoc-top"><div><h2>Committee</h2><p>Chain association · focus follows exact ancestry</p></div><label><input type="checkbox" checked={debug} onChange={e=>setDebug(e.target.checked)}/> Debug map</label></header>
  <div className={`assoc-layout ${debug?'':'assoc-no-map'}`}><div className="assoc-chat"><div className="assoc-intro">Hover or focus to preview. Click or tap to pin a selection.</div>
  {items.map(item=><div key={item.id} className={`assoc-item ${included[active].includes(item.id)?'assoc-linked':'assoc-dim'}`}><div className="assoc-rail" aria-hidden="true">{item.chains.map(chain=><span key={chain} className={`assoc-${chain}`}/>)}</div><button type="button" className="assoc-item-button" aria-pressed={pinned===item.select} title={`${item.id} · node ${item.node} · handled by ${item.chains.join(' + ')}`} {...interactions(item.select)}><span className="assoc-who">{item.who}</span>{item.title&&<strong>{item.title}</strong>}<span>{item.text}</span><small>{item.id} · {item.node} · Handled by {item.chains.join(' + ')}{item.ancestry&&` · ${item.ancestry}`}</small></button></div>)}
  <div className="assoc-selection" aria-live="polite"><strong>Focus: {active}</strong><span>{descriptions[active]}</span></div></div>
  {debug&&<aside className="assoc-aside" aria-label="Genealogy mini-map"><div className="assoc-map-label">Genealogy</div><div className="assoc-roots">{mapButton('A','A1 → A2','A')}{mapButton('B','B1 → B2','B')}</div><div className="assoc-connect">↘ &nbsp;&nbsp; ↙</div><div className="assoc-join">{mapButton('J','J1','J')}</div><div className="assoc-map-caption">J1 parents: A2 + B2</div><div className="assoc-later"><div>{mapButton('A3','A3','A')}<small>from A2</small></div><div>{mapButton('B3','B3','B')}<small>from B2</small></div></div><p>Later source continuations remain independent of J.</p></aside>}</div>
 </section>;
}

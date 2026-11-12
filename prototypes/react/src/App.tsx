import { useEffect, useState } from 'react';
import { ChatPrototype } from './components/chat/ChatPrototype';
import { DecompositionPrototype } from './components/decomposition/DecompositionPrototype';
import { GenealogyPrototype } from './components/genealogy/GenealogyPrototype';
import { ChainAssociationPrototype } from './components/association/ChainAssociationPrototype';
import { OperationGraphPrototype } from './components/operations/OperationGraphPrototype';

const samples = [
  { id: 'chat', label: 'Conversation', caption: 'Sections', description: 'One conversation. Independent work, visible as it happens.', Component: ChatPrototype },
  { id: 'decomposition', label: 'Decomposition', caption: 'Compare + Fragments', description: 'Trace the original request into instructions and shared requirements.', Component: DecompositionPrototype },
  { id: 'genealogy', label: 'Genealogy', caption: 'Context ancestry', description: 'Inspect the exact context behind each branch and join.', Component: GenealogyPrototype },
  { id: 'association', label: 'Chain focus', caption: 'Margin rails + Focus', description: 'Follow a chain through its own messages and inherited context.', Component: ChainAssociationPrototype },
  { id: 'operations', label: 'Operations', caption: 'Dependency graph', description: 'Explore what can run now, what is waiting, and what has finished.', Component: OperationGraphPrototype },
] as const;
type SampleId = typeof samples[number]['id'];
function readHash(): SampleId {
  const id = window.location.hash.slice(1);
  return samples.find(sample => sample.id === id)?.id ?? 'chat';
}

export function App() {
  const [selected, setSelected] = useState<SampleId>(readHash);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const sample = samples.find(item => item.id === selected)!;
  useEffect(() => {
    const onHashChange = () => setSelected(readHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);

  return (
    <div className="gallery">
      <header className="gallery-header">
        <a className="gallery-brand" href="#chat" aria-label="Pluribus prototypes home"><span className="gallery-mark" aria-hidden="true">c</span> Pluribus <span> / design lab</span></a>
        <div className="gallery-header-actions"><span className="gallery-fixture">Interactive fixtures</span><button onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')} aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}>{theme === 'light' ? 'Dark' : 'Light'} theme</button></div>
      </header>
      <div className="gallery-body">
        <nav className="gallery-nav" aria-label="Prototype samples">
          <div className="gallery-nav-label">Explore</div>
          {samples.map((item, index) => <a key={item.id} href={`#${item.id}`} aria-current={selected === item.id ? 'page' : undefined}><span className="gallery-nav-number">0{index + 1}</span><span>{item.label}<small>{item.caption}</small></span></a>)}
          <p className="gallery-note">Local sample data.<br />No model calls or API keys.</p>
        </nav>
        <main className="gallery-main">
          <div className="gallery-page-heading"><div><p className="gallery-eyebrow">Pluribus / {sample.caption}</p><h1>{sample.label}</h1><p>{sample.description}</p></div><span className="gallery-react-label">React + TypeScript</span></div>
          <div className="gallery-stage" key={sample.id}><sample.Component /></div>
        </main>
      </div>
    </div>
  );
}

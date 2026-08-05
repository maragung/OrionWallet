import { useState } from 'react';

type DocId = 'guide' | 'developer' | 'security';

const DOCS: Array<{ id: DocId; label: string; file: string; icon: string }> = [
  { id: 'guide', label: 'User Guide', file: 'USER_GUIDE.html', icon: '📖' },
  { id: 'developer', label: 'Developer', file: 'DEVELOPER.html', icon: '🛠️' },
  { id: 'security', label: 'Security', file: 'SECURITY.html', icon: '🔒' },
];

export function DocsPanel() {
  const [doc, setDoc] = useState<DocId>('guide');
  const active = DOCS.find((d) => d.id === doc)!;

  return (
    <>
      <div className="tab-bar" style={{ marginBottom: 'var(--sp-4)' }}>
        {DOCS.map((d) => (
          <div
            key={d.id}
            className={`tab ${doc === d.id ? 'active' : ''}`}
            onClick={() => setDoc(d.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setDoc(d.id);
              }
            }}
          >
            <span style={{ marginRight: 'var(--sp-1)' }}>{d.icon}</span>
            {d.label}
          </div>
        ))}
      </div>
      <iframe
        key={active.file}
        title={active.label}
        src={`/docs/${active.file}`}
        style={{
          width: '100%',
          height: '72vh',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-md)',
          background: '#0a0a0f',
        }}
      />
    </>
  );
}

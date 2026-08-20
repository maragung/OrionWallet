import { useState } from 'react';
import { PageHead } from './PageHead';
import { Icon, type IconName } from './icons/Icon';

type DocId = 'guide' | 'developer' | 'security';

const DOCS: Array<{ id: DocId; label: string; file: string; icon: IconName }> = [
  { id: 'guide', label: 'User Guide', file: 'USER_GUIDE.html', icon: 'book-open' },
  { id: 'developer', label: 'Developer', file: 'DEVELOPER.html', icon: 'wrench' },
  { id: 'security', label: 'Security', file: 'SECURITY.html', icon: 'shield-check' },
];

export function DocsPanel() {
  const [doc, setDoc] = useState<DocId>('guide');
  const active = DOCS.find((d) => d.id === doc)!;

  return (
    <div className="page">
      <PageHead
        icon="book-open"
        title="Documentation"
        sub="The guide, the developer reference and the security notes, served from this build."
      />

      {/* Real buttons, not divs with a hand-written key handler: `role="tab"` on a
          real button gets Enter and Space for free. */}
      <div className="tab-bar" role="tablist" aria-label="Document">
        {DOCS.map((d) => (
          <button
            key={d.id}
            type="button"
            role="tab"
            aria-selected={doc === d.id}
            className={`tab ${doc === d.id ? 'active' : ''}`}
            onClick={() => setDoc(d.id)}
          >
            <Icon name={d.icon} size={16} /> {d.label}
          </button>
        ))}
      </div>

      <iframe
        key={active.file}
        title={active.label}
        src={`/docs/${active.file}`}
        className="docs-frame"
      />
    </div>
  );
}

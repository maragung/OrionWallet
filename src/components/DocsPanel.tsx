import { useEffect, useState } from 'react';
import { PageHead } from './PageHead';
import { Icon, type IconName } from './icons/Icon';
import { useI18n } from '../i18n/useI18n';

type DocId = 'guide' | 'developer' | 'security';

const DOCS: Array<{ id: DocId; labelKey: string; file: string; icon: IconName }> = [
  { id: 'guide', labelKey: 'docs.tabGuide', file: 'USER_GUIDE.html', icon: 'book-open' },
  { id: 'developer', labelKey: 'docs.tabDeveloper', file: 'DEVELOPER.html', icon: 'wrench' },
  { id: 'security', labelKey: 'docs.tabSecurity', file: 'SECURITY.html', icon: 'shield-check' },
];

export function DocsPanel() {
  const { t, lang } = useI18n();
  const [doc, setDoc] = useState<DocId>('guide');
  /** Whether /docs/<lang>/<file> exists; false means the English original is shown. */
  const [localized, setLocalized] = useState(false);
  const active = DOCS.find((d) => d.id === doc)!;

  // Documents are translated as whole files under /docs/<lang>/. Probe for the
  // selected language's copy and fall back to the English original at /docs/
  // when there is none — the notice below says which one the user is reading.
  useEffect(() => {
    let cancelled = false;
    fetch(`/docs/${lang}/${active.file}`, { method: 'HEAD' })
      .then((r) => {
        if (!cancelled) setLocalized(r.ok);
      })
      .catch(() => {
        if (!cancelled) setLocalized(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lang, active.file]);

  const src = localized ? `/docs/${lang}/${active.file}` : `/docs/${active.file}`;

  return (
    <div className="page">
      <PageHead icon="book-open" title={t('docs.title')} sub={t('docs.sub')} />

      {/* Real buttons, not divs with a hand-written key handler: `role="tab"` on a
          real button gets Enter and Space for free. */}
      <div className="tab-bar" role="tablist" aria-label={t('docs.title')}>
        {DOCS.map((d) => (
          <button
            key={d.id}
            type="button"
            role="tab"
            aria-selected={doc === d.id}
            className={`tab ${doc === d.id ? 'active' : ''}`}
            onClick={() => setDoc(d.id)}
          >
            <Icon name={d.icon} size={16} /> {t(d.labelKey)}
          </button>
        ))}
      </div>

      {!localized && (
        <div className="info-box spaced">
          <Icon name="info" size={16} />
          <div className="info-box-body">{t('docs.untranslated')}</div>
        </div>
      )}

      {/* Keyed by language too, so switching language remounts the frame with the
          translated document instead of leaving the previous one on screen. */}
      <iframe
        key={`${lang}:${active.file}`}
        title={t(active.labelKey)}
        src={src}
        className="docs-frame"
      />
    </div>
  );
}

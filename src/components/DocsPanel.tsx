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
  //
  // English has no /docs/en/ directory: its originals live at /docs/<file>,
  // so the root file is the native copy and needs no probe.
  //
  // Probing must verify the reply is a real document, not the app shell: the
  // host answers any unknown /docs/... path with index.html (status 200) via
  // its SPA rewrite, and treating that as "translated" would load the whole
  // wallet UI inside this frame — a mirror. A genuine doc never contains the
  // app mount point (`id="root"`), so its absence in the fetched body is the
  // signal that the language copy really exists.
  const native = lang === 'en';
  useEffect(() => {
    let cancelled = false;
    if (native) {
      setLocalized(false);
      return () => {
        cancelled = true;
      };
    }
    fetch(`/docs/${lang}/${active.file}`)
      .then(async (r) => {
        if (cancelled) return;
        if (!r.ok) {
          setLocalized(false);
          return;
        }
        const text = await r.text();
        if (!cancelled) setLocalized(!text.includes('id="root"'));
      })
      .catch(() => {
        if (!cancelled) setLocalized(false);
      });
    return () => {
      cancelled = true;
    };
  }, [native, lang, active.file]);

  const src = native
    ? `/docs/${active.file}`
    : localized
      ? `/docs/${lang}/${active.file}`
      : `/docs/${active.file}`;

  const showNotice = !native && !localized;

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

      {showNotice && (
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

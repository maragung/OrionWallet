import { useState, useRef, useEffect } from 'react';
import { useI18n } from '../i18n/useI18n';
import type { LanguageCode } from '../i18n/types';

/**
 * Language switcher dropdown — instantly switches UI language without refresh.
 * Shows flag + native name. Supports 20 world languages.
 */
export function LanguageSwitcher() {
  const { lang, setLang, languages, currentLanguage } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleSelect = (code: LanguageCode) => {
    setLang(code);
    setOpen(false);
  };

  return (
    <div ref={ref} className="lang-switcher" style={{ position: 'relative' }}>
      <button
        className="ghost icon"
        onClick={() => setOpen(!open)}
        title={currentLanguage.englishName}
        aria-label={`Language: ${currentLanguage.englishName}`}
        style={{
          minHeight: 36,
          minWidth: 36,
          fontSize: 16,
          gap: 'var(--sp-1)',
          padding: 'var(--sp-1) var(--sp-2)',
        }}
      >
        <span style={{ fontSize: 18 }}>{currentLanguage.flag}</span>
        <span style={{ fontSize: 'var(--fs-xs)', fontWeight: 'var(--fw-semibold)' }}>
          {lang.toUpperCase()}
        </span>
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            right: 0,
            background: 'var(--bg-elevated-1)',
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--r-md)',
            boxShadow: 'var(--shadow-lg)',
            zIndex: 10000,
            minWidth: 200,
            maxHeight: 400,
            overflowY: 'auto',
            animation: 'slideUp var(--t-fast)',
          }}
        >
          {languages.map((l) => (
            <button
              key={l.code}
              className="ghost"
              onClick={() => handleSelect(l.code)}
              style={{
                width: '100%',
                justifyContent: 'flex-start',
                gap: 'var(--sp-2)',
                padding: 'var(--sp-2) var(--sp-3)',
                minHeight: 36,
                background: l.code === lang ? 'var(--accent-soft)' : 'transparent',
                color: l.code === lang ? 'var(--accent)' : 'var(--text-primary)',
                fontWeight: l.code === lang ? 'var(--fw-semibold)' : 'var(--fw-normal)',
                borderRadius: 0,
                borderBottom: '1px solid var(--border-subtle)',
              }}
            >
              <span style={{ fontSize: 18 }}>{l.flag}</span>
              <span style={{ flex: 1, textAlign: 'left' }}>{l.name}</span>
              {l.code === lang && <span style={{ color: 'var(--accent)' }}>✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

import { useCallback, useState } from 'react';
import { useI18n } from '../i18n/useI18n';
import { useAnchoredMenu } from '../hooks/useAnchoredMenu';
import { Icon } from './icons';
import type { LanguageCode } from '../i18n/types';

/**
 * Standalone language picker for screens that have no app header — currently the
 * unlock/landing screen, where a user who cannot read English would otherwise have
 * to guess their way past the lock before reaching the language list in the header
 * menu.
 *
 * Inside the app the same choice lives in `HeaderMenu`; both render the identical
 * `.menu-item` rows, so the two entry points look like one control.
 */
export function LanguageSwitcher() {
  const { lang, setLang, languages, currentLanguage } = useI18n();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  // Anchored in a top-level layer, like every other menu in the app: the corner it
  // sits in is `position: absolute` inside the auth shell, and a menu nested there
  // would be clipped and would also fall behind a toast.
  const {
    anchorRef,
    menuRef,
    style: menuStyle,
    portal,
  } = useAnchoredMenu<HTMLButtonElement>(open, {
    align: 'right',
    width: 232,
    maxHeight: 360,
    onDismiss: close,
  });

  const select = (code: LanguageCode) => {
    setLang(code);
    setOpen(false);
  };

  return (
    <>
      <button
        ref={anchorRef}
        className="chip lang-pill"
        onClick={() => setOpen(!open)}
        title={currentLanguage.englishName}
        aria-label={`Language: ${currentLanguage.englishName}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Icon name="globe" size={14} />
        <span className="chip-text">{lang.toUpperCase()}</span>
        <Icon name="chevron-down" size={14} className="muted" />
      </button>

      {open &&
        portal(
          <div
            ref={menuRef}
            className="menu-panel"
            role="menu"
            aria-label="Language"
            data-testid="language-menu"
            style={menuStyle}
          >
            <div className="menu-section">Language</div>
            {languages.map((l) => (
              <button
                key={l.code}
                className={`menu-item ${l.code === lang ? 'active' : ''}`}
                role="menuitemradio"
                aria-checked={l.code === lang}
                onClick={() => select(l.code)}
                lang={l.code}
              >
                {/* Flags stay as emoji here for the same reason as in `HeaderMenu`:
                    a national flag has no honest monochrome stroke silhouette. */}
                <span className="flag" aria-hidden="true">
                  {l.flag}
                </span>
                <span className="truncate">{l.name}</span>
                {l.code === lang && <Icon name="check" size={16} className="menu-item-note" />}
              </button>
            ))}
          </div>,
        )}
    </>
  );
}

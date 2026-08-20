import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWalletStore } from '../store/wallet-store';
import { useI18n } from '../i18n/useI18n';
import { PanelSkeleton } from './PanelSkeleton';
import { parseCircleTarget, parseCircleUri, type CircleTarget } from '../browser/octUri';
import {
  fetchCircleInfo,
  fetchPublicAsset,
  fetchSealedAsset,
  isSealedMode,
  MAX_ASSET_BYTES,
  MAX_SUBRESOURCE_BYTES,
  type CircleAsset,
  type CircleInfo,
} from '../browser/circleClient';
import { materializeHtml, sandboxFor, type RenderMode } from '../browser/materialize';
import { addBookmark, listBookmarks, removeBookmark, type Bookmark } from '../browser/bookmarks';
import { Icon } from './icons/Icon';
import { PageHead } from './PageHead';
import { getCurrentTheme } from '../hooks/useTheme';
import { THEME_COLORS } from '../styles/theme-colors';

interface NavState {
  history: string[]; // stack of oct:// uris
  index: number; // pointer into history
}

function randomToken(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * `oct://` circle browser (Option A: static full execution).
 *
 * Resolves circle assets directly from the Octra node, inlines all
 * sub-resources, and renders the page in a sandboxed `srcdoc` iframe. Sealed
 * (encrypted) circles prompt for a passphrase and are decrypted in-wallet.
 * Interactive compute (relayer bridge) is intentionally out of scope here.
 */
export function BrowserPanel() {
  const { wallet, rpc } = useWalletStore();
  const { t } = useI18n();

  const [address, setAddress] = useState('');
  const [nav, setNav] = useState<NavState>({ history: [], index: -1 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [srcDoc, setSrcDoc] = useState('');
  const [renderMode, setRenderMode] = useState<RenderMode>('public');
  const [pageTitle, setPageTitle] = useState('');

  // Sealed passphrase state.
  const [needPass, setNeedPass] = useState(false);
  const [passInput, setPassInput] = useState('');
  const passphraseRef = useRef<Record<string, string>>({});
  const pendingTargetRef = useRef<CircleTarget | null>(null);
  const bridgeTokenRef = useRef('');

  // Bookmarks.
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [showBookmarks, setShowBookmarks] = useState(false);

  const currentUri = nav.index >= 0 ? nav.history[nav.index]! : '';
  const canBack = nav.index > 0;
  const canForward = nav.index >= 0 && nav.index < nav.history.length - 1;

  const refreshBookmarks = useCallback(() => {
    listBookmarks()
      .then(setBookmarks)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshBookmarks();
  }, [refreshBookmarks]);

  const isCurrentBookmarked = useMemo(
    () => bookmarks.some((b) => b.uri === currentUri),
    [bookmarks, currentUri],
  );

  /**
   * Load and render a circle target. When `pushHistory` is false the nav stack
   * is left untouched (used for back/forward/reload).
   */
  const render = useCallback(
    async (target: CircleTarget, pushHistory: boolean) => {
      if (!rpc) {
        setError(t('browser.noRpc'));
        return;
      }
      setLoading(true);
      setError(null);
      setNeedPass(false);
      try {
        const info: CircleInfo = await fetchCircleInfo(rpc, target.circleId);
        const sealed = isSealedMode(info);
        const mode: RenderMode = sealed ? 'sealed' : 'public';

        // Sealed circles need a wallet (for the read-auth signature) + passphrase.
        let passphrase = '';
        if (sealed) {
          if (!wallet) {
            throw new Error(t('browser.sealedNeedsWallet'));
          }
          passphrase = passphraseRef.current[target.circleId] ?? '';
          if (!passphrase) {
            pendingTargetRef.current = target;
            setNeedPass(true);
            setLoading(false);
            return;
          }
        }

        const fetchAsset = async (path: string, maxBytes: number): Promise<CircleAsset> =>
          sealed
            ? fetchSealedAsset(rpc, wallet!, target.circleId, path, passphrase, maxBytes)
            : fetchPublicAsset(rpc, target.circleId, path, maxBytes);

        // Sub-resources get a tighter ceiling than the entry document: a page
        // pulls many of them, so the per-asset cap bounds total frame size.
        const load = async (path: string): Promise<CircleAsset> =>
          fetchAsset(path, MAX_SUBRESOURCE_BYTES);

        const entry = await fetchAsset(target.path, MAX_ASSET_BYTES);
        const bridgeToken = randomToken();
        bridgeTokenRef.current = bridgeToken;

        let html: string;
        if (entry.contentType.includes('html')) {
          html = await materializeHtml({
            circleId: target.circleId,
            htmlPath: target.path,
            htmlText: entry.text,
            mode,
            bridgeToken,
            load,
          });
        } else if (entry.contentType.startsWith('image/')) {
          const b64 = btoa(String.fromCharCode(...entry.bytes));
          html = fallbackDoc(
            `<img src="data:${entry.contentType};base64,${b64}" alt="">`,
            'centered',
          );
        } else {
          // Textual / other → show as preformatted text.
          const text = entry.text || `[${entry.contentType}, ${entry.bytes.length} bytes]`;
          html = fallbackDoc(`<pre>${escapeHtml(text)}</pre>`, 'text');
        }

        setRenderMode(mode);
        setSrcDoc(html);
        setPageTitle(extractTitle(entry.text) || target.circleId);
        setAddress(target.uri);

        if (pushHistory) {
          setNav((prev) => {
            const trimmed = prev.history.slice(0, prev.index + 1);
            trimmed.push(target.uri);
            return { history: trimmed, index: trimmed.length - 1 };
          });
        }
      } catch (e) {
        setError((e as Error).message);
        setSrcDoc('');
      } finally {
        setLoading(false);
      }
    },
    [rpc, wallet, t],
  );

  // Navigation via oct:// links inside the iframe (postMessage from prelude).
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const data = e.data as { type?: string; token?: string; uri?: string } | undefined;
      if (!data || data.type !== 'octra.circle.navigate') return;
      if (data.token !== bridgeTokenRef.current) return;
      const parsed = parseCircleUri(data.uri ?? '');
      if (parsed) void render(parsed, true);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [render]);

  const go = useCallback(() => {
    const target = parseCircleTarget(address.trim());
    if (!target.circleId) {
      setError(t('browser.invalidUri'));
      return;
    }
    void render(target, true);
  }, [address, render, t]);

  const back = useCallback(() => {
    if (!canBack) return;
    const idx = nav.index - 1;
    setNav((p) => ({ ...p, index: idx }));
    const parsed = parseCircleUri(nav.history[idx]!);
    if (parsed) void render(parsed, false);
  }, [canBack, nav, render]);

  const forward = useCallback(() => {
    if (!canForward) return;
    const idx = nav.index + 1;
    setNav((p) => ({ ...p, index: idx }));
    const parsed = parseCircleUri(nav.history[idx]!);
    if (parsed) void render(parsed, false);
  }, [canForward, nav, render]);

  const reload = useCallback(() => {
    if (!currentUri) return;
    const parsed = parseCircleUri(currentUri);
    if (parsed) void render(parsed, false);
  }, [currentUri, render]);

  const submitPassphrase = useCallback(() => {
    const target = pendingTargetRef.current;
    if (!target) return;
    passphraseRef.current[target.circleId] = passInput;
    setPassInput('');
    setNeedPass(false);
    void render(target, true);
  }, [passInput, render]);

  const toggleBookmark = useCallback(async () => {
    if (!currentUri) return;
    if (isCurrentBookmarked) {
      await removeBookmark(currentUri);
    } else {
      await addBookmark(currentUri, pageTitle || currentUri);
    }
    refreshBookmarks();
  }, [currentUri, isCurrentBookmarked, pageTitle, refreshBookmarks]);

  if (!rpc) return <PanelSkeleton title={t('nav.browser')} rows={2} />;

  return (
    <div className="page">
      <PageHead
        icon="app-window"
        title="Circle Browser"
        sub="Open an oct:// circle page. Sealed circles are decrypted in-wallet and rendered in a sandbox."
      />

      <div className="card browser-shell">
        {/* Address bar + controls */}
        <div className="browser-bar">
          <button
            className="icon-btn"
            onClick={back}
            disabled={!canBack}
            aria-label={t('browser.back')}
            title={t('browser.back')}
          >
            <Icon name="arrow-left" size={18} />
          </button>
          <button
            className="icon-btn"
            onClick={forward}
            disabled={!canForward}
            aria-label={t('browser.forward')}
            title={t('browser.forward')}
          >
            <Icon name="arrow-right" size={18} />
          </button>
          <button
            className="icon-btn"
            onClick={reload}
            disabled={!currentUri || loading}
            aria-label={t('browser.reload')}
            title={t('browser.reload')}
          >
            <Icon
              name={loading ? 'loader' : 'refresh'}
              size={18}
              className={loading ? 'icon-spin' : undefined}
            />
          </button>
          <input
            className="mono browser-url"
            placeholder="oct://oct…/index.html"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') go();
            }}
            spellCheck={false}
            aria-label={t('browser.open')}
          />
          <button className="primary btn-sm" onClick={go} disabled={loading}>
            {t('browser.open')}
          </button>
          {/* `aria-pressed`, not a swapped glyph: the button is a toggle, and a filled
            versus hollow star is invisible to a screen reader. */}
          <button
            className={`icon-btn ${isCurrentBookmarked ? 'on' : ''}`}
            onClick={toggleBookmark}
            disabled={!currentUri}
            aria-label={t('browser.bookmark')}
            aria-pressed={isCurrentBookmarked}
            title={t('browser.bookmark')}
          >
            <Icon name="star" size={18} />
          </button>
          <button
            className="icon-btn"
            onClick={() => setShowBookmarks((v) => !v)}
            aria-label={t('browser.bookmarks')}
            aria-expanded={showBookmarks}
            title={t('browser.bookmarks')}
          >
            <Icon name="menu" size={18} />
          </button>
        </div>

        {/* Mode badge / status */}
        <div className="browser-status">
          {srcDoc && (
            <span className={`tag ${renderMode === 'sealed' ? 'warn' : ''}`}>
              {renderMode === 'sealed' ? (
                <>
                  <Icon name="lock" size={12} /> {t('browser.sealed')}
                </>
              ) : (
                <>
                  <Icon name="globe" size={12} /> {t('browser.public')}
                </>
              )}
            </span>
          )}
          <span className="browser-title">{pageTitle}</span>
        </div>

        {/* Bookmarks drawer */}
        {showBookmarks && (
          <div className="browser-drawer">
            <div className="browser-drawer-head">{t('browser.bookmarks')}</div>
            {bookmarks.length === 0 ? (
              <div className="browser-drawer-empty">{t('browser.noBookmarks')}</div>
            ) : (
              bookmarks.map((b) => (
                <div key={b.uri} className="bookmark-row">
                  <button
                    className="ghost bookmark-open"
                    onClick={() => {
                      setShowBookmarks(false);
                      setAddress(b.uri);
                      const parsed = parseCircleUri(b.uri);
                      if (parsed) void render(parsed, true);
                    }}
                  >
                    <span className="bookmark-title">{b.title}</span>
                    <span className="mono bookmark-uri">{b.uri}</span>
                  </button>
                  <button
                    className="icon-btn plain danger"
                    onClick={async () => {
                      await removeBookmark(b.uri);
                      refreshBookmarks();
                    }}
                    aria-label={t('common.delete')}
                    title={t('common.delete')}
                  >
                    <Icon name="x" size={16} />
                  </button>
                </div>
              ))
            )}
          </div>
        )}

        {/* Sealed passphrase prompt */}
        {needPass && (
          <div className="browser-drawer">
            <div className="browser-pass-head">
              <Icon name="lock" size={16} /> {t('browser.passphrasePrompt')}
            </div>
            <div className="input-row">
              <input
                type="password"
                placeholder={t('browser.passphrase')}
                value={passInput}
                onChange={(e) => setPassInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitPassphrase();
                }}
                aria-label={t('browser.passphrase')}
                autoFocus
              />
              <button className="primary" onClick={submitPassphrase} disabled={!passInput}>
                <Icon name="unlock" size={16} /> {t('browser.unlock')}
              </button>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="browser-error">
            <Icon name="alert-triangle" size={16} />
            <span>
              {t('browser.error')}: {error}
            </span>
          </div>
        )}

        {/* Rendered circle */}
        {srcDoc ? (
          <iframe
            title="oct-circle"
            srcDoc={srcDoc}
            sandbox={sandboxFor(renderMode)}
            referrerPolicy="no-referrer"
            className="browser-frame"
          />
        ) : (
          !error &&
          !needPass && (
            <div className="browser-empty">
              <Icon name="app-window" size={28} />
              <span>{t('browser.emptyHint')}</span>
            </div>
          )
        )}
      </div>
    </div>
  );
}

/**
 * Chrome for an asset the circle did not ship as HTML — a bare image, or text.
 *
 * The frame is a separate document, so it cannot reach `global.css` or its custom
 * properties; the two colours have to be inlined. They are read from `THEME_COLORS`
 * rather than written as literals, because the pair that used to be hardcoded here
 * (`#0a0a0f` on `#ddd`) was the *previous* palette's base and stayed black after the
 * theme switched to light — a black slab in the middle of a white page.
 *
 * The colours are a snapshot taken when the asset loads. Flipping the theme while a
 * non-HTML asset is on screen leaves the frame on the old pair until the next
 * navigation; re-tinting it would mean re-fetching the asset for a cosmetic change.
 */
function fallbackDoc(body: string, kind: 'centered' | 'text'): string {
  const theme = getCurrentTheme();
  const bg = THEME_COLORS[theme];
  const fg = theme === 'light' ? '#4b5162' : '#a8b0be';
  const layout =
    kind === 'centered'
      ? 'display:flex;align-items:center;justify-content:center;min-height:100vh'
      : '';
  return (
    `<!DOCTYPE html><html><head><meta name="color-scheme" content="${theme}">` +
    `<style>html{color-scheme:${theme}}` +
    `body{margin:0;background:${bg};color:${fg};${layout}}` +
    `img{max-width:100%;height:auto}` +
    `pre{white-space:pre-wrap;word-break:break-word;padding:16px;margin:0;` +
    `font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;line-height:1.6}` +
    `</style></head><body>${body}</body></html>`
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function extractTitle(html: string): string {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  return m ? m[1]!.trim() : '';
}

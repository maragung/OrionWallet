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
          html = `<!DOCTYPE html><html><body style="margin:0;display:flex;align-items:center;justify-content:center;background:#0a0a0f;min-height:100vh"><img src="data:${entry.contentType};base64,${b64}" style="max-width:100%"></body></html>`;
        } else {
          // Textual / other → show as preformatted text.
          const text = entry.text || `[${entry.contentType}, ${entry.bytes.length} bytes]`;
          html = `<!DOCTYPE html><html><body style="margin:0;background:#0a0a0f;color:#ddd"><pre style="white-space:pre-wrap;word-break:break-word;padding:16px;font-family:monospace">${escapeHtml(text)}</pre></body></html>`;
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
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* Address bar + controls */}
      <div
        style={{
          display: 'flex',
          gap: 'var(--sp-1)',
          alignItems: 'center',
          padding: 'var(--sp-2)',
          borderBottom: '1px solid var(--border-subtle)',
          flexWrap: 'wrap',
        }}
      >
        <button className="ghost" onClick={back} disabled={!canBack} aria-label={t('browser.back')}>
          ←
        </button>
        <button
          className="ghost"
          onClick={forward}
          disabled={!canForward}
          aria-label={t('browser.forward')}
        >
          →
        </button>
        <button
          className="ghost"
          onClick={reload}
          disabled={!currentUri || loading}
          aria-label={t('browser.reload')}
        >
          ⟳
        </button>
        <input
          className="mono"
          style={{ flex: 1, minWidth: 180 }}
          placeholder="oct://oct…/index.html"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go();
          }}
          spellCheck={false}
        />
        <button className="primary" onClick={go} disabled={loading}>
          {loading ? <span className="spinner" /> : t('browser.open')}
        </button>
        <button
          className="ghost"
          onClick={toggleBookmark}
          disabled={!currentUri}
          aria-label={t('browser.bookmark')}
          title={t('browser.bookmark')}
        >
          {isCurrentBookmarked ? '★' : '☆'}
        </button>
        <button
          className="ghost"
          onClick={() => setShowBookmarks((v) => !v)}
          aria-label={t('browser.bookmarks')}
          title={t('browser.bookmarks')}
        >
          ☰
        </button>
      </div>

      {/* Mode badge / status */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--sp-2)',
          padding: 'var(--sp-1) var(--sp-2)',
          fontSize: 'var(--fs-xs)',
          color: 'var(--text-muted)',
          borderBottom: '1px solid var(--border-subtle)',
        }}
      >
        {srcDoc && (
          <span className={`tag ${renderMode === 'sealed' ? 'warn' : ''}`}>
            {renderMode === 'sealed' ? `🔒 ${t('browser.sealed')}` : `🌐 ${t('browser.public')}`}
          </span>
        )}
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {pageTitle}
        </span>
      </div>

      {/* Bookmarks drawer */}
      {showBookmarks && (
        <div style={{ borderBottom: '1px solid var(--border-subtle)', padding: 'var(--sp-2)' }}>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginBottom: 6 }}>
            {t('browser.bookmarks')}
          </div>
          {bookmarks.length === 0 ? (
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
              {t('browser.noBookmarks')}
            </div>
          ) : (
            bookmarks.map((b) => (
              <div
                key={b.uri}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--sp-2)',
                  padding: '4px 0',
                }}
              >
                <button
                  className="ghost"
                  style={{ flex: 1, justifyContent: 'flex-start', textAlign: 'left', minWidth: 0 }}
                  onClick={() => {
                    setShowBookmarks(false);
                    setAddress(b.uri);
                    const parsed = parseCircleUri(b.uri);
                    if (parsed) void render(parsed, true);
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block' }}>{b.title}</span>
                    <span
                      className="mono"
                      style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}
                    >
                      {b.uri}
                    </span>
                  </span>
                </button>
                <button
                  className="ghost danger"
                  onClick={async () => {
                    await removeBookmark(b.uri);
                    refreshBookmarks();
                  }}
                  aria-label={t('common.delete')}
                >
                  ✕
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {/* Sealed passphrase prompt */}
      {needPass && (
        <div style={{ padding: 'var(--sp-3)', borderBottom: '1px solid var(--border-subtle)' }}>
          <div style={{ marginBottom: 'var(--sp-2)', fontSize: 13 }}>
            🔒 {t('browser.passphrasePrompt')}
          </div>
          <div style={{ display: 'flex', gap: 'var(--sp-1)' }}>
            <input
              type="password"
              style={{ flex: 1 }}
              placeholder={t('browser.passphrase')}
              value={passInput}
              onChange={(e) => setPassInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitPassphrase();
              }}
              autoFocus
            />
            <button className="primary" onClick={submitPassphrase} disabled={!passInput}>
              {t('browser.unlock')}
            </button>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{ padding: 'var(--sp-3)', color: 'var(--danger)', fontSize: 13 }}>
          {t('browser.error')}: {error}
        </div>
      )}

      {/* Rendered circle */}
      {srcDoc ? (
        <iframe
          title="oct-circle"
          srcDoc={srcDoc}
          sandbox={sandboxFor(renderMode)}
          referrerPolicy="no-referrer"
          style={{
            width: '100%',
            height: '68vh',
            border: 'none',
            background: '#0a0a0f',
          }}
        />
      ) : (
        !error &&
        !needPass && (
          <div
            style={{
              padding: 32,
              textAlign: 'center',
              color: 'var(--text-muted)',
              fontSize: 13,
            }}
          >
            {t('browser.emptyHint')}
          </div>
        )
      )}
    </div>
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

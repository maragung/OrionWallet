/**
 * Turn a circle HTML asset into a self-contained `srcdoc` document for a
 * sandboxed iframe. All sub-resources (scripts, styles, images, fonts, media)
 * are inlined as `data:` URLs by resolving each through the circle, because —
 * unlike webcli — Orion has no local `/oct/` gateway server to stream them.
 *
 * Adapted from webcli `materializeSealedHtml` / `rewritePublicAssetRefs`
 * (static/circles.js:1216-1699). Two security postures:
 *   - sealed  : strict injected CSP + hardening prelude (no fetch/storage/etc.)
 *   - public  : looser (scripts + forms allowed), page JS may do its own network
 *
 * Intra-page `oct://` links are rewritten and click-intercepted to a
 * `postMessage({type:'octra.circle.navigate'})` so the host panel drives
 * navigation. There is no wallet/RPC bridge in this mode (Option A).
 */
import {
  normalizeAssetPath,
  circleUriOf,
  resolveCirclePath,
  isBlockedRemoteSpec,
  isDataSpec,
} from './octUri';
import type { CircleAsset } from './circleClient';

/** Loads a circle asset by (already-resolved) path. Provided by the panel. */
export type AssetLoader = (path: string) => Promise<CircleAsset>;

export type RenderMode = 'public' | 'sealed';

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

function makeDataUrl(contentType: string, bytes: Uint8Array): string {
  return `data:${contentType};base64,${bytesToBase64(bytes)}`;
}

function ensureHead(doc: Document): HTMLHeadElement {
  if (doc.head) return doc.head;
  const head = doc.createElement('head');
  doc.documentElement.insertBefore(head, doc.body || null);
  return head;
}

function prependHeadMeta(doc: Document, name: string, value: string, attrName: string): void {
  const head = ensureHead(doc);
  const meta = doc.createElement('meta');
  meta.setAttribute(attrName, name);
  meta.setAttribute('content', value);
  head.prepend(meta);
}

/** Strict CSP + no-referrer for sealed content (webcli circles.js:1259-1268). */
function injectSealedPolicy(doc: Document): void {
  doc.querySelectorAll('base').forEach((n) => n.remove());
  prependHeadMeta(
    doc,
    'Content-Security-Policy',
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
      'img-src data: blob:; font-src data:; media-src data: blob:; ' +
      "connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; " +
      "object-src 'none'; base-uri 'none'; form-action 'none'; manifest-src 'none'",
    'http-equiv',
  );
  prependHeadMeta(doc, 'referrer', 'no-referrer', 'name');
}

/** Rewrite an intra-page anchor to a canonical `oct://` URI (or `#`/data). */
function rewriteInternalAnchor(circleId: string, basePath: string, href: string): string {
  if (!href || href.startsWith('#') || isDataSpec(href)) return href;
  if (isBlockedRemoteSpec(href)) return '#';
  const resolved = resolveCirclePath(basePath, href);
  if (!resolved || isBlockedRemoteSpec(resolved)) return '#';
  return circleUriOf(circleId, resolved);
}

/**
 * Recursively inline a CSS text's `@import` and `url(...)` references as data:
 * URLs. Mirrors webcli `materializeCss` (circles.js:1216-1257).
 */
async function materializeCss(
  cssPath: string,
  cssText: string,
  load: AssetLoader,
  seen: Set<string> = new Set(),
): Promise<string> {
  if (seen.has(cssPath)) return '';
  const nextSeen = new Set(seen);
  nextSeen.add(cssPath);

  let result = cssText;

  // @import
  const importRegex = /@import\s+(?:url\(\s*)?["']?([^"')\s]+)["']?\s*\)?\s*;/gi;
  let m: RegExpExecArray | null;
  while ((m = importRegex.exec(result)) !== null) {
    const source = m[1]!.trim();
    let replacement = '';
    if (!isDataSpec(source) && !isBlockedRemoteSpec(source)) {
      const resolved = resolveCirclePath(cssPath, source);
      if (resolved && !isDataSpec(resolved) && !isBlockedRemoteSpec(resolved)) {
        const imported = await load(resolved);
        replacement = await materializeCss(resolved, imported.text, load, nextSeen);
      }
    }
    result = result.slice(0, m.index) + replacement + result.slice(m.index + m[0].length);
    importRegex.lastIndex = 0;
  }

  // url(...)
  const urlRegex = /url\(\s*(['"]?)([^"')]+)\1\s*\)/gi;
  while ((m = urlRegex.exec(result)) !== null) {
    const source = m[2]!.trim();
    let replacement = m[0];
    if (isBlockedRemoteSpec(source)) {
      replacement = 'url("data:,")';
    } else if (!isDataSpec(source)) {
      const resolved = resolveCirclePath(cssPath, source);
      if (!resolved || isBlockedRemoteSpec(resolved)) {
        replacement = 'url("data:,")';
      } else {
        const asset = await load(resolved);
        replacement = `url("${makeDataUrl(asset.contentType, asset.bytes)}")`;
      }
    }
    result = result.slice(0, m.index) + replacement + result.slice(m.index + m[0].length);
    urlRegex.lastIndex = m.index + replacement.length;
  }

  return result;
}

/** Prelude injected into the page: intercepts oct:// link clicks → parent. */
function navPreludeSource(circleId: string, htmlPath: string, token: string): string {
  const contextJson = JSON.stringify({
    circle_id: circleId,
    path: normalizeAssetPath(htmlPath),
    uri: circleUriOf(circleId, htmlPath),
  });
  return `(function(){
  var context=${contextJson};
  var token=${JSON.stringify(token)};
  try{
    window.OctraCircle=Object.freeze({
      context:Object.freeze(context),
      navigate:function(uri){parent.postMessage({type:'octra.circle.navigate',token:token,uri:uri},'*');}
    });
  }catch(e){}
  document.addEventListener('click',function(event){
    var t=event.target;
    var anchor=t&&t.closest?t.closest('a[href]'):null;
    if(!anchor)return;
    var href=anchor.getAttribute('href')||'';
    if(href.indexOf('oct://')===0){event.preventDefault();try{window.OctraCircle.navigate(href);}catch(e){}}
  },true);
})();`;
}

function installPrelude(doc: Document, circleId: string, htmlPath: string, token: string): void {
  const head = ensureHead(doc);
  const script = doc.createElement('script');
  script.textContent = navPreludeSource(circleId, htmlPath, token);
  head.prepend(script);
}

export interface MaterializeOptions {
  circleId: string;
  htmlPath: string;
  htmlText: string;
  mode: RenderMode;
  /** Random per-render token to authenticate navigate messages. */
  bridgeToken: string;
  /** Resolves + fetches (and decrypts, if sealed) a circle asset by path. */
  load: AssetLoader;
}

/**
 * Produce a full `<!DOCTYPE html>...` string with every sub-resource inlined,
 * ready to drop into an `<iframe srcdoc>`.
 */
export async function materializeHtml(opts: MaterializeOptions): Promise<string> {
  const { circleId, htmlPath, htmlText, mode, bridgeToken, load } = opts;
  const doc = new DOMParser().parseFromString(htmlText, 'text/html');

  // Always strip any page-authored <base> so relative resolution stays ours.
  doc.querySelectorAll('base').forEach((n) => n.remove());
  // Strip page-authored CSP metas — they reference `'self'` which is a null
  // origin under srcdoc and would break inlined data: resources.
  doc
    .querySelectorAll('meta[http-equiv]')
    .forEach((n) => {
      if ((n.getAttribute('http-equiv') || '').toLowerCase() === 'content-security-policy') {
        n.remove();
      }
    });

  if (mode === 'sealed') injectSealedPolicy(doc);
  installPrelude(doc, circleId, htmlPath, bridgeToken);

  // Inline <style> blocks.
  for (const node of Array.from(doc.querySelectorAll('style'))) {
    node.textContent = await materializeCss(htmlPath, node.textContent || '', load);
  }

  // <link> — stylesheets inlined as <style>, others → data: or dropped.
  for (const node of Array.from(doc.querySelectorAll('link[href]'))) {
    const rel = (node.getAttribute('rel') || '').toLowerCase();
    const href = node.getAttribute('href') || '';
    if (rel.includes('stylesheet')) {
      if (isBlockedRemoteSpec(href)) {
        node.remove();
      } else {
        const resolved = resolveCirclePath(htmlPath, href);
        if (!resolved || isBlockedRemoteSpec(resolved)) {
          node.remove();
        } else {
          const asset = await load(resolved);
          const style = doc.createElement('style');
          style.textContent = await materializeCss(resolved, asset.text, load);
          node.replaceWith(style);
        }
      }
    } else if (isBlockedRemoteSpec(href)) {
      node.removeAttribute('href');
    } else if (!isDataSpec(href)) {
      const resolved = resolveCirclePath(htmlPath, href);
      if (resolved && !isBlockedRemoteSpec(resolved)) {
        const asset = await load(resolved);
        node.setAttribute('href', makeDataUrl(asset.contentType, asset.bytes));
      }
    }
  }

  // <script src> → inline text (so it runs under the sandbox with no network).
  for (const node of Array.from(doc.querySelectorAll('script[src]'))) {
    const src = node.getAttribute('src') || '';
    if (isBlockedRemoteSpec(src)) {
      node.remove();
      continue;
    }
    const resolved = resolveCirclePath(htmlPath, src);
    if (!resolved || isBlockedRemoteSpec(resolved)) {
      node.remove();
      continue;
    }
    const asset = await load(resolved);
    const inline = doc.createElement('script');
    const typeAttr = node.getAttribute('type');
    if (typeAttr) inline.setAttribute('type', typeAttr);
    inline.textContent = asset.text;
    node.replaceWith(inline);
  }

  // Other [src] (img/media/etc.) → data: URLs.
  for (const node of Array.from(doc.querySelectorAll('[src]'))) {
    if (node.tagName.toLowerCase() === 'script') continue;
    const src = node.getAttribute('src') || '';
    if (isBlockedRemoteSpec(src)) {
      node.removeAttribute('src');
    } else if (!isDataSpec(src)) {
      const resolved = resolveCirclePath(htmlPath, src);
      if (resolved && !isBlockedRemoteSpec(resolved)) {
        const asset = await load(resolved);
        node.setAttribute('src', makeDataUrl(asset.contentType, asset.bytes));
      }
    }
  }

  // [poster] → data: URLs.
  for (const node of Array.from(doc.querySelectorAll('[poster]'))) {
    const poster = node.getAttribute('poster') || '';
    if (isBlockedRemoteSpec(poster)) {
      node.removeAttribute('poster');
    } else if (!isDataSpec(poster)) {
      const resolved = resolveCirclePath(htmlPath, poster);
      if (resolved && !isBlockedRemoteSpec(resolved)) {
        const asset = await load(resolved);
        node.setAttribute('poster', makeDataUrl(asset.contentType, asset.bytes));
      }
    }
  }

  // Anchors → oct:// (intercepted by the prelude); forms neutralized.
  for (const node of Array.from(doc.querySelectorAll('a[href]'))) {
    node.setAttribute(
      'href',
      rewriteInternalAnchor(circleId, htmlPath, node.getAttribute('href') || ''),
    );
  }
  for (const node of Array.from(doc.querySelectorAll('form[action]'))) {
    node.setAttribute('action', '#');
  }

  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
}

/** The iframe `sandbox` attribute value for a render mode. */
export function sandboxFor(mode: RenderMode): string {
  // Neither mode gets allow-same-origin (keeps the page in a null origin,
  // unable to touch Orion's storage/DOM). Public adds forms like webcli.
  return mode === 'sealed' ? 'allow-scripts' : 'allow-scripts allow-forms';
}

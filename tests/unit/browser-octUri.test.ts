import { describe, it, expect } from 'vitest';
import {
  parseCircleUri,
  parseCircleTarget,
  normalizeAssetPath,
  canonicalAssetPath,
  circleUriOf,
  isValidCircleId,
  resolveCirclePath,
  isBlockedRemoteSpec,
  isDataSpec,
  isTextContent,
  MAX_PATH_LENGTH,
} from '../../src/browser/octUri';

// Circle ids are real Octra addresses: `oct` + exactly 44 base58 chars.
// CIRCLE_A is the live octralabs demo circle.
const CIRCLE_A = 'oct99BWHFpV5r54DXKc2FhsBmZEaS6Q8zvCQrHRgXUcK4Fk';
const CIRCLE_B = 'octkF4KcUXgRHrQCvz8Q6SaEZmBshF2cKXD45r5VpFHWB99';

describe('circle id validation', () => {
  it('accepts well-formed ids', () => {
    expect(isValidCircleId(CIRCLE_A)).toBe(true);
    expect(isValidCircleId(CIRCLE_B)).toBe(true);
  });

  it('rejects malformed ids', () => {
    expect(isValidCircleId('octABC')).toBe(false); // too short
    expect(isValidCircleId(CIRCLE_A.slice(0, -1))).toBe(false); // 43 payload chars
    expect(isValidCircleId(`${CIRCLE_A}x`)).toBe(false); // 45 payload chars
    expect(isValidCircleId(`xyz${CIRCLE_A.slice(3)}`)).toBe(false); // bad prefix
    // 0, O, I and l are not in the base58 alphabet
    expect(isValidCircleId(`oct0${CIRCLE_A.slice(4)}`)).toBe(false);
    expect(isValidCircleId(`octO${CIRCLE_A.slice(4)}`)).toBe(false);
    expect(isValidCircleId(undefined)).toBe(false);
  });
});

describe('oct:// URI parsing', () => {
  it('defaults an empty path to /index.html', () => {
    expect(normalizeAssetPath('')).toBe('/index.html');
    expect(normalizeAssetPath('   ')).toBe('/index.html');
    expect(normalizeAssetPath(null)).toBe('/index.html');
  });

  it('roots a relative path with a single leading slash', () => {
    expect(normalizeAssetPath('app.js')).toBe('/app.js');
    expect(normalizeAssetPath('/style.css')).toBe('/style.css');
  });

  it('builds a canonical uri', () => {
    expect(circleUriOf(CIRCLE_A, 'x.js')).toBe(`oct://${CIRCLE_A}/x.js`);
    expect(circleUriOf(CIRCLE_A, '')).toBe(`oct://${CIRCLE_A}/index.html`);
  });

  it('parses a full uri with a path', () => {
    const r = parseCircleUri(`oct://${CIRCLE_A}/pages/a.html`);
    expect(r).toEqual({
      circleId: CIRCLE_A,
      path: '/pages/a.html',
      uri: `oct://${CIRCLE_A}/pages/a.html`,
    });
  });

  it('parses a bare circle id (no path) to /index.html', () => {
    const r = parseCircleUri(`oct://${CIRCLE_B}`);
    expect(r?.circleId).toBe(CIRCLE_B);
    expect(r?.path).toBe('/index.html');
  });

  it('is case-insensitive on the scheme and strips query/hash', () => {
    const r = parseCircleUri(`OCT://${CIRCLE_A}/a.html?x=1#frag`);
    expect(r?.circleId).toBe(CIRCLE_A);
    expect(r?.path).toBe('/a.html');
  });

  it('returns null for non-oct uris and empty ids', () => {
    expect(parseCircleUri('https://example.com')).toBeNull();
    expect(parseCircleUri('oct:///onlypath')).toBeNull();
    expect(parseCircleUri('')).toBeNull();
  });

  it('returns null for malformed circle ids', () => {
    expect(parseCircleUri('oct://octABC/a.html')).toBeNull();
    expect(parseCircleUri(`oct://${CIRCLE_A}x/a.html`)).toBeNull();
  });

  it('parseCircleTarget falls back to a bare id + path', () => {
    const r = parseCircleTarget(CIRCLE_A, 'sub/x.js');
    expect(r).toEqual({
      circleId: CIRCLE_A,
      path: '/sub/x.js',
      uri: `oct://${CIRCLE_A}/sub/x.js`,
    });
  });

  it('parseCircleTarget prefers an oct:// uri when given one', () => {
    const r = parseCircleTarget(`oct://${CIRCLE_A}/y.html`);
    expect(r.circleId).toBe(CIRCLE_A);
    expect(r.path).toBe('/y.html');
  });

  it('parseCircleTarget yields an empty uri for an unusable id', () => {
    const r = parseCircleTarget('not-a-circle', 'x.js');
    expect(r.uri).toBe('');
  });
});

describe('canonical asset paths', () => {
  it('drops empty and "." segments', () => {
    expect(canonicalAssetPath('/a//b/./c.js')).toBe('/a/b/c.js');
    expect(canonicalAssetPath('a/b.js')).toBe('/a/b.js');
  });

  it('rejects traversal, including percent-encoded', () => {
    expect(canonicalAssetPath('/a/../../etc/passwd')).toBe('');
    expect(canonicalAssetPath('/%2e%2e/secret')).toBe('');
  });

  it('rejects paths over the length cap', () => {
    expect(canonicalAssetPath(`/${'a'.repeat(MAX_PATH_LENGTH)}`)).toBe('');
    expect(canonicalAssetPath(`/${'a'.repeat(MAX_PATH_LENGTH - 2)}`)).not.toBe('');
  });

  it('rejects a uri whose path traverses', () => {
    expect(parseCircleUri(`oct://${CIRCLE_A}/../../etc/passwd`)).toBeNull();
  });
});

describe('path resolution + spec guards', () => {
  it('resolves relative specs against a base path', () => {
    expect(resolveCirclePath('/pages/a.html', 'b.js')).toBe('/pages/b.js');
    expect(resolveCirclePath('/pages/a.html', '../c.css')).toBe('/c.css');
    expect(resolveCirclePath('/pages/a.html', '/abs.png')).toBe('/abs.png');
  });

  it('leaves remote/data specs untouched', () => {
    expect(resolveCirclePath('/a.html', 'https://x/y.js')).toBe('https://x/y.js');
    expect(resolveCirclePath('/a.html', 'data:,')).toBe('data:,');
  });

  // Regression: the live octralabs demo circle cache-busts every sub-resource
  // (e.g. `app.js?v=circle-repeat-bounded`). Resolution must drop the query so
  // the path matches the on-chain canonical asset path.
  it('strips cache-busting query strings from sub-resource specs', () => {
    expect(resolveCirclePath('/index.html', 'style.css?v=circle-repeat-bounded')).toBe(
      '/style.css',
    );
    expect(resolveCirclePath('/index.html', 'app.js?v=circle-repeat-bounded')).toBe('/app.js');
    expect(
      resolveCirclePath('/index.html', 'tokenizer/gpt2_bpe.js?v=circle-repeat-bounded'),
    ).toBe('/tokenizer/gpt2_bpe.js');
  });

  it('strips hash fragments from sub-resource specs', () => {
    expect(resolveCirclePath('/index.html', 'sprite.svg#icon')).toBe('/sprite.svg');
  });

  it('classifies blocked remote specs', () => {
    expect(isBlockedRemoteSpec('https://x')).toBe(true);
    expect(isBlockedRemoteSpec('//x')).toBe(true);
    expect(isBlockedRemoteSpec('javascript:alert(1)')).toBe(true);
    expect(isBlockedRemoteSpec('mailto:a@b')).toBe(true);
    expect(isBlockedRemoteSpec('/local.js')).toBe(false);
  });

  it('classifies data/blob specs', () => {
    expect(isDataSpec('data:x')).toBe(true);
    expect(isDataSpec('blob:x')).toBe(true);
    expect(isDataSpec('/x')).toBe(false);
  });

  it('classifies textual content types', () => {
    expect(isTextContent('text/html; charset=utf-8')).toBe(true);
    expect(isTextContent('application/javascript')).toBe(true);
    expect(isTextContent('application/json')).toBe(true);
    expect(isTextContent('image/svg+xml')).toBe(true);
    expect(isTextContent('image/png')).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import {
  parseCircleUri,
  parseCircleTarget,
  normalizeAssetPath,
  circleUriOf,
  resolveCirclePath,
  isBlockedRemoteSpec,
  isDataSpec,
  isTextContent,
} from '../../src/browser/octUri';

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
    expect(circleUriOf('octABC', 'x.js')).toBe('oct://octABC/x.js');
    expect(circleUriOf('octABC', '')).toBe('oct://octABC/index.html');
  });

  it('parses a full uri with a path', () => {
    const r = parseCircleUri('oct://octABC/pages/a.html');
    expect(r).toEqual({
      circleId: 'octABC',
      path: '/pages/a.html',
      uri: 'oct://octABC/pages/a.html',
    });
  });

  it('parses a bare circle id (no path) to /index.html', () => {
    const r = parseCircleUri('oct://octXYZ');
    expect(r?.circleId).toBe('octXYZ');
    expect(r?.path).toBe('/index.html');
  });

  it('is case-insensitive on the scheme and strips query/hash', () => {
    const r = parseCircleUri('OCT://octABC/a.html?x=1#frag');
    expect(r?.circleId).toBe('octABC');
    expect(r?.path).toBe('/a.html');
  });

  it('returns null for non-oct uris and empty ids', () => {
    expect(parseCircleUri('https://example.com')).toBeNull();
    expect(parseCircleUri('oct:///onlypath')).toBeNull();
    expect(parseCircleUri('')).toBeNull();
  });

  it('parseCircleTarget falls back to a bare id + path', () => {
    const r = parseCircleTarget('octABC', 'sub/x.js');
    expect(r).toEqual({ circleId: 'octABC', path: '/sub/x.js', uri: 'oct://octABC/sub/x.js' });
  });

  it('parseCircleTarget prefers an oct:// uri when given one', () => {
    const r = parseCircleTarget('oct://octABC/y.html');
    expect(r.circleId).toBe('octABC');
    expect(r.path).toBe('/y.html');
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

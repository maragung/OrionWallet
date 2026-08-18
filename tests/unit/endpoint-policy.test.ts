/**
 * Endpoint policy — the gate in front of http:// RPC endpoints.
 *
 * Every case pins one blocker at a time, because the whole point of the module
 * is that "http does not work" has three different causes with three different
 * fixes, and telling the user the wrong one wastes their afternoon.
 */
import { describe, it, expect } from 'vitest';
import {
  assertEndpointAllowed,
  checkEndpoint,
  endpointWarning,
  isLoopbackUrl,
  isOriginAllowlisted,
  normalizeOrigin,
  parseEndpoint,
} from '../../src/wallet/endpoint-policy';

/** Plain-http page with the build flag on — the only situation http can work in. */
const HTTP_PAGE = { pageProtocol: 'http:', cspAllowsHttp: true };

describe('parseEndpoint', () => {
  it('parses absolute URLs and rejects everything else', () => {
    expect(parseEndpoint('https://rpc.example.com')?.hostname).toBe('rpc.example.com');
    expect(parseEndpoint('  https://rpc.example.com/  ')?.protocol).toBe('https:');
    expect(parseEndpoint('rpc.example.com')).toBeNull();
    expect(parseEndpoint('')).toBeNull();
    expect(parseEndpoint('   ')).toBeNull();
  });
});

describe('normalizeOrigin', () => {
  it('reduces a URL to scheme://host:port', () => {
    expect(normalizeOrigin('http://10.0.0.5:8080/rpc?x=1')).toBe('http://10.0.0.5:8080');
    expect(normalizeOrigin('https://rpc.example.com/rpc')).toBe('https://rpc.example.com');
  });

  it('assumes http:// for a bare host, since only http origins are ever listed', () => {
    expect(normalizeOrigin('10.0.0.5:8080')).toBe('http://10.0.0.5:8080');
  });

  it('drops the default port, so the same origin written two ways matches', () => {
    expect(normalizeOrigin('http://node.lan:80')).toBe('http://node.lan');
    expect(normalizeOrigin('http://node.lan')).toBe('http://node.lan');
  });

  it('rejects junk and non-web schemes', () => {
    expect(normalizeOrigin('')).toBeNull();
    expect(normalizeOrigin('   ')).toBeNull();
    expect(normalizeOrigin('ftp://node.lan')).toBeNull();
  });
});

describe('isOriginAllowlisted', () => {
  it('compares normalised forms, not raw strings', () => {
    expect(isOriginAllowlisted('http://10.0.0.5:8080', ['http://10.0.0.5:8080/'])).toBe(true);
    expect(isOriginAllowlisted('http://node.lan', ['node.lan'])).toBe(true);
    expect(isOriginAllowlisted('http://node.lan', ['http://other.lan'])).toBe(false);
  });

  it('is false for an empty or missing list', () => {
    expect(isOriginAllowlisted('http://node.lan', [])).toBe(false);
    expect(isOriginAllowlisted('http://node.lan', undefined)).toBe(false);
  });
});

describe('isLoopbackUrl', () => {
  it('covers the whole 127.0.0.0/8 range, ::1 and *.localhost', () => {
    expect(isLoopbackUrl('http://localhost:8080')).toBe(true);
    expect(isLoopbackUrl('http://node.localhost:8080')).toBe(true);
    expect(isLoopbackUrl('http://127.0.0.1:8080')).toBe(true);
    expect(isLoopbackUrl('http://127.1.2.3:8080')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:8080')).toBe(true);
  });

  it('is false for anything routable, including lookalikes', () => {
    expect(isLoopbackUrl('http://10.0.0.5:8080')).toBe(false);
    expect(isLoopbackUrl('http://127.0.0.1.evil.com')).toBe(false);
    expect(isLoopbackUrl('http://notlocalhost')).toBe(false);
    expect(isLoopbackUrl('nonsense')).toBe(false);
  });
});

describe('checkEndpoint', () => {
  it('allows https unconditionally', () => {
    const v = checkEndpoint('https://devnet.octrascan.io/rpc', {
      pageProtocol: 'https:',
      cspAllowsHttp: false,
    });
    expect(v).toMatchObject({ allowed: true, kind: 'https' });
  });

  it('allows loopback http even from an https page and with no allowlist', () => {
    const v = checkEndpoint('http://127.0.0.1:8080', {
      pageProtocol: 'https:',
      cspAllowsHttp: false,
      allowlist: [],
    });
    expect(v).toMatchObject({ allowed: true, kind: 'loopback' });
  });

  it('blames mixed content first on an https page — an allowlist cannot fix it', () => {
    const v = checkEndpoint('http://10.0.0.5:8080', {
      pageProtocol: 'https:',
      cspAllowsHttp: true,
      allowlist: ['http://10.0.0.5:8080'],
    });
    expect(v.allowed).toBe(false);
    expect(v.kind).toBe('mixed-content');
    expect(v.message).toMatch(/mixed content/i);
    expect(v.message).toMatch(/proxy|TLS/i);
  });

  it('blames the CSP when the build flag is off', () => {
    const v = checkEndpoint('http://10.0.0.5:8080', {
      pageProtocol: 'http:',
      cspAllowsHttp: false,
      allowlist: ['http://10.0.0.5:8080'],
    });
    expect(v.allowed).toBe(false);
    expect(v.kind).toBe('csp');
    expect(v.message).toContain('VITE_ALLOW_HTTP_ENDPOINTS=1');
  });

  it('blames the allowlist only once the browser would actually permit it', () => {
    const v = checkEndpoint('http://10.0.0.5:8080', HTTP_PAGE);
    expect(v.allowed).toBe(false);
    expect(v.kind).toBe('not-allowlisted');
    expect(v.origin).toBe('http://10.0.0.5:8080');
    expect(v.message).toMatch(/Settings → Network/);
  });

  it('allows an allowlisted origin, matching by origin rather than full URL', () => {
    const v = checkEndpoint('http://10.0.0.5:8080/rpc/v2', {
      ...HTTP_PAGE,
      allowlist: ['http://10.0.0.5:8080'],
    });
    expect(v).toMatchObject({ allowed: true, kind: 'allowlisted' });
  });

  it('does not let one allowlisted origin cover a different port', () => {
    const v = checkEndpoint('http://10.0.0.5:9999/rpc', {
      ...HTTP_PAGE,
      allowlist: ['http://10.0.0.5:8080'],
    });
    expect(v.allowed).toBe(false);
    expect(v.kind).toBe('not-allowlisted');
  });

  it('rejects a non-web scheme and an unparseable URL distinctly', () => {
    expect(checkEndpoint('ws://node.lan:8080', HTTP_PAGE)).toMatchObject({
      allowed: false,
      kind: 'scheme',
    });
    expect(checkEndpoint('http://', HTTP_PAGE)).toMatchObject({
      allowed: false,
      kind: 'invalid',
    });
    // A bare host:port parses as a URL whose scheme is the host, so it lands on
    // the scheme complaint rather than "invalid" — which still names the problem.
    expect(checkEndpoint('node.lan:8080/rpc', HTTP_PAGE)).toMatchObject({
      allowed: false,
      kind: 'scheme',
    });
  });

  describe('with a proxy in front', () => {
    it('judges the proxy, not the endpoint — the endpoint is never fetched', () => {
      const v = checkEndpoint('http://10.0.0.5:8080/rpc', {
        pageProtocol: 'https:',
        cspAllowsHttp: false,
        proxyUrl: 'https://proxy.example.com/?url=',
      });
      expect(v).toMatchObject({ allowed: true, kind: 'proxied' });
      expect(v.message).toContain('https://proxy.example.com');
    });

    it('refuses when the proxy itself is unreachable, and says so', () => {
      const v = checkEndpoint('https://rpc.example.com', {
        pageProtocol: 'https:',
        cspAllowsHttp: false,
        proxyUrl: 'http://10.0.0.5:3000/?url=',
      });
      expect(v.allowed).toBe(false);
      expect(v.message).toMatch(/proxy is unusable/i);
      expect(v.kind).toBe('mixed-content');
    });

    it('ignores a blank proxy setting', () => {
      const v = checkEndpoint('https://rpc.example.com', {
        pageProtocol: 'https:',
        proxyUrl: '   ',
      });
      expect(v).toMatchObject({ allowed: true, kind: 'https' });
    });
  });
});

describe('assertEndpointAllowed', () => {
  it('throws the verdict message, and nothing when allowed', () => {
    expect(() => assertEndpointAllowed('https://rpc.example.com', HTTP_PAGE)).not.toThrow();
    expect(() => assertEndpointAllowed('http://10.0.0.5:8080', HTTP_PAGE)).toThrow(
      /plaintext endpoint/i,
    );
  });
});

describe('endpointWarning', () => {
  it('is null for endpoints with nothing to warn about', () => {
    expect(endpointWarning('https://rpc.example.com', HTTP_PAGE)).toBeNull();
    expect(endpointWarning('http://127.0.0.1:8080', HTTP_PAGE)).toBeNull();
  });

  it('warns about a trusted-but-plaintext endpoint', () => {
    const w = endpointWarning('http://10.0.0.5:8080', {
      ...HTTP_PAGE,
      allowlist: ['http://10.0.0.5:8080'],
    });
    expect(w).toMatch(/Unencrypted RPC/);
    expect(w).toContain('http://10.0.0.5:8080');
  });

  it('passes the reason for a blocked endpoint straight through', () => {
    expect(endpointWarning('http://10.0.0.5:8080', HTTP_PAGE)).toMatch(/plaintext endpoint/i);
  });
});

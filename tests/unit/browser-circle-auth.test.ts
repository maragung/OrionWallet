import { describe, it, expect } from 'vitest';
import { frameV2, CIRCLE_AUTH_DOMAIN } from '../../src/browser/circleClient';

const enc = new TextEncoder();

/**
 * Independently build the expected framing so these are true vectors rather
 * than a restatement of the implementation:
 *
 *   <domain> ( "|" <byteLen> ":" <field> )*
 *
 * `<byteLen>` is the field's length in BYTES. The C++ reference uses
 * `std::string::size()`, which counts bytes, so a multi-byte UTF-8 field must
 * not be measured with JS string `.length`.
 */
function expected(domain: string, fields: string[]): Uint8Array {
  const chunks: number[] = [...enc.encode(domain)];
  for (const f of fields) {
    const body = enc.encode(f);
    chunks.push(...enc.encode(`|${body.length}:`), ...body);
  }
  return new Uint8Array(chunks);
}

describe('circle read-auth framing (frame_v2)', () => {
  it('uses the v2 domain separator', () => {
    expect(CIRCLE_AUTH_DOMAIN).toBe('octra_circle_auth_v2');
  });

  it('matches the reference framing for a typical read request', () => {
    const fields = [
      'octra_circle_asset_ciphertext_by_resource_key',
      'oct99BWHFpV5r54DXKc2FhsBmZEaS6Q8zvCQrHRgXUcK4Fk',
      'oct99BWHFpV5r54DXKc2FhsBmZEaS6Q8zvCQrHRgXUcK4Fk',
      'resource_key:abc123',
    ];
    expect(frameV2(CIRCLE_AUTH_DOMAIN, fields)).toEqual(
      expected(CIRCLE_AUTH_DOMAIN, fields),
    );
  });

  it('pins the exact byte string for a small vector', () => {
    const out = new TextDecoder().decode(frameV2('dom', ['ab', 'c']));
    expect(out).toBe('dom|2:ab|1:c');
  });

  // The v1 format was `op|circle|addr[|subject]` — an empty subject simply
  // vanished, so (subject="") and (no subject) signed identical bytes. v2 must
  // always emit the frame, even when empty.
  it('frames an empty field instead of dropping it', () => {
    const out = new TextDecoder().decode(frameV2('dom', ['op', '']));
    expect(out).toBe('dom|2:op|0:');
    expect(frameV2('dom', ['op', ''])).not.toEqual(frameV2('dom', ['op']));
  });

  // Length prefixes exist to remove delimiter ambiguity: a field containing
  // "|" must not be able to imitate a different field split.
  it('is unambiguous for fields containing the delimiter', () => {
    expect(frameV2('dom', ['a|b'])).not.toEqual(frameV2('dom', ['a', 'b']));
    expect(new TextDecoder().decode(frameV2('dom', ['a|b']))).toBe('dom|3:a|b');
  });

  it('counts BYTES, not JS string length, for multi-byte fields', () => {
    // "é" is 2 bytes in UTF-8 but 1 JS char; "😀" is 4 bytes but 2 JS chars.
    expect(new TextDecoder().decode(frameV2('dom', ['é']))).toBe('dom|2:é');
    expect(new TextDecoder().decode(frameV2('dom', ['😀']))).toBe('dom|4:😀');
    expect(frameV2('dom', ['é'])).toEqual(expected('dom', ['é']));
    expect(frameV2('dom', ['😀'])).toEqual(expected('dom', ['😀']));
  });

  it('handles a domain with no fields', () => {
    expect(new TextDecoder().decode(frameV2('dom', []))).toBe('dom');
  });
});

import { describe, it, expect } from 'vitest';
import {
  canonicalSerialize,
  canonicalSerializeOrdered,
  canonicalBytes,
  canonicalBytesOrdered,
  canonicalJsonForTx,
  computeTxHash,
  type CanonicalObject,
} from '../../src/tx/canonical-json';
import { sha256 } from '../../src/crypto/sha256';
import { hexEncode } from '../../src/crypto/hex';

describe('canonical-json', () => {
  it('serializes null', () => {
    expect(canonicalSerialize(null)).toBe('null');
  });

  it('serializes booleans', () => {
    expect(canonicalSerialize(true)).toBe('true');
    expect(canonicalSerialize(false)).toBe('false');
  });

  it('serializes integers', () => {
    expect(canonicalSerialize(0)).toBe('0');
    expect(canonicalSerialize(42)).toBe('42');
    expect(canonicalSerialize(-1)).toBe('-1');
    expect(canonicalSerialize(1000000)).toBe('1000000');
  });

  it('serializes integer-valued doubles without trailing .0 (nlohmann behavior)', () => {
    expect(canonicalSerialize(1000.0)).toBe('1000');
    expect(canonicalSerialize(1.0)).toBe('1');
  });

  it('serializes floats', () => {
    expect(canonicalSerialize(3.14)).toBe('3.14');
    expect(canonicalSerialize(0.5)).toBe('0.5');
  });

  it('serializes strings without escapes', () => {
    expect(canonicalSerialize('hello')).toBe('"hello"');
    expect(canonicalSerialize('')).toBe('""');
  });

  it('escapes special characters', () => {
    expect(canonicalSerialize('"')).toBe('"\\""');
    expect(canonicalSerialize('\\')).toBe('"\\\\"');
    expect(canonicalSerialize('\n')).toBe('"\\n"');
    expect(canonicalSerialize('\t')).toBe('"\\t"');
    expect(canonicalSerialize('\r')).toBe('"\\r"');
  });

  it('escapes control characters as \\u00XX', () => {
    expect(canonicalSerialize('\x01')).toBe('"\\u0001"');
    expect(canonicalSerialize('\x1f')).toBe('"\\u001f"');
  });

  it('serializes arrays', () => {
    expect(canonicalSerialize([1, 2, 3])).toBe('[1,2,3]');
    expect(canonicalSerialize([])).toBe('[]');
    expect(canonicalSerialize(['a', 'b'])).toBe('["a","b"]');
  });

  it('serializes objects (no whitespace)', () => {
    const obj = { a: 1, b: 'two', c: true };
    expect(canonicalSerialize(obj)).toBe('{"a":1,"b":"two","c":true}');
  });

  it('serializes empty object', () => {
    expect(canonicalSerialize({})).toBe('{}');
  });

  it('serializes nested structures', () => {
    const obj = { a: [1, 2], b: { c: 'd' } };
    expect(canonicalSerialize(obj)).toBe('{"a":[1,2],"b":{"c":"d"}}');
  });

  it('preserves insertion order with canonicalSerializeOrdered', () => {
    const entries: CanonicalObject = [
      ['z', 1],
      ['a', 2],
      ['m', 3],
    ];
    expect(canonicalSerializeOrdered(entries)).toBe('{"z":1,"a":2,"m":3}');
  });

  it('canonicalBytes returns UTF-8 bytes', () => {
    const bytes = canonicalBytes('hello');
    expect(bytes).toEqual(new TextEncoder().encode('"hello"'));
  });

  it('canonicalBytesOrdered returns UTF-8 bytes', () => {
    const entries: CanonicalObject = [['a', 1]];
    const bytes = canonicalBytesOrdered(entries);
    expect(bytes).toEqual(new TextEncoder().encode('{"a":1}'));
  });

  describe('canonicalJsonForTx', () => {
    it('produces the expected canonical form for a standard tx', () => {
      const tx = {
        from: 'oct' + 'a'.repeat(44),
        to: 'oct' + 'b'.repeat(44),
        amount: '1000000',
        nonce: 1,
        ou: '10000',
        timestamp: 1700000000,
        op_type: 'standard',
      };
      const canon = new TextDecoder().decode(canonicalJsonForTx(tx));
      expect(canon).toBe(
        `{"from":"${tx.from}","to_":"${tx.to}","amount":"1000000","nonce":1,"ou":"10000","timestamp":1700000000.0,"op_type":"standard"}`,
      );
    });

    it('includes message field when present', () => {
      const tx = {
        from: 'octaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        to: 'octbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        amount: '1',
        nonce: 0,
        ou: '1',
        timestamp: 0,
        op_type: 'standard',
        message: 'hello',
      };
      const canon = new TextDecoder().decode(canonicalJsonForTx(tx));
      expect(canon).toContain('"message":"hello"');
    });

    it('excludes empty message', () => {
      const tx = {
        from: 'octaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        to: 'octbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        amount: '1',
        nonce: 0,
        ou: '1',
        timestamp: 0,
        op_type: 'standard',
        message: '',
      };
      const canon = new TextDecoder().decode(canonicalJsonForTx(tx));
      expect(canon).not.toContain('message');
    });

    it('includes encrypted_data as a string', () => {
      const tx = {
        from: 'octaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        to: 'octbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        amount: '1',
        nonce: 0,
        ou: '1',
        timestamp: 0,
        op_type: 'stealth',
        encrypted_data: '{"foo":"bar"}',
      };
      const canon = new TextDecoder().decode(canonicalJsonForTx(tx));
      expect(canon).toContain('"encrypted_data":"{\\"foo\\":\\"bar\\"}"');
    });
  });

  describe('computeTxHash', () => {
    it('returns a 64-char hex string', () => {
      const tx = {
        from: 'octaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        to: 'octbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        amount: '1',
        nonce: 0,
        ou: '1',
        timestamp: 0,
        op_type: 'standard',
      };
      const hash = computeTxHash(tx);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('produces a stable hash for the same input', () => {
      const tx = {
        from: 'octaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        to: 'octbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        amount: '1',
        nonce: 0,
        ou: '1',
        timestamp: 0,
        op_type: 'standard',
      };
      const hash1 = computeTxHash(tx);
      const hash2 = computeTxHash(tx);
      expect(hash1).toBe(hash2);
    });

    it('hash matches sha256 of canonical bytes', () => {
      const tx = {
        from: 'octaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        to: 'octbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        amount: '1',
        nonce: 0,
        ou: '1',
        timestamp: 0,
        op_type: 'standard',
      };
      const expected = hexEncode(sha256(canonicalJsonForTx(tx)));
      expect(computeTxHash(tx)).toBe(expected);
    });
  });
});

import { describe, it, expect } from 'vitest';
import {
  signTransaction,
  verifyTransaction,
  buildTxJson,
  parseAmountRaw,
  formatAmount,
  recommendedOu,
  nowTs,
  type TransactionFields,
} from '../../src/tx/builder';
import { generateKeypair } from '../../src/crypto/ed25519';
import { base64Encode, base64Decode } from '../../src/crypto/base64';
import { deriveAddressFromPubkey } from '../../src/crypto/address';

describe('tx builder', () => {
  describe('parseAmountRaw', () => {
    it('parses integer string', () => {
      expect(parseAmountRaw('100')).toBe('100000000');
    });

    it('parses decimal string', () => {
      expect(parseAmountRaw('1.5')).toBe('1500000');
    });

    it('parses "0"', () => {
      expect(parseAmountRaw('0')).toBe('0');
    });

    it('parses "0.000001" (1 raw)', () => {
      expect(parseAmountRaw('0.000001')).toBe('1');
    });

    it('parses number input', () => {
      expect(parseAmountRaw(1.5)).toBe('1500000');
    });

    it('rejects negative', () => {
      expect(() => parseAmountRaw('-1')).toThrow('invalid amount');
    });

    it('rejects non-numeric', () => {
      expect(() => parseAmountRaw('abc')).toThrow('invalid amount');
    });

    it('truncates beyond 6 decimals', () => {
      // 1.1234567 → 1.123456 (truncates the 7)
      expect(parseAmountRaw('1.1234567')).toBe('1123456');
    });
  });

  describe('formatAmount', () => {
    it('formats raw 0', () => {
      expect(formatAmount('0')).toBe('0');
    });

    it('formats raw 1000000 as "1"', () => {
      expect(formatAmount('1000000')).toBe('1');
    });

    it('formats raw 1500000 as "1.5"', () => {
      expect(formatAmount('1500000')).toBe('1.5');
    });

    it('formats raw 1234567 as "1.234567"', () => {
      expect(formatAmount('1234567')).toBe('1.234567');
    });

    it('round-trips with parseAmountRaw', () => {
      const inputs = ['0', '1', '1.5', '0.000001', '100.123456'];
      for (const input of inputs) {
        const raw = parseAmountRaw(input);
        const formatted = formatAmount(raw);
        // Format may drop trailing zeros (e.g., "1.500000" → "1.5"), so re-parse
        expect(parseAmountRaw(formatted)).toBe(raw);
      }
    });

    // formatAmount runs inside table render paths (HistoryView). A throw there
    // unmounts the whole React tree and leaves the blank "Loading Orion Wallet…"
    // fallback from index.html. Neither node responses nor the local tx cache are
    // schema-validated, so malformed input must degrade instead of throwing.
    describe('malformed input (render-path safety)', () => {
      it('does not throw on null/undefined', () => {
        expect(() => formatAmount(null)).not.toThrow();
        expect(() => formatAmount(undefined)).not.toThrow();
        expect(formatAmount(null)).toBe('0');
        expect(formatAmount(undefined)).toBe('0');
      });

      it('accepts numbers, which the node sometimes returns instead of strings', () => {
        expect(() => formatAmount(1500000)).not.toThrow();
        expect(formatAmount(1500000)).toBe('1.5');
      });

      it('accepts bigint', () => {
        expect(formatAmount(1000000n)).toBe('1');
      });

      it('does not throw on non-numeric strings', () => {
        for (const bad of ['abc', '0x1f', '1e6', 'NaN', '--1']) {
          expect(() => formatAmount(bad)).not.toThrow();
        }
      });

      it('does not throw on empty or whitespace strings', () => {
        expect(formatAmount('')).toBe('0');
        expect(formatAmount('   ')).toBe('0');
      });

      it('does not throw on objects or arrays', () => {
        expect(() => formatAmount({})).not.toThrow();
        expect(() => formatAmount([])).not.toThrow();
      });

      it('handles negative raw amounts', () => {
        expect(formatAmount('-1500000')).toBe('-1.5');
        expect(formatAmount('-1000000')).toBe('-1');
      });
    });
  });

  describe('recommendedOu', () => {
    it('returns 10000 for small standard tx', () => {
      expect(recommendedOu('standard', 100_000n)).toBe('10000');
    });

    it('returns 30000 for large standard tx', () => {
      expect(recommendedOu('standard', 2_000_000_000n)).toBe('30000');
    });

    it('returns 1000000 for encrypt', () => {
      expect(recommendedOu('encrypt', 0n)).toBe('1000000');
    });

    it('returns 5000000 for program_deploy', () => {
      expect(recommendedOu('program_deploy', 0n)).toBe('5000000');
    });

    it('returns 100000 for program_call', () => {
      expect(recommendedOu('program_call', 0n)).toBe('100000');
    });
  });

  describe('nowTs', () => {
    it('returns current Unix timestamp in seconds', () => {
      const t = nowTs();
      const expected = Math.floor(Date.now() / 1000);
      expect(Math.abs(t - expected)).toBeLessThanOrEqual(2);
    });
  });

  describe('signTransaction + verifyTransaction', () => {
    it('signs and verifies a standard transaction', () => {
      const kp = generateKeypair();
      const addr = deriveAddressFromPubkey(kp.publicKey);
      const pubB64 = base64Encode(kp.publicKey);

      const fields: TransactionFields = {
        from: addr,
        to: 'oct' + 'b'.repeat(44),
        amount: '1000000',
        nonce: 1,
        ou: '10000',
        timestamp: 1700000000,
        op_type: 'standard',
      };

      const tx = signTransaction({
        secretKey: kp.secretKey,
        publicKeyB64: pubB64,
        fields,
      });

      // Signature is base64 (64 raw bytes → 88 base64 chars incl. padding).
      // Node verifies via Base64.decode_exn(signature).
      expect(tx.signature).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
      expect(base64Decode(tx.signature).length).toBe(64);
      expect(tx.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(tx.public_key).toBe(pubB64);

      // Verification succeeds
      expect(verifyTransaction(tx)).toBe(true);
    });

    it('fails verification with tampered amount', () => {
      const kp = generateKeypair();
      const addr = deriveAddressFromPubkey(kp.publicKey);
      const pubB64 = base64Encode(kp.publicKey);

      const tx = signTransaction({
        secretKey: kp.secretKey,
        publicKeyB64: pubB64,
        fields: {
          from: addr,
          to: 'oct' + 'b'.repeat(44),
          amount: '1000000',
          nonce: 1,
          ou: '10000',
          timestamp: 1700000000,
          op_type: 'standard',
        },
      });

      // Tamper
      const tampered = { ...tx, amount: '2000000' };
      expect(verifyTransaction(tampered)).toBe(false);
    });

    it('fails verification with wrong public key', () => {
      const kp1 = generateKeypair();
      const kp2 = generateKeypair();
      const addr = deriveAddressFromPubkey(kp1.publicKey);
      const pubB641 = base64Encode(kp1.publicKey);
      const pubB642 = base64Encode(kp2.publicKey);

      const tx = signTransaction({
        secretKey: kp1.secretKey,
        publicKeyB64: pubB641,
        fields: {
          from: addr,
          to: 'oct' + 'b'.repeat(44),
          amount: '1000000',
          nonce: 1,
          ou: '10000',
          timestamp: 1700000000,
          op_type: 'standard',
        },
      });

      // Wrong public key
      const tampered = { ...tx, public_key: pubB642 };
      expect(verifyTransaction(tampered)).toBe(false);
    });
  });

  describe('buildTxJson', () => {
    it('produces parseable JSON with all fields', () => {
      const kp = generateKeypair();
      const addr = deriveAddressFromPubkey(kp.publicKey);
      const pubB64 = base64Encode(kp.publicKey);

      const tx = signTransaction({
        secretKey: kp.secretKey,
        publicKeyB64: pubB64,
        fields: {
          from: addr,
          to: 'oct' + 'b'.repeat(44),
          amount: '1000000',
          nonce: 1,
          ou: '10000',
          timestamp: 1700000000,
          op_type: 'standard',
          message: 'hello',
        },
      });

      const json = buildTxJson(tx);
      const parsed = JSON.parse(json);
      expect(parsed.from).toBe(tx.from);
      // Wire format uses "to_" (node's of_yojson requirement), not "to".
      expect(parsed.to_).toBe(tx.to);
      expect(parsed.to).toBeUndefined();
      expect(parsed.amount).toBe(tx.amount);
      expect(parsed.nonce).toBe(tx.nonce);
      expect(parsed.ou).toBe(tx.ou);
      expect(parsed.timestamp).toBe(tx.timestamp);
      expect(parsed.op_type).toBe(tx.op_type);
      expect(parsed.signature).toBe(tx.signature);
      // "hash" is local-only and intentionally omitted from the wire payload.
      expect(parsed.hash).toBeUndefined();
      expect(parsed.public_key).toBe(tx.public_key);
      expect(parsed.message).toBe('hello');
    });
  });
});

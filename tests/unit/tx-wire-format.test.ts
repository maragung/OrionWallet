import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import { signTransaction, buildTxJson, verifyTransaction } from '../../src/tx/builder';
import { canonicalJsonForTx, type TransactionFields } from '../../src/tx/canonical-json';
import { deriveAddressFromPubkey } from '../../src/crypto/address';
import { base64Encode, base64Decode } from '../../src/crypto/base64';

/**
 * Regression: the submitted transaction MUST match the Octra node's wire
 * format (lib/core/transaction.ml). Previously the port emitted "to" (node
 * requires "to_") and hex signatures (node requires base64), causing every
 * submit to fail with "malformed transaction".
 */
describe('node wire-format compatibility (send/receive fix)', () => {
  function kp() {
    const k = nacl.sign.keyPair();
    return { publicKey: k.publicKey, secretKey: k.secretKey };
  }

  it('canonical signing JSON uses "to_" and node field order', () => {
    const fields: TransactionFields = {
      from: 'oct' + 'a'.repeat(44),
      to: 'oct' + 'b'.repeat(44),
      amount: '1500000',
      nonce: 7,
      ou: '10000',
      timestamp: 1700000000,
      op_type: 'standard',
    };
    const canon = new TextDecoder().decode(canonicalJsonForTx(fields));
    // Exact byte layout the node's serialize_for_signing produces.
    // timestamp is a Yojson float → integer values get a ".0" suffix.
    expect(canon).toBe(
      `{"from":"${fields.from}","to_":"${fields.to}","amount":"1500000",` +
        `"nonce":7,"ou":"10000","timestamp":1700000000.0,"op_type":"standard"}`,
    );
  });

  it('encrypted_data precedes message in canonical form (node order)', () => {
    const fields: TransactionFields = {
      from: 'octaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      to: 'octbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      amount: '1',
      nonce: 0,
      ou: '1',
      timestamp: 0,
      op_type: 'stealth',
      message: 'hi',
      encrypted_data: '{"x":1}',
    };
    const canon = new TextDecoder().decode(canonicalJsonForTx(fields));
    const encIdx = canon.indexOf('"encrypted_data"');
    const msgIdx = canon.indexOf('"message"');
    expect(encIdx).toBeGreaterThan(-1);
    expect(msgIdx).toBeGreaterThan(-1);
    expect(encIdx).toBeLessThan(msgIdx);
  });

  it('wire JSON has "to_", base64 signature, no "to"/"hash"', () => {
    const k = kp();
    const addr = deriveAddressFromPubkey(k.publicKey);
    const tx = signTransaction({
      secretKey: k.secretKey,
      publicKeyB64: base64Encode(k.publicKey),
      fields: {
        from: addr,
        to: 'oct' + 'c'.repeat(44),
        amount: '1000000',
        nonce: 1,
        ou: '10000',
        timestamp: 1700000000,
        op_type: 'standard',
      },
    });
    const wire = JSON.parse(buildTxJson(tx));
    expect(wire.to_).toBe('oct' + 'c'.repeat(44));
    expect(wire.to).toBeUndefined();
    expect(wire.hash).toBeUndefined();
    expect(base64Decode(wire.signature).length).toBe(64);
    expect(typeof wire.public_key).toBe('string');
  });

  it('signature verifies against the exact canonical bytes the node re-signs', () => {
    const k = kp();
    const addr = deriveAddressFromPubkey(k.publicKey);
    const fields: TransactionFields = {
      from: addr,
      to: 'oct' + 'd'.repeat(44),
      amount: '42',
      nonce: 3,
      ou: '10000',
      timestamp: 1700000123,
      op_type: 'standard',
    };
    const tx = signTransaction({
      secretKey: k.secretKey,
      publicKeyB64: base64Encode(k.publicKey),
      fields,
    });

    // Our own verifier
    expect(verifyTransaction(tx)).toBe(true);

    // Independent check: raw nacl verify over the canonical bytes with the
    // base64-decoded signature — this is exactly what the node does.
    const canon = new Uint8Array(canonicalJsonForTx(fields));
    const sigBytes = new Uint8Array(base64Decode(tx.signature));
    const pubBytes = new Uint8Array(k.publicKey);
    const ok = nacl.sign.detached.verify(canon, sigBytes, pubBytes);
    expect(ok).toBe(true);
  });
});

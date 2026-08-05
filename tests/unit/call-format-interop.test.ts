/**
 * Interop guard: a `call` tx signed by Orion must be byte-identical to the
 * proven Octora E2E signer, and its signature must verify. Uses the REAL
 * canonicalJsonForTx / signContractCall — not a reconstruction.
 */
import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import { signContractCall } from '../../src/connect/typed-data';
import { canonicalJsonForTx } from '../../src/tx/canonical-json';

function jsonEscape(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}
// verbatim from dev/scripts/test-ledger-e2e.js
function canonicalE2E(tx: Record<string, unknown>, extras: string[]): string {
  const keys = ['from', 'to_', 'amount', 'nonce', 'ou', 'timestamp', 'op_type', ...extras];
  const p: string[] = [];
  for (const k of keys) {
    if (tx[k] === undefined) continue;
    const v = tx[k];
    if (typeof v === 'string') p.push(`"${k}":"${jsonEscape(v)}"`);
    else if (typeof v === 'number' && k === 'nonce') p.push(`"${k}":${v}`);
    else if (typeof v === 'number') p.push(`"${k}":${Number.isInteger(v) ? v.toFixed(1) : v}`);
    else if (typeof v === 'boolean') p.push(`"${k}":${v}`);
    else p.push(`"${k}":"${jsonEscape(String(v))}"`);
  }
  return '{' + p.join(',') + '}';
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const seed = new Uint8Array(32).fill(7);
const kp = nacl.sign.keyPair.fromSeed(seed);
const wallet = {
  addr: 'octDLQFPawcje9rSTXxbaf8mihhMBb5QfXUpwthxmrH1Yia',
  sk: kp.secretKey,
  pubB64: btoa(String.fromCharCode(...kp.publicKey)),
} as never;

const PROGRAM = 'oct3o39Ubi2bxXVMk1u8MxkshNaiJ3BG35xpHKrK3hF35nV';

describe('call-format interop with Octora E2E signer', () => {
  it('produces canonical JSON byte-identical to the proven E2E signer', () => {
    const { tx } = signContractCall(wallet, {
      program: PROGRAM,
      method: 'buy',
      args: ['1', '1000'],
      nonce: 42,
      opType: 'call',
    });
    const orionBytes = canonicalJsonForTx({
      from: tx.from,
      to: tx.to,
      amount: tx.amount,
      nonce: tx.nonce,
      ou: tx.ou,
      timestamp: tx.timestamp,
      op_type: tx.op_type,
      encrypted_data: tx.encrypted_data,
      message: tx.message,
    } as never);
    const orion = new TextDecoder().decode(orionBytes);
    const e2e = canonicalE2E(
      {
        from: tx.from,
        to_: tx.to,
        amount: tx.amount,
        nonce: tx.nonce,
        ou: tx.ou,
        timestamp: tx.timestamp,
        op_type: tx.op_type,
        encrypted_data: tx.encrypted_data,
        message: tx.message,
      },
      ['encrypted_data', 'message'],
    );
    expect(orion).toBe(e2e);
  });

  it('signature verifies against the canonical bytes the chain will check', () => {
    const { tx } = signContractCall(wallet, {
      program: PROGRAM,
      method: 'claim',
      nonce: 9,
      opType: 'call',
    });
    const e2e = canonicalE2E(
      {
        from: tx.from,
        to_: tx.to,
        amount: tx.amount,
        nonce: tx.nonce,
        ou: tx.ou,
        timestamp: tx.timestamp,
        op_type: tx.op_type,
        encrypted_data: tx.encrypted_data,
        message: tx.message,
      },
      ['encrypted_data', 'message'],
    );
    const ok = nacl.sign.detached.verify(
      new Uint8Array(new TextEncoder().encode(e2e)),
      base64ToBytes(tx.signature as string),
      new Uint8Array(kp.publicKey),
    );
    expect(ok).toBe(true);
  });
});

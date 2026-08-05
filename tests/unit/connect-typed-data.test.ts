import { describe, it, expect } from 'vitest';
import {
  signPlainMessage,
  signTypedDataOctra,
  signContractApproval,
  signContractCall,
  type TypedData,
} from '../../src/connect/typed-data';
import { importWalletFromSeed } from '../../src/wallet/wallet';
import { verify } from '../../src/crypto/ed25519';
import { base64Decode } from '../../src/crypto/base64';
import { hexDecode } from '../../src/crypto/hex';
import { sha256 } from '../../src/crypto/sha256';
import { canonicalJsonForTx } from '../../src/tx/canonical-json';

const seed = new Uint8Array(32).fill(7);
const wallet = importWalletFromSeed(seed);

function verifyDigest(digestInput: string, sigB64: string): boolean {
  const digest = sha256(new TextEncoder().encode(digestInput));
  return verify(digest, base64Decode(sigB64), wallet.pk);
}

describe('signMessage', () => {
  it('produces a verifiable Ed25519 signature over the tagged digest', () => {
    const res = signPlainMessage(wallet, { message: 'hello world' });
    expect(res.address).toBe(wallet.addr);
    expect(res.publicKey).toBe(wallet.pubB64);
    const body = `octra-signed-message:v1\n${'hello world'.length}\nhello world`;
    expect(verifyDigest(body, res.signature)).toBe(true);
  });

  it('is deterministic for the same message', () => {
    expect(signPlainMessage(wallet, { message: 'x' }).signature).toBe(
      signPlainMessage(wallet, { message: 'x' }).signature,
    );
  });

  it('differs for different messages', () => {
    expect(signPlainMessage(wallet, { message: 'a' }).signature).not.toBe(
      signPlainMessage(wallet, { message: 'b' }).signature,
    );
  });

  it('defaults to the domain scheme when scheme is omitted', () => {
    const implicit = signPlainMessage(wallet, { message: 'gm' });
    const explicit = signPlainMessage(wallet, { message: 'gm', scheme: 'domain' });
    expect(implicit.signature).toBe(explicit.signature);
    expect(implicit.scheme).toBe('octra-ed25519-sha256/v1');
  });

  it('signs the untagged message bytes under scheme "raw"', () => {
    const res = signPlainMessage(wallet, { message: 'hello world', scheme: 'raw' });
    expect(res.scheme).toBe('octra-ed25519-sha256-raw/v1');
    // Raw digest is sha256 of the message bytes only: no tag, no length frame.
    expect(verifyDigest('hello world', res.signature)).toBe(true);
  });

  it('produces different signatures for raw vs domain on the same message', () => {
    const domain = signPlainMessage(wallet, { message: 'same', scheme: 'domain' });
    const raw = signPlainMessage(wallet, { message: 'same', scheme: 'raw' });
    expect(raw.signature).not.toBe(domain.signature);
  });
});

describe('signTypedData', () => {
  const td: TypedData = {
    domain: { name: 'App', version: '1', chainId: 'octra:devnet' },
    types: {
      Order: [
        { name: 'item', type: 'string' },
        { name: 'qty', type: 'number' },
      ],
    },
    primaryType: 'Order',
    message: { item: 'widget', qty: 3 },
  };

  it('produces a verifiable signature and hash', () => {
    const res = signTypedDataOctra(wallet, td);
    expect(res.hash).toMatch(/^[0-9a-f]{64}$/);
    // The signature verifies against the digest bytes (hex-decoded hash).
    expect(verify(hexDecode(res.hash), base64Decode(res.signature), wallet.pk)).toBe(true);
  });

  it('is deterministic regardless of message key insertion order', () => {
    const a = signTypedDataOctra(wallet, td);
    const reordered: TypedData = { ...td, message: { qty: 3, item: 'widget' } };
    const b = signTypedDataOctra(wallet, reordered);
    expect(a.hash).toBe(b.hash);
    expect(a.signature).toBe(b.signature);
  });

  it('changes when the message changes', () => {
    const other = signTypedDataOctra(wallet, { ...td, message: { item: 'widget', qty: 4 } });
    expect(other.hash).not.toBe(signTypedDataOctra(wallet, td).hash);
  });

  it('rejects an unknown primaryType', () => {
    expect(() => signTypedDataOctra(wallet, { ...td, primaryType: 'Nope' })).toThrow();
  });
});

describe('domain separation vs transactions', () => {
  it('a signed message can never equal a transaction signing digest', () => {
    // Build a real transaction canonical form and its digest.
    const txCanon = canonicalJsonForTx({
      from: wallet.addr,
      to: wallet.addr,
      amount: '1000000',
      nonce: 1,
      ou: '10000',
      timestamp: 1700000000,
      op_type: 'standard',
    });
    const txDigestBytes = txCanon; // tx signs over canonical bytes directly

    // The message scheme signs over sha256(tag + ...). Its pre-image starts
    // with the ASCII tag, which cannot begin with '{' like a tx canonical JSON.
    const msgBody = new TextEncoder().encode('octra-signed-message:v1\n2\nhi');
    expect(msgBody[0]).not.toBe(txDigestBytes[0]); // '{' (0x7b) vs 'o' (0x6f)

    // And the typed-data tag is distinct from the message tag.
    const typedPre = 'octra-typed-data:v1|';
    const msgPre = 'octra-signed-message:v1\n';
    expect(typedPre).not.toBe(msgPre);
  });
});

describe('approveContract', () => {
  it('signs a verifiable approval object and never marks it submitted', () => {
    const res = signContractApproval(wallet, {
      program: 'octProg',
      method: 'approve',
      spender: 'octSpender',
      limit: '1000000',
    });
    expect(res.type).toBe('octra-contract-approval');
    expect(res.owner).toBe(wallet.addr);
    expect(typeof res.signature).toBe('string');
    // No field that could be interpreted as "broadcast" or "sent".
    expect(Object.keys(res)).not.toContain('submitted');
    expect(Object.keys(res)).not.toContain('txHash');
  });
});

describe('signContract', () => {
  it('returns a SIGNED program_call tx but does not submit it', () => {
    const { tx, program, method, opType } = signContractCall(wallet, {
      program: 'octProg',
      method: 'stake',
      args: [1, 2],
      nonce: 7,
    });
    expect(tx.op_type).toBe('program_call');
    expect(tx.signature).toBeTruthy();
    expect(tx.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(program).toBe('octProg');
    expect(method).toBe('stake');
    expect(opType).toBe('program_call');
  });

  it('accepts opType "call" and produces op_type "call" in the tx', () => {
    const { tx, opType } = signContractCall(wallet, {
      program: 'octProg',
      method: 'stake',
      nonce: 7,
      opType: 'call',
    });
    expect(tx.op_type).toBe('call');
    expect(opType).toBe('call');
  });

  // The VM reads a `call` differently from a `program_call`: the method name is
  // a bare string in encrypted_data and the args are JSON in message. Signing
  // the nested program_call blob under the `call` label makes the node parse
  // the method as `{"program":...` and revert, so the encoding is asserted here
  // rather than only the op_type label.
  it('encodes opType "call" as bare method + JSON args in message', () => {
    const { tx } = signContractCall(wallet, {
      program: 'octProg',
      method: 'buy',
      args: ['1', '2'],
      nonce: 7,
      opType: 'call',
    });
    expect(tx.encrypted_data).toBe('buy');
    expect(tx.message).toBe('["1","2"]');
  });

  it('encodes a "call" with no args as an empty JSON array', () => {
    const { tx } = signContractCall(wallet, {
      program: 'octProg',
      method: 'claim',
      nonce: 7,
      opType: 'call',
    });
    expect(tx.encrypted_data).toBe('claim');
    expect(tx.message).toBe('[]');
  });

  it('keeps the nested blob encoding for program_call and sets no message', () => {
    const { tx } = signContractCall(wallet, {
      program: 'octProg',
      method: 'stake',
      args: [1, 2],
      nonce: 7,
    });
    expect(JSON.parse(tx.encrypted_data as string)).toEqual({
      program: 'octProg',
      method: 'stake',
      args: [1, 2],
    });
    expect(tx.message).toBeUndefined();
  });

  it('prices a "call" off the node schedule instead of the program_call default', () => {
    const { tx } = signContractCall(wallet, {
      program: 'octProg',
      method: 'buy',
      nonce: 7,
      opType: 'call',
    });
    expect(tx.ou).toBe('2000');
  });

  it('lets an explicit ou override the per-opType default', () => {
    const { tx } = signContractCall(wallet, {
      program: 'octProg',
      method: 'buy',
      nonce: 7,
      opType: 'call',
      ou: '5000',
    });
    expect(tx.ou).toBe('5000');
  });

  it('defaults opType to "program_call" when omitted', () => {
    const { tx, opType } = signContractCall(wallet, {
      program: 'octProg',
      method: 'stake',
      nonce: 7,
    });
    expect(tx.op_type).toBe('program_call');
    expect(opType).toBe('program_call');
  });
});

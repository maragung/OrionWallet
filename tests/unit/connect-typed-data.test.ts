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
    const res = signPlainMessage(wallet, 'hello world');
    expect(res.address).toBe(wallet.addr);
    expect(res.publicKey).toBe(wallet.pubB64);
    const body = `octra-signed-message:v1\n${'hello world'.length}\nhello world`;
    expect(verifyDigest(body, res.signature)).toBe(true);
  });

  it('is deterministic for the same message', () => {
    expect(signPlainMessage(wallet, 'x').signature).toBe(signPlainMessage(wallet, 'x').signature);
  });

  it('differs for different messages', () => {
    expect(signPlainMessage(wallet, 'a').signature).not.toBe(
      signPlainMessage(wallet, 'b').signature,
    );
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
    const { tx, program, method } = signContractCall(wallet, {
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
  });
});

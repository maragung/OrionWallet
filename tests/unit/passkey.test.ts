/**
 * Passkey unlock — sealing the wallet under a WebAuthn PRF value.
 *
 * The authenticator is mocked, so what is under test is our half of the deal:
 * the PRF output is what the ciphertext depends on, the stored record carries no
 * usable key, a different device cannot open it, and every refusal path leaves
 * the wallet reachable by PIN instead of half-broken.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  enablePasskeyUnlock,
  disablePasskeyUnlock,
  getPasskeyInfo,
  isPasskeySupported,
  unlockWithPasskey,
} from '../../src/wallet/passkey';
import { getPasskeyUnlock, deletePasskeyUnlock } from '../../src/wallet/storage';
import type { Wallet } from '../../src/wallet/wallet';
import { base64Encode } from '../../src/crypto/base64';
import { sha256 } from '../../src/crypto/sha256';

function makeWallet(): Wallet {
  const sk = new Uint8Array(64).map((_, i) => (i * 11 + 5) & 0xff);
  const pk = sk.subarray(32);
  return {
    addr: 'octCXyDYUpqcvSVi2ArNyrrjLJ2kwpfMgQyX9a1Dnxvf6SS',
    sk,
    pk,
    pubB64: base64Encode(pk),
    privB64: base64Encode(sk.subarray(0, 32)),
    mnemonic: 'abandon abandon abandon abandon abandon abandon abandon art',
    hdMaster: new Uint8Array(64).fill(3),
    name: 'Passkey Account',
    index: 0,
    hdVersion: 2,
    createdAt: 1_700_000_000_000,
  };
}

/**
 * A fake platform authenticator.
 *
 * PRF is modelled the way the spec describes it: a deterministic function of a
 * per-credential secret and the caller's salt. That is the only property our
 * code relies on, so a hash of the two is a faithful stand-in.
 */
class FakeAuthenticator {
  readonly credentialId = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  /** Set false to model an authenticator without PRF support. */
  prfSupported = true;
  /** Set false to model PRF being evaluated only at assertion time. */
  prfAtCreate = true;
  /** Throw this on the next call, to model a dismissed prompt. */
  failWith: DOMException | null = null;
  createCalls = 0;
  getCalls = 0;
  private secret = new Uint8Array(32).fill(0xa7);

  /** Swap the credential secret: same id, different device. */
  rotateSecret(fill: number) {
    this.secret = new Uint8Array(32).fill(fill);
  }

  private prf(salt: Uint8Array): ArrayBuffer {
    const input = new Uint8Array(this.secret.length + salt.length);
    input.set(this.secret, 0);
    input.set(salt, this.secret.length);
    const out = sha256(input);
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
  }

  private saltOf(options: unknown): Uint8Array {
    const ext = (
      options as { publicKey?: { extensions?: { prf?: { eval?: { first?: unknown } } } } }
    ).publicKey?.extensions?.prf?.eval?.first;
    if (!ext) throw new Error('fake authenticator: no PRF salt was requested');
    if (ext instanceof ArrayBuffer) return new Uint8Array(ext);
    const view = ext as ArrayBufferView;
    return new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength);
  }

  private results(salt: Uint8Array, evaluate: boolean) {
    if (!this.prfSupported) return { prf: { enabled: false } };
    return evaluate
      ? { prf: { enabled: true, results: { first: this.prf(salt) } } }
      : { prf: { enabled: true } };
  }

  install() {
    const credentials = {
      create: vi.fn(async (options: unknown) => {
        this.createCalls++;
        if (this.failWith) throw this.failWith;
        const salt = this.saltOf(options);
        const ext = this.results(salt, this.prfSupported && this.prfAtCreate);
        return {
          rawId: this.credentialId.buffer.slice(0, this.credentialId.length),
          getClientExtensionResults: () => ext,
        };
      }),
      get: vi.fn(async (options: unknown) => {
        this.getCalls++;
        if (this.failWith) throw this.failWith;
        const salt = this.saltOf(options);
        return {
          rawId: this.credentialId.buffer.slice(0, this.credentialId.length),
          getClientExtensionResults: () => this.results(salt, this.prfSupported),
        };
      }),
    };
    Object.defineProperty(navigator, 'credentials', { value: credentials, configurable: true });
    Object.defineProperty(window, 'PublicKeyCredential', {
      value: function PublicKeyCredential() {},
      configurable: true,
    });
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  }
}

let auth: FakeAuthenticator;

beforeEach(async () => {
  await deletePasskeyUnlock().catch(() => undefined);
  auth = new FakeAuthenticator();
  auth.install();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isPasskeySupported', () => {
  it('is false without a secure context', () => {
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
    expect(isPasskeySupported()).toBe(false);
  });

  it('is true with a secure context and a WebAuthn-capable browser', () => {
    expect(isPasskeySupported()).toBe(true);
  });
});

describe('enablePasskeyUnlock', () => {
  it('stores a record that holds no key material', async () => {
    const wallet = makeWallet();
    const info = await enablePasskeyUnlock(wallet);
    expect(info.addr).toBe(wallet.addr);

    const rec = await getPasskeyUnlock();
    expect(rec).not.toBeNull();
    expect(rec!.credentialId).toBe(base64Encode(auth.credentialId));
    expect(rec!.ct.length).toBeGreaterThan(0);
    expect(rec!.iv.length).toBe(12);

    // Nothing in the record may contain the private key or the phrase.
    const dump = JSON.stringify(rec) + base64Encode(rec!.ct) + base64Encode(rec!.iv);
    expect(dump).not.toContain(wallet.privB64);
    expect(dump).not.toContain(wallet.mnemonic);
  });

  it('needs no second gesture when PRF is evaluated at registration', async () => {
    await enablePasskeyUnlock(makeWallet());
    expect(auth.createCalls).toBe(1);
    expect(auth.getCalls).toBe(0);
  });

  it('falls back to an assertion when registration does not evaluate PRF', async () => {
    auth.prfAtCreate = false;
    await enablePasskeyUnlock(makeWallet());
    expect(auth.createCalls).toBe(1);
    expect(auth.getCalls).toBe(1);
    expect(await getPasskeyUnlock()).not.toBeNull();
  });

  it('refuses an authenticator without PRF, and stores nothing', async () => {
    auth.prfSupported = false;
    await expect(enablePasskeyUnlock(makeWallet())).rejects.toThrow(/PRF/i);
    expect(await getPasskeyUnlock()).toBeNull();
  });

  it('reports a dismissed prompt without storing anything', async () => {
    auth.failWith = new DOMException('user cancelled', 'NotAllowedError');
    await expect(enablePasskeyUnlock(makeWallet())).rejects.toThrow(/dismissed or timed out/i);
    expect(await getPasskeyUnlock()).toBeNull();
  });

  it('refuses a watch-only account', async () => {
    const w = { ...makeWallet(), sk: new Uint8Array(0), watchOnly: true };
    await expect(enablePasskeyUnlock(w)).rejects.toThrow(/watch-only/i);
    expect(auth.createCalls).toBe(0);
  });

  it('uses a fresh salt for each registration', async () => {
    await enablePasskeyUnlock(makeWallet());
    const first = await getPasskeyUnlock();
    await enablePasskeyUnlock(makeWallet());
    const second = await getPasskeyUnlock();
    expect(second!.prfSalt).not.toBe(first!.prfSalt);
  });
});

describe('unlockWithPasskey', () => {
  it('round-trips the wallet through the authenticator', async () => {
    const wallet = makeWallet();
    await enablePasskeyUnlock(wallet);

    const restored = await unlockWithPasskey();
    expect(restored.addr).toBe(wallet.addr);
    expect(restored.name).toBe(wallet.name);
    expect(restored.index).toBe(wallet.index);
    expect(restored.mnemonic).toBe(wallet.mnemonic);
    expect(Array.from(restored.sk)).toEqual(Array.from(wallet.sk));
    expect(Array.from(restored.hdMaster!)).toEqual(Array.from(wallet.hdMaster!));
  });

  it('round-trips a watch-only flag rather than resurrecting a broken signer', async () => {
    // Enabling is refused for watch-only accounts, so seal a signing wallet and
    // check the flag survives the serialize/seal/open path either way.
    const wallet = makeWallet();
    await enablePasskeyUnlock(wallet);
    expect((await unlockWithPasskey()).watchOnly).toBe(false);
  });

  it('fails when the passkey is not set up', async () => {
    await expect(unlockWithPasskey()).rejects.toThrow(/not set up/i);
  });

  it('cannot be opened by a different credential secret', async () => {
    await enablePasskeyUnlock(makeWallet());
    auth.rotateSecret(0x5c); // same credential id, different device secret

    await expect(unlockWithPasskey()).rejects.toThrow(/no longer opens/i);
    // A record that will not open is dropped, so the unlock screen stops
    // offering a button that can only fail.
    expect(await getPasskeyUnlock()).toBeNull();
  });

  it('keeps the record when the user just dismisses the prompt', async () => {
    await enablePasskeyUnlock(makeWallet());
    auth.failWith = new DOMException('nope', 'NotAllowedError');

    await expect(unlockWithPasskey()).rejects.toThrow(/dismissed or timed out/i);
    expect(await getPasskeyUnlock()).not.toBeNull();
  });

  it('refuses when the authenticator returns no PRF value', async () => {
    await enablePasskeyUnlock(makeWallet());
    auth.prfSupported = false;

    await expect(unlockWithPasskey()).rejects.toThrow(/PRF/i);
    // The credential may simply be unavailable right now, so the record stays.
    expect(await getPasskeyUnlock()).not.toBeNull();
  });
});

describe('getPasskeyInfo / disablePasskeyUnlock', () => {
  it('describes the registered account without opening it', async () => {
    const wallet = makeWallet();
    await enablePasskeyUnlock(wallet);

    const info = await getPasskeyInfo();
    expect(info).toEqual({
      addr: wallet.addr,
      name: wallet.name,
      createdAt: expect.any(Number),
    });
    expect(auth.getCalls).toBe(0); // no gesture needed to describe it
  });

  it('is null once switched off', async () => {
    await enablePasskeyUnlock(makeWallet());
    await disablePasskeyUnlock();
    expect(await getPasskeyInfo()).toBeNull();
    expect(await getPasskeyUnlock()).toBeNull();
  });
});

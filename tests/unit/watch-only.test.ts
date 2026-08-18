/**
 * Watch-only accounts — the guard that keeps a key-less account from ever
 * reaching a signing path, and the round-trip that keeps it key-less after a
 * refresh.
 */
import { describe, it, expect } from 'vitest';
import {
  WATCH_ONLY_INDEX,
  WatchOnlyError,
  assertCanSign,
  isWatchOnly,
  makeWatchOnlyWallet,
} from '../../src/wallet/watch-only';
import { serializeWallet, deserializeWallet, type Wallet } from '../../src/wallet/wallet';
import type { ManifestEntry } from '../../src/wallet/storage';
import { base64Encode } from '../../src/crypto/base64';

const ADDR = 'octCXyDYUpqcvSVi2ArNyrrjLJ2kwpfMgQyX9a1Dnxvf6SS';

function signingWallet(): Wallet {
  const sk = new Uint8Array(64).map((_, i) => (i * 13 + 1) & 0xff);
  const pk = sk.subarray(32);
  return {
    addr: ADDR,
    sk,
    pk,
    pubB64: base64Encode(pk),
    privB64: base64Encode(sk.subarray(0, 32)),
    mnemonic: 'abandon abandon abandon abandon abandon abandon abandon art',
    hdMaster: new Uint8Array(64).fill(4),
    name: 'Account 0',
    index: 0,
    hdVersion: 2,
    createdAt: 1_700_000_000_000,
  };
}

function entry(over: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    addr: ADDR,
    name: 'Cold storage',
    index: WATCH_ONLY_INDEX,
    pubB64: '',
    createdAt: 1_700_000_000_000,
    watchOnly: true,
    ...over,
  };
}

describe('isWatchOnly', () => {
  it('is false for a normal wallet and for nothing at all', () => {
    expect(isWatchOnly(signingWallet())).toBe(false);
    expect(isWatchOnly(null)).toBe(false);
    expect(isWatchOnly(undefined)).toBe(false);
  });

  it('is true once the flag is set', () => {
    expect(isWatchOnly(makeWatchOnlyWallet(entry()))).toBe(true);
  });
});

describe('assertCanSign', () => {
  it('lets a wallet with a 64-byte secret key through', () => {
    expect(() => assertCanSign(signingWallet(), 'send transactions')).not.toThrow();
  });

  it('refuses a watch-only wallet, naming the action', () => {
    try {
      assertCanSign(makeWatchOnlyWallet(entry()), 'send transactions');
      throw new Error('expected assertCanSign to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(WatchOnlyError);
      expect((e as Error).message).toContain('cannot send transactions');
      // The message has to say what to do next, not just what failed.
      expect((e as Error).message).toMatch(/recovery phrase/i);
    }
  });

  it('refuses a wallet whose keys are missing even without the flag', () => {
    // Defence in depth: a truncated key can never be handed to the signer just
    // because the flag was lost somewhere along the way.
    const broken = { ...signingWallet(), sk: new Uint8Array(32) };
    expect(() => assertCanSign(broken)).toThrow(WatchOnlyError);
  });

  it('refuses when there is no wallet at all', () => {
    expect(() => assertCanSign(null)).toThrow(/No wallet is open/);
  });
});

describe('makeWatchOnlyWallet', () => {
  it('produces a wallet with no key material', () => {
    const w = makeWatchOnlyWallet(entry());
    expect(w.addr).toBe(ADDR);
    expect(w.sk.length).toBe(0);
    expect(w.privB64).toBe('');
    expect(w.mnemonic).toBe('');
    expect(w.hdMaster!.length).toBe(0);
    expect(w.watchOnly).toBe(true);
    expect(w.index).toBe(WATCH_ONLY_INDEX);
    expect(w.name).toBe('Cold storage');
  });

  it('carries the public key when the manifest has one', () => {
    const pk = new Uint8Array(32).fill(7);
    const w = makeWatchOnlyWallet(entry({ pubB64: base64Encode(pk) }));
    expect(Array.from(w.pk)).toEqual(Array.from(pk));
  });

  it('tolerates an unreadable public key rather than failing to open', () => {
    const w = makeWatchOnlyWallet(entry({ pubB64: '!!!not base64!!!' }));
    expect(w.pk.length).toBe(0);
    expect(w.watchOnly).toBe(true);
  });

  it('rejects an address that is not an Octra address', () => {
    expect(() => makeWatchOnlyWallet(entry({ addr: 'oct-not-real' }))).toThrow(/Invalid address/);
  });

  it('falls back to a label when the entry has none', () => {
    expect(makeWatchOnlyWallet(entry({ name: '' })).name).toBe('Watch-only');
  });
});

describe('serialize round-trip', () => {
  it('keeps a watch-only account watch-only across a refresh', () => {
    const restored = deserializeWallet(serializeWallet(makeWatchOnlyWallet(entry())));
    expect(restored.watchOnly).toBe(true);
    expect(restored.sk.length).toBe(0);
    // The whole point: the restored account still fails closed.
    expect(() => assertCanSign(restored, 'send transactions')).toThrow(WatchOnlyError);
  });

  it('does not mark a normal wallet as watch-only', () => {
    const restored = deserializeWallet(serializeWallet(signingWallet()));
    expect(restored.watchOnly).toBe(false);
    expect(() => assertCanSign(restored)).not.toThrow();
  });
});

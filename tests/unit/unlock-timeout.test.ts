import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Regression guard for the unlock budget.
 *
 * The storage read can wedge forever (an IndexedDB upgrade blocked by another
 * tab), so it is bounded. Decryption must NOT be bounded: PBKDF2 runs 600k
 * iterations, and without crypto.subtle it falls back to pure JS, which takes
 * seconds on desktop and much longer on mobile. An earlier blanket timeout
 * around the whole unlock aborted legitimate decryptions.
 */

const hoisted = vi.hoisted(() => ({
  loadWalletEntry: vi.fn(),
  loadWalletEncrypted: vi.fn(),
}));

vi.mock('../../src/wallet/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/wallet/storage')>();
  return { ...actual, loadWalletEntry: hoisted.loadWalletEntry };
});

vi.mock('../../src/wallet/wallet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/wallet/wallet')>();
  return { ...actual, loadWalletEncrypted: hoisted.loadWalletEncrypted };
});

const { unlockWallet } = await import('../../src/api/wallet-api');

const fakeEntry = {
  id: 'default',
  blob: new Uint8Array([1, 2, 3]),
  addrHint: 'oct1abcd...',
  name: 'test',
  createdAt: Date.now(),
};

describe('unlockWallet timeout budget', () => {
  beforeEach(() => {
    hoisted.loadWalletEntry.mockReset();
    hoisted.loadWalletEncrypted.mockReset();
  });

  it('rejects when the storage read hangs (blocked IndexedDB upgrade)', async () => {
    hoisted.loadWalletEntry.mockReturnValue(new Promise(() => {}));

    await expect(unlockWallet('123456', 'default', 100)).rejects.toThrow(
      /Reading the stored wallet timed out/i,
    );
  });

  it('does NOT abort a slow decryption that outlasts the read budget', async () => {
    hoisted.loadWalletEntry.mockResolvedValue(fakeEntry);
    hoisted.loadWalletEncrypted.mockImplementation(
      () =>
        new Promise((resolve) =>
          // Far longer than the read budget below — mimics pure-JS PBKDF2.
          setTimeout(() => resolve({ addr: 'oct1test', privB64: 'k' }), 300),
        ),
    );

    const wallet = await unlockWallet('123456', 'default', 50);
    expect(wallet).toMatchObject({ addr: 'oct1test' });
  });

  it('throws a clear error when no wallet is stored under the id', async () => {
    hoisted.loadWalletEntry.mockResolvedValue(null);

    await expect(unlockWallet('123456', 'default', 500)).rejects.toThrow(
      /No stored wallet with id 'default'/,
    );
  });

  it('propagates a wrong-PIN decryption failure untouched', async () => {
    hoisted.loadWalletEntry.mockResolvedValue(fakeEntry);
    hoisted.loadWalletEncrypted.mockRejectedValue(
      new Error('walletDecrypt: decryption failed (wrong PIN or corrupted data)'),
    );

    await expect(unlockWallet('000000', 'default', 500)).rejects.toThrow(/decryption failed/);
  });
});

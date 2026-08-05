import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  createNewWallet,
  unlockWallet,
  importMnemonic,
  listStoredWallets,
  listAccounts,
  unlockAccount,
  deriveNewHdAccount,
  removeAccount,
  getActiveAddress,
} from '../../src/api/wallet-api';
import { wipeEverything, closeDb } from '../../src/wallet/storage';
import { validateMnemonic } from '../../src/crypto/bip39';
import { isValidAddress } from '../../src/crypto/address';

describe('wallet API (integration with IndexedDB)', () => {
  beforeAll(async () => {
    // Make sure fake-indexeddb is installed (setup.ts also does this, but
    // re-check here for robustness across test ordering)
    if (typeof indexedDB === 'undefined') {
      await import('fake-indexeddb/auto');
    }
  });

  beforeEach(async () => {
    // Ensure IDB is ready before each wipe
    if (typeof indexedDB === 'undefined') {
      await import('fake-indexeddb/auto');
    }
    await wipeEverything();
  });

  it('creates a new wallet and persists it', async () => {
    const { wallet, mnemonic } = await createNewWallet('Test Account', 'Pass1word!abc');
    expect(isValidAddress(wallet.addr)).toBe(true);
    expect(wallet.name).toBe('Test Account');
    expect(wallet.mnemonic).toBe(mnemonic);
    expect(validateMnemonic(mnemonic)).toBe(true);

    // Wallet should be in storage
    const list = await listStoredWallets();
    expect(list.length).toBe(1);
    expect(list[0]!.name).toBe('Test Account');

    // Should appear in manifest
    const accounts = await listAccounts();
    expect(accounts.length).toBe(1);
    expect(accounts[0]!.addr).toBe(wallet.addr);
  });

  it('unlocks the persisted wallet with correct PIN', async () => {
    const { wallet } = await createNewWallet('Unlock Test', 'Pass1word!abc');
    const unlocked = await unlockWallet('Pass1word!abc');
    expect(unlocked.addr).toBe(wallet.addr);
    expect(unlocked.name).toBe('Unlock Test');
  });

  it('throws on wrong PIN', async () => {
    await createNewWallet('Wrong PIN', 'Pass1word!abc');
    await expect(unlockWallet('wrong-pin')).rejects.toThrow('decryption failed');
  });

  it('imports a wallet from mnemonic', async () => {
    const mnemonic =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const wallet = await importMnemonic(mnemonic, 'Imported', 'Pass1word!abc');
    expect(wallet.mnemonic).toBe(mnemonic);
    expect(wallet.name).toBe('Imported');
    expect(isValidAddress(wallet.addr)).toBe(true);

    // Same mnemonic → same address (deterministic)
    const wallet2 = await importMnemonic(mnemonic, 'Imported 2', 'Pass1word!abc');
    expect(wallet2.addr).toBe(wallet.addr);
  });

  it('rejects invalid mnemonic on import', async () => {
    await expect(
      importMnemonic('not a valid mnemonic phrase', 'Bad', 'Pass1word!abc'),
    ).rejects.toThrow('invalid word count');
  });

  it('rejects weak PIN on create', async () => {
    await expect(createNewWallet('Weak', 'short')).rejects.toThrow('PIN');
  });

  it('can list accounts after creation', async () => {
    const { wallet } = await createNewWallet('Account 1', 'Pass1word!abc');
    const accounts1 = await listAccounts();
    expect(accounts1.length).toBe(1);
    expect(accounts1[0]!.addr).toBe(wallet.addr);
  });

  it('wipeEverything clears storage', async () => {
    await createNewWallet('Test', 'Pass1word!abc');
    await wipeEverything();
    const list = await listStoredWallets();
    expect(list.length).toBe(0);
    const accounts = await listAccounts();
    expect(accounts.length).toBe(0);
  });

  it('rejects weak PIN on import', async () => {
    await expect(
      importMnemonic(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        'X',
        'weak',
      ),
    ).rejects.toThrow('PIN');
  });

  describe('unlockAccount (switching the active account)', () => {
    const PIN = 'Pass1word!abc';

    it('unlocks the primary account and marks it active', async () => {
      const { wallet } = await createNewWallet('Account 1', PIN);
      const unlocked = await unlockAccount(wallet.addr, PIN);

      expect(unlocked.addr).toBe(wallet.addr);
      // Real signing keys must be present, not just manifest metadata.
      expect(unlocked.sk.length).toBe(64);
      expect(await getActiveAddress()).toBe(wallet.addr);
    });

    it('unlocks a derived HD account and switches the active address to it', async () => {
      const { wallet } = await createNewWallet('Account 1', PIN);
      const derived = await deriveNewHdAccount(wallet, 1, 'Account 2', PIN);
      expect(derived.addr).not.toBe(wallet.addr);

      const unlocked = await unlockAccount(derived.addr, PIN);
      expect(unlocked.addr).toBe(derived.addr);
      expect(unlocked.sk.length).toBe(64);
      expect(await getActiveAddress()).toBe(derived.addr);

      // And we can switch back to the first account.
      const back = await unlockAccount(wallet.addr, PIN);
      expect(back.addr).toBe(wallet.addr);
      expect(await getActiveAddress()).toBe(wallet.addr);
    });

    it('derives deterministically, so the unlocked account matches the manifest', async () => {
      const { wallet } = await createNewWallet('Account 1', PIN);
      const derived = await deriveNewHdAccount(wallet, 3, 'Account 4', PIN);

      const unlocked = await unlockAccount(derived.addr, PIN);
      expect(unlocked.addr).toBe(derived.addr);
      expect(unlocked.index).toBe(3);
    });

    it('throws on a wrong PIN and leaves the active account untouched', async () => {
      const { wallet } = await createNewWallet('Account 1', PIN);
      const derived = await deriveNewHdAccount(wallet, 1, 'Account 2', PIN);
      // deriveNewHdAccount does not change the active account.
      const activeBefore = await getActiveAddress();

      await expect(unlockAccount(derived.addr, 'Wrong1word!xyz')).rejects.toThrow();
      expect(await getActiveAddress()).toBe(activeBefore);
    });

    it('rejects an address that is not in the manifest', async () => {
      const { wallet } = await createNewWallet('Account 1', PIN);
      // Valid-looking but unknown address: reuse a derived one that we never registered.
      const stranger = (await deriveNewHdAccount(wallet, 7, 'Temp', PIN)).addr;
      await removeAccount(stranger);

      await expect(unlockAccount(stranger, PIN)).rejects.toThrow('not in the manifest');
    });

    it('rejects a malformed address', async () => {
      await createNewWallet('Account 1', PIN);
      await expect(unlockAccount('not-an-address', PIN)).rejects.toThrow('Invalid address');
    });
  });
});

afterAll(async () => {
  await closeDb();
});

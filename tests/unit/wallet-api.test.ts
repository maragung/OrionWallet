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
  changePin,
  exportMnemonic,
  exportPrivateKey,
  walletIdForAddr,
} from '../../src/api/wallet-api';
import { wipeEverything, closeDb, loadWalletEntry } from '../../src/wallet/storage';
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

    // Wallet should be in storage: its own per-account entry plus the
    // `default` entry (first wallet on the device).
    const list = await listStoredWallets();
    expect(list.length).toBe(2);
    expect(list.map((e) => e.id).sort()).toEqual(['default', walletIdForAddr(wallet.addr)].sort());

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

  describe('multi-account from different seed phrases', () => {
    const PIN = 'Pass1word!abc';
    const NEW_PIN = 'Pass2word!xyz';
    const MNEMONIC_A =
      'legal winner thank year wave sausage worth useful legal winner thank yellow';
    const MNEMONIC_B =
      'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';

    async function seedTwoWallets() {
      const a = await importMnemonic(MNEMONIC_A, 'Seed A', PIN);
      const b = await importMnemonic(MNEMONIC_B, 'Seed B', PIN);
      expect(a.addr).not.toBe(b.addr); // two genuinely different seeds
      return { a, b };
    }

    it('switches between accounts of different seeds without error', async () => {
      const { a, b } = await seedTwoWallets();

      const unlockedB = await unlockAccount(b.addr, PIN);
      expect(unlockedB.addr).toBe(b.addr);
      expect(unlockedB.mnemonic).toBe(MNEMONIC_B);
      expect(await getActiveAddress()).toBe(b.addr);

      const backToA = await unlockAccount(a.addr, PIN);
      expect(backToA.addr).toBe(a.addr);
      expect(backToA.mnemonic).toBe(MNEMONIC_A);
      expect(await getActiveAddress()).toBe(a.addr);
    });

    it('importing a second seed does not overwrite the first wallet keystore', async () => {
      const { a, b } = await seedTwoWallets();

      // The default entry still belongs to the FIRST wallet…
      const def = await loadWalletEntry('default');
      expect(def).not.toBeNull();
      const viaDefault = await unlockWallet(PIN);
      expect(viaDefault.addr).toBe(a.addr);
      // …and the second wallet has its own per-account entry.
      const own = await loadWalletEntry(walletIdForAddr(b.addr));
      expect(own).not.toBeNull();
      expect(own!.addrHint).toBe(b.addr.slice(0, 8) + '...');
    });

    it('each account may have its own PIN — importing with a different PIN works', async () => {
      const a = await importMnemonic(MNEMONIC_A, 'Seed A', PIN);
      const b = await importMnemonic(MNEMONIC_B, 'Seed B', 'Other1Pass!qw');

      // Both accounts unlock with their own PIN, whatever the other uses.
      expect((await unlockAccount(a.addr, PIN)).addr).toBe(a.addr);
      expect((await unlockAccount(b.addr, 'Other1Pass!qw')).addr).toBe(b.addr);
      // A PIN from one account never opens the other.
      await expect(unlockAccount(b.addr, PIN)).rejects.toThrow();
      // …and switching back still works with the right PIN.
      expect((await unlockAccount(a.addr, PIN)).addr).toBe(a.addr);
    });

    it('changePin re-encrypts only the active account, leaving other PINs untouched', async () => {
      const { a, b } = await seedTwoWallets();
      const active = await unlockAccount(b.addr, PIN);

      await changePin(active, PIN, NEW_PIN);

      // The changed account opens with its new PIN…
      expect((await unlockAccount(b.addr, NEW_PIN)).addr).toBe(b.addr);
      await expect(unlockAccount(b.addr, PIN)).rejects.toThrow();
      // …while the other account keeps its own (unchanged) PIN.
      expect((await unlockAccount(a.addr, PIN)).addr).toBe(a.addr);
      await expect(unlockAccount(a.addr, NEW_PIN)).rejects.toThrow();
    });

    it('removing a second-seed account keeps the default keystore intact', async () => {
      const { a, b } = await seedTwoWallets();
      await removeAccount(b.addr);

      expect(await loadWalletEntry(walletIdForAddr(b.addr))).toBeNull();
      expect(await loadWalletEntry('default')).not.toBeNull();
      expect((await unlockWallet(PIN)).addr).toBe(a.addr);
      expect((await listAccounts()).map((x) => x.addr)).toEqual([a.addr]);
    });

    it('exports use the account’s own keystore, not the default one', async () => {
      const { b } = await seedTwoWallets();
      const unlockedB = await unlockAccount(b.addr, PIN);

      expect(await exportMnemonic(unlockedB, PIN)).toBe(MNEMONIC_B);
      expect(typeof (await exportPrivateKey(unlockedB, PIN))).toBe('string');
      // Wrong PIN is still rejected against the account's own blob.
      await expect(exportMnemonic(unlockedB, 'Wrong1word!xy')).rejects.toThrow();
    });
  });
});

afterAll(async () => {
  await closeDb();
});

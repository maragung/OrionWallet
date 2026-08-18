import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { useWalletStore } from '../../src/store/wallet-store';
import {
  loadSettings,
  saveSettings,
  wipeEverything,
  closeDb,
  type Settings,
} from '../../src/wallet/storage';
import { getNetworkDef } from '../../src/wallet/networks';

/**
 * Regression tests for the top-bar network switcher.
 *
 * The pill used to be dead in two ways: the component skipped the switch
 * whenever the store had no settings yet (one failed read at boot was enough),
 * and it wrote a whole settings snapshot back, reverting anything another writer
 * had changed meanwhile. Both live in the store's `switchNetwork` now.
 */

const devnet = getNetworkDef('devnet')!;
const mainnet = getNetworkDef('mainnet')!;

const baseSettings: Settings = {
  id: 'settings',
  rpcUrl: devnet.rpcUrl,
  network: 'devnet',
  theme: 'dark',
  explorerUrl: devnet.explorerUrl,
};

describe('wallet store — switchNetwork', () => {
  beforeAll(async () => {
    if (typeof indexedDB === 'undefined') {
      await import('fake-indexeddb/auto');
    }
  });

  beforeEach(async () => {
    await wipeEverything();
    useWalletStore.setState({ wallet: null, isUnlocked: false, settings: null, rpcWarning: null });
  });

  afterAll(async () => {
    await closeDb();
  });

  it('switches even when settings were never loaded into the store', async () => {
    await saveSettings(baseSettings);
    expect(useWalletStore.getState().settings).toBeNull();

    await useWalletStore.getState().switchNetwork(mainnet);

    const stored = await loadSettings();
    expect(stored.network).toBe('mainnet');
    expect(stored.rpcUrl).toBe(mainnet.rpcUrl);
    expect(useWalletStore.getState().settings?.network).toBe('mainnet');
  });

  it('points the RPC client at the new endpoint', async () => {
    await saveSettings(baseSettings);
    useWalletStore.setState({ settings: baseSettings });

    await useWalletStore.getState().switchNetwork(mainnet);

    // The client is rebuilt rather than reconfigured, so compare the URL it uses.
    const rpc = useWalletStore.getState().rpc;
    expect(rpc).not.toBeNull();
    expect(JSON.stringify(rpc)).toContain(mainnet.rpcUrl);
  });

  it('keeps fields another writer changed since the store read them', async () => {
    // The store holds a snapshot from before the language switcher wrote.
    useWalletStore.setState({ settings: { ...baseSettings, language: 'en' } });
    await saveSettings({ ...baseSettings, language: 'id', autoLockMinutes: 7 });

    await useWalletStore.getState().switchNetwork(mainnet);

    const stored = await loadSettings();
    expect(stored.network).toBe('mainnet');
    expect(stored.language).toBe('id');
    expect(stored.autoLockMinutes).toBe(7);
  });

  it('writes nothing when the requested network is already active', async () => {
    await saveSettings({ ...baseSettings, language: 'id' });
    useWalletStore.setState({ settings: { ...baseSettings, language: 'id' } });

    await useWalletStore.getState().switchNetwork(devnet);

    const stored = await loadSettings();
    expect(stored.network).toBe('devnet');
    expect(stored.language).toBe('id');
  });

  it('adopts the stored network when the store guessed the default', async () => {
    // Nothing loaded settings, so the pill was showing devnet while mainnet was
    // stored. Asking for mainnet must publish the truth, not stay on the guess.
    await saveSettings({ ...baseSettings, network: 'mainnet', rpcUrl: mainnet.rpcUrl });

    await useWalletStore.getState().switchNetwork(mainnet);

    expect(useWalletStore.getState().settings?.network).toBe('mainnet');
    expect((await loadSettings()).network).toBe('mainnet');
  });
});

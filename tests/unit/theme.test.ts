import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { wipeEverything, closeDb, loadSettings, saveSettings } from '../../src/wallet/storage';
import type { Settings } from '../../src/wallet/storage';

describe('theme persistence', () => {
  beforeAll(async () => {
    if (typeof indexedDB === 'undefined') {
      await import('fake-indexeddb/auto');
    }
  });

  beforeEach(async () => {
    await wipeEverything();
  });

  afterAll(async () => {
    await closeDb();
  });

  it('default settings have theme=dark', async () => {
    const s = await loadSettings();
    expect(s.theme).toBe('dark');
  });

  it('can save and load theme=light', async () => {
    const s: Settings = {
      id: 'settings',
      rpcUrl: 'https://example.com/rpc',
      network: 'mainnet',
      theme: 'light',
    };
    await saveSettings(s);
    const loaded = await loadSettings();
    expect(loaded.theme).toBe('light');
  });

  it('can save and load theme=system', async () => {
    const s: Settings = {
      id: 'settings',
      rpcUrl: 'https://example.com/rpc',
      network: 'mainnet',
      theme: 'system',
    };
    await saveSettings(s);
    const loaded = await loadSettings();
    expect(loaded.theme).toBe('system');
  });

  it('theme persists across save/load cycles', async () => {
    for (const theme of ['dark', 'light', 'system'] as const) {
      await saveSettings({
        id: 'settings',
        rpcUrl: 'https://example.com/rpc',
        network: 'mainnet',
        theme,
      });
      const loaded = await loadSettings();
      expect(loaded.theme).toBe(theme);
    }
  });
});

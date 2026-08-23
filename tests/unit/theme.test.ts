import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { wipeEverything, closeDb, loadSettings, saveSettings } from '../../src/wallet/storage';
import type { Settings } from '../../src/wallet/storage';
import { readThemeCookie, writeThemeCookie } from '../../src/utils/theme-cookie';

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

describe('theme cookie', () => {
  beforeEach(() => {
    // Reset the cookie this suite owns, whatever a previous test left there.
    document.cookie = 'orion_theme=; path=/; max-age=0';
  });

  it('reads null when no theme cookie exists', () => {
    expect(readThemeCookie()).toBeNull();
  });

  it('round-trips the effective theme (dark/light)', () => {
    writeThemeCookie('light');
    expect(readThemeCookie()).toBe('light');
    writeThemeCookie('dark');
    expect(readThemeCookie()).toBe('dark');
  });

  it('ignores malformed cookie values instead of trusting them', () => {
    document.cookie = 'orion_theme=purple; path=/';
    expect(readThemeCookie()).toBeNull();
  });
});

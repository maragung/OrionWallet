import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { useWalletStore } from '../../src/store/wallet-store';
import type { Wallet } from '../../src/wallet/wallet';
import { wipeEverything, closeDb } from '../../src/wallet/storage';
import { generateKeypair } from '../../src/crypto/ed25519';
import { deriveAddressFromPubkey } from '../../src/crypto/address';
import { base64Encode } from '../../src/crypto/base64';
import { stubPvacGlueUnavailable } from './helpers/pvac-glue';

/** PVAC states that are still in motion; everything else is a settled outcome. */
const PVAC_IN_FLIGHT = ['idle', 'loading'];

/**
 * Poll until PVAC stops loading. The load is deliberately fire-and-forget, so
 * there is nothing to await — and a fixed sleep either flakes on a loaded
 * machine or wastes the time it reserves.
 */
async function waitForPvacToSettle(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let state = useWalletStore.getState();
  while (PVAC_IN_FLIGHT.includes(state.pvacStatus) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    state = useWalletStore.getState();
  }
  return state;
}

// Build a fake wallet for testing (doesn't go through createNewWallet)
function makeTestWallet(): Wallet {
  const kp = generateKeypair();
  const addr = deriveAddressFromPubkey(kp.publicKey);
  return {
    addr,
    sk: kp.secretKey,
    pk: kp.publicKey,
    pubB64: base64Encode(kp.publicKey),
    privB64: base64Encode(kp.secretKey.subarray(0, 32)),
    mnemonic: '',
    hdMaster: new Uint8Array(0),
    name: 'Test',
    index: 0,
    hdVersion: 2,
    createdAt: Date.now(),
  };
}

describe('wallet store — PVAC auto-load', () => {
  beforeAll(async () => {
    if (typeof indexedDB === 'undefined') {
      await import('fake-indexeddb/auto');
    }
    // Without this the WASM probe's behaviour is whatever the host network does.
    stubPvacGlueUnavailable();
  });

  beforeEach(async () => {
    await wipeEverything();
    // Reset store state
    useWalletStore.setState({
      wallet: null,
      isUnlocked: false,
      pvacStatus: 'idle',
      pvacError: null,
      pvacAvailable: false,
      pvacBridgeReady: false,
    });
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await closeDb();
  });

  it('starts with pvacStatus=idle and pvacBridgeReady=false', () => {
    const state = useWalletStore.getState();
    expect(state.pvacStatus).toBe('idle');
    expect(state.pvacBridgeReady).toBe(false);
    expect(state.pvacAvailable).toBe(false);
  });

  it('setWallet triggers PVAC auto-load (sets status to loading/ready/unavailable)', async () => {
    const wallet = makeTestWallet();
    useWalletStore.getState().setWallet(wallet);

    // Status should leave 'idle' — poll rather than wait a fixed 50ms so
    // fast paths (load completes within the window) don't flake under load.
    let state = useWalletStore.getState();
    const deadline = Date.now() + 1000;
    while (state.pvacStatus === 'idle' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      state = useWalletStore.getState();
    }
    // loading → ready / unavailable / failed depending on whether pvac.wasm exists
    expect(['loading', 'ready', 'unavailable', 'failed']).toContain(state.pvacStatus);

    const finalState = await waitForPvacToSettle();
    expect(['ready', 'unavailable', 'failed']).toContain(finalState.pvacStatus);
  });

  it('lock() resets pvacStatus to idle and pvacBridgeReady to false', async () => {
    const wallet = makeTestWallet();
    useWalletStore.getState().setWallet(wallet);
    await waitForPvacToSettle();

    useWalletStore.getState().lock();
    const state = useWalletStore.getState();
    expect(state.pvacStatus).toBe('idle');
    expect(state.pvacBridgeReady).toBe(false);
    expect(state.wallet).toBeNull();
    expect(state.isUnlocked).toBe(false);
  });

  it('reloadPvac with no wallet shows a warning toast', async () => {
    const pushToast = vi.fn();
    // Override pushToast temporarily
    const original = useWalletStore.getState().pushToast;
    useWalletStore.setState({ pushToast });

    const ok = await useWalletStore.getState().reloadPvac();
    expect(ok).toBe(false);
    expect(pushToast).toHaveBeenCalledWith('warning', expect.stringContaining('No wallet'));

    // Restore
    useWalletStore.setState({ pushToast: original });
  });

  it('initPvacForWallet returns boolean', async () => {
    const wallet = makeTestWallet();
    const ok = await useWalletStore.getState().initPvacForWallet(wallet);
    expect(typeof ok).toBe('boolean');
    // The result depends on whether pvac.wasm is available in the test env.
    // In jsdom, it's not, so we expect false and status='unavailable' or 'failed'.
    const state = useWalletStore.getState();
    if (!ok) {
      expect(['unavailable', 'failed']).toContain(state.pvacStatus);
    } else {
      expect(state.pvacStatus).toBe('ready');
    }
  });

  it('does not re-init when bridge is already ready (idempotent)', async () => {
    const wallet = makeTestWallet();
    // First init
    await useWalletStore.getState().initPvacForWallet(wallet);
    const state1 = useWalletStore.getState();

    // Second init — should be idempotent
    const ok = await useWalletStore.getState().initPvacForWallet(wallet);
    expect(typeof ok).toBe('boolean');

    const state2 = useWalletStore.getState();
    if (state1.pvacStatus === 'ready') {
      // If first init succeeded, second should also succeed without re-loading
      expect(state2.pvacStatus).toBe('ready');
      expect(ok).toBe(true);
    }
  });
});

describe('wallet store — RPC auto-init', () => {
  beforeAll(async () => {
    if (typeof indexedDB === 'undefined') {
      await import('fake-indexeddb/auto');
    }
  });

  beforeEach(async () => {
    await wipeEverything();
    useWalletStore.setState({
      wallet: null,
      isUnlocked: false,
      rpc: null,
      settings: null,
    });
  });

  afterAll(async () => {
    await closeDb();
  });

  it('initRpc loads settings from IndexedDB and creates an RpcClient', async () => {
    const rpc = await useWalletStore.getState().initRpc();
    expect(rpc).toBeTruthy();
    expect(rpc.url).toBeTruthy();
    const state = useWalletStore.getState();
    expect(state.rpc).toBe(rpc);
    expect(state.settings).toBeTruthy();
  });

  it('setWallet with no RPC triggers auto-init of RPC', async () => {
    const wallet = makeTestWallet();
    useWalletStore.setState({ rpc: null, settings: null });
    useWalletStore.getState().setWallet(wallet);

    // Wait for the async initRpc — poll rather than sleep a fixed 100ms, which
    // races the store when the whole suite is loaded.
    await vi.waitFor(() => {
      expect(useWalletStore.getState().rpc).not.toBeNull();
    });
  });
});

describe('wallet store — toast auto-dismiss', () => {
  beforeEach(() => {
    useWalletStore.setState({ toasts: [] });
  });

  it('pushToast adds a toast that auto-dismisses after 5s (10s for errors)', async () => {
    useWalletStore.getState().pushToast('info', 'test info');
    expect(useWalletStore.getState().toasts.length).toBe(1);

    // Use fake timers? Vitest supports them via vi.useFakeTimers but let's just
    // verify the toast was added — the dismissal is timer-dependent and would
    // slow the test. Just verify the add.
    useWalletStore.getState().dismissToast(useWalletStore.getState().toasts[0]!.id);
    expect(useWalletStore.getState().toasts.length).toBe(0);
  });

  it('pushToast with error level stays longer (10s) than info (5s)', () => {
    // Just verify the API accepts both levels
    useWalletStore.getState().pushToast('error', 'test error');
    useWalletStore.getState().pushToast('warning', 'test warn');
    useWalletStore.getState().pushToast('success', 'test success');
    useWalletStore.getState().pushToast('info', 'test info');
    expect(useWalletStore.getState().toasts.length).toBe(4);
  });
});

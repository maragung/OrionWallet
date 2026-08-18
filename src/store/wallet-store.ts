/**
 * Global wallet store (Zustand).
 * Holds the unlocked wallet, RPC client, PVAC bridge, and toast notifications.
 *
 * AUTO-LOAD PVAC WASM:
 *   When a wallet is unlocked (via setWallet), the store automatically:
 *     1. Loads the PVAC WASM module (if available at the deployed base URL)
 *     2. Initializes the WasmPvacBridge with the wallet's privB64
 *     3. Replaces the global bridge via setPvacBridge
 *   The PVAC load status is exposed via `pvacStatus` so the UI can show
 *   an indicator (loading / ready / failed).
 */
import { create } from 'zustand';
import type { Wallet } from '../wallet/wallet';
import { RpcClient } from '../rpc/client';
import { loadSettings, saveSettings, type Settings } from '../wallet/storage';
import {
  hasUnlockSession,
  saveUnlockSession,
  resealUnlockSession,
  restoreUnlockSession,
  clearUnlockSession,
} from '../wallet/unlock-session';
import { getPvacBridge, isPvacWasmAvailable } from '../pvac';

export type ToastLevel = 'info' | 'success' | 'error' | 'warning';
export interface Toast {
  id: number;
  level: ToastLevel;
  message: string;
  timestamp: number;
}

export type PvacStatus = 'idle' | 'loading' | 'ready' | 'failed' | 'unavailable';

interface WalletStoreState {
  // Wallet state
  wallet: Wallet | null;
  isUnlocked: boolean;
  /**
   * True while a persisted unlock session is being reopened on boot. Seeded
   * synchronously so the very first paint after a reload shows a restoring
   * state instead of flashing the PIN screen.
   */
  isRestoringSession: boolean;

  // RPC
  rpc: RpcClient | null;
  settings: Settings | null;

  // PVAC (FHE) state
  pvacStatus: PvacStatus;
  pvacError: string | null;
  pvacAvailable: boolean; // whether WASM module is loaded
  pvacBridgeReady: boolean; // whether bridge was init'd with wallet privB64

  // UI
  toasts: Toast[];
  isLoading: boolean;
  loadingMessage: string;

  // Actions
  setWallet: (w: Wallet | null, opts?: { persistSession?: boolean }) => void;
  lock: () => void;
  /** Reopen this tab's unlock session, if it has a live one. */
  resumeSession: () => Promise<boolean>;
  initRpc: () => Promise<RpcClient>;
  setSettings: (s: Settings) => Promise<void>;
  pushToast: (level: ToastLevel, message: string) => void;
  dismissToast: (id: number) => void;
  setLoading: (loading: boolean, message?: string) => void;
  initPvacForWallet: (wallet: Wallet) => Promise<boolean>;
  reloadPvac: () => Promise<boolean>;
}

let toastId = 1;

/**
 * In-flight session restore, shared by every caller.
 *
 * Both app roots ask to resume on mount, and React StrictMode runs mount
 * effects twice in dev — without this they would race over the same envelope.
 */
let resumeInFlight: Promise<boolean> | null = null;

/**
 * Auto-load the PVAC WASM module + init the bridge with the wallet's privB64.
 * Idempotent: if already initialized for the same wallet, returns true immediately.
 * Updates pvacStatus in the store as it progresses.
 *
 * @param wallet The wallet to init PVAC for
 * @param setStatus Callback to update pvacStatus in the store
 */
async function autoLoadPvac(
  wallet: Wallet,
  setStatus: (
    status: PvacStatus,
    error?: string | null,
    available?: boolean,
    bridgeReady?: boolean,
  ) => void,
): Promise<boolean> {
  // If already loaded and initialized, skip
  if (isPvacWasmAvailable()) {
    const bridge = getPvacBridge();
    if (bridge.isInitialized()) {
      setStatus('ready', null, true, true);
      return true;
    }
  }

  setStatus('loading', null, false, false);

  try {
    // Step 1: Load the WASM module (replaces global bridge with WasmPvacBridge).
    // Use the throwing variant so the classified reason reaches the UI instead
    // of collapsing into a generic "not found".
    const { loadPvacWasmOrThrow, PvacLoadError } = await import('../pvac/wasm-bridge');
    try {
      await loadPvacWasmOrThrow();
    } catch (err) {
      const detail =
        err instanceof PvacLoadError
          ? `${err.message} — ${err.remedy}`
          : `PVAC failed to load: ${(err as Error).message}`;
      // PVAC is optional: the wallet stays usable, but the reason is recorded
      // so Settings can show what to do about it.
      setStatus('unavailable', detail, false, false);
      return false;
    }

    // Step 2: Initialize the bridge with the wallet's privB64 (FHE keygen from seed)
    const bridge = getPvacBridge();
    const ok = await bridge.init(wallet.privB64);
    if (!ok) {
      setStatus(
        'unavailable',
        'PVAC key generation from the wallet seed failed. Check the browser console for details.',
        true,
        false,
      );
      return false;
    }

    setStatus('ready', null, true, true);
    return true;
  } catch (err) {
    const detail =
      err instanceof Error ? `PVAC load interrupted: ${err.message}` : 'Unknown PVAC error';
    setStatus('unavailable', detail, false, false);
    return false;
  }
}

export const useWalletStore = create<WalletStoreState>((set, get) => ({
  wallet: null,
  isUnlocked: false,
  isRestoringSession: hasUnlockSession(),
  rpc: null,
  settings: null,

  pvacStatus: 'idle',
  pvacError: null,
  pvacAvailable: false,
  pvacBridgeReady: false,

  toasts: [],
  isLoading: false,
  loadingMessage: '',

  /**
   * Set (unlock) or clear (lock) the wallet.
   * When a wallet is set, automatically:
   *   - Initializes RPC if needed
   *   - Auto-loads PVAC WASM + inits bridge
   *   - Seals an unlock session so a page reload does not ask for the PIN again
   *     (`persistSession: false` for a wallet that came out of one already)
   */
  setWallet: (w, opts = {}) => {
    set({ wallet: w, isUnlocked: w !== null });
    if (w) {
      if (opts.persistSession !== false) {
        saveUnlockSession(w).catch((e) => console.error('Persisting unlock session failed:', e));
      }
      // The unlock screen (and its ProcessingModal) unmounts the instant
      // `isUnlocked` flips, so drive the GLOBAL LoadingOverlay here instead.
      // It renders on top of the already-mounted wallet layout, which keeps the
      // content visible behind a modal rather than flashing a blank page.
      const needsRpc = !get().rpc;
      if (needsRpc) {
        set({ isLoading: true, loadingMessage: 'Preparing wallet…' });
      }
      // Auto-init RPC if not yet done
      if (needsRpc) {
        get()
          .initRpc()
          .catch((e) => console.error('Auto-init RPC failed:', e))
          .finally(() => set({ isLoading: false, loadingMessage: '' }));
      }
      // Auto-load PVAC WASM (background, never blocks the UI)
      get()
        .initPvacForWallet(w)
        .catch((e) => console.error('Auto-load PVAC failed:', e));
    } else {
      // Wallet locked — reset PVAC status (bridge state remains in memory,
      // but we mark it as not ready since there's no wallet to operate on)
      set({ pvacStatus: 'idle', pvacAvailable: false, pvacBridgeReady: false });
    }
  },

  lock: () => {
    const w = get().wallet;
    if (w) {
      // Best-effort wipe
      for (let i = 0; i < w.sk.length; i++) w.sk[i] = 0;
      for (let i = 0; i < w.pk.length; i++) w.pk[i] = 0;
      if (w.hdMaster.length > 0) for (let i = 0; i < w.hdMaster.length; i++) w.hdMaster[i] = 0;
      w.privB64 = '';
      w.mnemonic = '';
      w.hdMaster = new Uint8Array(0);
    }
    // Locking is explicit: the persisted session must not survive it, or the
    // next reload would silently unlock again.
    clearUnlockSession().catch((e) => console.error('Clearing unlock session failed:', e));
    set({
      wallet: null,
      isUnlocked: false,
      isRestoringSession: false,
      pvacStatus: 'idle',
      pvacAvailable: false,
      pvacBridgeReady: false,
      isLoading: false,
      loadingMessage: '',
    });
  },

  /**
   * Reopen the unlock session this tab sealed before the reload.
   *
   * Resolves false when there is nothing to restore (no session, expired, or
   * unreadable), in which case the caller shows the PIN screen as before.
   */
  resumeSession: async () => {
    if (get().isUnlocked) {
      set({ isRestoringSession: false });
      return true;
    }
    if (resumeInFlight) return resumeInFlight;
    if (!hasUnlockSession()) {
      set({ isRestoringSession: false });
      return false;
    }

    set({ isRestoringSession: true });
    resumeInFlight = (async () => {
      try {
        const wallet = await restoreUnlockSession();
        if (!wallet) return false;
        // The session it came from was just rotated — do not seal it again.
        get().setWallet(wallet, { persistSession: false });
        return true;
      } catch (e) {
        console.error('Restoring unlock session failed:', e);
        return false;
      } finally {
        set({ isRestoringSession: false });
        resumeInFlight = null;
      }
    })();
    return resumeInFlight;
  },

  initRpc: async () => {
    let settings = get().settings;
    if (!settings) {
      settings = await loadSettings();
      set({ settings });
    }
    const rpc = new RpcClient({
      url: settings.rpcUrl,
      timeoutMs: 15_000,
    });
    set({ rpc });
    return rpc;
  },

  setSettings: async (s) => {
    await saveSettings(s);
    set({ settings: s, rpc: new RpcClient({ url: s.rpcUrl }) });
    // Auto-lock timing and the keep-unlocked switch live in settings, so the
    // sealed session has to be re-minted for a change to apply to the session
    // already in flight rather than only to the next unlock.
    const w = get().wallet;
    if (w) {
      resealUnlockSession(w, s).catch((e) => console.error('Re-sealing unlock session failed:', e));
    }
  },

  pushToast: (level, message) => {
    const toast: Toast = { id: toastId++, level, message, timestamp: Date.now() };
    set((state) => ({ toasts: [...state.toasts, toast] }));
    // Auto-dismiss after 5s (10s for errors)
    const ttl = level === 'error' ? 10_000 : 5_000;
    setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((t) => t.id !== toast.id) }));
    }, ttl);
  },

  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

  setLoading: (loading, message = '') => set({ isLoading: loading, loadingMessage: message }),

  /**
   * Initialize PVAC bridge for a specific wallet.
   * Called automatically by setWallet; can also be called manually to retry.
   */
  initPvacForWallet: async (wallet: Wallet) => {
    const prevAvailable = get().pvacAvailable;
    const prevBridgeReady = get().pvacBridgeReady;
    return autoLoadPvac(wallet, (status, error, available, bridgeReady) =>
      set({
        pvacStatus: status,
        pvacError: error ?? null,
        pvacAvailable: available !== undefined ? available : prevAvailable,
        pvacBridgeReady: bridgeReady !== undefined ? bridgeReady : prevBridgeReady,
      }),
    );
  },

  /**
   * Force reload the PVAC WASM module and re-init the bridge.
   * Useful after recompiling the WASM or to retry after a failure.
   */
  reloadPvac: async () => {
    const wallet = get().wallet;
    if (!wallet) {
      get().pushToast('warning', 'No wallet loaded — cannot init PVAC');
      return false;
    }
    // Reset the WASM module cache by re-importing
    // (the loadPvacWasm function is idempotent — calling it again returns
    // the existing module. To force a true reload, the user would need to
    // hard-refresh the page. We just re-init the bridge here.)
    set({ pvacStatus: 'loading', pvacError: null });
    return get().initPvacForWallet(wallet);
  },
}));

/**
 * Shared wallet-side host for the SDK connect flow, used by the LONG-LIVED
 * main wallet window.
 *
 * When a /connect popup hands its port off (see ./handoff), the main window
 * adopts the session and services the dApp from here — so reads and signatures
 * keep working after the popup is closed. Approval prompts and PIN unlocks are
 * surfaced through a module-level bus that `ConnectApprovalHost` renders as a
 * global modal in the wallet UI.
 */
import { useWalletStore } from '../store/wallet-store';
import { listAccounts } from '../api/wallet-api';
import { fetchNextNonce } from '../api/nonce';
import type { Wallet } from '../wallet/wallet';
import { activeNetworkInfo, networkInfoList } from '../wallet/networks';
import type {
  WalletHost,
  ApprovalRequest,
  ApprovalDecision,
} from './rpc-handler';

// ── Approval bus (connect + sign prompts) ────────────────────────────────────

interface PendingApproval {
  id: number;
  request: ApprovalRequest;
  resolve: (d: ApprovalDecision) => void;
}

let approvalSeq = 1;
const pendingApprovals: PendingApproval[] = [];
const approvalListeners = new Set<() => void>();

// ── Unlock-account bus (PIN to decrypt a non-active session account) ─────────

interface PendingUnlock {
  addr: string;
  resolve: (w: Wallet | null) => void;
}
let pendingUnlock: PendingUnlock | null = null;
const unlockListeners = new Set<() => void>();

// ── Account chosen in the connect picker (mirrors handler session account) ───

let chosenAccount: string | null = null;

// ── Manifest account cache (getAccounts is synchronous on the host) ──────────

let accountsCache: Array<{ address: string; publicKey: string; name?: string; index?: number }> = [];

export function subscribeApprovals(cb: () => void): () => void {
  approvalListeners.add(cb);
  return () => approvalListeners.delete(cb);
}

export function getPendingApprovals(): readonly PendingApproval[] {
  return pendingApprovals;
}

export function resolveApproval(id: number, decision: ApprovalDecision): void {
  const i = pendingApprovals.findIndex((p) => p.id === id);
  if (i < 0) return;
  const [p] = pendingApprovals.splice(i, 1);
  approvalListeners.forEach((f) => f());
  p.resolve(decision);
}

export function subscribeUnlockAccount(cb: () => void): () => void {
  unlockListeners.add(cb);
  return () => unlockListeners.delete(cb);
}

export function getPendingUnlockAccount(): { addr: string } | null {
  return pendingUnlock ? { addr: pendingUnlock.addr } : null;
}

export function resolveUnlockAccount(w: Wallet | null): void {
  const r = pendingUnlock;
  if (!r) return;
  pendingUnlock = null;
  unlockListeners.forEach((f) => f());
  r.resolve(w);
}

export function setChosenAccount(addr: string | null): void {
  chosenAccount = addr;
}

export async function refreshHostAccounts(): Promise<void> {
  try {
    const list = await listAccounts();
    accountsCache = list.map((a) => ({
      address: a.addr,
      publicKey: a.pubB64,
      name: a.name,
      index: a.index,
    }));
  } catch {
    accountsCache = [];
  }
}

/**
 * Build a `WalletHost` backed by the live wallet store. Reads/signs route to
 * the wallet's RPC and the (possibly non-active) session account; approvals and
 * unlock-account prompts are surfaced via the module buses above.
 */
export function createWalletHost(): WalletHost {
  return {
    getWallet: () => useWalletStore.getState().wallet,
    isUnlocked: () => useWalletStore.getState().isUnlocked,
    getAddress: () => useWalletStore.getState().wallet?.addr ?? null,
    getAccounts: () => accountsCache,
    getNetwork: () => useWalletStore.getState().settings?.network ?? 'devnet',
    getNetworkInfo: () => {
      const s = useWalletStore.getState().settings;
      return activeNetworkInfo(s?.network ?? 'devnet', s?.customNetworks);
    },
    getNetworks: () => networkInfoList(useWalletStore.getState().settings?.customNetworks),
    getChainId: async () => {
      const client = useWalletStore.getState().rpc;
      if (!client) return 'octra:devnet';
      const st = await client.getNodeStatus();
      return st.ok && st.result?.chain_id ? st.result.chain_id : 'octra:devnet';
    },
    getBalance: async () => {
      const s = useWalletStore.getState();
      const addr = chosenAccount ?? s.wallet?.addr;
      if (!s.rpc || !addr) return { balance: '0', balanceRaw: '0', nonce: 0 };
      const bi = await s.rpc.getBalance(addr);
      if (!bi.ok || !bi.result) return { balance: '0', balanceRaw: '0', nonce: 0 };
      return {
        balance: bi.result.balance ?? '0',
        balanceRaw: bi.result.balance_raw ?? '0',
        nonce: bi.result.nonce ?? 0,
      };
    },
    getNextNonce: async () => {
      const s = useWalletStore.getState();
      const addr = chosenAccount ?? s.wallet?.addr;
      if (!s.rpc || !addr) throw new Error('RPC unavailable');
      return fetchNextNonce(s.rpc, addr);
    },
    requestApproval: (request: ApprovalRequest) =>
      new Promise<ApprovalDecision>((resolve) => {
        const id = approvalSeq++;
        pendingApprovals.push({ id, request, resolve });
        approvalListeners.forEach((f) => f());
      }),
    requestUnlock: () => Promise.resolve(useWalletStore.getState().isUnlocked),
    requestUnlockAccount: (addr: string) => {
      const active = useWalletStore.getState().wallet;
      if (active && active.addr === addr) return Promise.resolve(active);
      return new Promise<Wallet | null>((resolve) => {
        pendingUnlock = { addr, resolve };
        unlockListeners.forEach((f) => f());
      });
    },
    setSessionAccount: (addr: string) => {
      chosenAccount = addr;
    },
    getSessionAccount: () => chosenAccount,
  };
}

/** Expose the chosen session account so the connect picker can default to it. */
export function getChosenAccount(): string | null {
  return chosenAccount;
}

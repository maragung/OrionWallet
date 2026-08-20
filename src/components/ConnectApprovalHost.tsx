/**
 * Global approval surface for SDK connect sessions hosted by the main wallet
 * window (see ./host + ./handoff). Renders connect/sign prompts and the
 * unlock-account PIN prompt as modals on top of the wallet UI, fed by the
 * module-level buses in ./host. This is what lets signing keep working after
 * the /connect popup has handed off and closed.
 */
import { useEffect, useState } from 'react';
import {
  subscribeApprovals,
  getPendingApprovals,
  resolveApproval,
  subscribeUnlockAccount,
  getPendingUnlockAccount,
  resolveUnlockAccount,
  setChosenAccount,
  getChosenAccount,
} from '../connect/host';
import { ApprovalPrompt, type ApprovalDecision } from '../connect/approval-ui/ApprovalPrompt';
import { PinModal } from './PinModal';
import { unlockAccount, listAccounts } from '../api/wallet-api';
import { useWalletStore } from '../store/wallet-store';

export function ConnectApprovalHost() {
  const [tick, setTick] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [unlockAddr, setUnlockAddr] = useState<string | null>(null);
  const [accountNames, setAccountNames] = useState<Record<string, string>>({});

  const force = () => setTick((t) => t + 1);

  useEffect(() => subscribeApprovals(force), []);
  useEffect(
    () =>
      subscribeUnlockAccount(() => {
        const p = getPendingUnlockAccount();
        setUnlockAddr(p?.addr ?? null);
        force();
      }),
    [],
  );

  useEffect(() => {
    listAccounts()
      .then((list) => {
        const map: Record<string, string> = {};
        for (const a of list) map[a.addr] = a.name;
        setAccountNames(map);
      })
      .catch(() => undefined);
  }, [tick]);

  const approvals = getPendingApprovals();
  const pendingUnlock = getPendingUnlockAccount();

  const onDecision = (id: number, d: ApprovalDecision) => {
    setSelected(null);
    resolveApproval(id, d);
  };

  const onSelectAccount = (addr: string) => {
    setSelected(addr);
    setChosenAccount(addr);
  };

  const handlePinSubmit = async (pin: string) => {
    if (!unlockAddr) return;
    try {
      const w = await unlockAccount(unlockAddr, pin); // throws on wrong PIN
      resolveUnlockAccount(w);
      setUnlockAddr(null);
    } catch (e) {
      useWalletStore.getState().pushToast('error', `Unlock failed: ${(e as Error).message}`);
    }
  };

  const handlePinCancel = () => {
    resolveUnlockAccount(null);
    setUnlockAddr(null);
  };

  if (approvals.length === 0 && !pendingUnlock) return null;

  return (
    <div className="connect-overlay approval-host">
      {pendingUnlock && (
        <PinModal
          open
          title="Unlock account"
          description={`Enter your PIN to unlock ${
            accountNames[pendingUnlock.addr] ?? 'this account'
          } for the connected dApp. Your active wallet account stays unchanged.`}
          confirmLabel="Unlock"
          busyLabel="Unlocking…"
          onSubmit={handlePinSubmit}
          onCancel={handlePinCancel}
        />
      )}

      {approvals.map((p) => (
        <ApprovalPrompt
          key={p.id}
          request={p.request}
          busy={false}
          accounts={p.request.accounts}
          selectedAccount={
            selected ?? getChosenAccount() ?? p.request.accounts?.[0]?.address ?? null
          }
          onSelectAccount={onSelectAccount}
          onDecision={(d) => onDecision(p.id, d)}
        />
      ))}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { useWalletStore } from '../store/wallet-store';
import { ProcessingModal } from './ProcessingModal';
import { usePanelLoading } from '../hooks/usePanelLoading';
import {
  listAccounts,
  unlockAccount,
  deriveNewHdAccount,
  removeAccount,
  addWatchOnlyAccount,
  openWatchOnlyAccount,
} from '../api/wallet-api';
import type { ManifestEntry } from '../wallet/storage';
import { isValidAddress } from '../crypto/address';
import { PinModal } from './PinModal';

export function AccountSwitcher() {
  const { wallet, setWallet, lock, pushToast } = useWalletStore();
  const panelLoading = usePanelLoading();
  const [accounts, setAccounts] = useState<ManifestEntry[]>([]);
  const [showDerive, setShowDerive] = useState(false);
  const [showWatch, setShowWatch] = useState(false);
  const [watchAddr, setWatchAddr] = useState('');
  const [watchName, setWatchName] = useState('');
  const [newName, setNewName] = useState('');
  const [newIndex, setNewIndex] = useState(0);
  const [pin, setPin] = useState('');
  /** Account awaiting a PIN before it can become active. */
  const [pendingSwitch, setPendingSwitch] = useState<ManifestEntry | null>(null);

  const refresh = async () => {
    try {
      const list = await listAccounts();
      setAccounts(list);
    } catch (e) {
      pushToast('error', `Failed to list accounts: ${(e as Error).message}`);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet]);

  if (!wallet) return null;

  const handleSwitch = async (acct: ManifestEntry) => {
    if (!isValidAddress(acct.addr)) return pushToast('error', 'Invalid address');
    // A watch-only account has no keystore, so there is nothing to decrypt and
    // no PIN to ask for.
    if (acct.watchOnly) {
      panelLoading.show('Switching account', `Loading ${acct.name}…`);
      try {
        setWallet(await openWatchOnlyAccount(acct.addr));
        pushToast('success', `Switched to ${acct.name} (watch-only)`);
        await refresh();
      } catch (e) {
        pushToast('error', `Switch failed: ${(e as Error).message}`);
      } finally {
        panelLoading.hide();
      }
      return;
    }
    // Switching needs the account's signing keys, which only exist after a
    // decrypt, so ask for the PIN in a modal instead of silently updating the
    // manifest and leaving the old account live in memory.
    setPendingSwitch(acct);
  };

  const handleAddWatch = async () => {
    panelLoading.show('Adding account', 'Recording the address in your manifest…');
    try {
      const entry = await addWatchOnlyAccount(watchAddr, watchName);
      setShowWatch(false);
      setWatchAddr('');
      setWatchName('');
      await refresh();
      pushToast('success', `Now watching ${entry.name}`);
    } catch (e) {
      pushToast('error', `Could not add: ${(e as Error).message}`);
    } finally {
      panelLoading.hide();
    }
  };

  const confirmSwitch = async (enteredPin: string) => {
    const acct = pendingSwitch;
    if (!acct) return;
    panelLoading.show('Switching account', `Loading ${acct.name}…`);
    try {
      const w = await unlockAccount(acct.addr, enteredPin);
      // Pushing the wallet into the store re-renders every subscriber (header,
      // balance, this table), so the active account updates everywhere at once.
      setWallet(w);
      setPendingSwitch(null);
      pushToast('success', `Switched to ${w.name} (${w.addr.slice(0, 12)}…)`);
      await refresh();
    } finally {
      panelLoading.hide();
    }
  };

  const handleDerive = async () => {
    if (!pin) return pushToast('error', 'PIN required to derive new account');
    if (!newName.trim()) return pushToast('error', 'Account name required');
    panelLoading.show('Deriving account', 'Deriving a new HD account from the seed…');
    try {
      const newWallet = await deriveNewHdAccount(wallet, newIndex, newName, pin);
      setWallet(newWallet);
      pushToast('success', `Derived account ${newWallet.addr.slice(0, 12)}…`);
      setShowDerive(false);
      setNewName('');
      setNewIndex(0);
      setPin('');
      await refresh();
    } catch (e) {
      pushToast('error', `Derive failed: ${(e as Error).message}`);
    } finally {
      panelLoading.hide();
    }
  };

  const handleRemove = async (addr: string) => {
    if (
      !confirm(
        `Remove account ${addr.slice(0, 16)}… from manifest and delete its encrypted wallet data?`,
      )
    )
      return;
    panelLoading.show('Removing account', 'Deleting the account from local storage…');
    try {
      await removeAccount(addr);
      // Removing the account that is currently open has to close it too, or its
      // keys would live on in memory — and in the unlock session, which would
      // bring the deleted account back on the next reload.
      if (addr === wallet.addr) {
        lock();
        pushToast('success', 'Account removed — wallet locked');
        return;
      }
      await refresh();
      pushToast('success', 'Account removed');
    } catch (e) {
      pushToast('error', `Remove failed: ${(e as Error).message}`);
    } finally {
      panelLoading.hide();
    }
  };

  return (
    <>
      <div className="card">
        <div className="card-header">
          <div className="card-title">HD Accounts</div>
          <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
            <button
              className="ghost"
              onClick={() => {
                setShowWatch(!showWatch);
                setShowDerive(false);
              }}
            >
              {showWatch ? 'Cancel' : '👁 Watch Address'}
            </button>
            <button
              className="ghost"
              onClick={() => {
                setShowDerive(!showDerive);
                setShowWatch(false);
              }}
            >
              {showDerive ? 'Cancel' : '+ Derive New'}
            </button>
          </div>
        </div>

        {showWatch && (
          <div
            style={{
              marginBottom: 16,
              padding: 16,
              background: 'var(--bg-tertiary)',
              borderRadius: 8,
            }}
          >
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
              Track any Octra address without its keys. Balance, tokens and history work; sending
              and signing are refused.
            </div>
            <div className="form-row">
              <label htmlFor="waddr">Address</label>
              <input
                id="waddr"
                className="mono"
                value={watchAddr}
                onChange={(e) => setWatchAddr(e.target.value)}
                placeholder="oct..."
                autoComplete="off"
                spellCheck={false}
                style={
                  watchAddr && !isValidAddress(watchAddr.trim())
                    ? { borderColor: 'var(--error)' }
                    : undefined
                }
              />
            </div>
            <div className="form-row">
              <label htmlFor="wname">Label</label>
              <input
                id="wname"
                value={watchName}
                onChange={(e) => setWatchName(e.target.value)}
                placeholder="Cold storage"
                maxLength={64}
              />
            </div>
            <div className="form-actions">
              <button
                className="primary"
                onClick={handleAddWatch}
                disabled={!isValidAddress(watchAddr.trim()) || !watchName.trim()}
              >
                Add Watch-Only Account
              </button>
            </div>
          </div>
        )}

        {showDerive && (
          <div
            style={{
              marginBottom: 16,
              padding: 16,
              background: 'var(--bg-tertiary)',
              borderRadius: 8,
            }}
          >
            <div className="form-row">
              <label htmlFor="dname">Account Name</label>
              <input
                id="dname"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Account 2"
              />
            </div>
            <div className="form-row">
              <label htmlFor="didx">Account Index</label>
              <input
                id="didx"
                type="number"
                min={0}
                max={1000}
                value={newIndex}
                onChange={(e) => setNewIndex(parseInt(e.target.value, 10) || 0)}
              />
            </div>
            <div className="form-row">
              <label htmlFor="dpin">PIN (current wallet PIN)</label>
              <input
                id="dpin"
                type="password"
                className="mono"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
              />
            </div>
            <div className="form-actions">
              <button className="primary" onClick={handleDerive} disabled={!pin || !newName.trim()}>
                Derive Account
              </button>
            </div>
          </div>
        )}

        {accounts.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)' }}>
            No accounts in manifest.
          </div>
        ) : (
          <div className="table-scroll">
            <table className="history-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Address</th>
                  <th>Index</th>
                  <th>Active</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.addr}>
                    <td>
                      {a.name}
                      {a.watchOnly && (
                        <span
                          className="tag warn"
                          style={{ marginLeft: 6 }}
                          title="No keys — cannot sign"
                        >
                          👁 watch-only
                        </span>
                      )}
                    </td>
                    <td className="mono" title={a.addr}>
                      {a.addr.slice(0, 12)}…{a.addr.slice(-8)}
                    </td>
                    <td className="mono">{a.watchOnly ? '—' : a.index}</td>
                    <td>
                      {a.addr === wallet.addr ? (
                        <span className="tag ok">active</span>
                      ) : (
                        <button className="ghost" onClick={() => void handleSwitch(a)}>
                          Switch
                        </button>
                      )}
                    </td>
                    <td>
                      <button
                        className="ghost"
                        onClick={() => handleRemove(a.addr)}
                        title="Remove from manifest"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div
          style={{
            marginTop: 12,
            padding: 12,
            background: 'var(--bg-tertiary)',
            borderRadius: 8,
            fontSize: 12,
            color: 'var(--text-muted)',
          }}
        >
          Accounts are derived deterministically from your wallet's BIP39 master seed. The same
          mnemonic always produces the same set of accounts in the same order. Watch-only entries
          are just addresses — removing one never deletes key material, because it holds none.
        </div>
      </div>

      <PinModal
        open={pendingSwitch !== null}
        title="Switch account"
        description={
          pendingSwitch
            ? `Enter your PIN to unlock "${pendingSwitch.name}" (${pendingSwitch.addr.slice(0, 12)}…). ` +
              'The signing keys must be decrypted before this account can become active.'
            : undefined
        }
        confirmLabel="Switch"
        busyLabel="Switching…"
        onSubmit={confirmSwitch}
        onCancel={() => setPendingSwitch(null)}
      />
      <ProcessingModal
        open={panelLoading.loading}
        title={panelLoading.title}
        message={panelLoading.message}
        dismissible
        onClose={panelLoading.hide}
      />
    </>
  );
}

import { useRef, useState } from 'react';
import { useWalletStore } from '../store/wallet-store';
import { ProcessingModal } from './ProcessingModal';
import { usePanelLoading } from '../hooks/usePanelLoading';
import { saveWalletEncrypted, loadWalletEncrypted } from '../wallet/wallet';
import { saveWalletEntry } from '../wallet/storage';
import { addAccountToManifest } from '../wallet/storage';
import { assertValidPin } from '../wallet/pin';
import { ConfirmDialog } from './ConfirmDialog';
import { Icon } from './icons';

export function WalletExportImport() {
  const { wallet, setWallet, pushToast } = useWalletStore();
  const panelLoading = usePanelLoading();
  const [exportPin, setExportPin] = useState('');
  const [importPin, setImportPin] = useState('');
  const [importNewPin, setImportNewPin] = useState('');
  const [importConfirmPin, setImportConfirmPin] = useState('');
  const [showExportConfirm, setShowExportConfirm] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!wallet) return null;

  const requestExport = () => {
    if (!exportPin) return pushToast('error', 'Enter PIN to authorize export');
    setShowExportConfirm(true);
  };

  const handleExport = async () => {
    setShowExportConfirm(false);
    if (!exportPin) return pushToast('error', 'Enter PIN to authorize export');
    panelLoading.show('Exporting wallet', 'Encrypting and packaging the wallet file…');
    try {
      // Verify PIN by re-decrypting (best-effort: try the default wallet entry)
      const { loadWalletEntry } = await import('../wallet/storage');
      const entry = await loadWalletEntry('default');
      if (entry) {
        await loadWalletEncrypted(entry.blob, exportPin);
      }
      // Re-encrypt with the same PIN and trigger a download
      const blob = await saveWalletEncrypted(wallet, exportPin);
      // Copy to a fresh ArrayBuffer to satisfy BlobPart typing (no SharedArrayBuffer)
      const ab = new ArrayBuffer(blob.byteLength);
      new Uint8Array(ab).set(blob);
      const file = new File([ab], 'wallet.oct', { type: 'application/octet-stream' });
      const url = URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = url;
      a.download = `wallet-${wallet.addr.slice(0, 12)}.oct`;
      a.click();
      URL.revokeObjectURL(url);
      pushToast('success', 'Wallet exported as encrypted .oct file');
      setExportPin('');
    } catch (e) {
      pushToast('error', `Export failed: ${(e as Error).message}`);
    } finally {
      panelLoading.hide();
    }
  };

  const handleImport = async (file: File) => {
    if (!importNewPin || importNewPin !== importConfirmPin) {
      return pushToast('error', 'New PINs do not match');
    }
    try {
      assertValidPin(importNewPin);
    } catch (e) {
      return pushToast('error', `Invalid PIN: ${(e as Error).message}`);
    }
    if (!importPin) return pushToast('error', 'Enter the wallet file PIN');

    panelLoading.show('Importing wallet', `Reading ${file.name}…`);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      // Decrypt with the file's PIN
      const importedWallet = await loadWalletEncrypted(buf, importPin);
      // Re-encrypt with the new PIN (the user's chosen PIN for this browser)
      const newBlob = await saveWalletEncrypted(importedWallet, importNewPin);
      await saveWalletEntry({
        id: 'default',
        blob: newBlob,
        addrHint: importedWallet.addr.slice(0, 8) + '...',
        name: importedWallet.name,
        createdAt: importedWallet.createdAt,
      });
      await addAccountToManifest({
        addr: importedWallet.addr,
        name: importedWallet.name,
        index: importedWallet.index,
        pubB64: importedWallet.pubB64,
        createdAt: importedWallet.createdAt,
      });
      setWallet(importedWallet);
      pushToast('success', `Wallet imported: ${importedWallet.addr.slice(0, 12)}…`);
      setImportPin('');
      setImportNewPin('');
      setImportConfirmPin('');
    } catch (e) {
      pushToast('error', `Import failed: ${(e as Error).message}`);
    } finally {
      panelLoading.hide();
    }
  };

  const pinMismatch = Boolean(importConfirmPin) && importNewPin !== importConfirmPin;

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title">
          <Icon name="save" size={18} /> Export / Import Wallet File
        </div>
      </div>

      <p className="card-desc">
        Export your wallet as an encrypted <code>.oct</code> file (AES-256-GCM with PBKDF2 key
        derivation). Import the file on another device or browser to restore access. The PIN used to
        encrypt the file is required for import.
      </p>

      <div className="stack-section">
        <div className="card-subhead flush">
          <Icon name="download" size={16} /> Export Current Wallet
        </div>
        <div className="form-row">
          <label htmlFor="exp-pin">Wallet PIN (to authorize export)</label>
          <input
            id="exp-pin"
            type="password"
            className="mono"
            value={exportPin}
            onChange={(e) => setExportPin(e.target.value)}
          />
        </div>
        <div className="form-actions start">
          <button className="primary" onClick={requestExport} disabled={!exportPin}>
            <Icon name="download" size={16} /> Download .oct File
          </button>
        </div>
      </div>

      <div>
        <div className="card-subhead flush">
          <Icon name="upload" size={16} /> Import Wallet from File
        </div>
        <div className="form-row">
          <label htmlFor="imp-pin">File PIN (PIN used to encrypt the .oct file)</label>
          <input
            id="imp-pin"
            type="password"
            className="mono"
            value={importPin}
            onChange={(e) => setImportPin(e.target.value)}
          />
        </div>
        <div className="grid-2">
          <div className="form-row">
            <label htmlFor="imp-new-pin">New PIN (for this browser)</label>
            <input
              id="imp-new-pin"
              type="password"
              className="mono"
              value={importNewPin}
              onChange={(e) => setImportNewPin(e.target.value)}
            />
          </div>
          <div className="form-row">
            <label htmlFor="imp-conf">Confirm New PIN</label>
            <input
              id="imp-conf"
              type="password"
              className="mono"
              value={importConfirmPin}
              onChange={(e) => setImportConfirmPin(e.target.value)}
              aria-invalid={pinMismatch}
              data-invalid={pinMismatch ? 'true' : undefined}
            />
            {/* Said here rather than only on submit: the button is disabled until the two
                match, and a disabled button with no reason beside it looks broken. */}
            {pinMismatch && (
              <div className="field-error">
                <Icon name="alert-triangle" size={12} /> The two PINs do not match.
              </div>
            )}
          </div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".oct,application/octet-stream"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleImport(f);
            e.target.value = ''; // allow re-selecting the same file
          }}
        />
        <div className="form-actions start">
          <button
            className="primary"
            onClick={() => fileInputRef.current?.click()}
            disabled={!importPin || !importNewPin || importNewPin !== importConfirmPin}
          >
            <Icon name="upload" size={16} /> Choose .oct File…
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={showExportConfirm}
        danger
        icon="save"
        title="Export Wallet File"
        message="This downloads an encrypted .oct file containing your wallet. Anyone with this file and its PIN can access your funds. Store it securely and never share it."
        confirmLabel="Download .oct File"
        cancelLabel="Cancel"
        onConfirm={handleExport}
        onCancel={() => setShowExportConfirm(false)}
        details={[
          `Wallet:  ${wallet.addr}`,
          `File:    wallet-${wallet.addr.slice(0, 12)}.oct`,
          `Format:  AES-256-GCM encrypted`,
        ].join('\n')}
      />
      <ProcessingModal
        open={panelLoading.loading}
        title={panelLoading.title}
        message={panelLoading.message}
        dismissible
        onClose={panelLoading.hide}
      />
    </div>
  );
}

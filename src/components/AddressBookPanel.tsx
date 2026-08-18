/**
 * Address book (contacts) management for the wallet Settings screen.
 *
 * Recipients live in IndexedDB, keyed by address, and are offered as a picker in
 * the send form. Saving a label is the cheapest defence the wallet can give
 * against the mistake that actually loses funds: pasting the wrong address.
 */
import { useCallback, useEffect, useState } from 'react';
import { useWalletStore } from '../store/wallet-store';
import { listContacts, upsertContact, deleteContact, type ContactEntry } from '../wallet/storage';
import { isValidAddress } from '../crypto/address';
import { CopyButton } from './CopyButton';
import { downloadCsv, exportFilename } from '../utils/csv';

export function AddressBookPanel() {
  const { pushToast } = useWalletStore();
  const [contacts, setContacts] = useState<ContactEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [addr, setAddr] = useState('');
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  /** Address being edited, or null when the form is adding a new contact. */
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setContacts(await listContacts());
    } catch (e) {
      pushToast('error', `Failed to load contacts: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [pushToast]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const resetForm = () => {
    setAddr('');
    setName('');
    setNote('');
    setEditing(null);
  };

  const save = async () => {
    const a = addr.trim();
    const n = name.trim();
    if (!isValidAddress(a)) return pushToast('error', 'Invalid Octra address');
    if (!n) return pushToast('error', 'Contact name required');
    // Adding an address that is already saved would silently overwrite the
    // existing label, so say what is happening instead.
    const clash = !editing && contacts.some((c) => c.addr === a);
    setBusy(true);
    try {
      await upsertContact(a, n, note);
      pushToast('success', clash ? `Updated existing contact ${n}` : `Saved ${n}`);
      resetForm();
      await refresh();
    } catch (e) {
      pushToast('error', `Save failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (c: ContactEntry) => {
    setEditing(c.addr);
    setAddr(c.addr);
    setName(c.name);
    setNote(c.note ?? '');
  };

  const remove = async (c: ContactEntry) => {
    if (!confirm(`Remove "${c.name}" (${c.addr.slice(0, 16)}…) from the address book?`)) return;
    try {
      await deleteContact(c.addr);
      if (editing === c.addr) resetForm();
      pushToast('success', 'Contact removed');
      await refresh();
    } catch (e) {
      pushToast('error', `Remove failed: ${(e as Error).message}`);
    }
  };

  const exportCsv = () => {
    if (contacts.length === 0) return;
    downloadCsv(exportFilename('contacts', ''), [
      ['Name', 'Address', 'Note', 'Saved (ISO)'],
      ...contacts.map((c) => [c.name, c.addr, c.note ?? '', new Date(c.createdAt).toISOString()]),
    ]);
    pushToast('success', `Exported ${contacts.length} contacts`);
  };

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title">Address Book</div>
        <button
          className="ghost"
          onClick={exportCsv}
          disabled={contacts.length === 0}
          title={contacts.length === 0 ? 'No contacts to export' : 'Export contacts as CSV'}
        >
          ⤓ CSV
        </button>
      </div>

      <div className="form-row">
        <label htmlFor="ab-addr">Address</label>
        <input
          id="ab-addr"
          className="mono"
          placeholder="oct…"
          value={addr}
          // The address is the primary key: editing it would orphan the old row,
          // so an existing contact is renamed in place instead.
          disabled={editing !== null}
          onChange={(e) => setAddr(e.target.value)}
        />
      </div>
      <div className="form-row">
        <label htmlFor="ab-name">Name</label>
        <input
          id="ab-name"
          placeholder="Exchange deposit"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="form-row">
        <label htmlFor="ab-note">Note (optional)</label>
        <input
          id="ab-note"
          placeholder="Memo required — see their docs"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      <div className="form-actions">
        <button className="primary" onClick={save} disabled={busy || !addr.trim() || !name.trim()}>
          {editing ? 'Save changes' : 'Add contact'}
        </button>
        {editing && (
          <button className="ghost" onClick={resetForm} disabled={busy}>
            Cancel
          </button>
        )}
      </div>

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
          <div className="skeleton" style={{ height: 32 }} />
          <div className="skeleton" style={{ height: 32 }} />
        </div>
      ) : contacts.length === 0 ? (
        <div className="empty-state" style={{ padding: 'var(--sp-6)' }}>
          <div className="icon">📇</div>
          <div className="title">No contacts yet</div>
          <div className="desc">
            Saved addresses appear in the send form, so you can pick a recipient by name instead of
            pasting one.
          </div>
        </div>
      ) : (
        <div className="table-scroll">
          <table className="history-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Address</th>
                <th>Note</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.addr}>
                  <td>{c.name}</td>
                  <td className="mono" title={c.addr}>
                    {c.addr.slice(0, 12)}…{c.addr.slice(-6)} <CopyButton value={c.addr} />
                  </td>
                  <td style={{ color: 'var(--text-muted)' }}>{c.note ?? '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="ghost" onClick={() => startEdit(c)} title="Rename">
                      ✎
                    </button>
                    <button className="ghost" onClick={() => remove(c)} title="Remove">
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

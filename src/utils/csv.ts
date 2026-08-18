/**
 * CSV serialisation (RFC 4180) plus a browser download helper.
 *
 * Used by the history export. Kept dependency-free: the CSP allows no external
 * scripts, and a spreadsheet-compatible writer is a dozen lines.
 */

/**
 * Cells beginning with one of these are executed as formulas by Excel, Sheets
 * and LibreOffice. A transaction field is attacker-influenced (an address book
 * note, a memo, an op type from a hostile node), so the value is prefixed with
 * an apostrophe to keep it inert text. The visible content is unchanged in the
 * spreadsheet; only the raw file carries the extra quote.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/** Quote and escape a single cell. */
export function escapeCsvCell(value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value);
  const safe = FORMULA_LEAD.test(raw) ? `'${raw}` : raw;
  // RFC 4180: wrap in quotes when the cell holds a quote, comma or newline,
  // doubling any embedded quote.
  if (/[",\r\n]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}

/**
 * Serialise rows to a CSV document. The first row is normally the header.
 *
 * Lines are CRLF-terminated (RFC 4180) and the document is *not* BOM-prefixed —
 * `downloadCsv` adds the BOM, since that is an Excel concern rather than a
 * property of the CSV itself.
 */
export function toCsv(rows: readonly (readonly unknown[])[]): string {
  return rows.map((row) => row.map(escapeCsvCell).join(',')).join('\r\n');
}

/**
 * Hand a text file to the browser as a download.
 *
 * The blob URL is revoked on the next tick: revoking it synchronously can race
 * the download in some browsers, and never revoking leaks the blob for the life
 * of the document.
 */
export function downloadTextFile(
  filename: string,
  text: string,
  mime: string = 'text/plain;charset=utf-8',
): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Byte-order mark. Written as an escape: a literal BOM is invisible in source. */
const BOM = '\uFEFF';

/** Download rows as a UTF-8 CSV, BOM-prefixed so Excel detects the encoding. */
export function downloadCsv(filename: string, rows: readonly (readonly unknown[])[]): void {
  downloadTextFile(filename, `${BOM}${toCsv(rows)}`, 'text/csv;charset=utf-8');
}

/**
 * `orion-history-oct1abcd-20260817.csv` — a stable, sortable filename that
 * says which account and which day the export came from.
 */
export function exportFilename(kind: string, addr: string, at: Date = new Date()): string {
  const day = `${at.getFullYear()}${String(at.getMonth() + 1).padStart(2, '0')}${String(at.getDate()).padStart(2, '0')}`;
  const who = addr ? `-${addr.slice(0, 8)}` : '';
  return `orion-${kind}${who}-${day}.csv`;
}

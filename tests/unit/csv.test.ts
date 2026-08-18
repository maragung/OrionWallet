import { describe, it, expect } from 'vitest';
import { escapeCsvCell, toCsv, exportFilename } from '../../src/utils/csv';

describe('escapeCsvCell', () => {
  it('leaves a plain cell untouched', () => {
    expect(escapeCsvCell('oct1abc')).toBe('oct1abc');
    expect(escapeCsvCell(42)).toBe('42');
  });

  it('renders null and undefined as an empty cell', () => {
    expect(escapeCsvCell(null)).toBe('');
    expect(escapeCsvCell(undefined)).toBe('');
  });

  it('quotes cells holding a comma, quote or newline', () => {
    expect(escapeCsvCell('a,b')).toBe('"a,b"');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('neutralises spreadsheet formulas', () => {
    // A hostile node could return an op_type of =HYPERLINK(...) and a note is
    // user text; neither may execute when the file is opened.
    expect(escapeCsvCell('=1+1')).toBe("'=1+1");
    expect(escapeCsvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(escapeCsvCell('-2+3')).toBe("'-2+3");
    // Quoting still applies on top of the apostrophe.
    expect(escapeCsvCell('=A1,B1')).toBe('"\'=A1,B1"');
  });
});

describe('toCsv', () => {
  it('joins rows with CRLF and cells with commas', () => {
    expect(
      toCsv([
        ['h1', 'h2'],
        ['a', 'b'],
      ]),
    ).toBe('h1,h2\r\na,b');
  });

  it('round-trips a row count', () => {
    const rows = [['hash', 'amount'], ...Array.from({ length: 5 }, (_, i) => [`h${i}`, i])];
    expect(toCsv(rows).split('\r\n')).toHaveLength(6);
  });

  it('handles an empty input', () => {
    expect(toCsv([])).toBe('');
  });
});

describe('exportFilename', () => {
  it('names the file after the kind, account and day', () => {
    const at = new Date(Date.UTC(2026, 7, 17, 12, 0, 0));
    const name = exportFilename('history', 'oct1abcdefghij', at);
    expect(name).toMatch(/^orion-history-oct1abcd-\d{8}\.csv$/);
  });

  it('omits the account segment when there is no address', () => {
    expect(exportFilename('history', '', new Date(Date.UTC(2026, 0, 2)))).toMatch(
      /^orion-history-\d{8}\.csv$/,
    );
  });
});

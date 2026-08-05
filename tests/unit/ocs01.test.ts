/**
 * OCS01 primitive tests.
 *
 * Fixtures are REAL values read from live Octra nodes during design, not
 * invented numbers — notably mainnet's `ao` token (decimals 0, supply 1e27),
 * which sits far beyond IEEE-754 integer precision and is the reason every
 * amount is carried as bigint.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_U128,
  DISPLAY_DECIMALS,
  balanceKey,
  grantKey,
  parseU128,
  parseDecimals,
  parseText,
  formatTokenAmount,
  formatStorageAmount,
} from '../../src/tokens/ocs01';

const ADDR = 'octCo5bJiSwt96Lm7PWM1yzcALsApEWrudoFykSaAGk3Mpy';
const SPENDER = 'oct39TH6PmokBGXVRibeAThZiomaweFqR5amvKpByTBqbhQ';

describe('storage keys', () => {
  it('builds a colon-separated balance key', () => {
    // The node resolves ONLY this form; bracket/dot/slash variants return null.
    expect(balanceKey(ADDR)).toBe(`balances:${ADDR}`);
  });

  it('builds a colon-separated grant key', () => {
    expect(grantKey(ADDR, SPENDER)).toBe(`grants:${ADDR}:${SPENDER}`);
  });
});

describe('parseU128', () => {
  it('parses the node string form exactly', () => {
    expect(parseU128('6000000')).toBe(6000000n);
  });

  it('parses 1e27 without precision loss (mainnet `ao` supply)', () => {
    const v = parseU128('1000000000000000000000000000');
    expect(v).toBe(1000000000000000000000000000n);
    // The whole point: routing this value through Number corrupts it. Compare
    // against the true digit string, not a numeric literal — a literal is
    // itself a double and rounds to the same wrong value, hiding the bug.
    expect(String(Number(v))).not.toBe('1000000000000000000000000000');
    expect(BigInt(Number(v))).toBe(1000000000000000013287555072n);
    // Exactly the drift measured against the live mainnet value.
    expect(BigInt(Number(v)) - v!).toBe(13287555072n);
  });

  it('accepts MAX_U128 and rejects one above it', () => {
    expect(parseU128(MAX_U128.toString())).toBe(MAX_U128);
    expect(parseU128((MAX_U128 + 1n).toString())).toBeNull();
  });

  it('rejects unsafe numbers that already lost precision', () => {
    expect(parseU128(1e27)).toBeNull();
    expect(parseU128(Number.MAX_SAFE_INTEGER + 2)).toBeNull();
  });

  it('accepts safe integer numbers', () => {
    expect(parseU128(2500000)).toBe(2500000n);
  });

  it('rejects null, blanks, negatives and non-numeric text', () => {
    for (const bad of [null, undefined, '', '   ', '-1', '1.5', 'abc', '0x10', {}, []]) {
      expect(parseU128(bad)).toBeNull();
    }
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseU128('  42  ')).toBe(42n);
  });
});

describe('parseDecimals', () => {
  it('distinguishes decimals 0 from missing decimals', () => {
    // `ao` (mainnet) really is 0-decimal; `BFC` (devnet) has no key at all.
    // Collapsing these would mis-scale every balance of the latter.
    expect(parseDecimals('0')).toBe(0);
    expect(parseDecimals(null)).toBeNull();
    expect(parseDecimals(undefined)).toBeNull();
  });

  it('parses common on-chain values', () => {
    expect(parseDecimals('6')).toBe(6);
    expect(parseDecimals('9')).toBe(9);
    expect(parseDecimals('18')).toBe(18);
  });

  it('rejects implausible or malformed values rather than trusting them', () => {
    for (const bad of ['-1', '1.5', 'six', '', '  ', '39', {}]) {
      expect(parseDecimals(bad)).toBeNull();
    }
  });
});

describe('parseText', () => {
  it('returns trimmed text and nulls out blanks', () => {
    expect(parseText('PAAMM X')).toBe('PAAMM X');
    expect(parseText('  NRT  ')).toBe('NRT');
    // Devnet has tokens with an empty `name`.
    expect(parseText('')).toBeNull();
    expect(parseText('   ')).toBeNull();
    expect(parseText(null)).toBeNull();
    expect(parseText(7)).toBeNull();
  });
});

describe('formatTokenAmount — real on-chain fixtures', () => {
  const cases: Array<[string, bigint, number | null, string]> = [
    ['PX holder balance', 2000000n, 6, '2'],
    ['PX owner balance', 6000000n, 6, '6'],
    ['NRT supply', 1000000000n, 9, '1'],
    ['WYCF holder balance', 624814636022n, 9, '624.814636'],
    ['BINX supply', 1000000000000n, 6, '1,000,000'],
    ['BONUS odd supply', 1000000000028000n, 6, '1,000,000,000.028'],
    ['FALSE supply', 1000000000000000n, 6, '1,000,000,000'],
    ['ao supply (1e27, decimals 0)', 10n ** 27n, 0, '1,000,000,000,000,000,000,000,000,000'],
    ['BFC (decimals unknown)', 1000000000n, null, '1,000,000,000'],
    ['zero', 0n, 6, '0'],
  ];

  it.each(cases)('%s', (_label, raw, decimals, expected) => {
    expect(formatTokenAmount(raw, decimals).display).toBe(expected);
  });
});

describe('formatTokenAmount — dust must never display as zero', () => {
  it('renders one base unit of an 18-decimal token as a dust marker', () => {
    const r = formatTokenAmount(1n, 18);
    expect(r.display).toBe('<0.000001');
    expect(r.dust).toBe(true);
    // Showing a real holding as "0" would be a correctness bug.
    expect(r.display).not.toBe('0');
    // The exact value stays available for tooltip/copy.
    expect(r.exact).toBe('0.000000000000000001');
  });

  it('renders one base unit of a 6-decimal token exactly, not as dust', () => {
    const r = formatTokenAmount(1n, 6);
    expect(r.display).toBe('0.000001');
    expect(r.dust).toBe(false);
  });

  it('flags true zero as zero, not dust', () => {
    const r = formatTokenAmount(0n, 18);
    expect(r.display).toBe('0');
    expect(r.dust).toBe(false);
  });
});

describe('formatTokenAmount — truncation never rounds up', () => {
  it('truncates rather than rounding a value that would round up', () => {
    // 0.9999999 at 7dp -> visible 6dp must be 0.999999, never 1.
    const r = formatTokenAmount(9999999n, 7);
    expect(r.display).toBe('0.999999');
    expect(r.truncated).toBe(true);
    expect(r.exact).toBe('0.9999999');
  });

  it('does not flag truncation when hidden digits are only zeros', () => {
    const r = formatTokenAmount(1500000000n, 9); // 1.5
    expect(r.display).toBe('1.5');
    expect(r.truncated).toBe(false);
  });

  it('keeps full precision in `exact` for MAX_U128', () => {
    const r = formatTokenAmount(MAX_U128, 18);
    expect(r.exact).toBe('340282366920938463463.374607431768211455');
    expect(r.display).toBe('340,282,366,920,938,463,463.374607');
    expect(r.truncated).toBe(true);
  });
});

describe('formatTokenAmount — flags and guards', () => {
  it('marks unknown decimals as unscaled so the UI can label raw units', () => {
    const r = formatTokenAmount(1000000000n, null);
    expect(r.unscaled).toBe(true);
    expect(r.exact).toBe('1000000000');
  });

  it('does not mark decimals 0 as unscaled', () => {
    expect(formatTokenAmount(10n ** 27n, 0).unscaled).toBe(false);
  });

  it('rejects negative amounts', () => {
    expect(() => formatTokenAmount(-1n, 6)).toThrow(RangeError);
  });

  it('exposes the documented display precision', () => {
    expect(DISPLAY_DECIMALS).toBe(6);
  });
});

describe('formatStorageAmount', () => {
  it('formats a raw node value end to end', () => {
    expect(formatStorageAmount('624814636022', 9)?.display).toBe('624.814636');
  });

  it('returns null for unusable values instead of guessing', () => {
    expect(formatStorageAmount(null, 6)).toBeNull();
    expect(formatStorageAmount('not-a-number', 6)).toBeNull();
  });
});

/**
 * OCS01 fungible-token primitives (Octra's native token standard).
 *
 * The interface lives at `public/templates/token/interfaces/IOCS01.aml`, with a
 * reference implementation in `public/templates/token/main.aml`.
 *
 * READ MODEL — the node exposes NO view-call RPC (`octra_call`, `vm_view`,
 * `octra_query` etc. do not exist), so every read goes through
 * `octra_contractStorage(address, key)`. Storage keys are flat strings; map
 * entries are addressed with a COLON separator:
 *
 *     symbol | name | decimals | total_supply | owner
 *     balances:<address>
 *
 * The colon form is the only one the node resolves — `balances[addr]`,
 * `balances.addr` and `balances/addr` all return null (verified against live
 * devnet and mainnet nodes).
 *
 * NUMERIC MODEL — amounts are u128. This exceeds IEEE-754 double precision by
 * many orders of magnitude, so every amount is carried as `bigint` and only
 * converted to a string at the render boundary. A real mainnet token (`ao`)
 * has a total supply of 1e27; passing that through `Number` yields
 * 1000000000000000013287555072 — a drift of over 13 billion base units.
 * Nothing in this module may construct a `Number` from an amount.
 */

/** Upper bound of a u128, mirroring MAX_U128 in the reference AML contract. */
export const MAX_U128 = 340282366920938463463374607431768211455n;

/** Fractional digits shown in list UIs before truncation. */
export const DISPLAY_DECIMALS = 6;

/**
 * Largest `decimals` value we will scale by.
 *
 * The reference contract enforces `dec <= 18`, but a contract deployed from
 * different source can store anything. A wildly large value would push every
 * balance below the display threshold and render the whole list as dust, so
 * out-of-range values are treated as "unknown" instead of being trusted.
 */
export const MAX_DECIMALS = 38;

/** Flat (non-map) OCS01 storage keys. */
export const OCS01_KEYS = {
  symbol: 'symbol',
  name: 'name',
  decimals: 'decimals',
  totalSupply: 'total_supply',
  owner: 'owner',
} as const;

/** Storage key for one holder's balance: `balances:<address>`. */
export function balanceKey(address: string): string {
  return `balances:${address}`;
}

/** Storage key for an allowance: `grants:<owner>:<spender>`. */
export function grantKey(owner: string, spender: string): string {
  return `grants:${owner}:${spender}`;
}

/**
 * Parse a u128 storage value into a bigint.
 *
 * Returns null for absent/blank/malformed values, and for anything outside
 * [0, MAX_U128]. Accepts the string form the node returns; also accepts a
 * JS number only when it is a safe integer, since a non-safe number has
 * already lost precision before reaching us and must not be trusted.
 */
export function parseU128(value: unknown): bigint | null {
  if (value === null || value === undefined) return null;

  let digits: string;
  if (typeof value === 'bigint') {
    digits = value.toString();
  } else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return null;
    digits = value.toString();
  } else if (typeof value === 'string') {
    digits = value.trim();
  } else {
    return null;
  }

  if (digits === '' || !/^\d+$/.test(digits)) return null;

  const parsed = BigInt(digits);
  return parsed > MAX_U128 ? null : parsed;
}

/**
 * Parse a `decimals` storage value.
 *
 * CRITICAL: `0` and "missing" are different states and must not collapse.
 * Mainnet's `ao` token genuinely declares `decimals: "0"` (balances are exact
 * whole units), whereas devnet's `BFC` has no `decimals` key at all (scaling
 * unknown — balances can only be shown as raw base units). Returning 0 for a
 * missing key would silently mis-scale every balance of such a token.
 */
export function parseDecimals(value: unknown): number | null {
  if (value === null || value === undefined) return null;

  const raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : null;
  if (raw === null) return null;

  const digits = raw.trim();
  if (digits === '' || !/^\d+$/.test(digits)) return null;

  const n = Number(digits);
  if (!Number.isInteger(n) || n < 0 || n > MAX_DECIMALS) return null;
  return n;
}

/** Parse a string storage value (symbol/name/owner), normalising blanks to null. */
export function parseText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return s === '' ? null : s;
}

export interface FormattedAmount {
  /** Value for the UI, e.g. "624.814636", "1,000,000", "<0.000001". */
  display: string;
  /** Full untruncated decimal string (ungrouped) for tooltips/copy/confirmations. */
  exact: string;
  /** The fraction was cut at DISPLAY_DECIMALS — `display` understates `exact`. */
  truncated: boolean;
  /** Non-zero but smaller than the display threshold; shown as "<0.000001". */
  dust: boolean;
  /** `decimals` was unknown, so `display` is in raw base units. */
  unscaled: boolean;
}

/** Insert thousands separators into a digit string of arbitrary length. */
function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Render a raw u128 balance for display.
 *
 * Truncates the fraction at DISPLAY_DECIMALS and NEVER rounds up: rounding up
 * would imply the holder has more than they do. A non-zero balance below the
 * threshold renders as "<0.000001" rather than "0", because displaying real
 * funds as zero is a correctness failure, not a cosmetic one.
 *
 * When `decimals` is null the amount cannot be scaled, so raw base units are
 * returned with `unscaled` set; callers must label that clearly in the UI.
 */
export function formatTokenAmount(raw: bigint, decimals: number | null): FormattedAmount {
  if (raw < 0n) throw new RangeError('token amount cannot be negative');

  const digits = raw.toString();

  if (decimals === null) {
    return {
      display: group(digits),
      exact: digits,
      truncated: false,
      dust: false,
      unscaled: true,
    };
  }

  if (decimals === 0) {
    return {
      display: group(digits),
      exact: digits,
      truncated: false,
      dust: false,
      unscaled: false,
    };
  }

  // Left-pad so there is always at least one integer digit to slice off.
  const padded = digits.padStart(decimals + 1, '0');
  const intPart = padded.slice(0, padded.length - decimals);
  const fracPart = padded.slice(padded.length - decimals);

  const exactFrac = fracPart.replace(/0+$/, '');
  const exact = exactFrac === '' ? intPart : `${intPart}.${exactFrac}`;

  const shownFrac = fracPart.slice(0, DISPLAY_DECIMALS).replace(/0+$/, '');
  const hiddenFrac = fracPart.slice(DISPLAY_DECIMALS).replace(/0+$/, '');
  const truncated = hiddenFrac !== '';

  // Non-zero, but everything visible would render as plain "0".
  if (intPart.replace(/^0+/, '') === '' && shownFrac === '' && raw > 0n) {
    return {
      display: `<0.${'0'.repeat(DISPLAY_DECIMALS - 1)}1`,
      exact,
      truncated: true,
      dust: true,
      unscaled: false,
    };
  }

  const display = shownFrac === '' ? group(intPart) : `${group(intPart)}.${shownFrac}`;
  return { display, exact, truncated, dust: false, unscaled: false };
}

/**
 * Convenience wrapper: format a raw storage value straight from the node.
 * Returns null when the value is not a usable u128.
 */
export function formatStorageAmount(
  rawValue: unknown,
  decimals: number | null,
): FormattedAmount | null {
  const raw = parseU128(rawValue);
  return raw === null ? null : formatTokenAmount(raw, decimals);
}

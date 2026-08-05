/**
 * JSON encoding for contract-call arguments.
 *
 * `JSON.stringify` cannot serialize a BigInt — it throws — and `Number` cannot
 * represent a u128 without loss. Contract amounts are u128, so neither works on
 * its own: a mainnet token exists with a supply of 1e27, which `Number` rounds
 * to 1000000000000000013287555072.
 *
 * This encoder emits bigints as bare JSON integer literals (the exact form the
 * node uses on-chain: `["oct…",2500000]`) while delegating every other value to
 * `JSON.stringify`. For argument lists that contain no bigint the output is
 * byte-identical to `JSON.stringify(args)`, so existing signatures are
 * unaffected — `tests/unit/call-format-interop.test.ts` pins that.
 */

/** Inclusive upper bound of a u128, mirroring MAX_U128 in the reference AML. */
const U128_MAX = 340282366920938463463374607431768211455n;

/**
 * Serialize one argument.
 *
 * Bigints become bare digits. `undefined`, functions and symbols become `null`,
 * matching how `JSON.stringify` treats them inside an array.
 */
function encodeArg(value: unknown): string {
  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw new RangeError('contract argument out of range: negative values are not u128');
    }
    if (value > U128_MAX) {
      throw new RangeError('contract argument out of range: exceeds u128');
    }
    return value.toString();
  }

  if (typeof value === 'number' && !Number.isFinite(value)) {
    // JSON.stringify turns these into null, which would silently become a
    // different argument than intended.
    throw new RangeError('contract argument must be finite');
  }

  if (typeof value === 'number' && !Number.isSafeInteger(value) && Number.isInteger(value)) {
    // An integer beyond 2^53 has already lost precision before reaching us.
    throw new RangeError(
      'contract argument exceeds safe integer precision — pass a bigint instead',
    );
  }

  const encoded = JSON.stringify(value);
  // JSON.stringify returns undefined for undefined/function/symbol.
  return encoded === undefined ? 'null' : encoded;
}

/**
 * Encode a contract-call argument list as a JSON array string.
 *
 * Byte-identical to `JSON.stringify(args)` whenever no argument is a bigint.
 */
export function encodeCallArgs(args: readonly unknown[]): string {
  return `[${args.map(encodeArg).join(',')}]`;
}

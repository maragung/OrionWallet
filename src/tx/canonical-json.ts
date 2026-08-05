/**
 * Canonical JSON serialization (byte-exact match with nlohmann::json::dump()).
 * Ported from lib/tx_builder.hpp (canonical_json function).
 *
 * CRITICAL: This must produce byte-identical output to nlohmann::json's
 * `j.dump()` (no pretty-print, default float precision, UTF-8 escape rules).
 * Ed25519 signatures in Octra are computed over this exact byte sequence,
 * so any deviation invalidates the signature.
 *
 * nlohmann::json serialization rules:
 *   1. Object keys are emitted in insertion order (NOT sorted).
 *      However, Octra's tx_builder builds the JSON object in a specific
 *      field order, so we must emit in the SAME order.
 *   2. Strings: ASCII printable (0x20-0x7E) as-is, except `"` and `\` which
 *      are escaped. Control chars (< 0x20) use standard escape sequences
 *      (\n, \r, \t, \b, \f) or \u00XX for others. UTF-8 multi-byte sequences
 *      are emitted as-is (NOT \u-escaped) by default.
 *   3. Numbers:
 *      - Integers: as-is (no decimal point, no exponent).
 *      - Floats: nlohmann uses the "shortest round-trip" representation
 *        (via Ryu or Grisu). For Octra amounts, which are stored as
 *        strings in canonical_json, this only matters for nonce/timestamp
 *        fields that might be encoded as integers.
 *      - **Special**: integer-valued doubles are emitted WITHOUT trailing
 *        ".0" (e.g., 1000.0 → "1000"). This matches nlohmann behavior.
 *   4. Booleans: `true` / `false` (lowercase).
 *   5. null: `null`.
 *   6. Arrays: comma-separated, no spaces.
 *   7. Objects: comma-separated `"key":value` pairs, no spaces.
 *   8. No whitespace anywhere (no pretty-print).
 *
 * Octra's canonical_json actually normalizes a few things:
 *   - All values are emitted in the field order defined by the Transaction
 *     struct (from, to, amount, nonce, ou, timestamp, op_type, ...).
 *   - Strings that look like numbers stay as strings (amount is a string).
 *   - The `signature` and `hash` fields are excluded from canonical form
 *     (they are computed FROM the canonical form, so cannot be part of it).
 */

import { sha256 } from '../crypto/sha256';
import { hexEncode } from '../crypto/hex';

/**
 * Wrapper marking a number that must be serialized as an OCaml/Yojson `Float`.
 * The Octra node stores `timestamp` as a float and re-serializes it via Yojson
 * for signature verification, which ALWAYS appends ".0" to integer-valued
 * floats (e.g. 1700000000 -> "1700000000.0"). Emitting a bare integer here
 * produces different signing bytes and an "invalid signature" rejection.
 */
export class CanonicalFloat {
  constructor(public readonly value: number) {}
}

/** JSON value type for canonical serialization. */
export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalFloat
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

/** Ordered key-value object (preserves insertion order even for numeric-like keys). */
export type CanonicalObject = Array<[string, CanonicalValue]>;

/** Escape a string per nlohmann::json rules. */
function escapeString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22)
      out += '\\"'; // "
    else if (c === 0x5c)
      out += '\\\\'; // backslash
    else if (c === 0x08) out += '\\b';
    else if (c === 0x0c) out += '\\f';
    else if (c === 0x0a) out += '\\n';
    else if (c === 0x0d) out += '\\r';
    else if (c === 0x09) out += '\\t';
    else if (c < 0x20) {
      // Control char: \u00XX
      out += '\\u' + c.toString(16).padStart(4, '0');
    } else {
      // Printable ASCII or UTF-8 multi-byte: emit as-is
      out += s[i]!;
    }
  }
  out += '"';
  return out;
}

/** Format a number per nlohmann::json rules. */
function formatNumber(n: number): string {
  if (Number.isNaN(n)) return 'null'; // nlohmann emits null for NaN
  if (!Number.isFinite(n)) return 'null'; // nlohmann emits null for infinity
  if (Number.isInteger(n)) return n.toString();
  // Float: shortest round-trip representation.
  // JS Number.toString() already produces shortest round-trip (IEEE 754)
  // per ECMAScript spec. This matches nlohmann's default behavior.
  // However, nlohmann emits integer-valued doubles as integers (no ".0").
  // We already handled that case above via Number.isInteger.
  return n.toString();
}

/**
 * Format a number as an OCaml/Yojson `Float` value.
 * Yojson always appends ".0" for integer-valued floats (e.g. 1700000000.0),
 * and uses shortest round-trip for fractional values.
 * This is used for the `timestamp` field, which the node stores as `float`
 * and re-serializes via Yojson for signature verification.
 */
function formatFloat(n: number): string {
  if (Number.isNaN(n) || !Number.isFinite(n)) return 'null';
  if (Number.isInteger(n)) return n.toString() + '.0';
  return n.toString();
}

/** Serialize a CanonicalValue to its canonical byte-exact string. */
export function canonicalSerialize(value: CanonicalValue): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof CanonicalFloat) return formatFloat(value.value);
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'string') return escapeString(value);
  if (Array.isArray(value)) {
    let out = '[';
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out += ',';
      out += canonicalSerialize(value[i]!);
    }
    out += ']';
    return out;
  }
  // Object — emit as {key:value,...}
  // Note: we accept both plain objects and ordered [k,v] arrays.
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string') {
    // Already handled above; this is a single pair array (unlikely path)
  }
  let out = '{';
  let first = true;
  for (const [k, v] of Object.entries(value)) {
    if (!first) out += ',';
    first = false;
    out += escapeString(k) + ':' + canonicalSerialize(v);
  }
  out += '}';
  return out;
}

/** Serialize a CanonicalObject (ordered key-value array) preserving insertion order. */
export function canonicalSerializeOrdered(entries: CanonicalObject): string {
  let out = '{';
  for (let i = 0; i < entries.length; i++) {
    if (i > 0) out += ',';
    out += escapeString(entries[i]![0]) + ':' + canonicalSerialize(entries[i]![1]);
  }
  out += '}';
  return out;
}

/** UTF-8 encode the canonical JSON to bytes (for signing). */
export function canonicalBytes(value: CanonicalValue): Uint8Array {
  return new TextEncoder().encode(canonicalSerialize(value));
}

/** UTF-8 encode an ordered canonical object to bytes. */
export function canonicalBytesOrdered(entries: CanonicalObject): Uint8Array {
  return new TextEncoder().encode(canonicalSerializeOrdered(entries));
}

/**
 * Build the canonical JSON for an Octra transaction, matching the C++
 * tx_builder.hpp canonical_json() output exactly.
 *
 * Field order (per tx_builder.hpp):
 *   from, to, amount, nonce, ou, timestamp, op_type, [op-specific fields...]
 *
 * Fields EXCLUDED from canonical form (computed from it):
 *   signature, hash, public_key
 */
export interface TransactionFields {
  from: string;
  to: string; // internal field name; serialized as "to_" in canonical/wire format
  amount: string; // raw integer as string (1 OCT = 1_000_000)
  nonce: number;
  ou: string; // fee as string
  timestamp: number;
  op_type: string;
  message?: string;
  encrypted_data?: string; // JSON-stringified payload (already a string)
  // Allow arbitrary extra fields (op-specific)
  [key: string]: CanonicalValue | undefined;
}

/** Build canonical JSON for a transaction (excluding signature/hash/public_key). */
export function canonicalJsonForTx(tx: TransactionFields): Uint8Array {
  const entries: CanonicalObject = [
    ['from', tx.from],
    ['to_', tx.to], // node expects "to_" (trailing underscore) per transaction.ml
    ['amount', tx.amount],
    ['nonce', tx.nonce],
    ['ou', tx.ou],
    // Node stores timestamp as float; Yojson emits integer-valued floats
    // with a ".0" suffix. Must match exactly or the signature is rejected.
    ['timestamp', new CanonicalFloat(tx.timestamp)],
    ['op_type', tx.op_type],
  ];
  // Append op-specific fields in the EXACT order used by the node's
  // serialize_for_signing (lib/core/transaction.ml):
  //   base... then encrypted_data (if present), then message (if present).
  if (tx.encrypted_data !== undefined && tx.encrypted_data !== '') {
    // encrypted_data is itself a JSON string; it is emitted as a STRING
    // in the canonical form (not nested object).
    entries.push(['encrypted_data', tx.encrypted_data]);
  }
  if (tx.message !== undefined && tx.message !== '') {
    entries.push(['message', tx.message]);
  }
  // Additional fields beyond the standard ones (preserve insertion order).
  const knownKeys = new Set([
    'from',
    'to', // internal name; serialized above as "to_"
    'amount',
    'nonce',
    'ou',
    'timestamp',
    'op_type',
    'message',
    'encrypted_data',
    // Excluded from canonical form (computed FROM it):
    'signature',
    'hash',
    'public_key',
  ]);
  for (const [k, v] of Object.entries(tx)) {
    if (knownKeys.has(k)) continue;
    if (v === undefined) continue;
    entries.push([k, v]);
  }
  return canonicalBytesOrdered(entries);
}

/**
 * Compute the transaction hash (tx_hash in C++).
 * Format: sha256(canonical_json) → hex string.
 */
export function computeTxHash(tx: TransactionFields): string {
  const canon = canonicalJsonForTx(tx);
  return hexEncode(sha256(canon));
}

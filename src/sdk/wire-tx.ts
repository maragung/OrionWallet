/**
 * Turn a wallet-signed transaction into the JSON the Octra node accepts.
 *
 * This lives in the SDK because it is the other half of "the wallet never
 * broadcasts". Sign-only means the dApp submits, and submitting requires knowing
 * three things that are not guessable from the signed object it was handed:
 *
 *   1. the recipient field is named `to_` on the wire, with a trailing
 *      underscore. The node's `of_yojson` requires it and rejects `to` outright
 *      as "Malformed JSON" — the least informative possible answer to a
 *      one-character naming difference.
 *   2. `hash` is local bookkeeping and is not part of the wire format.
 *   3. key order is fixed by the node's `Transaction.to_yojson`.
 *
 * Leaving that knowledge inside the wallet meant every integrator rediscovered
 * it from a rejected submit. It is pure data reshaping with no dependencies, so
 * there is no reason for it to be wallet-only — `src/tx/builder.ts` now calls
 * through here too, so the wallet and every dApp share one implementation rather
 * than two that can drift.
 *
 * Nothing here signs, validates, or contacts anything: the signature was
 * produced over the canonical signing JSON (see `src/tx/canonical-json.ts`), and
 * this only renames and orders fields the signature already covers. Mutating any
 * *value* after signing invalidates it — `op_type` included, which is why the
 * wallet exposes `wallet_signTransfer` instead of letting callers rewrite it.
 */

/** The subset of a signed transaction the node's submit endpoint reads. */
export interface SignedTxLike {
  from: string;
  /** Recipient as the wallet returns it. Emitted as `to_`. */
  to: string;
  amount: string;
  nonce: number;
  ou: string;
  timestamp: number;
  op_type: string;
  signature: string;
  public_key: string;
  message?: string;
  encrypted_data?: string;
  /** Local-only; deliberately dropped from the wire payload. */
  hash?: string;
  [extra: string]: unknown;
}

/**
 * Field names this module places itself. Anything else on the object is passed
 * through unchanged and appended, so a future node field works without a
 * release here — the alternative, silently dropping unknown keys, would strip a
 * field the signature covers and produce an invalid submit.
 */
const PLACED_KEYS: ReadonlySet<string> = new Set([
  'from',
  'to',
  'to_',
  'amount',
  'nonce',
  'ou',
  'timestamp',
  'op_type',
  'signature',
  'hash',
  'public_key',
  'message',
  'encrypted_data',
]);

/**
 * Wire-format object for `octra_submit` / the node's submit endpoint.
 *
 * Matches the node's `Transaction.to_yojson` (lib/core/transaction.ml):
 *   from, to_, amount, nonce, ou, timestamp, signature, op_type,
 *   [public_key], [message], [encrypted_data]
 */
export function toNodeWireTx(tx: SignedTxLike): Record<string, unknown> {
  // A `to_` already on the input wins over `to`: a caller that has done the
  // rename itself must not get its value silently replaced by an absent one.
  const recipient = typeof tx.to_ === 'string' ? tx.to_ : tx.to;
  const ordered: Array<[string, unknown]> = [
    ['from', tx.from],
    ['to_', recipient],
    ['amount', tx.amount],
    ['nonce', tx.nonce],
    ['ou', tx.ou],
    ['timestamp', tx.timestamp],
    ['signature', tx.signature],
    ['op_type', tx.op_type],
    ['public_key', tx.public_key],
  ];
  if (tx.message) ordered.push(['message', tx.message]);
  if (tx.encrypted_data) ordered.push(['encrypted_data', tx.encrypted_data]);
  for (const [k, v] of Object.entries(tx)) {
    if (PLACED_KEYS.has(k)) continue;
    ordered.push([k, v]);
  }
  const obj: Record<string, unknown> = {};
  for (const [k, v] of ordered) obj[k] = v;
  return obj;
}

/** `toNodeWireTx` as a JSON string, for transports that want the raw body. */
export function buildNodeWireJson(tx: SignedTxLike): string {
  return JSON.stringify(toNodeWireTx(tx));
}

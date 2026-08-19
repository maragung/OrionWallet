/**
 * Octra transaction types and builder.
 * Ported from lib/tx_builder.hpp (Transaction struct, sign_transaction, build_tx_json).
 */
import { sign, verify } from '../crypto/ed25519';
import { base64Decode, base64Encode } from '../crypto/base64';
import { hexEncode } from '../crypto/hex';
import { sha256 } from '../crypto/sha256';
import { canonicalJsonForTx, computeTxHash, type TransactionFields } from './canonical-json';
import { buildNodeWireJson, type SignedTxLike } from '../sdk/wire-tx';

/** Operation types supported by Octra. */
export type OpType =
  | 'standard'
  | 'encrypt'
  | 'decrypt'
  | 'stealth'
  | 'key_switch'
  | 'program_deploy'
  | 'program_call'
  | 'call'
  | 'circle_deploy'
  | 'circle_update'
  | 'circle_asset_put'
  | 'circle_relay'
  | 'register_pvac';

/** A complete Octra transaction with signature. */
export interface Transaction extends TransactionFields {
  /** Base64-encoded Ed25519 signature over the canonical signing JSON. */
  signature: string;
  /** Hex-encoded SHA-256 of the canonical signing JSON (the tx hash). */
  hash: string;
  /** Base64-encoded Ed25519 public key of the sender. */
  public_key: string;
}

/** Signing inputs (everything needed to produce a signed transaction). */
export interface SignTxInputs {
  /** Sender Ed25519 secret key (64 bytes = seed||pub). */
  secretKey: Uint8Array;
  /** Sender Ed25519 public key (32 bytes), base64-encoded. */
  publicKeyB64: string;
  /** Transaction fields (without signature/hash/public_key). */
  fields: TransactionFields;
}

/** Sign a transaction.
 * Produces the canonical JSON, signs with Ed25519, and returns the full
 * signed transaction (with signature, hash, and public_key populated).
 */
export function signTransaction(inputs: SignTxInputs): Transaction {
  const canon = canonicalJsonForTx(inputs.fields);
  const sig = sign(canon, inputs.secretKey);
  const hash = hexEncode(sha256(canon));
  return {
    ...inputs.fields,
    // Node verifies via Base64.decode_exn(tx.signature) — must be base64, not hex.
    signature: base64Encode(sig),
    hash,
    public_key: inputs.publicKeyB64,
  };
}

/** Verify a transaction signature. */
export function verifyTransaction(tx: Transaction): boolean {
  try {
    const pub = base64Decode(tx.public_key);
    if (pub.length !== 32) return false;
    const sig = base64Decode(tx.signature);
    if (sig.length !== 64) return false;
    const canon = canonicalJsonForTx(tx);
    return verify(canon, sig, pub);
  } catch {
    return false;
  }
}

/**
 * Build the JSON payload to submit to the RPC node (full signed tx as JSON).
 *
 * The field naming and ordering rules live in `src/sdk/wire-tx.ts`, not here:
 * every dApp that submits a wallet-signed transaction needs exactly the same
 * transformation, and it was previously reachable only from inside the wallet.
 * One implementation, shared — this wrapper keeps the existing call sites.
 */
export function buildTxJson(tx: Transaction): string {
  return buildNodeWireJson(tx as SignedTxLike);
}

/**
 * Compute the recommended OU (fee) for a given operation type and amount.
 * Ported from main.cpp parse_ou / recommended_ou_for_op.
 *
 * The Octra devnet RPC returns fee schedule with "recommended" and "fast" values.
 * For simplicity, we use hardcoded defaults that match typical Octra fees:
 *   standard:   10000 raw (0.01 OCT)
 *   encrypt:    1000000 raw (1 OCT)
 *   stealth:    1000000 raw (1 OCT)
 *   program_deploy: 5000000 raw (5 OCT)
 *   program_call:   100000 raw (0.1 OCT)
 *   call:           2000 raw (0.002 OCT)
 *
 * `call` is priced off the node's own schedule: devnet reports
 * recommended=1000 / fast=2000 for this op. We default to the `fast` tier so a
 * call lands promptly without the 50x overpay that the `program_call` default
 * would impose.
 *
 * These can be overridden by the user in the Send form.
 */
export function recommendedOu(opType: string, amountRaw: number | bigint): string {
  const amt = typeof amountRaw === 'bigint' ? amountRaw : BigInt(amountRaw);
  switch (opType) {
    case 'standard':
      return amt < 1_000_000_000n ? '10000' : '30000';
    case 'encrypt':
    case 'decrypt':
    case 'stealth':
    case 'key_switch':
      return '1000000';
    case 'program_deploy':
    case 'circle_deploy':
      return '5000000';
    case 'call':
      return '2000';
    case 'program_call':
    case 'register_pvac':
      return '100000';
    case 'circle_update':
    case 'circle_relay':
      return '1000000';
    case 'circle_asset_put':
      return '500000';
    default:
      return '10000';
  }
}

/** Parse a human-readable amount (e.g., "1.5") into raw integer string. */
export function parseAmountRaw(amount: string | number): string {
  if (typeof amount === 'number') {
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error(`parseAmountRaw: invalid amount ${amount}`);
    }
    // Convert to raw integer (6 decimals)
    const raw = Math.round(amount * 1_000_000);
    return raw.toString();
  }
  const s = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(`parseAmountRaw: invalid amount string '${amount}'`);
  }
  const [whole, frac = ''] = s.split('.');
  const fracPadded = (frac + '000000').slice(0, 6);
  const raw = BigInt(whole!) * 1_000_000n + BigInt(fracPadded || '0');
  return raw.toString();
}

/** Format a raw amount string as a human-readable OCT string.
 *
 * Handles two formats:
 *   - Raw integer string (e.g., "1500000") → "1.5"
 *   - Decimal OCT string (e.g., "94.231308") → "94.231308" (passed through)
 *
 * Defensive by design: this runs inside table render paths, where a throw
 * unmounts the whole React tree and blanks the app. Node responses and the
 * local tx cache are not schema-validated, so `raw` may be a number, null, or
 * a non-numeric string. Any unparseable input degrades to a placeholder
 * instead of throwing.
 */
export function formatAmount(raw: unknown): string {
  if (raw === null || raw === undefined) return '0';

  // Accept numbers/bigints as well as strings — the node has been observed to
  // serialize amounts as JSON numbers in some responses.
  const rawStr = typeof raw === 'string' ? raw : String(raw);
  const trimmed = rawStr.trim();
  if (trimmed === '' || trimmed === '0') return '0';

  // If the string contains a decimal point, it's already in OCT format
  if (trimmed.includes('.')) return trimmed;

  // Otherwise, it's a raw integer — convert to OCT (1 OCT = 1,000,000 raw)
  try {
    const value = BigInt(trimmed);
    const negative = value < 0n;
    const abs = negative ? -value : value;
    const whole = abs / 1_000_000n;
    const frac = abs % 1_000_000n;
    const sign = negative ? '-' : '';
    if (frac === 0n) return `${sign}${whole}`;
    return `${sign}${whole}.${frac.toString().padStart(6, '0').replace(/0+$/, '')}`;
  } catch {
    // Not a valid integer literal (e.g. "abc", "1e6", "0x1f") — show it raw
    // rather than crashing the panel.
    return trimmed;
  }
}

/** Compute current timestamp in seconds since Unix epoch (matches C++ now_ts). */
export function nowTs(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Sign an encrypted-balance read request.
 * Mirrors octra::sign_balance_request (lib/tx_builder.hpp):
 *   msg = "octra_encryptedBalance|" + addr
 */
export function signBalanceRequest(addr: string, secretKey: Uint8Array): string {
  const msg = new TextEncoder().encode(`octra_encryptedBalance|${addr}`);
  return base64Encode(sign(msg, secretKey));
}

/**
 * Sign a PVAC pubkey registration request.
 * Mirrors octra::sign_register_request (lib/tx_builder.hpp):
 *   msg = "register_pvac|" + addr + "|" + sha256_hex(pk_blob)
 * where pk_blob is the RAW serialized PVAC pubkey bytes.
 */
export function signRegisterRequest(
  addr: string,
  pkBlob: Uint8Array,
  secretKey: Uint8Array,
): string {
  const pkHash = hexEncode(sha256(pkBlob));
  const msg = new TextEncoder().encode(`register_pvac|${addr}|${pkHash}`);
  return base64Encode(sign(msg, secretKey));
}

export { canonicalJsonForTx, computeTxHash };
export type { TransactionFields };

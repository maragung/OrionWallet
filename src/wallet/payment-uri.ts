/**
 * The payment URI the Receive screen puts in its QR code, and the parser the
 * scanner uses to read one back.
 *
 * Format (mirrors what ReceiveView encodes):
 *   octra:<address>[?amount=<OCT>]
 * A bare address is also accepted — plenty of wallets and explorers hand out
 * addresses with no scheme at all.
 */
import { isValidAddress } from '../crypto/address';

export interface PaymentTarget {
  addr: string;
  /** Amount in OCT exactly as written in the URI, when it carried one. */
  amount?: string;
}

const SCHEME = /^octra:(\/\/)?/i;

/** Build `octra:<addr>` (plus `?amount=` when given). */
export function buildPaymentUri(addr: string, amount?: string): string {
  const amt = amount?.trim();
  return amt ? `octra:${addr}?amount=${encodeURIComponent(amt)}` : `octra:${addr}`;
}

/**
 * Parse a scanned or pasted payment target. Returns null for anything that is
 * not a valid Octra address, so a caller can treat null as "not a payment code"
 * rather than having to validate again.
 */
export function parsePaymentUri(text: string | null | undefined): PaymentTarget | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  const withoutScheme = trimmed.replace(SCHEME, '');
  const [addrPart = '', queryPart = ''] = withoutScheme.split('?', 2);
  // Addresses are base58, so case is significant — never normalise it.
  const addr = addrPart.trim();
  if (!isValidAddress(addr)) return null;

  if (!queryPart) return { addr };
  let amount: string | undefined;
  try {
    const raw = new URLSearchParams(queryPart).get('amount');
    // Ignore a malformed amount rather than rejecting the whole code: the
    // address is the part that matters, and the user can retype the number.
    if (raw && /^\d+(\.\d+)?$/.test(raw.trim())) amount = raw.trim();
  } catch {
    /* ignore an unparseable query string */
  }
  return amount ? { addr, amount } : { addr };
}

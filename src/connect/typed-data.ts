/**
 * Octra-native, domain-separated signing encoders (wallet side).
 *
 * Every DEFAULT scheme below is prefixed with a UNIQUE domain tag before
 * hashing, so a signature produced for one purpose can never be replayed as
 * another — and critically, none of them can collide with a transaction
 * signature. A signed Octra transaction is Ed25519 over canonical JSON that
 * begins with `{"from":...`; the tags here begin with `octra-*:` ASCII, so the
 * signed byte strings are structurally disjoint from any transaction.
 *
 * EXCEPTION: `signPlainMessage` accepts an opt-in `scheme: 'raw'` that signs
 * SHA-256(message) with NO domain tag, for interop with external verifiers.
 * It remains disjoint from transaction signing only because a transaction is
 * signed over its full canonical JSON bytes (always far longer than the
 * 32-byte digest signed here), never over a hash. Callers must opt in
 * explicitly; the default stays `'domain'`.
 *
 * IMPORTANT: These produce SIGNATURES ONLY. `signContract` builds a signed
 * transaction object but DOES NOT submit it — broadcasting happens only inside
 * the wallet UI, never through the SDK.
 */
import { sign } from '../crypto/ed25519';
import { sha256 } from '../crypto/sha256';
import { hexEncode } from '../crypto/hex';
import { base64Encode } from '../crypto/base64';
import { canonicalSerializeOrdered, type CanonicalObject } from '../tx/canonical-json';
import {
  signTransaction,
  nowTs,
  recommendedOu,
  parseAmountRaw,
  type Transaction,
  type TransactionFields,
} from '../tx/builder';
import { encodeCallArgs } from '../tx/call-args';
import { isValidAddress } from '../crypto/address';
import type { Wallet } from '../wallet/wallet';

const MSG_TAG = 'octra-signed-message:v1\n';
const TYPED_TAG = 'octra-typed-data:v1|';
const APPROVE_TAG = 'octra-contract-approval:v1|';

export interface SignMessageParams {
  message: string;
  scheme?: 'raw' | 'domain';
}

/**
 * Sign a plain UTF-8 message with configurable domain separation.
 *
 * `scheme: 'domain'` (default) signs SHA-256(TAG + len + message), ensuring
 * the signature can never be replayed as a transaction or other typed data.
 *
 * `scheme: 'raw'` signs SHA-256(message) directly, for compatibility with
 * external systems that expect untagged message signing.
 */
export function signPlainMessage(
  wallet: Wallet,
  params: SignMessageParams,
): { address: string; publicKey: string; message: string; signature: string; scheme: string } {
  const { message, scheme = 'domain' } = params;
  const digest =
    scheme === 'raw'
      ? sha256(new TextEncoder().encode(message))
      : sha256(new TextEncoder().encode(`${MSG_TAG}${message.length}\n${message}`));
  const sig = sign(digest, wallet.sk);
  return {
    address: wallet.addr,
    publicKey: wallet.pubB64,
    message,
    signature: base64Encode(sig),
    scheme: scheme === 'raw' ? 'octra-ed25519-sha256-raw/v1' : 'octra-ed25519-sha256/v1',
  };
}

export interface TypedData {
  domain: { name: string; version: string; chainId?: string };
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

/** Deterministically encode typed data into an ordered canonical object. */
function encodeTypedData(td: TypedData): string {
  const domain: CanonicalObject = [
    ['name', td.domain.name],
    ['version', td.domain.version],
  ];
  if (td.domain.chainId !== undefined) domain.push(['chainId', td.domain.chainId]);

  // Encode the message following the field order declared in `types` for the
  // primaryType, so serialization is stable regardless of JS object order.
  const fields = td.types[td.primaryType];
  if (!fields) throw new Error(`typed data: unknown primaryType "${td.primaryType}"`);
  const msg: CanonicalObject = fields.map((f) => {
    const v = td.message[f.name];
    return [f.name, (v ?? null) as never];
  });

  const root: CanonicalObject = [
    ['domain', domainToValue(domain)],
    ['primaryType', td.primaryType],
    ['message', objToValue(msg)],
  ];
  return canonicalSerializeOrdered(root);
}

// Helpers to embed ordered objects inside a CanonicalObject value slot.
function domainToValue(entries: CanonicalObject): Record<string, never> {
  return Object.fromEntries(entries) as Record<string, never>;
}
function objToValue(entries: CanonicalObject): Record<string, never> {
  return Object.fromEntries(entries) as Record<string, never>;
}

/** Sign typed data: Ed25519 over SHA-256(TAG + canonicalJSON). */
export function signTypedDataOctra(
  wallet: Wallet,
  td: TypedData,
): { address: string; publicKey: string; signature: string; hash: string; scheme: string } {
  const canonical = encodeTypedData(td);
  const digestInput = new TextEncoder().encode(TYPED_TAG + canonical);
  const digest = sha256(digestInput);
  const sig = sign(digest, wallet.sk);
  return {
    address: wallet.addr,
    publicKey: wallet.pubB64,
    signature: base64Encode(sig),
    hash: hexEncode(digest),
    scheme: 'octra-ed25519-sha256/v1',
  };
}

export interface ApproveContractParams {
  program: string;
  method: string;
  spender?: string;
  args?: unknown[];
  limit?: string;
  expiry?: number;
}

/**
 * Sign a contract-approval intent. Produces a signed, human-auditable approval
 * object the dApp can later submit THROUGH THE WALLET. Never broadcast here.
 */
export function signContractApproval(
  wallet: Wallet,
  params: ApproveContractParams,
): Record<string, unknown> {
  const approval: CanonicalObject = [
    ['program', params.program],
    ['method', params.method],
    ['spender', params.spender ?? ''],
    ['args', (params.args ?? []) as never],
    ['limit', params.limit ?? ''],
    ['expiry', params.expiry ?? 0],
    ['owner', wallet.addr],
  ];
  const canonical = canonicalSerializeOrdered(approval);
  const digest = sha256(new TextEncoder().encode(APPROVE_TAG + canonical));
  const sig = sign(digest, wallet.sk);
  return {
    type: 'octra-contract-approval',
    version: 1,
    program: params.program,
    method: params.method,
    spender: params.spender ?? null,
    args: params.args ?? [],
    limit: params.limit ?? null,
    expiry: params.expiry ?? null,
    owner: wallet.addr,
    publicKey: wallet.pubB64,
    hash: hexEncode(digest),
    signature: base64Encode(sig),
    scheme: 'octra-ed25519-sha256/v1',
  };
}

export interface SignContractParams {
  program: string;
  method: string;
  args?: unknown[];
  amount?: string;
  ou?: string;
  nonce: number;
  opType?: 'call' | 'program_call';
}

/**
 * Build and sign a contract-call transaction. Returns the SIGNED transaction
 * object for the dApp to inspect/submit through the wallet UI — this function
 * does not touch the network.
 *
 * `opType` selects the on-chain operation label AND the payload encoding, which
 * are NOT interchangeable — the Octra VM parses each differently:
 *
 *   - `program_call` (default): the whole invocation is one JSON blob in
 *     `encrypted_data` → `{"program":…,"method":…,"args":[…]}`.
 *
 *   - `call`: the VM reads the method name from `encrypted_data` as a bare
 *     string and the argument list from `message` as JSON. Packing the nested
 *     blob into `encrypted_data` here would make the node read the method name
 *     as `{"program":...` and revert.
 *
 * Because the Ed25519 signature covers the canonical JSON, the payload MUST be
 * shaped correctly BEFORE signing; a dApp cannot repair it afterwards without
 * invalidating the signature.
 */
export function signContractCall(
  wallet: Wallet,
  params: SignContractParams,
): { tx: Transaction; program: string; method: string; opType: 'call' | 'program_call' } {
  const opType = params.opType ?? 'program_call';
  const args = params.args ?? [];
  // Args are encoded with encodeCallArgs rather than JSON.stringify so that
  // u128 amounts can be passed as bigint: JSON.stringify throws on a BigInt,
  // and Number silently corrupts values above 2^53. Output is byte-identical
  // to JSON.stringify for argument lists containing no bigint.
  const encodedArgs = encodeCallArgs(args);
  // Payload encoding is dictated by opType — see the doc comment above.
  const payload =
    opType === 'call'
      ? { encrypted_data: params.method, message: encodedArgs }
      : {
          encrypted_data:
            `{"program":${JSON.stringify(params.program)},` +
            `"method":${JSON.stringify(params.method)},` +
            `"args":${encodedArgs}}`,
        };
  const tx = signTransaction({
    secretKey: wallet.sk,
    publicKeyB64: wallet.pubB64,
    fields: {
      from: wallet.addr,
      to: params.program,
      amount: params.amount ?? '0',
      nonce: params.nonce,
      ou: params.ou ?? recommendedOu(opType, 0n),
      timestamp: nowTs(),
      op_type: opType,
      ...payload,
    },
  });
  return { tx, program: params.program, method: params.method, opType };
}

export interface SignTransferParams {
  /** Recipient address (`oct…`). Validated before anything is signed. */
  to: string;
  /**
   * Amount to send. A decimal OCT string ("1.5") or a number is converted with
   * `parseAmountRaw`; pass `amountRaw` instead to give the integer directly.
   */
  amount?: string | number;
  /** Amount in raw base units, as an integer string. Wins over `amount`. */
  amountRaw?: string;
  /** Fee. Defaults to the recommended OU for a standard transfer of this size. */
  ou?: string;
  /** Sender nonce. The caller fetches it so the approval shows what is signed. */
  nonce: number;
  /** Optional public memo, carried in the tx `message` field. */
  message?: string;
}

/**
 * Build and sign a plain native-token transfer (`op_type: 'standard'`).
 *
 * SIGNS ONLY — nothing is submitted here. The transfer is built the same way
 * `api/send.ts` builds it, so a transaction signed through the SDK and one sent
 * from the wallet UI are byte-identical apart from the values the caller chose.
 *
 * This exists so a dApp never has to disguise a transfer as a contract call.
 * `op_type` is part of the canonical JSON that gets signed, so a caller that
 * signs a `call` and then rewrites `op_type` to `standard` ends up with a
 * transaction whose signature no longer verifies — and, worse, the user
 * approved a prompt describing a contract call they never made.
 */
/**
 * Resolve a transfer request into the exact numbers that will be signed, without
 * signing anything.
 *
 * The approval prompt and the signature MUST agree on every field, so both go
 * through this: the UI renders what it returns, and `signNativeTransfer` signs
 * what it returns. Computing the fee twice — once for the prompt and once for the
 * signature — is how a user ends up approving one fee and signing another.
 *
 * `from` is optional so a caller that only wants to validate a request (before
 * an account is chosen) can still do so; pass it to also reject a self-send.
 */
export function previewTransfer(
  params: Omit<SignTransferParams, 'nonce'>,
  from?: string,
): { to: string; amountRaw: string; ou: string } {
  if (!isValidAddress(params.to)) {
    throw new Error(`signTransfer: invalid recipient address "${params.to}"`);
  }
  // Matches the wallet UI's own refusal: a standard transfer to self is not a
  // no-op on Octra, it is rejected by the node, so catch it before signing.
  if (from !== undefined && params.to === from) {
    throw new Error('signTransfer: cannot send to your own address with a standard transfer');
  }
  const amountRaw = resolveAmountRaw(params);
  const raw = BigInt(amountRaw);
  if (raw <= 0n) throw new Error('signTransfer: amount must be positive');
  const ou = params.ou ?? recommendedOu('standard', raw);
  if (!/^\d+(\.\d+)?$/.test(ou)) {
    throw new Error(`signTransfer: fee (ou) must be a positive number, got "${ou}"`);
  }
  return { to: params.to, amountRaw, ou };
}

/**
 * Build and sign a plain native-token transfer (`op_type: 'standard'`).
 *
 * SIGNS ONLY — nothing is submitted here. The transfer is built the same way
 * `api/send.ts` builds it, so a transaction signed through the SDK and one sent
 * from the wallet UI are byte-identical apart from the values the caller chose.
 *
 * This exists so a dApp never has to disguise a transfer as a contract call.
 * `op_type` is part of the canonical JSON that gets signed, so a caller that
 * signs a `call` and then rewrites `op_type` to `standard` ends up with a
 * transaction whose signature no longer verifies — and, worse, the user
 * approved a prompt describing a contract call they never made.
 */
export function signNativeTransfer(
  wallet: Wallet,
  params: SignTransferParams,
): { tx: Transaction; to: string; amountRaw: string; ou: string; opType: 'standard' } {
  const { to, amountRaw, ou } = previewTransfer(params, wallet.addr);
  if (!Number.isInteger(params.nonce) || params.nonce < 0) {
    throw new Error(`signTransfer: invalid nonce ${String(params.nonce)}`);
  }
  const fields: TransactionFields = {
    from: wallet.addr,
    to,
    amount: amountRaw,
    nonce: params.nonce,
    ou,
    timestamp: nowTs(),
    op_type: 'standard',
  };
  if (params.message) fields.message = params.message;
  const tx = signTransaction({
    secretKey: wallet.sk,
    publicKeyB64: wallet.pubB64,
    fields,
  });
  return { tx, to, amountRaw, ou, opType: 'standard' };
}

/**
 * Resolve the amount a caller gave into a raw integer string.
 *
 * `amountRaw` is preferred when present because it is unambiguous. A decimal
 * `amount` goes through `parseAmountRaw`, which is the same conversion the send
 * form uses, so "0.1" cannot mean two different values depending on entry point.
 */
function resolveAmountRaw(params: Omit<SignTransferParams, 'nonce'>): string {
  if (params.amountRaw !== undefined) {
    const s = String(params.amountRaw).trim();
    if (!/^\d+$/.test(s)) throw new Error(`signTransfer: amountRaw must be an integer, got "${s}"`);
    return s;
  }
  if (params.amount === undefined || params.amount === null || params.amount === '') {
    throw new Error('signTransfer: amount is required');
  }
  return parseAmountRaw(params.amount);
}

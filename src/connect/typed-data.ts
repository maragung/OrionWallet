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
import { signTransaction, nowTs, recommendedOu, type Transaction } from '../tx/builder';
import { encodeCallArgs } from '../tx/call-args';
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

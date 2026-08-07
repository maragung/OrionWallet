/**
 * Circle RPC client for the `oct://` browser.
 *
 * Talks DIRECTLY to the Octra node over the wallet's existing JSON-RPC client
 * (no local gateway server, unlike webcli). The public devnet/mainnet nodes
 * expose the circle methods directly:
 *   - `circle_info(circle_id)`                         → metadata / manifest
 *   - `circle_asset(circle_id, path)`                  → public asset bytes (body_b64)
 *   - `octra_circleAssetCiphertextByResourceKeyAuth`   → sealed ciphertext (Ed25519 read-auth)
 *
 * The sealed read is authorized by an Ed25519 signature over a length-framed
 * message (webcli lib/tx_builder.hpp `frame_v2` + `sign_circle_read_request`):
 *
 *   octra_circle_auth_v2|<len>:<op>|<len>:<circle_id>|<len>:<addr>|<len>:<subject>
 *
 * Each `<len>` is the field's length in BYTES (the C++ side uses
 * `std::string::size()`), so multi-byte UTF-8 fields must be measured after
 * encoding. The subject is always framed, even when empty (`|0:`), which is
 * what distinguishes this from the older `op|circle|addr[|subject]` format —
 * length prefixes remove the delimiter ambiguity that format allowed.
 *
 * This is a READ authorization only — it never moves funds. The signature is
 * built here by the wallet, never by page content.
 */
import type { RpcClient } from '../rpc/client';
import type { Wallet } from '../wallet/wallet';
import { sign } from '../crypto/ed25519';
import { base64Encode } from '../crypto/base64';
import { resourceKeyOfPath, decryptSealedBytes, type SealedAsset } from './sealed';
import { normalizeAssetPath, isTextContent } from './octUri';

const enc = new TextEncoder();

/** Circle metadata (subset consumed by the browser). */
export interface CircleInfo {
  circle_id: string;
  runtime?: string;
  version?: string;
  owner?: string;
  privacy_class?: string;
  browser_mode?: string;
  /** `public_resources` | `sealed_read` — decides the render path. */
  resource_mode?: string;
  stable_root?: string;
  assets_root?: string;
  [k: string]: unknown;
}

/** A resolved circle asset: decoded bytes + content type + text (when textual). */
export interface CircleAsset {
  circleId: string;
  path: string;
  contentType: string;
  bytes: Uint8Array;
  /** UTF-8 text when the content type is textual; else empty string. */
  text: string;
  sealed: boolean;
}

/** Hard ceiling for any single circle asset (webcli: 32 MiB). */
export const MAX_ASSET_BYTES = 33_554_432;
/** Per-subresource ceiling when materializing a page (webcli: 1 MiB). */
export const MAX_SUBRESOURCE_BYTES = 1024 * 1024;

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

/**
 * Decode a node-supplied base64 body, rejecting anything malformed or oversized.
 * The re-encode check catches non-canonical base64 (padding tricks, stray
 * whitespace) that would otherwise decode to bytes we never verified.
 */
function decodeAssetBody(b64: string, label: string, maxBytes: number): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = b64ToBytes(b64);
  } catch {
    throw new Error(`circle asset body invalid: ${label}`);
  }
  if (bytes.length > maxBytes) {
    throw new Error(`circle asset exceeds limit: ${label}`);
  }
  if (bytesToB64(bytes) !== b64) {
    throw new Error(`circle asset body invalid: ${label}`);
  }
  return bytes;
}

/** Read a circle's metadata. Throws with the node's error message on failure. */
export async function fetchCircleInfo(rpc: RpcClient, circleId: string): Promise<CircleInfo> {
  const r = await rpc.rpcCall<CircleInfo>('circle_info', [circleId]);
  if (!r.ok || !r.result) {
    throw new Error(r.error ?? 'circle not found');
  }
  return r.result;
}

/** True when a circle's resource mode requires a sealed (passphrase) read. */
export function isSealedMode(info: CircleInfo): boolean {
  return (info.resource_mode ?? '').toLowerCase() === 'sealed_read';
}

interface PublicAssetResult {
  circle_id?: string;
  canonical_path?: string;
  content_type?: string;
  size_bytes?: number;
  body_b64?: string;
}

/**
 * Fetch a PUBLIC circle asset (no auth).
 *
 * `maxBytes` defaults to the top-level asset ceiling; the materializer passes
 * the smaller subresource ceiling. The node's echoed `circle_id` /
 * `canonical_path` must match what we asked for, so a node cannot answer a
 * request for `/index.html` with some other circle's document
 * (webcli circles.js:1276-1293).
 */
export async function fetchPublicAsset(
  rpc: RpcClient,
  circleId: string,
  path: string,
  maxBytes: number = MAX_ASSET_BYTES,
): Promise<CircleAsset> {
  const norm = normalizeAssetPath(path);
  const r = await rpc.rpcCall<PublicAssetResult>('circle_asset', [circleId, norm]);
  if (!r.ok || !r.result) {
    throw new Error(r.error ?? `asset not found: ${norm}`);
  }
  const res = r.result;
  if (
    (res.circle_id && res.circle_id !== circleId) ||
    (res.canonical_path && res.canonical_path !== norm)
  ) {
    throw new Error(`circle asset response invalid: ${norm}`);
  }
  const contentType = res.content_type ?? 'application/octet-stream';
  const bytes = res.body_b64 ? decodeAssetBody(res.body_b64, norm, maxBytes) : new Uint8Array(0);
  return {
    circleId,
    path: res.canonical_path ?? norm,
    contentType,
    bytes,
    text: isTextContent(contentType) ? new TextDecoder().decode(bytes) : '',
    sealed: false,
  };
}

/**
 * Length-prefix framing shared by circle read authorizations.
 * Mirrors webcli `frame_v2` (lib/tx_builder.hpp): `domain|<len>:<field>|...`
 * where `<len>` counts UTF-8 BYTES, and every field is framed unconditionally.
 *
 * Exported for the vector tests, which pin the exact bytes signed.
 */
export function frameV2(domain: string, fields: string[]): Uint8Array {
  const parts: Uint8Array[] = [enc.encode(domain)];
  for (const field of fields) {
    const body = enc.encode(field);
    parts.push(enc.encode(`|${body.length}:`), body);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Domain separator for circle read-authorization signatures. */
export const CIRCLE_AUTH_DOMAIN = 'octra_circle_auth_v2';

/**
 * Build the Ed25519 read-authorization signature for a sealed ciphertext read.
 * Signs the `octra_circle_auth_v2` framing of (op, circle_id, addr, subject).
 */
function signCircleRead(wallet: Wallet, op: string, circleId: string, subject: string): string {
  const msg = frameV2(CIRCLE_AUTH_DOMAIN, [op, circleId, wallet.addr, subject]);
  return base64Encode(sign(msg, wallet.sk));
}

/**
 * Fetch and decrypt a SEALED circle asset.
 *
 * Requires an unlocked wallet (for the read-auth signature) and the circle's
 * passphrase (for local AES-GCM decryption). The node only ever returns
 * ciphertext; decryption happens here, in-wallet.
 */
export async function fetchSealedAsset(
  rpc: RpcClient,
  wallet: Wallet,
  circleId: string,
  path: string,
  passphrase: string,
  maxBytes: number = MAX_ASSET_BYTES,
): Promise<CircleAsset> {
  const norm = normalizeAssetPath(path);
  const resourceKey = resourceKeyOfPath(circleId, norm);
  const sig = signCircleRead(
    wallet,
    'octra_circle_asset_ciphertext_by_resource_key',
    circleId,
    `resource_key|${resourceKey}`,
  );
  const r = await rpc.rpcCall<SealedAsset>('octra_circleAssetCiphertextByResourceKeyAuth', [
    circleId,
    resourceKey,
    wallet.addr,
    wallet.pubB64,
    sig,
  ]);
  if (!r.ok || !r.result) {
    throw new Error(r.error ?? `sealed asset not found: ${norm}`);
  }
  const asset = r.result;
  // The lookup key is derived from `norm`, so any identity the node echoes back
  // must match what we asked for — otherwise it substituted a different asset.
  if (
    (asset.circle_id && asset.circle_id !== circleId) ||
    (asset.canonical_path && asset.canonical_path !== norm)
  ) {
    throw new Error(`sealed asset response invalid: ${norm}`);
  }
  // Decryption verifies the plaintext hash, so oversize is checked on the
  // decrypted result rather than the (padded, encrypted) wire body.
  const bytes = await decryptSealedBytes(circleId, asset, passphrase);
  if (bytes.length > maxBytes) {
    throw new Error(`circle asset exceeds limit: ${norm}`);
  }
  const contentType = asset.content_type ?? 'application/octet-stream';
  return {
    circleId,
    path: asset.canonical_path ?? norm,
    contentType,
    bytes,
    text: isTextContent(contentType) ? new TextDecoder().decode(bytes) : '',
    sealed: true,
  };
}

/** Version token used to cache-key decrypted assets (webcli uses assets_root). */
export function versionTokenOf(info: CircleInfo): string {
  return info.assets_root || info.stable_root || '';
}

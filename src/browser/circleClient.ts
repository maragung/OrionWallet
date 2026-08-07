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
 * The sealed read is authorized by an Ed25519 signature over
 *   `octra_circle_asset_ciphertext_by_resource_key|<circle_id>|<addr>|resource_key|<key>`
 * signed by the wallet secret key (webcli main.cpp:5185 + lib/tx_builder.hpp:154-165).
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

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
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

/** Fetch a PUBLIC circle asset (no auth). */
export async function fetchPublicAsset(
  rpc: RpcClient,
  circleId: string,
  path: string,
): Promise<CircleAsset> {
  const norm = normalizeAssetPath(path);
  const r = await rpc.rpcCall<PublicAssetResult>('circle_asset', [circleId, norm]);
  if (!r.ok || !r.result) {
    throw new Error(r.error ?? `asset not found: ${norm}`);
  }
  const contentType = r.result.content_type ?? 'application/octet-stream';
  const bytes = r.result.body_b64 ? b64ToBytes(r.result.body_b64) : new Uint8Array(0);
  return {
    circleId,
    path: r.result.canonical_path ?? norm,
    contentType,
    bytes,
    text: isTextContent(contentType) ? new TextDecoder().decode(bytes) : '',
    sealed: false,
  };
}

/**
 * Build the Ed25519 read-authorization signature for a sealed ciphertext read.
 * Signs `op|circle_id|addr|subject` with the wallet secret key.
 */
function signCircleRead(wallet: Wallet, op: string, circleId: string, subject: string): string {
  const msg = subject
    ? `${op}|${circleId}|${wallet.addr}|${subject}`
    : `${op}|${circleId}|${wallet.addr}`;
  return base64Encode(sign(enc.encode(msg), wallet.sk));
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
  const bytes = await decryptSealedBytes(circleId, asset, passphrase);
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

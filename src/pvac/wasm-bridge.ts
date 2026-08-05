/**
 * PVAC WASM bridge — real implementation backed by the Emscripten-compiled module.
 *
 * Mirrors octra::PvacBridge from the reference webcli (lib/pvac_bridge.hpp):
 *   encode_bound_cipher(ct)  = "hfhe_v1|" + base64(pvac_serialize_cipher(ct))
 *   encode_zero_proof(zp)    = "zkzp_v2|" + base64(pvac_serialize_zero_proof(zp))
 *   encode_bound_range_proof = "rp_v1|"   + base64(pvac_serialize_bound_range_proof(zp))
 *
 * MEMORY MODEL:
 *   - pvac_keygen_from_seed writes opaque pk/sk handles into out-pointers
 *   - serialize_* return a malloc'd buffer + write the length into a size_t*
 *     out-param; the buffer MUST be released with pvac_free_bytes
 *   - Every _malloc MUST be paired with _free
 */
import { base64Decode, base64Encode } from '../crypto/base64';
import { sha256 } from '../crypto/sha256';
import { randomBytes } from '../crypto/random';
import type { PvacCipher, PvacCommitment, PvacZeroProof, IPvacBridge } from './index';

export const HFHE_PREFIX = 'hfhe_v1|';
export const RP_PREFIX = 'rp_v1|';
export const ZKZP_PREFIX = 'zkzp_v2|';

/** Emscripten module shape (subset we use). */
interface PvacModule {
  ready?: Promise<void>;
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
  getValue(ptr: number, type: string): number | bigint;
  setValue(ptr: number, value: number | bigint, type: string): void;

  _pvac_default_params(): number;
  _pvac_free_params(p: number): void;
  _pvac_keygen_from_seed(prm: number, seedPtr: number, pkOut: number, skOut: number): void;
  _pvac_free_pubkey(pk: number): void;
  _pvac_free_seckey(sk: number): void;

  _pvac_enc_value_seeded(pk: number, sk: number, valLo: number, seedPtr: number): number;
  _pvac_enc_zero_seeded(pk: number, sk: number, seedPtr: number): number;
  _pvac_dec_value_i64(pk: number, sk: number, ct: number, valueOut: number): number;
  _pvac_ct_sub(pk: number, a: number, b: number): number;
  _pvac_ct_add(pk: number, a: number, b: number): number;
  _pvac_free_cipher(ct: number): void;

  _pvac_pedersen_commit_v2(
    amount: number,
    blindingPtr: number,
    outPtr: number,
    outCap: number,
    outLenPtr: number,
  ): number;
  _pvac_commit_ct_v2(
    pk: number,
    ct: number,
    outPtr: number,
    outCap: number,
    outLenPtr: number,
  ): number;

  _pvac_make_zero_proof_bound(
    pk: number,
    sk: number,
    ct: number,
    amount: number,
    blindingPtr: number,
  ): number;
  _pvac_make_bound_range_proof(
    pk: number,
    sk: number,
    ct: number,
    amount: number,
    blindingPtr: number,
  ): number;
  _pvac_verify_zero_bound(pk: number, ct: number, proof: number, commitPtr: number): number;
  _pvac_verify_bound_range_commitment(
    pk: number,
    ct: number,
    proof: number,
    commitPtr: number,
  ): number;
  _pvac_free_zero_proof(zp: number): void;

  _pvac_serialize_cipher(ct: number, lenPtr: number): number;
  _pvac_deserialize_cipher(dataPtr: number, len: number): number;
  _pvac_serialize_pubkey(pk: number, lenPtr: number): number;
  _pvac_deserialize_pubkey(dataPtr: number, len: number): number;
  _pvac_serialize_zero_proof(zp: number, lenPtr: number): number;
  _pvac_serialize_bound_range_proof(zp: number, lenPtr: number): number;
  _pvac_free_bytes(buf: number): void;

  _pvac_cipher_base_layer_count(ct: number): number;
  _pvac_pubkey_is_key_bound_extension(legacy: number, bound: number): number;
  _pvac_aes_kat?(outPtr: number, outCap: number): number;
}

let modulePromise: Promise<PvacModule> | null = null;

/**
 * Why the PVAC module could not be loaded.
 *
 * These map to distinct user-facing remedies, so they must stay distinguishable.
 * Previously every failure was swallowed by an empty `catch {}` and surfaced as
 * a generic "module not found", which made the problem impossible to diagnose.
 */
export type PvacFailureReason =
  | 'not-built' // /wasm/pvac.js is missing (404) — run npm run build:wasm
  | 'csp-blocked' // CSP lacks 'wasm-unsafe-eval' — WebAssembly compilation refused
  | 'missing-exports' // module loaded but lacks required functions — stale build
  | 'init-failed' // module loaded but FHE keygen from the wallet seed failed
  | 'unknown';

/** A load failure carrying its classified cause plus an actionable remedy. */
export class PvacLoadError extends Error {
  readonly reason: PvacFailureReason;
  readonly remedy: string;

  constructor(reason: PvacFailureReason, message: string, remedy: string) {
    super(message);
    this.name = 'PvacLoadError';
    this.reason = reason;
    this.remedy = remedy;
  }
}

const REMEDIES: Record<PvacFailureReason, string> = {
  'not-built':
    'The WASM module has not been compiled. Run `npm run build:wasm` to generate public/wasm/pvac.js.',
  'csp-blocked':
    "The Content-Security-Policy is blocking WebAssembly. Add 'wasm-unsafe-eval' to script-src in index.html.",
  'missing-exports': 'The compiled module is out of date. Rebuild it with `npm run build:wasm`.',
  'init-failed':
    'The module loaded but FHE key generation failed. Check the browser console for details.',
  unknown: 'Check the browser console for the underlying error.',
};

/** Build a classified error, attaching the matching remedy. */
function pvacError(reason: PvacFailureReason, message: string): PvacLoadError {
  return new PvacLoadError(reason, message, REMEDIES[reason]);
}

/**
 * Detect a CSP rejection of WebAssembly compilation.
 *
 * Chromium throws `EvalError`/`CompileError` mentioning CSP when `script-src`
 * lacks `'wasm-unsafe-eval'`; Firefox and Safari word it differently, so match
 * on the substrings all engines share.
 */
function isCspFailure(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return (
    /content security policy|unsafe-eval|wasm-eval|EvalError/i.test(msg) ||
    (err instanceof WebAssembly.CompileError && /csp|policy/i.test(msg))
  );
}

/**
 * Verify the glue script is actually served before importing it.
 *
 * A bare dynamic import of a missing file throws a generic module-resolution
 * error that looks identical to a CSP rejection. Probing first lets us tell
 * "never built" apart from "blocked", which need different fixes.
 */
async function assertModuleReachable(url: string): Promise<void> {
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    if (!res.ok) {
      throw pvacError('not-built', `PVAC: ${url} returned HTTP ${res.status}`);
    }
  } catch (err) {
    if (err instanceof PvacLoadError) throw err;
    // A network-layer failure here means the asset is not being served.
    throw pvacError('not-built', `PVAC: cannot reach ${url} (${String(err)})`);
  }
}

/**
 * Load the PVAC WASM module. Returns a singleton promise.
 * The Emscripten glue + wasm binary are served from <base>/wasm/pvac.js.
 */
export async function loadPvacModule(): Promise<PvacModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      // Must use an ABSOLUTE URL: a bare specifier fails to resolve, and a
      // relative './wasm/pvac.js' resolves against the bundled asset location
      // (/assets/) → 404. Anchor to Vite's base so it works under sub-paths.
      const base = import.meta.env.BASE_URL || '/';
      const path = `${base}/wasm/pvac.js`.replace(/\/{2,}/g, '/');
      const url = new URL(path, window.location.origin).href;

      // Probe first so "never built" is distinguishable from "blocked by CSP" —
      // a plain dynamic import reports both as an opaque resolution failure.
      await assertModuleReachable(url);

      const factory = (await import(/* @vite-ignore */ url)) as unknown as {
        default: (opts?: Record<string, unknown>) => Promise<PvacModule>;
      };
      // The Emscripten factory is what actually compiles the .wasm binary, so
      // this is where a CSP rejection surfaces.
      const mod = await factory.default();
      if (mod.ready) await mod.ready;
      return mod;
    })().catch((err) => {
      // Reset the singleton so a later retry (e.g. the Reload PVAC button) can
      // try again instead of replaying a cached rejection forever.
      modulePromise = null;
      throw err;
    });
  }
  return modulePromise;
}

/** Allocate a buffer in the WASM heap and copy bytes in. */
function writeBytes(mod: PvacModule, bytes: Uint8Array): number {
  const ptr = mod._malloc(bytes.length || 1);
  if (bytes.length) mod.HEAPU8.set(bytes, ptr);
  return ptr;
}

/** Copy bytes out of the WASM heap. */
function readBytes(mod: PvacModule, ptr: number, length: number): Uint8Array {
  return mod.HEAPU8.slice(ptr, ptr + length);
}

/** Free any number of pointers (ignores 0/undefined). */
function freeAll(mod: PvacModule, ...ptrs: (number | undefined)[]): void {
  for (const p of ptrs) if (p) mod._free(p);
}

/** Real WASM-backed PVAC bridge. */
export class WasmPvacBridge implements IPvacBridge {
  private mod: PvacModule | null = null;
  private prm = 0;
  private pk = 0;
  private sk = 0;
  private initialized = false;

  /** Max representable balance (matches the reference bridge domain check). */
  private static readonly MAX_BALANCE_RAW = 1_000_000_000n * 1_000_000n;

  private require(): PvacModule {
    if (!this.mod || !this.pk || !this.sk) throw new Error('PVAC: not initialized');
    return this.mod;
  }

  async init(privB64: string): Promise<boolean> {
    this.mod = await loadPvacModule();

    this.prm = this.mod._pvac_default_params();
    if (!this.prm) throw new Error('PVAC: pvac_default_params returned 0');

    // Seed = first 32 bytes of the decoded priv_b64 (matches PvacBridge::init)
    const skBytes = base64Decode(privB64);
    if (skBytes.length < 32) throw new Error('PVAC: privB64 too short (need >= 32 bytes)');
    const seed = skBytes.subarray(0, 32);

    const seedPtr = writeBytes(this.mod, seed);
    const pkPtr = this.mod._malloc(4);
    const skPtr = this.mod._malloc(4);
    try {
      this.mod._pvac_keygen_from_seed(this.prm, seedPtr, pkPtr, skPtr);
      this.pk = this.mod.getValue(pkPtr, 'i32') as number;
      this.sk = this.mod.getValue(skPtr, 'i32') as number;
      if (!this.pk || !this.sk) throw new Error('PVAC: keygen returned null handle');
      this.initialized = true;
      return true;
    } finally {
      freeAll(this.mod, seedPtr, pkPtr, skPtr);
    }
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  // ─── serialization helpers ────────────────────────────────────────────

  /** Call a `uint8_t* fn(handle, size_t* len)` export and copy the result out. */
  private serializePtr(fn: (handle: number, lenPtr: number) => number, handle: number): Uint8Array {
    const mod = this.require();
    const lenPtr = mod._malloc(4);
    let bufPtr = 0;
    try {
      bufPtr = fn(handle, lenPtr);
      if (!bufPtr) throw new Error('PVAC: serialize returned null');
      const len = mod.getValue(lenPtr, 'i32') as number;
      if (len <= 0) throw new Error('PVAC: serialize returned empty buffer');
      return readBytes(mod, bufPtr, len);
    } finally {
      if (bufPtr) mod._pvac_free_bytes(bufPtr);
      mod._free(lenPtr);
    }
  }

  serializeCipher(ctHandle: number): Uint8Array {
    const mod = this.require();
    return this.serializePtr((h, l) => mod._pvac_serialize_cipher(h, l), ctHandle);
  }

  serializeZeroProof(zpHandle: number): Uint8Array {
    const mod = this.require();
    return this.serializePtr((h, l) => mod._pvac_serialize_zero_proof(h, l), zpHandle);
  }

  serializeBoundRangeProof(zpHandle: number): Uint8Array {
    const mod = this.require();
    return this.serializePtr((h, l) => mod._pvac_serialize_bound_range_proof(h, l), zpHandle);
  }

  serializePubkeyBytes(): Uint8Array {
    const mod = this.require();
    return this.serializePtr((h, l) => mod._pvac_serialize_pubkey(h, l), this.pk);
  }

  serializePubkeyB64(): string {
    return base64Encode(this.serializePubkeyBytes());
  }

  // ─── low-level FHE ops (handle-based) ─────────────────────────────────

  /** Encrypt a value → raw cipher handle. Caller must freeCipherHandle(). */
  encryptHandle(amount: bigint, seed?: Uint8Array): number {
    const mod = this.require();
    const useSeed = seed ?? randomBytes(32);
    if (useSeed.length !== 32) throw new Error('PVAC: seed must be 32 bytes');
    const amountNum = Number(amount);
    if (!Number.isSafeInteger(amountNum) || amountNum < 0) {
      throw new Error('PVAC: amount out of supported range (0 .. 2^53)');
    }
    const seedPtr = writeBytes(mod, useSeed);
    try {
      const ct = mod._pvac_enc_value_seeded(this.pk, this.sk, amountNum, seedPtr);
      if (!ct) throw new Error('PVAC: encrypt returned null');
      return ct;
    } finally {
      mod._free(seedPtr);
    }
  }

  /** Deserialize a cipher from a "hfhe_v1|<b64>" string → handle (0 if empty). */
  decodeCipherHandle(s: string): number {
    const mod = this.require();
    if (!s || s === '0') return 0;
    if (!s.startsWith(HFHE_PREFIX)) {
      throw new Error('PVAC: cipher missing hfhe_v1 prefix');
    }
    const raw = base64Decode(s.slice(HFHE_PREFIX.length));
    const dataPtr = writeBytes(mod, raw);
    try {
      const ct = mod._pvac_deserialize_cipher(dataPtr, raw.length);
      if (!ct) throw new Error('PVAC: cannot decode cipher');
      return ct;
    } finally {
      mod._free(dataPtr);
    }
  }

  freeCipherHandle(ct: number): void {
    if (ct && this.mod) this.mod._pvac_free_cipher(ct);
  }

  freeZeroProofHandle(zp: number): void {
    if (zp && this.mod) this.mod._pvac_free_zero_proof(zp);
  }

  /** Homomorphic subtraction on handles: a - b → new handle. */
  ctSubHandle(a: number, b: number): number {
    const mod = this.require();
    const out = mod._pvac_ct_sub(this.pk, a, b);
    if (!out) throw new Error('PVAC: ct_sub returned null');
    return out;
  }

  /** Decrypt a cipher handle to an int64. Returns null if outside the valid domain. */
  decryptHandle(ct: number): bigint | null {
    const mod = this.require();
    const outPtr = mod._malloc(8);
    try {
      const ok = mod._pvac_dec_value_i64(this.pk, this.sk, ct, outPtr);
      if (!ok) return null;
      const lo = BigInt(mod.getValue(outPtr, 'i32') as number) & 0xffffffffn;
      const hi = BigInt(mod.getValue(outPtr + 4, 'i32') as number);
      let v = (hi << 32n) | lo;
      // Interpret as signed 64-bit
      if (v >= 1n << 63n) v -= 1n << 64n;
      if (v < 0n || v > WasmPvacBridge.MAX_BALANCE_RAW) return null;
      return v;
    } finally {
      mod._free(outPtr);
    }
  }

  /** Pedersen commitment (32 bytes) over amount + blinding. */
  pedersenCommitBytes(amount: bigint, blinding: Uint8Array): Uint8Array {
    const mod = this.require();
    if (blinding.length !== 32) throw new Error('PVAC: blinding must be 32 bytes');
    const amountNum = Number(amount);
    if (!Number.isSafeInteger(amountNum) || amountNum < 0) {
      throw new Error('PVAC: amount out of supported range');
    }
    const blindingPtr = writeBytes(mod, blinding);
    const outPtr = mod._malloc(32);
    const outLenPtr = mod._malloc(4);
    try {
      const rc = mod._pvac_pedersen_commit_v2(amountNum, blindingPtr, outPtr, 32, outLenPtr);
      const outLen = mod.getValue(outLenPtr, 'i32') as number;
      if (rc !== 0 || outLen !== 32) throw new Error('PVAC: pedersen_commit_v2 failed');
      return readBytes(mod, outPtr, 32);
    } finally {
      freeAll(mod, blindingPtr, outPtr, outLenPtr);
    }
  }

  /** Zero-knowledge proof bound to a cipher + amount + blinding → handle. */
  makeZeroProofBoundHandle(ct: number, amount: bigint, blinding: Uint8Array): number {
    const mod = this.require();
    if (blinding.length !== 32) throw new Error('PVAC: blinding must be 32 bytes');
    const amountNum = Number(amount);
    if (!Number.isSafeInteger(amountNum) || amountNum < 0) {
      throw new Error('PVAC: amount out of supported range');
    }
    const blindingPtr = writeBytes(mod, blinding);
    try {
      const zp = mod._pvac_make_zero_proof_bound(this.pk, this.sk, ct, amountNum, blindingPtr);
      if (!zp) throw new Error('PVAC: make_zero_proof_bound returned null');
      return zp;
    } finally {
      mod._free(blindingPtr);
    }
  }

  /** Bound range proof over a cipher (used for the new balance in decrypt) → handle. */
  makeBoundRangeProofHandle(ct: number, amount: bigint, blinding: Uint8Array): number {
    const mod = this.require();
    if (blinding.length !== 32) throw new Error('PVAC: blinding must be 32 bytes');
    const amountNum = Number(amount);
    if (!Number.isSafeInteger(amountNum) || amountNum < 0) {
      throw new Error('PVAC: amount out of supported range');
    }
    const blindingPtr = writeBytes(mod, blinding);
    try {
      const zp = mod._pvac_make_bound_range_proof(this.pk, this.sk, ct, amountNum, blindingPtr);
      if (!zp) throw new Error('PVAC: make_bound_range_proof returned null');
      return zp;
    } finally {
      mod._free(blindingPtr);
    }
  }

  /** Verify a bound range proof against a commitment. */
  verifyBoundRangeCommitment(ct: number, zp: number, commitment: Uint8Array): boolean {
    const mod = this.require();
    if (commitment.length !== 32) return false;
    const commitPtr = writeBytes(mod, commitment);
    try {
      return mod._pvac_verify_bound_range_commitment(this.pk, ct, zp, commitPtr) !== 0;
    } finally {
      mod._free(commitPtr);
    }
  }

  /** Number of base layers in a cipher (used by refresh policy checks). */
  baseLayerCount(ct: number): number {
    const mod = this.require();
    return mod._pvac_cipher_base_layer_count(ct);
  }

  /** Whether a remote (legacy) pubkey is a key-bound extension of the local one. */
  pubkeyExtendsLocal(legacyB64: string): boolean {
    const mod = this.require();
    let legacy = 0;
    let dataPtr = 0;
    try {
      const raw = base64Decode(legacyB64);
      dataPtr = writeBytes(mod, raw);
      legacy = mod._pvac_deserialize_pubkey(dataPtr, raw.length);
      if (!legacy) return false;
      return mod._pvac_pubkey_is_key_bound_extension(legacy, this.pk) === 1;
    } catch {
      return false;
    } finally {
      if (legacy) mod._pvac_free_pubkey(legacy);
      if (dataPtr) mod._free(dataPtr);
    }
  }

  // ─── transport encoding (matches the reference bridge) ────────────────

  /** "hfhe_v1|" + base64(serialize_cipher(ct)) */
  encodeBoundCipherHandle(ct: number): string {
    return HFHE_PREFIX + base64Encode(this.serializeCipher(ct));
  }

  /** "zkzp_v2|" + base64(serialize_zero_proof(zp)) */
  encodeZeroProofHandle(zp: number): string {
    return ZKZP_PREFIX + base64Encode(this.serializeZeroProof(zp));
  }

  /** "rp_v1|" + base64(serialize_bound_range_proof(zp)) */
  encodeBoundRangeProofHandle(zp: number): string {
    return RP_PREFIX + base64Encode(this.serializeBoundRangeProof(zp));
  }

  /**
   * Decrypt an on-chain encrypted-balance cipher string to a raw amount.
   * Returns 0n for an empty balance, or null when the value is outside the
   * valid balance domain (i.e. a legacy blob that needs an upgrade).
   */
  tryGetBalance(cipherStr: string): bigint | null {
    if (!cipherStr || cipherStr === '0') return 0n;
    let ct = 0;
    try {
      ct = this.decodeCipherHandle(cipherStr);
      if (!ct) return 0n;
      return this.decryptHandle(ct);
    } catch {
      return null;
    } finally {
      this.freeCipherHandle(ct);
    }
  }

  // ─── IPvacBridge surface (object-based, for compatibility) ────────────

  encrypt(amount: bigint, seed?: Uint8Array): PvacCipher {
    const ct = this.encryptHandle(amount, seed);
    try {
      return { version: 'hfhe_v1', bytes: this.serializeCipher(ct) };
    } finally {
      this.freeCipherHandle(ct);
    }
  }

  decrypt(cipher: PvacCipher): bigint | null {
    let ct = 0;
    try {
      ct = this.decodeCipherHandle(this.encodeBoundCipher(cipher));
      if (!ct) return 0n;
      return this.decryptHandle(ct);
    } catch {
      return null;
    } finally {
      this.freeCipherHandle(ct);
    }
  }

  getBalance(cipherStr: string): bigint {
    return this.tryGetBalance(cipherStr) ?? 0n;
  }

  pedersenCommit(amount: bigint, blinding: Uint8Array): PvacCommitment {
    return { bytes: this.pedersenCommitBytes(amount, blinding) };
  }

  makeZeroProofBound(cipher: PvacCipher, amount: bigint, blinding: Uint8Array): PvacZeroProof {
    let ct = 0;
    let zp = 0;
    try {
      ct = this.decodeCipherHandle(this.encodeBoundCipher(cipher));
      zp = this.makeZeroProofBoundHandle(ct, amount, blinding);
      return { bytes: this.serializeZeroProof(zp) };
    } finally {
      this.freeZeroProofHandle(zp);
      this.freeCipherHandle(ct);
    }
  }

  verifyZeroProof(cipher: PvacCipher, proof: PvacZeroProof, commitment: PvacCommitment): boolean {
    const mod = this.require();
    let ct = 0;
    let zp = 0;
    let dataPtr = 0;
    let commitPtr = 0;
    try {
      ct = this.decodeCipherHandle(this.encodeBoundCipher(cipher));
      dataPtr = writeBytes(mod, proof.bytes);
      zp = (
        mod as unknown as {
          _pvac_deserialize_zero_proof(d: number, l: number): number;
        }
      )._pvac_deserialize_zero_proof(dataPtr, proof.bytes.length);
      if (!ct || !zp) return false;
      commitPtr = writeBytes(mod, commitment.bytes);
      return mod._pvac_verify_zero_bound(this.pk, ct, zp, commitPtr) !== 0;
    } catch {
      return false;
    } finally {
      this.freeZeroProofHandle(zp);
      this.freeCipherHandle(ct);
      freeAll(mod, dataPtr, commitPtr);
    }
  }

  encodeBoundCipher(cipher: PvacCipher): string {
    return `${cipher.version}|${base64Encode(cipher.bytes)}`;
  }

  decodeCipher(s: string): PvacCipher {
    if (s === '0' || s === '') return { version: 'hfhe_v1', bytes: new Uint8Array(0) };
    const idx = s.indexOf('|');
    if (idx < 0) throw new Error('decodeCipher: missing version separator');
    return { version: s.slice(0, idx), bytes: base64Decode(s.slice(idx + 1)) };
  }

  encodeZeroProof(proof: PvacZeroProof): string {
    return `zkzp_v2|${base64Encode(proof.bytes)}`;
  }

  decodeZeroProof(s: string): PvacZeroProof {
    const idx = s.indexOf('|');
    if (idx < 0) throw new Error('decodeZeroProof: missing version separator');
    return { bytes: base64Decode(s.slice(idx + 1)) };
  }

  ctSub(a: PvacCipher, b: PvacCipher): PvacCipher {
    let ha = 0;
    let hb = 0;
    let hout = 0;
    try {
      ha = this.decodeCipherHandle(this.encodeBoundCipher(a));
      hb = this.decodeCipherHandle(this.encodeBoundCipher(b));
      hout = this.ctSubHandle(ha, hb);
      return { version: 'hfhe_v1', bytes: this.serializeCipher(hout) };
    } finally {
      this.freeCipherHandle(hout);
      this.freeCipherHandle(hb);
      this.freeCipherHandle(ha);
    }
  }

  encryptZero(seed?: Uint8Array): PvacCipher {
    const mod = this.require();
    const useSeed = seed ?? randomBytes(32);
    if (useSeed.length !== 32) throw new Error('PVAC: seed must be 32 bytes');
    const seedPtr = writeBytes(mod, useSeed);
    let ct = 0;
    try {
      ct = mod._pvac_enc_zero_seeded(this.pk, this.sk, seedPtr);
      if (!ct) throw new Error('PVAC: encrypt_zero returned null');
      return { version: 'hfhe_v1', bytes: this.serializeCipher(ct) };
    } finally {
      this.freeCipherHandle(ct);
      mod._free(seedPtr);
    }
  }
}

/**
 * Attempt to load the PVAC WASM module and replace the global bridge.
 * Returns true if loaded successfully.
 *
 * On failure the classified reason is logged, and the thrown `PvacLoadError`
 * is available to callers that want to surface the remedy in the UI.
 */
export async function loadPvacWasm(_wasmUrl?: string): Promise<boolean> {
  try {
    await loadPvacWasmOrThrow();
    return true;
  } catch (err) {
    if (err instanceof PvacLoadError) {
      console.error(`[PVAC] ${err.reason}: ${err.message}\n  → ${err.remedy}`);
    } else {
      console.error('[PVAC] Unexpected load failure:', err);
    }
    return false;
  }
}

/**
 * Same as `loadPvacWasm` but throws a classified `PvacLoadError` instead of
 * returning false, so the caller can present the precise cause and remedy.
 */
export async function loadPvacWasmOrThrow(): Promise<void> {
  let mod: PvacModule;
  try {
    mod = await loadPvacModule();
  } catch (err) {
    if (err instanceof PvacLoadError) throw err;
    if (isCspFailure(err)) {
      throw pvacError('csp-blocked', `PVAC: WebAssembly blocked by CSP (${String(err)})`);
    }
    throw pvacError('unknown', `PVAC: module load failed (${String(err)})`);
  }

  // Verify the exports we actually depend on are present. The serialization
  // functions were missing from earlier builds, which silently broke
  // encrypt/decrypt (the node rejected the tx as "malformed").
  const required: (keyof PvacModule)[] = [
    '_pvac_default_params',
    '_pvac_keygen_from_seed',
    '_pvac_enc_value_seeded',
    '_pvac_serialize_cipher',
    '_pvac_deserialize_cipher',
    '_pvac_serialize_zero_proof',
    '_pvac_serialize_bound_range_proof',
    '_pvac_pedersen_commit_v2',
    '_pvac_make_zero_proof_bound',
    '_pvac_make_bound_range_proof',
    '_pvac_dec_value_i64',
    '_pvac_ct_sub',
    '_pvac_free_bytes',
  ];
  const missing = required.filter((fn) => typeof mod[fn] !== 'function');
  if (missing.length > 0) {
    throw pvacError(
      'missing-exports',
      `PVAC: compiled module is missing ${missing.length} export(s): ${missing.join(', ')}`,
    );
  }

  const { setPvacBridge } = await import('./index');
  setPvacBridge(new WasmPvacBridge());
}

export { sha256, randomBytes };

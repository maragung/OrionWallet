/**
 * PVAC (Private Verifiable Arithmetic Computation) — HFHE library bridge.
 *
 * STATUS: STUB. The real PVAC implementation in the original C++ repo
 * (pvac/ directory, ~3000 lines of header-only C++ with ristretto255,
 * bulletproofs, LPN, Toeplitz matrices, field arithmetic) cannot be
 * trivially reimplemented in TypeScript. The recommended path is to
 * compile the existing C++ to WebAssembly via Emscripten.
 *
 * This module provides:
 *   1. A complete TypeScript INTERFACE that mirrors octra::PvacBridge.
 *   2. Stub implementations that throw "PVAC not available" errors.
 *   3. Documentation of the Emscripten compile plan.
 *   4. Hooks for runtime loading of the real WASM module.
 *
 * ROADMAP:
 *   - Phase 1 (this file): interface + stubs + loader scaffolding
 *   - Phase 2: Emscripten compile of pvac/ → pvac.wasm + pvac.js glue
 *   - Phase 3: Replace stubs with ccall/cwrap invocations into the WASM module
 *
 * See pvac/PORTING.md for the Emscripten compile plan.
 */
import { base64Decode, base64Encode } from '../crypto/base64';
import { randomBytes } from '../crypto/random';
import { sha256 } from '../crypto/sha256';

/** A PVAC ciphertext (opaque structure). */
export interface PvacCipher {
  /** Schema version tag (e.g., "hfhe_v1"). */
  version: string;
  /** Raw ciphertext bytes. */
  bytes: Uint8Array;
}

/** A Pedersen commitment (32 bytes). */
export interface PvacCommitment {
  bytes: Uint8Array; // 32 bytes
}

/** A zero-knowledge proof bound to a ciphertext and amount. */
export interface PvacZeroProof {
  bytes: Uint8Array;
}

/** Serialized forms (base64-encoded strings, prefixed with version tag). */
export interface SerializedCipher {
  /** e.g., "hfhe_v1|<base64>" */
  str: string;
}
export interface SerializedProof {
  /** e.g., "zkzp_v2|<base64>" */
  str: string;
}

/** Public PvacBridge interface (mirrors octra::PvacBridge in C++). */
export interface IPvacBridge {
  /** Initialize the bridge from a wallet's private key (base64). */
  init(privB64: string): Promise<boolean>;
  /** Check if the bridge has been initialized. */
  isInitialized(): boolean;
  /** Serialize the local PVAC public key to base64. */
  serializePubkeyB64(): string;
  /** Encrypt a uint64 amount using FHE. */
  encrypt(amount: bigint, seed?: Uint8Array): PvacCipher;
  /** Decrypt a cipher to a uint64 amount. */
  decrypt(cipher: PvacCipher): bigint | null;
  /** Get the current balance from a cipher string ("0" if no encrypted balance). */
  getBalance(cipherStr: string): bigint;
  /** Compute a Pedersen commitment to an amount with a blinding factor. */
  pedersenCommit(amount: bigint, blinding: Uint8Array): PvacCommitment;
  /** Build a zero-knowledge proof bound to a cipher + amount + blinding. */
  makeZeroProofBound(cipher: PvacCipher, amount: bigint, blinding: Uint8Array): PvacZeroProof;
  /** Verify a zero-knowledge proof. */
  verifyZeroProof(cipher: PvacCipher, proof: PvacZeroProof, commitment: PvacCommitment): boolean;
  /** Encode a cipher + commitment + proof into a single transport string. */
  encodeBoundCipher(cipher: PvacCipher): string;
  /** Decode a transport string back into a cipher. */
  decodeCipher(s: string): PvacCipher;
  /** Encode a zero proof into a transport string. */
  encodeZeroProof(proof: PvacZeroProof): string;
  /** Decode a zero proof from a transport string. */
  decodeZeroProof(s: string): PvacZeroProof;
  /** Homomorphic subtraction: a - b (used in stealth send). */
  ctSub(a: PvacCipher, b: PvacCipher): PvacCipher;
  /** Encrypt zero (used for padding). */
  encryptZero(seed?: Uint8Array): PvacCipher;
}

/** Error thrown when PVAC WASM is not loaded. */
export class PvacNotAvailableError extends Error {
  constructor(
    message: string = 'PVAC WASM module not loaded. Encrypted balance operations are disabled — standard wallet features work normally.',
  ) {
    super(message);
    this.name = 'PvacNotAvailableError';
  }
}

/**
 * Stub implementation that throws on every method.
 * Used until the real WASM module is available.
 */
export class StubPvacBridge implements IPvacBridge {
  private initialized = false;
  private privB64 = '';

  async init(privB64: string): Promise<boolean> {
    // Stub: accept the input but mark as initialized with a fake pubkey
    this.privB64 = privB64;
    this.initialized = true;
    return true;
  }
  isInitialized(): boolean {
    return this.initialized;
  }
  serializePubkeyB64(): string {
    if (!this.initialized) throw new PvacNotAvailableError();
    // Deterministic stub pubkey derived from privB64
    return base64Encode(sha256(new TextEncoder().encode(this.privB64)));
  }
  encrypt(_amount: bigint, _seed?: Uint8Array): PvacCipher {
    throw new PvacNotAvailableError('PVAC encrypt requires the WASM module');
  }
  decrypt(_cipher: PvacCipher): bigint | null {
    throw new PvacNotAvailableError('PVAC decrypt requires the WASM module');
  }
  getBalance(_cipherStr: string): bigint {
    // Stub: return 0n for empty balance
    return 0n;
  }
  pedersenCommit(_amount: bigint, _blinding: Uint8Array): PvacCommitment {
    throw new PvacNotAvailableError('PVAC pedersenCommit requires the WASM module');
  }
  makeZeroProofBound(_cipher: PvacCipher, _amount: bigint, _blinding: Uint8Array): PvacZeroProof {
    throw new PvacNotAvailableError('PVAC makeZeroProofBound requires the WASM module');
  }
  verifyZeroProof(
    _cipher: PvacCipher,
    _proof: PvacZeroProof,
    _commitment: PvacCommitment,
  ): boolean {
    throw new PvacNotAvailableError('PVAC verifyZeroProof requires the WASM module');
  }
  encodeBoundCipher(cipher: PvacCipher): string {
    return `${cipher.version}|${base64Encode(cipher.bytes)}`;
  }
  decodeCipher(s: string): PvacCipher {
    if (s === '0' || s === '') {
      return { version: 'hfhe_v1', bytes: new Uint8Array(0) };
    }
    const idx = s.indexOf('|');
    if (idx < 0) throw new Error('decodeCipher: missing version separator');
    const version = s.slice(0, idx);
    const bytes = base64Decode(s.slice(idx + 1));
    return { version, bytes };
  }
  encodeZeroProof(proof: PvacZeroProof): string {
    return `zkzp_v2|${base64Encode(proof.bytes)}`;
  }
  decodeZeroProof(s: string): PvacZeroProof {
    const idx = s.indexOf('|');
    if (idx < 0) throw new Error('decodeZeroProof: missing version separator');
    return { bytes: base64Decode(s.slice(idx + 1)) };
  }
  ctSub(_a: PvacCipher, _b: PvacCipher): PvacCipher {
    throw new PvacNotAvailableError('PVAC ctSub requires the WASM module');
  }
  encryptZero(_seed?: Uint8Array): PvacCipher {
    throw new PvacNotAvailableError('PVAC encryptZero requires the WASM module');
  }
}

/** Singleton bridge instance (stub until WASM is loaded). */
let bridgeInstance: IPvacBridge | null = null;

/** Get the current PvacBridge instance (creates a stub if none). */
export function getPvacBridge(): IPvacBridge {
  if (!bridgeInstance) bridgeInstance = new StubPvacBridge();
  return bridgeInstance;
}

/** Replace the bridge (e.g., with a real WASM-backed implementation). */
export function setPvacBridge(b: IPvacBridge): void {
  bridgeInstance = b;
}

/** Check if a real WASM-backed PVAC is available. */
export function isPvacWasmAvailable(): boolean {
  return bridgeInstance !== null && !(bridgeInstance instanceof StubPvacBridge);
}

/**
 * Attempt to load the real PVAC WASM module.
 * Returns true if loaded successfully.
 *
 * The WASM module is compiled from the original C++ PVAC library via
 * Emscripten. See scripts/build-wasm.sh and src/pvac/PORTING.md.
 *
 * @returns true if loaded successfully; false if unavailable, blocked, or failed.
 * On failure, the reason is logged to the console.
 */
export async function loadPvacWasm(wasmUrl?: string): Promise<boolean> {
  try {
    const { loadPvacWasm: load } = await import('./wasm-bridge');
    return await load(wasmUrl);
  } catch (err) {
    // Log the actual cause so diagnosis is possible.
    console.error('[PVAC] Failed to load WASM bridge:', err);
    return false;
  }
}

export { randomBytes };

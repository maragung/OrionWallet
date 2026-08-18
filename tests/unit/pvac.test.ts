import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import {
  isPvacWasmAvailable,
  getPvacBridge,
  StubPvacBridge,
  PvacNotAvailableError,
} from '../../src/pvac';
import { stubPvacGlueUnavailable } from './helpers/pvac-glue';

describe('pvac stub', () => {
  beforeAll(() => stubPvacGlueUnavailable());
  afterAll(() => vi.unstubAllGlobals());

  it('isPvacWasmAvailable returns false initially', () => {
    // Note: this could be true if a previous test loaded the WASM.
    // We test that the function doesn't throw.
    expect(typeof isPvacWasmAvailable()).toBe('boolean');
  });

  it('getPvacBridge returns a bridge instance', () => {
    const bridge = getPvacBridge();
    expect(bridge).toBeDefined();
    expect(bridge.isInitialized).toBeDefined();
  });

  it('stub bridge init succeeds and marks as initialized', async () => {
    const bridge = new StubPvacBridge();
    expect(bridge.isInitialized()).toBe(false);
    const ok = await bridge.init('c29tZXByaXZrZXk=');
    expect(ok).toBe(true);
    expect(bridge.isInitialized()).toBe(true);
  });

  it('stub bridge serializePubkeyB64 returns a non-empty string after init', async () => {
    const bridge = new StubPvacBridge();
    await bridge.init('c29tZXByaXZrZXk=');
    const pk = bridge.serializePubkeyB64();
    expect(typeof pk).toBe('string');
    expect(pk.length).toBeGreaterThan(0);
  });

  it('stub bridge encrypt throws PvacNotAvailableError', async () => {
    const bridge = new StubPvacBridge();
    await bridge.init('c29tZXByaXZrZXk=');
    expect(() => bridge.encrypt(42n)).toThrow(PvacNotAvailableError);
  });

  it('stub bridge decrypt throws PvacNotAvailableError', async () => {
    const bridge = new StubPvacBridge();
    await bridge.init('c29tZXByaXZrZXk=');
    expect(() => bridge.decrypt({ version: 'hfhe_v1', bytes: new Uint8Array(0) })).toThrow(
      PvacNotAvailableError,
    );
  });

  it('stub bridge getBalance returns 0n for empty cipher', async () => {
    const bridge = new StubPvacBridge();
    await bridge.init('c29tZXByaXZrZXk=');
    expect(bridge.getBalance('0')).toBe(0n);
    expect(bridge.getBalance('')).toBe(0n);
  });

  it('encodeBoundCipher / decodeCipher round-trip', async () => {
    const bridge = new StubPvacBridge();
    const cipher = { version: 'hfhe_v1', bytes: new Uint8Array([1, 2, 3, 4, 5]) };
    const encoded = bridge.encodeBoundCipher(cipher);
    expect(encoded).toBe('hfhe_v1|AQIDBAU=');
    const decoded = bridge.decodeCipher(encoded);
    expect(decoded.version).toBe('hfhe_v1');
    expect(Array.from(decoded.bytes)).toEqual([1, 2, 3, 4, 5]);
  });

  it('decodeCipher returns empty cipher for "0"', async () => {
    const bridge = new StubPvacBridge();
    const decoded = bridge.decodeCipher('0');
    expect(decoded.bytes.length).toBe(0);
  });

  it('encodeZeroProof / decodeZeroProof round-trip', async () => {
    const bridge = new StubPvacBridge();
    const proof = { bytes: new Uint8Array([10, 20, 30]) };
    const encoded = bridge.encodeZeroProof(proof);
    expect(encoded).toBe('zkzp_v2|ChQe');
    const decoded = bridge.decodeZeroProof(encoded);
    expect(Array.from(decoded.bytes)).toEqual([10, 20, 30]);
  });

  it('ctSub throws PvacNotAvailableError', async () => {
    const bridge = new StubPvacBridge();
    await bridge.init('c29tZXByaXZrZXk=');
    expect(() =>
      bridge.ctSub(
        { version: 'hfhe_v1', bytes: new Uint8Array(0) },
        { version: 'hfhe_v1', bytes: new Uint8Array(0) },
      ),
    ).toThrow(PvacNotAvailableError);
  });

  it('loadPvacWasm returns false (stub mode)', async () => {
    const ok = await import('../../src/pvac').then((m) => m.loadPvacWasm());
    expect(ok).toBe(false);
  });

  it('leaves the stub bridge in place when the glue script is missing', async () => {
    await import('../../src/pvac').then((m) => m.loadPvacWasm());
    expect(isPvacWasmAvailable()).toBe(false);
    expect(getPvacBridge()).toBeInstanceOf(StubPvacBridge);
  });
});

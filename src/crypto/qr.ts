/**
 * Minimal QR code encoder (byte mode, ECC level L/M) — dependency-free.
 *
 * Implements just enough of ISO/IEC 18004 to encode short ASCII payloads such
 * as an Octra address. Supports versions 1..10, which covers up to ~150 bytes
 * at ECC level M — far more than the 47-char address we need.
 */

// ─── Galois field (GF(256)) tables for Reed–Solomon ───────────────────
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[(LOG[a]! + LOG[b]!) % 255]!;
}

/** Build the RS generator polynomial of the given degree. */
function rsGenerator(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]!;
      next[j + 1] ^= gfMul(poly[j]!, EXP[i]!);
    }
    poly = next;
  }
  return poly;
}

/** Compute RS error-correction codewords for a data block. */
function rsEncode(data: Uint8Array, ecLen: number): Uint8Array {
  const gen = rsGenerator(ecLen);
  const res = new Uint8Array(data.length + ecLen);
  res.set(data);
  for (let i = 0; i < data.length; i++) {
    const factor = res[i]!;
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j++) {
      res[i + j] ^= gfMul(gen[j]!, factor);
    }
  }
  return res.subarray(data.length);
}

// ─── Version/ECC capacity tables (ECC level M, versions 1..10) ────────
// [totalCodewords, ecCodewordsPerBlock, group1Blocks, group1DataCodewords,
//  group2Blocks, group2DataCodewords]
const VERSION_M: Array<[number, number, number, number, number, number]> = [
  [26, 10, 1, 16, 0, 0], // v1
  [44, 16, 1, 28, 0, 0], // v2
  [70, 26, 1, 44, 0, 0], // v3
  [100, 18, 2, 32, 0, 0], // v4
  [134, 24, 2, 43, 0, 0], // v5
  [172, 16, 4, 27, 0, 0], // v6
  [196, 18, 4, 31, 0, 0], // v7
  [242, 22, 2, 38, 2, 39], // v8
  [292, 22, 3, 36, 2, 37], // v9
  [346, 26, 4, 43, 1, 44], // v10
];

const ALIGNMENT_POS: number[][] = [
  [], // v1
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

/** Bit writer (MSB first). */
class BitBuffer {
  private bits: number[] = [];
  put(value: number, length: number) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  get length() {
    return this.bits.length;
  }
  toBytes(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((b, i) => {
      if (b) out[i >>> 3]! |= 0x80 >>> (i % 8);
    });
    return out;
  }
}

export interface QrResult {
  size: number;
  /** size*size booleans, true = dark module. */
  modules: boolean[];
}

/**
 * Encode a string into QR modules (ECC level M).
 * Throws when the payload does not fit into version 10.
 */
export function encodeQr(text: string): QrResult {
  const data = new TextEncoder().encode(text);

  // Pick the smallest version that fits.
  let version = -1;
  let spec: [number, number, number, number, number, number] | null = null;
  for (let v = 0; v < VERSION_M.length; v++) {
    const s = VERSION_M[v]!;
    const dataCodewords = s[2] * s[3] + s[4] * s[5];
    const lenBits = v + 1 < 10 ? 8 : 16;
    const needed = Math.ceil((4 + lenBits + data.length * 8) / 8);
    if (needed <= dataCodewords) {
      version = v + 1;
      spec = s;
      break;
    }
  }
  if (version < 0 || !spec) throw new Error('QR: payload too large');

  const [, ecLen, g1Blocks, g1Data, g2Blocks, g2Data] = spec;
  const totalData = g1Blocks * g1Data + g2Blocks * g2Data;

  // ── Build the bitstream: mode(4) + length + payload + terminator ──
  const bb = new BitBuffer();
  bb.put(0b0100, 4); // byte mode
  bb.put(data.length, version < 10 ? 8 : 16);
  for (const byte of data) bb.put(byte, 8);
  const capacityBits = totalData * 8;
  bb.put(0, Math.min(4, capacityBits - bb.length)); // terminator

  const dataBytes = bb.toBytes();
  const bytes = new Uint8Array(totalData);
  bytes.set(dataBytes.subarray(0, Math.min(dataBytes.length, totalData)));
  // Pad with the spec's alternating 0xEC / 0x11 filler bytes.
  for (let i = dataBytes.length, alt = 0; i < totalData; i++, alt++) {
    bytes[i] = alt % 2 === 0 ? 0xec : 0x11;
  }

  // ── Split into blocks, compute EC, then interleave ──
  const blocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (let i = 0; i < g1Blocks; i++) {
    const b = bytes.slice(offset, offset + g1Data);
    offset += g1Data;
    blocks.push(b);
    ecBlocks.push(rsEncode(b, ecLen));
  }
  for (let i = 0; i < g2Blocks; i++) {
    const b = bytes.slice(offset, offset + g2Data);
    offset += g2Data;
    blocks.push(b);
    ecBlocks.push(rsEncode(b, ecLen));
  }

  const finalBytes: number[] = [];
  const maxData = Math.max(g1Data, g2Data || 0);
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.length) finalBytes.push(b[i]!);
  }
  for (let i = 0; i < ecLen; i++) {
    for (const b of ecBlocks) finalBytes.push(b[i]!);
  }

  // ── Lay out the matrix ──
  const size = version * 4 + 17;
  const modules: (boolean | null)[] = new Array(size * size).fill(null);
  const at = (r: number, c: number) => r * size + c;

  const placeFinder = (row: number, col: number) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r;
        const cc = col + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const dark =
          (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        modules[at(rr, cc)] = dark;
      }
    }
  };
  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    modules[at(6, i)] = i % 2 === 0;
    modules[at(i, 6)] = i % 2 === 0;
  }

  // Alignment patterns
  const aligns = ALIGNMENT_POS[version - 1]!;
  for (const r of aligns) {
    for (const c of aligns) {
      // Skip the three finder corners
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6))
        continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          modules[at(r + dr, c + dc)] = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
        }
      }
    }
  }

  // Dark module + reserved format areas
  modules[at(size - 8, 8)] = true;
  const reserveFormat = () => {
    for (let i = 0; i < 9; i++) {
      if (modules[at(8, i)] === null) modules[at(8, i)] = false;
      if (modules[at(i, 8)] === null) modules[at(i, 8)] = false;
    }
    // Copy 2 spans 8 modules on each edge: columns size-8..size-1 on row 8,
    // and rows size-8..size-1 on column 8. Although the format *bits* only
    // fill 7 of the top-right cells, (8, size-8) is still a reserved
    // function module — treating it as data shifts the whole bitstream and
    // makes the symbol undecodable.
    for (let i = 0; i < 8; i++) {
      if (modules[at(8, size - 1 - i)] === null) modules[at(8, size - 1 - i)] = false;
      if (modules[at(size - 1 - i, 8)] === null) modules[at(size - 1 - i, 8)] = false;
    }
  };
  reserveFormat();

  // ── Place data bits (zig-zag, bottom-right upward) ──
  let bitIdx = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // skip vertical timing column
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        if (modules[at(row, cc)] !== null) continue;
        let dark = false;
        if (bitIdx < finalBytes.length * 8) {
          dark = ((finalBytes[bitIdx >>> 3]! >>> (7 - (bitIdx % 8))) & 1) === 1;
        }
        bitIdx++;
        // Mask 0: (row + col) % 2 === 0
        if ((row + cc) % 2 === 0) dark = !dark;
        modules[at(row, cc)] = dark;
      }
    }
    upward = !upward;
  }

  // ── Format info (ECC M = 0b00, mask 0) with BCH(15,5) ──
  const formatBits = (() => {
    const data5 = 0b00000; // ECC M (00) | mask 0 (000)
    let d = data5 << 10;
    const gen = 0b10100110111;
    for (let i = 4; i >= 0; i--) {
      if ((d >>> (i + 10)) & 1) d ^= gen << i;
    }
    return ((data5 << 10) | d) ^ 0b101010000010010;
  })();

  for (let i = 0; i < 15; i++) {
    // Format bits are placed MSB-first: index i corresponds to bit (14 - i).
    const bit = ((formatBits >>> (14 - i)) & 1) === 1;
    // Copy 1: around the top-left finder
    if (i < 6) modules[at(8, i)] = bit;
    else if (i < 8) modules[at(8, i + 1)] = bit;
    else if (i === 8) modules[at(7, 8)] = bit;
    else modules[at(14 - i, 8)] = bit;
    // Copy 2: bits 0..6 run up the bottom-left edge, 7..14 along the top-right.
    if (i < 7) modules[at(size - 1 - i, 8)] = bit;
    else modules[at(8, size - 15 + i)] = bit;
  }

  // Re-assert the fixed dark module (spec: always dark, never format data).
  modules[at(size - 8, 8)] = true;

  return { size, modules: modules.map((m) => m === true) };
}

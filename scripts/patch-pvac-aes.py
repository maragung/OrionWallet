#!/usr/bin/env python3
"""
Patch the PVAC source to add a software AES fallback for WASM builds.

The original PVAC requires hardware AES (AES-NI on x86 or ARM crypto extensions).
WASM doesn't have native AES instructions, so we add a pure-software
implementation as a third path. The software AES is slower (~5-10x) but
produces identical output and is good enough for browser use.

This patch only activates when neither AES-NI nor ARM AES is available
(i.e., when compiling to WASM). It does NOT modify the original AESNI
or ARM AES paths.
"""

import sys
from pathlib import Path

LPN_HPP_REL = "include/pvac/crypto/lpn.hpp"

PATCH_MARKER = '#error "hfhe requires hardware AES support'

SOFTWARE_AES_IMPL = r'''
#define PVAC_USE_SOFTWARE_AES 1

// ---- Software AES-256 (portable, no hardware dependencies) ----
// Used when compiling to WASM or other targets without AES-NI/ARM-AES.
// ~5-10x slower than hardware but produces identical ciphertext.
// NOTE: This block is inserted INSIDE namespace pvac { ... }, so the
// nested `namespace software_aes` becomes pvac::software_aes as expected.

namespace software_aes {

constexpr uint8_t sbox[256] = {
    0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
    0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
    0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
    0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
    0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
    0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
    0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
    0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
    0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
    0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
    0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
    0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
    0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
    0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
    0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
    0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16
};

constexpr uint8_t rcon[7] = {0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40};

inline uint8_t xtime(uint8_t x) {
    return (uint8_t)((x << 1) ^ (((x >> 7) & 1) * 0x1b));
}

inline uint32_t sub_word(uint32_t w) {
    return ((uint32_t)sbox[(w >> 24) & 0xff] << 24)
         | ((uint32_t)sbox[(w >> 16) & 0xff] << 16)
         | ((uint32_t)sbox[(w >>  8) & 0xff] <<  8)
         | ((uint32_t)sbox[(w >>  0) & 0xff] <<  0);
}

inline uint32_t rot_word(uint32_t w) {
    return (w >> 8) | (w << 24);
}

inline void key_expand_256(const uint8_t key[32], uint8_t rk_out[240]) {
    uint32_t w[60];
    std::memcpy(w, key, 32);
    for (int i = 8; i < 60; ++i) {
        uint32_t t = w[i - 1];
        if (i % 8 == 0) {
            t = sub_word(rot_word(t)) ^ ((uint32_t)rcon[i / 8 - 1]);
        } else if (i % 8 == 4) {
            t = sub_word(t);
        }
        w[i] = w[i - 8] ^ t;
    }
    std::memcpy(rk_out, w, 240);
}

// AES-256 single-block encrypt (16 bytes in, 16 bytes out, 240-byte key schedule)
inline void encrypt_block(const uint8_t in[16], const uint8_t rk[240], uint8_t out[16]) {
    uint8_t state[16];
    std::memcpy(state, in, 16);
    // AddRoundKey round 0
    for (int i = 0; i < 16; ++i) state[i] ^= rk[i];
    // Rounds 1..13: SubBytes, ShiftRows, MixColumns, AddRoundKey
    for (int round = 1; round <= 13; ++round) {
        uint8_t tmp[16];
        // SubBytes
        for (int i = 0; i < 16; ++i) tmp[i] = sbox[state[i]];
        // ShiftRows (state is column-major in AES spec; here we treat tmp as 4x4 column-major)
        // Row 0: no shift, Row 1: shift left 1, Row 2: shift left 2, Row 3: shift left 3
        uint8_t shifted[16];
        for (int row = 0; row < 4; ++row) {
            for (int col = 0; col < 4; ++col) {
                shifted[col * 4 + row] = tmp[((col + row) % 4) * 4 + row];
            }
        }
        // MixColumns
        for (int col = 0; col < 4; ++col) {
            uint8_t* c = &shifted[col * 4];
            uint8_t a0 = c[0], a1 = c[1], a2 = c[2], a3 = c[3];
            uint8_t t = a0 ^ a1 ^ a2 ^ a3;
            c[0] ^= t ^ xtime(a0 ^ a1);
            c[1] ^= t ^ xtime(a1 ^ a2);
            c[2] ^= t ^ xtime(a2 ^ a3);
            c[3] ^= t ^ xtime(a3 ^ a0);
        }
        // AddRoundKey
        for (int i = 0; i < 16; ++i) state[i] = shifted[i] ^ rk[round * 16 + i];
    }
    // Final round: SubBytes, ShiftRows, AddRoundKey (no MixColumns)
    uint8_t tmp[16];
    for (int i = 0; i < 16; ++i) tmp[i] = sbox[state[i]];
    uint8_t shifted[16];
    for (int row = 0; row < 4; ++row) {
        for (int col = 0; col < 4; ++col) {
            shifted[col * 4 + row] = tmp[((col + row) % 4) * 4 + row];
        }
    }
    for (int i = 0; i < 16; ++i) out[i] = shifted[i] ^ rk[14 * 16 + i];
}

} // namespace software_aes

struct AesCtr256 {
    alignas(16) uint8_t rk[240];  // 15 round keys x 16 bytes
    uint64_t ctr_val;
    alignas(16) uint64_t buf[2] = {0, 0};
    bool has_buf = false;

    void init(const uint8_t key[32], uint64_t nonce) {
        software_aes::key_expand_256(key, rk);
        ctr_val = nonce;
        has_buf = false;
    }

    inline void encrypt_ctr_block(uint8_t out[16]) {
        alignas(16) uint8_t ctr_block[16] = {0};
        std::memcpy(ctr_block, &ctr_val, 8);
        software_aes::encrypt_block(ctr_block, rk, out);
        ++ctr_val;
    }

    inline uint64_t next_u64() {
        if (has_buf) {
            has_buf = false;
            return buf[1];
        }
        alignas(16) uint8_t tmp[16];
        encrypt_ctr_block(tmp);
        std::memcpy(buf, tmp, 16);
        has_buf = true;
        return buf[0];
    }

    inline void fill_u64(uint64_t* out, size_t n) {
        size_t i = 0;
        if (has_buf && n > 0) {
            out[0] = buf[1];
            has_buf = false;
            i = 1;
        }
        alignas(16) uint8_t tmp[16];
        alignas(16) uint64_t pair[2];
        for (; i + 1 < n; i += 2) {
            encrypt_ctr_block(tmp);
            std::memcpy(pair, tmp, 16);
            out[i] = pair[0];
            out[i + 1] = pair[1];
        }
        if (i < n) {
            encrypt_ctr_block(tmp);
            std::memcpy(buf, tmp, 16);
            out[i] = buf[0];
            has_buf = true;
        }
    }

    inline uint64_t bounded(uint64_t M) {
        if (M <= 1) return 0;
        uint64_t lim = UINT64_MAX - (UINT64_MAX % M);
        for (;;) {
            uint64_t x = next_u64();
            if (x < lim) return x % M;
        }
    }
};

// end software AES path
'''

def main():
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <pvac-source-dir>", file=sys.stderr)
        sys.exit(1)
    pvac_dir = Path(sys.argv[1])
    lpn_path = pvac_dir / LPN_HPP_REL
    if not lpn_path.exists():
        print(f"ERROR: {lpn_path} not found", file=sys.stderr)
        sys.exit(1)

    content = lpn_path.read_text()
    if "PVAC_USE_SOFTWARE_AES" in content:
        print(f"Already patched: {lpn_path}")
        return

    if PATCH_MARKER not in content:
        print(f"ERROR: Patch marker not found in {lpn_path}", file=sys.stderr)
        sys.exit(1)

    # Replace the #error with software AES implementation
    # Need to find the matching #endif to insert before it
    error_idx = content.index(PATCH_MARKER)
    # Find the next #endif after the error
    endif_idx = content.index("#endif", error_idx)
    # Replace from the #error line up to (not including) the #endif
    # Find the start of the #error line
    line_start = content.rfind("\n", 0, error_idx) + 1
    # Find the end of the #error line (including newline)
    line_end = content.index("\n", error_idx) + 1
    # Replace just the #error line with the software AES impl
    new_content = content[:line_start] + SOFTWARE_AES_IMPL + content[line_end:]

    # Backup original
    backup = lpn_path.with_suffix(".hpp.bak")
    if not backup.exists():
        backup.write_text(content)
    lpn_path.write_text(new_content)
    print(f"Patched: {lpn_path}")
    print(f"Backup:  {backup}")

if __name__ == "__main__":
    main()

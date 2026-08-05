# PVAC (Private Verifiable Arithmetic Computation) — WASM Port

## Status

**Complete.** The C++ PVAC library is compiled to WebAssembly and wired into the wallet.
`WasmPvacBridge` (`src/pvac/wasm-bridge.ts`) implements the full `IPvacBridge` surface
against the compiled C API.

The stub (`StubPvacBridge` in `src/pvac/index.ts`) remains as the fallback when the module
cannot be loaded — PVAC is optional, and every standard wallet feature works without it.

| Artifact | Path | Size |
|---|---|---|
| WASM binary | `public/wasm/pvac.wasm` | ~664 KB |
| ES6 glue | `public/wasm/pvac.js` | ~67 KB |

---

## Why WASM rather than a TypeScript rewrite

PVAC is roughly 3000 lines of header-only C++ implementing:

- ristretto255 group arithmetic (constant-time)
- Bulletproofs (R1CS, inner-product arguments, range proofs)
- LPN (Learning Parity with Noise) — the FHE scheme core
- Toeplitz matrices for LPN evaluation
- Prime-field arithmetic
- Homomorphic encrypt / decrypt / arithmetic / recrypt
- Pedersen commitments and zero-knowledge proofs

Reimplementing that in TypeScript would take months and risk subtle, hard-to-detect
cryptographic bugs. Compiling the existing reviewed C++ is the safer path.

---

## Building

### Prerequisites

- Emscripten SDK, activated in the current shell
- The `pvac/` directory from `octra-labs/webcli`

### Steps

```bash
# 1. Emscripten
git clone https://github.com/emscripten-core/emsdk.git /tmp/emsdk
cd /tmp/emsdk && ./emsdk install latest && ./emsdk activate latest
source /tmp/emsdk/emsdk_env.sh

# 2. PVAC source
git clone https://github.com/octra-labs/webcli ../webcli-source

# 3. Software AES patch (required — see below)
python3 scripts/patch-pvac-aes.py ../webcli-source/pvac

# 4. Compile
npm run build:wasm
```

`scripts/build-wasm.sh` discovers exported functions by scanning `pvac_c_api.h` for every
`pvac_<name>(` token, regardless of return type. An earlier return-type-anchored regex
silently dropped pointer-returning functions such as
`uint8_t* pvac_serialize_cipher(...)`, which broke cipher and proof serialization — and
therefore encrypt/decrypt — in a way that surfaced only as the node rejecting transactions
as "malformed".

---

## The software AES patch

PVAC hard-`#error`s unless hardware AES is available (AES-NI on x86_64, crypto extensions
on aarch64). WebAssembly exposes neither, so `pvac_c_api.cpp` will not compile for
`wasm32-unknown-emscripten` without modification:

```
error: "hfhe requires hardware AES support (x86_64 with -maes or aarch64 with crypto extensions)"
error: unknown type name 'AesCtr256'
```

`scripts/patch-pvac-aes.py` replaces that `#error` with a portable software AES-256
implementation plus a matching `AesCtr256` CTR-mode wrapper.

Properties:

- **Additive.** The AES-NI and ARM paths are untouched; the software path activates only
  when neither is available.
- **Output-identical.** Same ciphertext as the hardware paths.
- **Slower.** Roughly 5–10× the cost of hardware AES.
- **Idempotent.** Re-running is a no-op, and the original is saved as `lpn.hpp.bak`.

---

## Compile flags

```
-O3 -std=c++17 -fPIC
-s WASM=1 -s MODULARIZE=1 -s EXPORT_ES6=1
-s EXPORT_NAME="createPvacModule"
-s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=64MB -s MAXIMUM_MEMORY=512MB
-s EXPORTED_RUNTIME_METHODS="['ccall','cwrap','getValue','setValue',
                              'HEAPU8','HEAP32','HEAP64',
                              'UTF8ToString','stringToUTF8','lengthBytesUTF8']"
-s EXPORTED_FUNCTIONS="[<all pvac_* from the header>,_malloc,_free]"
```

### Threading

Not enabled. Adding `-pthread -s PTHREAD_POOL_SIZE=4` would speed up recrypt and proof
generation, but requires SharedArrayBuffer and therefore cross-origin isolation. COOP/COEP
are already configured for it, so this remains a viable future step.

---

## Loading

`loadPvacModule` in `src/pvac/wasm-bridge.ts` runs three steps:

1. **Probe.** `HEAD` the glue URL first. Without this, "never built" (404) and "blocked by
   CSP" both surface as an identical opaque module-resolution failure.
2. **Import.** Dynamic `import()` of an **absolute** URL with `/* @vite-ignore */`. It must
   be absolute: a bare specifier fails to resolve, and `./wasm/pvac.js` resolves against the
   bundled asset directory (`/assets/`) and 404s. The URL is anchored to `BASE_URL` so
   sub-path deployments work.
3. **Verify.** Assert all 13 required `_pvac_*` exports are present before installing the
   bridge, so a stale build fails loudly instead of misbehaving later.

### Content-Security-Policy

`script-src` **must** include `'wasm-unsafe-eval'`. The Emscripten glue calls
`WebAssembly.instantiate()`, which Chromium blocks without that directive. Omitting it was
the original cause of the module silently failing to load. The directive permits
WebAssembly compilation only; it does not re-enable JavaScript `eval()`.

### Failure classification

Load failures are classified as `PvacFailureReason`, each mapped to a concrete remedy shown
in Settings:

| Reason | Meaning | Remedy |
|---|---|---|
| `not-built` | `pvac.js` returns 404 | `npm run build:wasm` |
| `csp-blocked` | CSP refuses WebAssembly compilation | Add `'wasm-unsafe-eval'` to `script-src` |
| `missing-exports` | Module lacks required functions | Rebuild — the artifact is stale |
| `init-failed` | Loaded, but FHE keygen failed | Inspect the console |
| `unknown` | Anything else | Inspect the console |

The module promise is reset on failure so **↻ Reload PVAC** retries rather than replaying a
cached rejection.

---

## Memory management

The C API is manual-memory. The rules:

- Every `_malloc` needs a matching `_free`.
- `serialize_*` returns a heap buffer plus a length written through a `size_t*` out-param.
  The buffer **must** be released with `_pvac_free_bytes`, not `_free`.
- Handles from `keygen` / `enc_*` / proof constructors need their matching
  `_pvac_free_pubkey` / `_pvac_free_seckey` / `_pvac_free_cipher` / `_pvac_free_zero_proof`.

Always pair allocation with `try/finally`. `WasmPvacBridge` follows this consistently.

---

## Transport encoding

Mirrors `octra::PvacBridge` in the reference `lib/pvac_bridge.hpp`:

| Value | Encoding |
|---|---|
| Cipher | `hfhe_v1\|` + base64(`pvac_serialize_cipher`) |
| Zero proof | `zkzp_v2\|` + base64(`pvac_serialize_zero_proof`) |
| Bound range proof | `rp_v1\|` + base64(`pvac_serialize_bound_range_proof`) |

---

## Remaining work

- [ ] Move heavy operations into a Web Worker — software AES blocks the main thread
- [ ] Consider enabling pthreads for a 2–4× speedup on recrypt and proof generation
- [ ] Port the C++ test vectors into `tests/unit/` for cross-implementation verification
- [ ] Benchmark encrypt/decrypt latency across browsers and document expectations

---

## License

The PVAC source is GPL-2.0-only (with OpenSSL exemption). Any WASM artifact compiled from
it inherits that license and must be distributed accordingly.

#!/usr/bin/env bash
# Build the PVAC WASM module from the original C++ source.
#
# REQUIRES:
#   - Emscripten SDK activated (emcc/em++ in PATH)
#   - Original pvac/ source directory at: ../webcli-source/pvac/
#
# OUTPUTS:
#   - public/wasm/pvac.wasm
#   - public/wasm/pvac.js  (ES6 glue)
#   - public/wasm/pvac.d.ts (TypeScript types)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
SRC_DIR="${PVAC_SRC_DIR:-${ROOT_DIR}/../webcli-source/pvac}"
OUT_DIR="${ROOT_DIR}/public/wasm"

# Auto-detect emsdk
if ! command -v em++ &> /dev/null; then
  if [ -f "/tmp/emsdk/emsdk_env.sh" ]; then
    echo "Activating emsdk from /tmp/emsdk..."
    source /tmp/emsdk/emsdk_env.sh
  else
    echo "ERROR: em++ not found. Install Emscripten SDK:"
    echo "  git clone https://github.com/emscripten-core/emsdk.git /tmp/emsdk"
    echo "  cd /tmp/emsdk && ./emsdk install latest && ./emsdk activate latest"
    echo "  source /tmp/emsdk/emsdk_env.sh"
    exit 1
  fi
fi

echo "PVAC WASM Build Script"
echo "======================"
echo "Source: ${SRC_DIR}"
echo "Output: ${OUT_DIR}"
echo "em++:   $(em++ --version | head -1)"
echo ""

if [ ! -d "${SRC_DIR}" ]; then
  echo "ERROR: PVAC source not found at ${SRC_DIR}"
  echo "Clone the original repo first:"
  echo "  git clone https://github.com/octra-labs/webcli ${ROOT_DIR}/../webcli-source"
  exit 1
fi

mkdir -p "${OUT_DIR}"

# Get all exported C API functions from the header.
# Match every `pvac_<name>(` token regardless of return type (including
# pointer returns like `uint8_t* pvac_serialize_cipher(...)`, which the old
# return-type-anchored regex silently dropped — breaking cipher/proof
# serialization and, with it, encrypt/decrypt).
EXPORTED_FUNCS=$(grep -oE 'pvac_[a-zA-Z0-9_]+[[:space:]]*\(' "${SRC_DIR}/pvac_c_api.h" \
  | sed -E 's/[[:space:]]*\(//' \
  | sed -E 's/^/_/' \
  | sort -u \
  | tr '\n' ',' \
  | sed 's/,$//')

echo "Exported functions: ${EXPORTED_FUNCS:0:200}..."
echo ""

echo "Compiling PVAC to WASM..."
em++ \
  -O3 \
  -std=c++17 \
  -fPIC \
  -I "${SRC_DIR}/include" \
  -s WASM=1 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME="createPvacModule" \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=64MB \
  -s MAXIMUM_MEMORY=512MB \
  -s EXPORTED_RUNTIME_METHODS="['ccall','cwrap','getValue','setValue','HEAPU8','HEAP32','HEAP64','UTF8ToString','stringToUTF8','lengthBytesUTF8']" \
  -s EXPORTED_FUNCTIONS="[${EXPORTED_FUNCS},_malloc,_free]" \
  "${SRC_DIR}/pvac_c_api.cpp" \
  -o "${OUT_DIR}/pvac.js"

echo ""
echo "Build complete!"
ls -lh "${OUT_DIR}/"

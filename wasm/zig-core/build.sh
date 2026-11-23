#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_RAW="$DIR/core.raw.wasm"
OUT_OPT="$DIR/core.wasm"

zig build-exe "$DIR/src/core.zig" \
  -target wasm32-freestanding \
  -OReleaseSmall \
  -fno-entry \
  -rdynamic \
  -femit-bin="$OUT_RAW"

if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -Oz --enable-bulk-memory --enable-sign-ext "$OUT_RAW" -o "$OUT_OPT"
  rm -f "$OUT_RAW"
else
  mv "$OUT_RAW" "$OUT_OPT"
fi

RAW_BYTES=$(wc -c < "$OUT_OPT")
GZ_BYTES=$(gzip -9 -c "$OUT_OPT" | wc -c)
echo "Built $OUT_OPT: ${RAW_BYTES} bytes raw (${GZ_BYTES} bytes gzip)"

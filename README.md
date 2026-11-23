# PWA Kit

Build local-first Progressive Web Apps with a thin SolidJS UI shell and a tiny Zig WebAssembly compute core.

Heavy text processing runs inside a dedicated Web Worker compiled from Zig (~3.1 KB raw, ~1.6 KB gzipped) so the main UI thread stays responsive. Offline persistence falls back cleanly from OPFS to IndexedDB to memory.

## Installation

Requires Node.js 20+ and Zig 0.14+ (Binaryen `wasm-opt` is optional for extra size reduction).

```bash
cd shell && npm install
```

## Quick Start

Build the Zig WebAssembly core and run unit, property, and JS-vs-WASM benchmark tests:

```bash
make test
```

Typecheck, bundle, and preview the PWA locally with `COOP`/`COEP` headers:

```bash
cd shell && npm run typecheck && npm run build && npm run preview
```

## Bundled Zig WASM Kernels

All kernels live in `wasm/zig-core/src/core.zig` with zero heap allocations:

| Export | Algorithm | Memory Model |
| :--- | :--- | :--- |
| `diff_lines` | FNV-1a hashed Myers line diff with compact trace and RLE opcodes | 8 MiB static BSS arena (0 bytes on disk) |
| `strip_ansi` | Single-pass CSI, OSC, and 2-byte ESC stripper preserving UTF-8 | Zero heap, zero GC |
| `fuzzy_score` | Case-insensitive word-boundary and camelCase subsequence scorer | Zero heap, zero GC |

## Repository Structure

```text
pwa-kit/
├── wasm/zig-core/
│   ├── src/core.zig       # Zero-dependency Zig wasm32-freestanding kernels
│   ├── bridge.mjs         # Universal ESM wrapper (Node, Browser, Web Worker)
│   └── build.sh           # zig build-exe + wasm-opt -Oz pipeline
├── shell/
│   ├── src/
│   │   ├── styles/        # Zero-runtime CSS tokens (dark & light, APCA Lc >= 60)
│   │   ├── plugins/       # Composable KernelRegistry
│   │   ├── workers/       # Dedicated Web Worker + typed RPC client
│   │   └── App.tsx        # Thin SolidJS workbench
│   └── public/            # manifest.webmanifest, icon.svg, sw.js
└── tests/
    └── zig-core.test.mjs  # Unit, property, and JS-vs-WASM benchmark tests
```

## Configuration

All host and port settings come from environment variables with loopback defaults (`127.0.0.1:4173`). See [`.env.example`](.env.example).

## License

MIT.

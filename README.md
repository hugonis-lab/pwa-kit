# PWA Kit — Thin SolidJS Shell + Zig WASM Core

A local-first, composable Progressive Web App starter and WebAssembly kernel toolkit built around a strict separation of concerns:

- **Thin Reactive UI Shell (`shell/`)**: Fine-grained **SolidJS** + **Vite** + **Zero-Runtime Static CSS** (`tokens.css` + `app.css`, decoupled from any utility framework or OS theme) with an offline-first Service Worker precache shell and `COOP`/`COEP` headers.
- **Zero-Dependency Zig WASM Core (`wasm/zig-core/`)**: Compiles to a **`~3.1 KB` raw (`~1.6 KB` gzip)** `wasm32-freestanding` binary running inside a dedicated **Web Worker** (`core.worker.ts`) so heavy compute never blocks the main thread or INP budget.
- **Composable Kernel Registry (`shell/src/plugins/registry.ts`)**: Register additional WASM/Worker kernels cleanly without modifying the shell architecture.
- **Local-First Persistence (`shell/src/storage/localStore.ts`)**: Zero-dependency `OPFS → IndexedDB → Memory` workspace snapshot adapter with offline restore/delete.
- **Automated UI Quality Gate CI (`.forgejo/workflows/ui-gate.yaml`)**: Portable workflow running `ui-gate` on every push and pull request.

## Included Zig WASM Kernels (`core.zig`)

| Export | Algorithm | Memory Model |
| :--- | :--- | :--- |
| `diff_lines` | FNV-1a hashed Myers $O(ND)$ line diff with prefix/suffix trim, compact triangular trace, RLE `u32` opcodes, and `max_d` guardrail | Deterministic 8 MiB static BSS bump arena (0 bytes on disk) |
| `strip_ansi` | Single-pass CSI / OSC (BEL & ST) / 2-byte ESC stripper preserving UTF-8 | Zero heap / zero GC |
| `fuzzy_score` | Case-insensitive word-boundary, camelCase, and consecutive-run subsequence scorer | Zero heap / zero GC |

## Quickstart

### Prerequisites
- **Node.js** `>= 20`
- **Zig** `>= 0.14` (tested with `0.17.0`)
- Optional: **Binaryen** (`wasm-opt`) for `-Oz` post-optimization

### Build & Test

```bash
# 1. Compile the Zig WASM core & run unit + randomized property + benchmark tests
make test

# 2. Install shell dependencies and build the production PWA bundle
cd shell && npm install && npm run typecheck && npm run build

# 3. Preview locally with COOP/COEP headers
cd shell && npm run preview
```

## Architecture

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
    └── zig-core.test.mjs  # Unit, property-based reconstruction, & JS vs WASM benchmarks
```

## Configuration (12-Factor)

See [`.env.example`](.env.example). All host/port settings are environment-driven with loopback defaults (`127.0.0.1:4173`).

## License

MIT

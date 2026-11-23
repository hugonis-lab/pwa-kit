import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";
import fs from "node:fs";
import path from "node:path";

// Copies the freshly compiled Zig WASM binary into public/ and dist/ without bundler bloat.
function copyZigWasmPlugin(): Plugin {
  const srcWasm = path.resolve(__dirname, "../wasm/zig-core/core.wasm");
  const destPublic = path.resolve(__dirname, "public/core.wasm");
  return {
    name: "pwa-kit-copy-zig-wasm",
    buildStart() {
      if (fs.existsSync(srcWasm)) {
        fs.mkdirSync(path.dirname(destPublic), { recursive: true });
        fs.copyFileSync(srcWasm, destPublic);
      }
    },
  };
}

// Emits a deterministic precache manifest into sw.js on production build (zero-bloat offline shell).
function offlinePrecachePlugin(): Plugin {
  return {
    name: "pwa-kit-offline-precache",
    apply: "build",
    closeBundle() {
      const distDir = path.resolve(__dirname, "dist");
      if (!fs.existsSync(distDir)) return;
      const assets: string[] = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg", "./core.wasm"];
      const assetsDir = path.join(distDir, "assets");
      if (fs.existsSync(assetsDir)) {
        for (const entry of fs.readdirSync(assetsDir)) {
          assets.push(`./assets/${entry}`);
        }
      }
      const swPath = path.join(distDir, "sw.js");
      if (fs.existsSync(swPath)) {
        const src = fs.readFileSync(swPath, "utf8");
        const version = `pwa-kit-v${Date.now().toString(36)}`;
        const patched = src
          .replace("__PRECACHE_VERSION__", version)
          .replace("/*__PRECACHE_MANIFEST__*/[]", JSON.stringify(assets));
        fs.writeFileSync(swPath, patched, "utf8");
      }
    },
  };
}

export default defineConfig({
  plugins: [copyZigWasmPlugin(), solid(), offlinePrecachePlugin()],
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
  },
  worker: {
    format: "es",
  },
  build: {
    target: "es2022",
    sourcemap: false,
    cssMinify: true,
    assetsInlineLimit: 0,
  },
});

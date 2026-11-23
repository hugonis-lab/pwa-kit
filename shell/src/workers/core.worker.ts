// Dedicated Web Worker hosting the Zig wasm32-freestanding core completely off the main thread.
import { loadCore } from "../../../wasm/zig-core/bridge.mjs";

type CoreInstance = Awaited<ReturnType<typeof loadCore>>;

let corePromise: Promise<{ core: CoreInstance; wasmBytes: number; initMs: number }> | null = null;

async function getCore(wasmUrl?: string) {
  if (!corePromise) {
    corePromise = (async () => {
      const t0 = performance.now();
      const targetUrl = wasmUrl || new URL("/core.wasm", self.location.origin).href;
      const res = await fetch(targetUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${targetUrl}`);
      const buf = await res.arrayBuffer();
      const core = await loadCore(buf);
      return { core, wasmBytes: buf.byteLength, initMs: performance.now() - t0 };
    })();
  }
  return corePromise;
}

// Pure-JS Myers reference inside the worker for fair apples-to-apples browser benchmarking
function jsMyersGuardrail(oldLines: string[], newLines: string[], maxD = 800) {
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (
    prefix + suffix < oldLines.length &&
    prefix + suffix < newLines.length &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }
  const a = oldLines.slice(prefix, oldLines.length - suffix);
  const b = newLines.slice(prefix, newLines.length - suffix);
  const n = a.length;
  const m = b.length;
  const limit = Math.min(maxD, n + m);
  const v = new Int32Array(2 * limit + 1);
  let found = -1;
  for (let d = 0; d <= limit; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[limit + k - 1] < v[limit + k + 1]) ? v[limit + k + 1] : v[limit + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[limit + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  return found;
}

const ANSI_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

self.onmessage = async (ev: MessageEvent<{ id: number; op: string; payload?: Record<string, unknown> }>) => {
  const { id, op, payload = {} } = ev.data;
  try {
    const wasmUrl = typeof payload.wasmUrl === "string" ? payload.wasmUrl : undefined;
    const { core, wasmBytes, initMs } = await getCore(wasmUrl);
    const t0 = performance.now();

    if (op === "init") {
      self.postMessage({
        id,
        ok: true,
        result: {
          wasmBytes,
          initMs,
          arenaCapBytes: core.arenaCapacity(),
        },
      });
      return;
    }

    if (op === "diff") {
      const result = core.computeUnifiedDiff(
        String(payload.oldText ?? ""),
        String(payload.newText ?? ""),
        { contextLines: Number(payload.contextLines ?? 3), maxD: Number(payload.maxD ?? 800) }
      );
      self.postMessage({ id, ok: true, result, elapsedMs: performance.now() - t0 });
      return;
    }

    if (op === "stripAnsi") {
      const cleaned = core.stripAnsi(String(payload.text ?? ""));
      self.postMessage({ id, ok: true, result: { cleaned }, elapsedMs: performance.now() - t0 });
      return;
    }

    if (op === "fuzzyRank") {
      const items = Array.isArray(payload.items) ? (payload.items as string[]) : [];
      const hits = core.fuzzyRank(String(payload.query ?? ""), items, Number(payload.limit ?? 30));
      self.postMessage({ id, ok: true, result: { hits }, elapsedMs: performance.now() - t0 });
      return;
    }

    if (op === "benchmark") {
      // 1. 2500-line 3-hunk edit
      const base = Array.from({ length: 2500 }, (_, i) => `export function fn_${i}(arg) { return arg + ${i}; }`);
      const edited = base.slice();
      edited[15] = "export function fn_15(arg) { return arg * 15; }";
      edited[1250] = "export function fn_1250(arg) { return arg + 12500; }";
      edited.splice(2480, 2, "export function fn_2480_new() { return 42; }");
      const old2500 = base.join("\n");
      const new2500 = edited.join("\n");
      core.computeUnifiedDiff(old2500, new2500); // warmup
      const w0 = performance.now();
      for (let i = 0; i < 10; i++) core.computeUnifiedDiff(old2500, new2500);
      const wasm2500 = (performance.now() - w0) / 10;
      const j0 = performance.now();
      for (let i = 0; i < 10; i++) jsMyersGuardrail(old2500.split("\n"), new2500.split("\n"));
      const js2500 = (performance.now() - j0) / 10;

      // 2. 1800x1800 full-rewrite guardrail
      const a1800 = Array.from({ length: 1800 }, (_, i) => `old_line_payload_${i}`).join("\n");
      const b1800 = Array.from({ length: 1800 }, (_, i) => `new_line_payload_${i}`).join("\n");
      const gw0 = performance.now();
      core.computeUnifiedDiff(a1800, b1800, { maxD: 800 });
      const wasm1800 = performance.now() - gw0;
      const gj0 = performance.now();
      jsMyersGuardrail(a1800.split("\n"), b1800.split("\n"), 800);
      const js1800 = performance.now() - gj0;

      // 3. 300 KB ANSI log strip
      const bigAnsi =
        "\x1b[32m[INFO]\x1b[0m \x1b[1;36mworker\x1b[0m processed 128 frames in \x1b[33m4.2ms\x1b[0m\n".repeat(4000);
      const aw0 = performance.now();
      core.stripAnsi(bigAnsi);
      const wasmAnsi = performance.now() - aw0;
      const aj0 = performance.now();
      bigAnsi.replace(ANSI_RE, "");
      const jsAnsi = performance.now() - aj0;

      self.postMessage({
        id,
        ok: true,
        result: {
          cases: [
            { name: "2500-line 3-hunk diff", wasmMs: wasm2500, jsMs: js2500 },
            { name: "1800x1800 rewrite guardrail", wasmMs: wasm1800, jsMs: js1800 },
            { name: "300 KB ANSI log strip", wasmMs: wasmAnsi, jsMs: jsAnsi },
          ],
        },
        elapsedMs: performance.now() - t0,
      });
      return;
    }

    throw new Error(`Unknown worker op: ${op}`);
  } catch (err) {
    self.postMessage({
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

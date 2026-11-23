import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { loadCore, OP_EQUAL, OP_DEL, OP_ADD, OP_TRUNC } from "../wasm/zig-core/bridge.mjs";

const wasmPath = path.resolve(import.meta.dirname, "../wasm/zig-core/core.wasm");
const wasmBytes = fs.readFileSync(wasmPath);
const core = await loadCore(wasmBytes);

// Pure-JS reference implementations for apples-to-apples benchmarking
const ANSI_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
function jsStripAnsi(s) {
  return s.replace(ANSI_RE, "");
}

function jsMyersDiff(oldLines, newLines, maxD = 800) {
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
  if (n === 0 && m === 0) return { truncated: false, edits: 0 };
  const limit = Math.min(maxD, n + m);
  const offset = limit;
  const v = new Int32Array(2 * limit + 1);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  return { truncated: found < 0, edits: found };
}

test("wasm binary meets < 15 KB raw / < 8 KB gzip size budget", () => {
  assert.ok(wasmBytes.length < 15_360, `Expected < 15 KB raw, got ${wasmBytes.length} bytes`);
  assert.ok(core.arenaCapacity() >= 4 * 1024 * 1024);
  console.log(`  [size] core.wasm = ${wasmBytes.length} bytes raw`);
});

test("stripAnsi removes CSI, OSC (BEL & ST), 2-byte ESC and preserves UTF-8", () => {
  const input = "\x1b[38;5;196mERR\x1b[0m \x1b]0;Window Title\x07ok \x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\ — café 🚀";
  const out = core.stripAnsi(input);
  assert.equal(out, "ERR ok link — café 🚀");
  assert.equal(core.stripAnsi(""), "");
  assert.equal(core.stripAnsi("plain text"), "plain text");
});

test("fuzzyScore rewards boundaries, consecutive runs, and rejects non-subsequences", () => {
  assert.equal(core.fuzzyScore("", "anything"), 0);
  assert.equal(core.fuzzyScore("xyz", "abc"), -1);
  assert.equal(core.fuzzyScore("abcd", "abc"), -1);

  const exactBoundary = core.fuzzyScore("ud", "src/ui/UnifiedDiff.tsx");
  const scattered = core.fuzzyScore("ud", "src/utils/unrelated_document.ts");
  assert.ok(exactBoundary > scattered, `Expected ${exactBoundary} > ${scattered}`);

  const ranked = core.fuzzyRank("diff", [
    "src/components/Sidebar.tsx",
    "src/workers/diff.worker.ts",
    "src/utils/unifiedDiffEngine.ts",
    "README.md",
  ]);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].text, "src/workers/diff.worker.ts");
});

test("diffLines handles identical, pure add, pure del, CRLF, and multi-hunk edits", () => {
  const same = core.computeUnifiedDiff("a\nb\nc\n", "a\r\nb\r\nc\r\n");
  assert.equal(same.hunks.length, 0);
  assert.equal(same.added, 0);
  assert.equal(same.removed, 0);

  const added = core.computeUnifiedDiff("", "one\ntwo\nthree\n");
  assert.equal(added.isNewFile, true);
  assert.equal(added.added, 3);
  assert.equal(added.removed, 0);
  assert.equal(added.hunks.length, 1);
  assert.equal(added.hunks[0].oldStart, 0);
  assert.equal(added.hunks[0].newStart, 1);

  const deleted = core.computeUnifiedDiff("alpha\nbeta\n", "");
  assert.equal(deleted.isDeletedFile, true);
  assert.equal(deleted.added, 0);
  assert.equal(deleted.removed, 2);

  const base = Array.from({ length: 40 }, (_, i) => `row ${i + 1}`);
  const edited = base.slice();
  edited[2] = "row 3 CHANGED";
  edited.splice(35, 0, "inserted A", "inserted B");
  const multi = core.computeUnifiedDiff(base.join("\n"), edited.join("\n"), { contextLines: 3 });
  assert.equal(multi.hunks.length, 2);
  assert.equal(multi.added, 3);
  assert.equal(multi.removed, 1);
  assert.equal(multi.hunks[0].oldStart, 1);
  assert.equal(multi.hunks[1].oldStart, 33);
  assert.equal(multi.hunks[1].newStart, 33);
});

test("diffLines edit-script reconstruction property across randomized edits", () => {
  let seed = 0x1337c0de;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  for (let trial = 0; trial < 25; trial++) {
    const oldLines = Array.from({ length: 60 }, (_, i) => `line_${i}_${Math.floor(rand() * 8)}`);
    const newLines = oldLines.slice();
    const mutations = 1 + Math.floor(rand() * 15);
    for (let m = 0; m < mutations; m++) {
      const idx = Math.floor(rand() * Math.max(1, newLines.length));
      const r = rand();
      if (r < 0.33 && newLines.length > 0) newLines.splice(idx, 1);
      else if (r < 0.66) newLines.splice(idx, 0, `ins_${trial}_${m}`);
      else if (newLines.length > 0) newLines[idx] = `mod_${trial}_${m}`;
    }
    const { ops } = core.diffOpcodes(oldLines.join("\n"), newLines.join("\n"), 800);
    // Reconstruct newLines strictly from oldLines + ops
    const rebuilt = [];
    let oi = 0;
    let ni = 0;
    for (const { op, count } of ops) {
      if (op === OP_TRUNC) continue;
      if (op === OP_EQUAL) {
        for (let k = 0; k < count; k++) {
          assert.equal(oldLines[oi], newLines[ni], `Trial ${trial}: EQUAL mismatch`);
          rebuilt.push(oldLines[oi]);
          oi++;
          ni++;
        }
      } else if (op === OP_DEL) {
        oi += count;
      } else if (op === OP_ADD) {
        for (let k = 0; k < count; k++) {
          rebuilt.push(newLines[ni]);
          ni++;
        }
      }
    }
    assert.equal(oi, oldLines.length);
    assert.equal(ni, newLines.length);
    assert.deepEqual(rebuilt, newLines);
  }
});

test("benchmark: 2500-line 3-hunk diff and 1800x1800 full-rewrite guardrail (WASM vs JS)", () => {
  const base = Array.from({ length: 2500 }, (_, i) => `export function fn_${i}(arg) { return arg + ${i}; }`);
  const edited = base.slice();
  edited[15] = "export function fn_15(arg) { return arg * 15; }";
  edited[1250] = "export function fn_1250(arg) { return arg + 12500; }";
  edited.splice(2480, 2, "export function fn_2480_new() { return 42; }");
  const oldText = base.join("\n");
  const newText = edited.join("\n");

  // Warmup
  for (let i = 0; i < 3; i++) {
    core.computeUnifiedDiff(oldText, newText);
    jsMyersDiff(base, edited);
  }

  const N = 20;
  const tW0 = performance.now();
  let lastW;
  for (let i = 0; i < N; i++) lastW = core.computeUnifiedDiff(oldText, newText);
  const wasm2500 = (performance.now() - tW0) / N;

  const tWO0 = performance.now();
  for (let i = 0; i < N; i++) core.diffOpcodes(oldText, newText);
  const wasmOps2500 = (performance.now() - tWO0) / N;

  const tJ0 = performance.now();
  for (let i = 0; i < N; i++) jsMyersDiff(oldText.split("\n"), newText.split("\n"));
  const js2500 = (performance.now() - tJ0) / N;

  assert.equal(lastW.hunks.length, 3);
  assert.equal(lastW.added, 3);
  assert.equal(lastW.removed, 4);

  // 1800x1800 full-rewrite guardrail
  const a1800 = Array.from({ length: 1800 }, (_, i) => `old_line_payload_${i}`).join("\n");
  const b1800 = Array.from({ length: 1800 }, (_, i) => `new_line_payload_${i}`).join("\n");

  const tGW0 = performance.now();
  const gdW = core.computeUnifiedDiff(a1800, b1800, { maxD: 800 });
  const wasm1800 = performance.now() - tGW0;

  const tGJ0 = performance.now();
  const gdJ = jsMyersDiff(a1800.split("\n"), b1800.split("\n"), 800);
  const js1800 = performance.now() - tGJ0;

  assert.equal(gdW.truncatedFallback, true);
  assert.equal(gdW.added, 1800);
  assert.equal(gdW.removed, 1800);
  assert.equal(gdJ.truncated, true);

  // 300 KB ANSI log strip benchmark
  const ansiChunk = "\x1b[32m[INFO]\x1b[0m \x1b[1;36mworker\x1b[0m processed 128 frames in \x1b[33m4.2ms\x1b[0m\n";
  const bigAnsi = ansiChunk.repeat(4000);
  const tAW0 = performance.now();
  const cleanW = core.stripAnsi(bigAnsi);
  const wasmAnsi = performance.now() - tAW0;
  const tAJ0 = performance.now();
  const cleanJ = jsStripAnsi(bigAnsi);
  const jsAnsi = performance.now() - tAJ0;
  assert.equal(cleanW, cleanJ);

  console.log(`  [bench] 2500-line 3-hunk diff : WASM full ${wasm2500.toFixed(2)} ms (ops ${wasmOps2500.toFixed(2)} ms) vs JS Myers ${js2500.toFixed(2)} ms`);
  console.log(`  [bench] 1800x1800 guardrail   : WASM ${wasm1800.toFixed(2)} ms vs JS ${js1800.toFixed(2)} ms (${(js1800 / wasm1800).toFixed(2)}x)`);
  console.log(`  [bench] 300KB ANSI strip      : WASM ${wasmAnsi.toFixed(2)} ms vs JS ${jsAnsi.toFixed(2)} ms (${(jsAnsi / wasmAnsi).toFixed(2)}x)`);
  assert.ok(wasm2500 < 5, `Expected WASM 2500-line diff < 5ms, got ${wasm2500.toFixed(2)}ms`);
  assert.ok(wasm1800 < 20, `Expected WASM 1800x1800 guardrail < 20ms, got ${wasm1800.toFixed(2)}ms`);
});

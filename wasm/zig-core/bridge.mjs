// Zero-dependency ESM bridge for the Zig wasm32-freestanding core (Node, Browser, Web Worker).
// Zero allocations on the WASM side outside its deterministic bump arena.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const OP_EQUAL = 0;
export const OP_DEL = 1;
export const OP_ADD = 2;
export const OP_TRUNC = 3;

export function splitDiffLines(text) {
  if (!text) return [];
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function computeIntralineSpans(oldStr, newStr) {
  if (!oldStr || !newStr || oldStr === newStr) return null;
  let prefix = 0;
  const minLen = Math.min(oldStr.length, newStr.length);
  while (prefix < minLen && oldStr.charCodeAt(prefix) === newStr.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    oldStr.charCodeAt(oldStr.length - 1 - suffix) === newStr.charCodeAt(newStr.length - 1 - suffix)
  ) {
    suffix++;
  }
  const common = prefix + suffix;
  const maxLen = Math.max(oldStr.length, newStr.length);
  // Ignore trivial indent-only matches
  if (common < 4 || common / maxLen < 0.25) return null;
  const oldEnd = oldStr.length - suffix;
  const newEnd = newStr.length - suffix;
  if (prefix === oldEnd && prefix === newEnd) return null;
  return { oldSpan: [prefix, oldEnd], newSpan: [prefix, newEnd] };
}

async function instantiateInput(input) {
  if (input instanceof WebAssembly.Module) {
    return WebAssembly.instantiate(input, {});
  }
  if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
    const bytes = input instanceof ArrayBuffer ? input : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return instance;
  }
  if (typeof Response !== "undefined" && input instanceof Response) {
    if (typeof WebAssembly.instantiateStreaming === "function") {
      try {
        const { instance } = await WebAssembly.instantiateStreaming(input.clone(), {});
        return instance;
      } catch {
        // Fallback when MIME type is not application/wasm
      }
    }
    const { instance } = await WebAssembly.instantiate(await input.arrayBuffer(), {});
    return instance;
  }
  if (typeof input === "string" || input instanceof URL) {
    const res = await fetch(input);
    if (!res.ok) throw new Error(`Failed to fetch WASM binary: ${res.status} ${res.statusText}`);
    return instantiateInput(res);
  }
  throw new TypeError("loadCore expects ArrayBuffer, TypedArray, WebAssembly.Module, Response, URL, or fetchable URL string");
}

export async function loadCore(wasmInput) {
  const instance = await instantiateInput(wasmInput);
  const exports = instance.exports;
  const memory = exports.memory;

  function memU8() {
    return new Uint8Array(memory.buffer);
  }
  function memU32() {
    return new Uint32Array(memory.buffer);
  }

  function writeUtf8(str) {
    // Worst case UTF-8 expansion is 3 bytes per UTF-16 code unit
    const maxBytes = str.length * 3 + 1;
    const ptr = exports.wasm_alloc(maxBytes);
    if (ptr === 0) throw new RangeError("WASM scratch arena exhausted");
    const target = new Uint8Array(memory.buffer, ptr, maxBytes);
    const { written } = enc.encodeInto(str, target);
    return { ptr, len: written };
  }

  function stripAnsi(input) {
    if (!input) return "";
    exports.wasm_reset();
    const { ptr: srcPtr, len: srcLen } = writeUtf8(input);
    const dstPtr = exports.wasm_alloc(srcLen + 1);
    if (dstPtr === 0) throw new RangeError("WASM scratch arena exhausted");
    const outLen = exports.strip_ansi(srcPtr, srcLen, dstPtr);
    return dec.decode(memU8().subarray(dstPtr, dstPtr + outLen));
  }

  function fuzzyScore(query, target) {
    if (!query) return 0;
    if (!target || query.length > target.length) return -1;
    exports.wasm_reset();
    const q = writeUtf8(query);
    const t = writeUtf8(target);
    return exports.fuzzy_score(q.ptr, q.len, t.ptr, t.len);
  }

  function fuzzyRank(query, items, limit = 50) {
    const qStr = query || "";
    if (!qStr) {
      return items.slice(0, limit).map((text, index) => ({ index, text, score: 0 }));
    }
    exports.wasm_reset();
    const q = writeUtf8(qStr);
    const qSavedArena = exports.wasm_arena_used();
    const hits = [];
    for (let i = 0; i < items.length; i++) {
      const text = items[i];
      if (!text || qStr.length > text.length) continue;
      // Allocate target right after query, then reset arena back to query mark via scratch slice
      const tBytes = enc.encode(text);
      const tPtr = exports.wasm_alloc(tBytes.length + 1);
      if (tPtr === 0) {
        exports.wasm_reset();
        const q2 = writeUtf8(qStr);
        const t2 = writeUtf8(text);
        const sc = exports.fuzzy_score(q2.ptr, q2.len, t2.ptr, t2.len);
        if (sc >= 0) hits.push({ index: i, text, score: sc });
        continue;
      }
      memU8().set(tBytes, tPtr);
      const sc = exports.fuzzy_score(q.ptr, q.len, tPtr, tBytes.length);
      if (sc >= 0) hits.push({ index: i, text, score: sc });
      // Avoid exhausting 4 MiB arena across huge candidate lists
      if (exports.wasm_arena_used() > exports.wasm_arena_cap() - 65536) {
        exports.wasm_reset();
        writeUtf8(qStr);
      }
    }
    void qSavedArena;
    hits.sort((a, b) => b.score - a.score || a.text.length - b.text.length);
    return hits.slice(0, limit);
  }

  function diffOpcodes(oldText, newText, maxD = 800) {
    exports.wasm_reset();
    const a = writeUtf8(oldText || "");
    const b = writeUtf8(newText || "");
    const outCap = 65536;
    const outPtr = exports.wasm_alloc(outCap * 4);
    if (outPtr === 0) throw new RangeError("WASM scratch arena exhausted");
    const count = exports.diff_lines(a.ptr, a.len, b.ptr, b.len, maxD, outPtr, outCap);
    if (count < 0) throw new RangeError("WASM diff_lines returned OOM");
    const view = memU32().subarray(outPtr >>> 2, (outPtr >>> 2) + count);
    const ops = new Array(count);
    let truncatedFallback = false;
    for (let i = 0; i < count; i++) {
      const packed = view[i];
      const op = packed >>> 30;
      const n = packed & 0x3fffffff;
      if (op === OP_TRUNC) {
        truncatedFallback = true;
      }
      ops[i] = { op, count: n };
    }
    return { ops, truncatedFallback };
  }

  function computeUnifiedDiff(oldText, newText, opts = {}) {
    const contextLines = opts.contextLines ?? 3;
    const maxD = opts.maxD ?? 800;
    const oldLines = splitDiffLines(oldText || "");
    const newLines = splitDiffLines(newText || "");
    const isNewFile = oldLines.length === 0 && newLines.length > 0;
    const isDeletedFile = oldLines.length > 0 && newLines.length === 0;

    if (oldLines.length === 0 && newLines.length === 0) {
      return { hunks: [], added: 0, removed: 0, isNewFile: false, isDeletedFile: false, truncatedFallback: false };
    }

    const { ops, truncatedFallback } = diffOpcodes(oldText || "", newText || "", maxD);

    // Compute stats and hunk windows directly from compact RLE opcodes (avoids allocating
    // JS line objects for thousands of unchanged lines outside context windows).
    const runs = [];
    let oi = 0;
    let ni = 0;
    let added = 0;
    let removed = 0;
    let pos = 0;

    for (const { op, count } of ops) {
      if (op === OP_TRUNC) continue;
      if (op === OP_EQUAL) {
        runs.push({ op, count, oi, ni, start: pos, end: pos + count });
        oi += count;
        ni += count;
        pos += count;
      } else if (op === OP_DEL) {
        runs.push({ op, count, oi, ni, start: pos, end: pos + count });
        oi += count;
        removed += count;
        pos += count;
      } else if (op === OP_ADD) {
        runs.push({ op, count, oi, ni, start: pos, end: pos + count });
        ni += count;
        added += count;
        pos += count;
      }
    }

    if (added === 0 && removed === 0) {
      return { hunks: [], added: 0, removed: 0, isNewFile, isDeletedFile, truncatedFallback };
    }

    // Merge [start - contextLines, end + contextLines] windows across change runs
    const ranges = [];
    for (const r of runs) {
      if (r.op === OP_EQUAL) continue;
      const wStart = Math.max(0, r.start - contextLines);
      const wEnd = Math.min(pos, r.end + contextLines);
      if (ranges.length > 0 && wStart <= ranges[ranges.length - 1][1]) {
        ranges[ranges.length - 1][1] = Math.max(ranges[ranges.length - 1][1], wEnd);
      } else {
        ranges.push([wStart, wEnd]);
      }
    }

    // Materialize only the lines falling inside each hunk window
    let runIdx = 0;
    const hunks = ranges.map(([wStart, wEnd]) => {
      const lines = [];
      while (runIdx < runs.length && runs[runIdx].end <= wStart) runIdx++;
      let j = runIdx;
      while (j < runs.length && runs[j].start < wEnd) {
        const r = runs[j];
        const segStart = Math.max(wStart, r.start);
        const segEnd = Math.min(wEnd, r.end);
        const off = segStart - r.start;
        const len = segEnd - segStart;
        if (r.op === OP_EQUAL) {
          for (let k = 0; k < len; k++) {
            lines.push({
              type: "ctx",
              oldLine: r.oi + off + k + 1,
              newLine: r.ni + off + k + 1,
              text: oldLines[r.oi + off + k],
            });
          }
        } else if (r.op === OP_DEL) {
          for (let k = 0; k < len; k++) {
            lines.push({
              type: "del",
              oldLine: r.oi + off + k + 1,
              newLine: null,
              text: oldLines[r.oi + off + k],
            });
          }
        } else if (r.op === OP_ADD) {
          for (let k = 0; k < len; k++) {
            lines.push({
              type: "add",
              oldLine: null,
              newLine: r.ni + off + k + 1,
              text: newLines[r.ni + off + k],
            });
          }
        }
        j++;
      }

      // Pair adjacent 1:1 del/add blocks for intraline highlights
      if (!truncatedFallback) {
        let i = 0;
        while (i < lines.length) {
          if (lines[i].type === "del") {
            const delStart = i;
            while (i < lines.length && lines[i].type === "del") i++;
            const addStart = i;
            while (i < lines.length && lines[i].type === "add") i++;
            const pairs = Math.min(addStart - delStart, i - addStart);
            for (let p = 0; p < pairs; p++) {
              const spans = computeIntralineSpans(lines[delStart + p].text, lines[addStart + p].text);
              if (spans) {
                lines[delStart + p].highlight = spans.oldSpan;
                lines[addStart + p].highlight = spans.newSpan;
              }
            }
          } else {
            i++;
          }
        }
      }

      let oldCount = 0;
      let newCount = 0;
      let oldStart = 0;
      let newStart = 0;
      for (const l of lines) {
        if (l.type !== "add") {
          if (oldStart === 0) oldStart = l.oldLine;
          oldCount++;
        }
        if (l.type !== "del") {
          if (newStart === 0) newStart = l.newLine;
          newCount++;
        }
      }
      return { oldStart, oldCount, newStart, newCount, lines };
    });

    return { hunks, added, removed, isNewFile, isDeletedFile, truncatedFallback };
  }

  return {
    instance,
    exports,
    arenaCapacity: () => exports.wasm_arena_cap(),
    arenaUsed: () => exports.wasm_arena_used(),
    stripAnsi,
    fuzzyScore,
    fuzzyRank,
    diffOpcodes,
    computeUnifiedDiff,
  };
}

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const WASM_PATH = new URL("../../wasm/zig-core/core.wasm", import.meta.url);
const WASM_BYTES = fs.readFileSync(WASM_PATH);

function patchGlobal(name, value) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
    enumerable: true,
  });
  return () => {
    if (original) Object.defineProperty(globalThis, name, original);
    else delete globalThis[name];
  };
}

function wasmArrayBuffer() {
  return WASM_BYTES.buffer.slice(WASM_BYTES.byteOffset, WASM_BYTES.byteOffset + WASM_BYTES.byteLength);
}

function okResponse() {
  return { ok: true, status: 200, arrayBuffer: async () => wasmArrayBuffer() };
}

function makeSelf(recorder) {
  const self = {
    location: { origin: "http://127.0.0.1:4173" },
    postMessage: (msg) => recorder.push(msg),
  };
  return self;
}

async function loadWorker(caseName, { fetchImpl, selfOverride } = {}) {
  const messages = [];
  const self = makeSelf(messages);
  if (selfOverride) Object.assign(self, selfOverride);
  const fetchCalls = [];
  const fetchImplDefault = async (url) => {
    fetchCalls.push(String(url));
    return okResponse();
  };
  const fetchMock = fetchImpl || fetchImplDefault;
  const restoreSelf = patchGlobal("self", self);
  const restoreFetch = patchGlobal("fetch", fetchMock);
  try {
    await import(`../src/workers/core.worker.ts?case=${caseName}`);
    return {
      messages,
      fetchCalls,
      self,
      async send(id, op, payload = {}) {
        await self.onmessage({ data: { id, op, payload } });
        return messages;
      },
      restore() {
        restoreSelf();
        restoreFetch();
      },
    };
  } catch (err) {
    restoreSelf();
    restoreFetch();
    throw err;
  }
}

test("init with explicit wasmUrl: returns wasmBytes, initMs, arenaCapBytes", async () => {
  const w = await loadWorker("init-explicit");
  try {
    const messages = await w.send(1, "init", { wasmUrl: "http://127.0.0.1:4173/core.wasm" });
    assert.equal(messages.length, 1);
    const msg = messages[0];
    assert.equal(msg.id, 1);
    assert.equal(msg.ok, true);
    assert.equal(msg.result.wasmBytes, WASM_BYTES.length);
    assert.ok(typeof msg.result.initMs === "number" && msg.result.initMs >= 0);
    assert.ok(msg.result.arenaCapBytes > 0);
    assert.deepEqual(w.fetchCalls, ["http://127.0.0.1:4173/core.wasm"]);
  } finally {
    w.restore();
  }
});

test("init with default URL derived from self.location.origin", async () => {
  const w = await loadWorker("init-default");
  try {
    const messages = await w.send(1, "init", {});
    assert.equal(messages[0].ok, true);
    assert.equal(w.fetchCalls.length, 1);
    assert.equal(w.fetchCalls[0], "http://127.0.0.1:4173/core.wasm");
    assert.equal(messages[0].result.wasmBytes, WASM_BYTES.length);
  } finally {
    w.restore();
  }
});

test("init caches the core across subsequent calls", async () => {
  const w = await loadWorker("init-cached");
  try {
    await w.send(1, "init", { wasmUrl: "http://127.0.0.1:4173/core.wasm" });
    await w.send(2, "init", { wasmUrl: "http://127.0.0.1:4173/core.wasm" });
    assert.equal(w.fetchCalls.length, 1, "fetch must be cached across init calls");
    assert.equal(w.messages.length, 2);
    assert.equal(w.messages[1].ok, true);
    // a non-init op reuses the cached core too
    await w.send(3, "stripAnsi", { text: "plain" });
    assert.equal(w.fetchCalls.length, 1);
  } finally {
    w.restore();
  }
});

test("diff: default and custom contextLines/maxD", async () => {
  const w = await loadWorker("diff");
  try {
    const oldText = "line1\nline2\nline3\n";
    const newText = "line1\nline2-changed\nline3\n";

    const messages = await w.send(1, "diff", { oldText, newText });
    assert.equal(messages[0].ok, true);
    assert.equal(messages[0].result.added, 1);
    assert.equal(messages[0].result.removed, 1);
    assert.ok(Array.isArray(messages[0].result.hunks));

    const custom = await w.send(2, "diff", { oldText, newText, contextLines: 0, maxD: 800 });
    assert.equal(custom[1].ok, true);
    assert.equal(custom[1].result.added, 1);

    const customMaxD = await w.send(3, "diff", { oldText, newText, contextLines: 5, maxD: 1 });
    assert.equal(customMaxD[2].ok, true);
    assert.ok(Array.isArray(customMaxD[2].result.hunks));
  } finally {
    w.restore();
  }
});

test("stripAnsi: strips escape sequences", async () => {
  const w = await loadWorker("stripAnsi");
  try {
    const messages = await w.send(1, "stripAnsi", { text: "\x1b[32mERR\x1b[0m plain \x1b[1;36mworker\x1b[0m" });
    assert.equal(messages[0].ok, true);
    assert.equal(messages[0].result.cleaned, "ERR plain worker");
  } finally {
    w.restore();
  }
});

test("fuzzyRank: normal array, custom limit, and non-array items -> []", async () => {
  const w = await loadWorker("fuzzyRank");
  try {
    const messages = await w.send(1, "fuzzyRank", {
      query: "diff",
      items: ["src/workers/diff.worker.ts", "src/utils/unifiedDiffEngine.ts", "README.md"],
      limit: 25,
    });
    assert.equal(messages[0].ok, true);
    assert.ok(messages[0].result.hits.length >= 1);
    assert.equal(messages[0].result.hits[0].text, "src/workers/diff.worker.ts");

    const limited = await w.send(2, "fuzzyRank", {
      query: "diff",
      items: ["src/workers/diff.worker.ts", "src/utils/unifiedDiffEngine.ts"],
      limit: 1,
    });
    assert.equal(limited[1].result.hits.length, 1);

    const notArray = await w.send(3, "fuzzyRank", { query: "diff", items: "not-an-array" });
    assert.deepEqual(notArray[2].result.hits, []);
  } finally {
    w.restore();
  }
});

test("benchmark: all 3 cases returned with numeric timings", async () => {
  const w = await loadWorker("benchmark");
  try {
    const messages = await w.send(1, "benchmark", {});
    assert.equal(messages[0].ok, true);
    const cases = messages[0].result.cases;
    assert.equal(cases.length, 3);
    const names = cases.map((c) => c.name);
    assert.deepEqual(names, ["2500-line 3-hunk diff", "1800x1800 rewrite guardrail", "300 KB ANSI log strip"]);
    for (const c of cases) {
      assert.ok(typeof c.wasmMs === "number" && c.wasmMs >= 0);
      assert.ok(typeof c.jsMs === "number" && c.jsMs >= 0);
    }
  } finally {
    w.restore();
  }
});

test("unknown op posts ok:false with error message", async () => {
  const w = await loadWorker("unknown-op");
  try {
    const messages = await w.send(7, "notARealOp", {});
    assert.equal(messages[0].ok, false);
    assert.equal(messages[0].error, "Unknown worker op: notARealOp");
  } finally {
    w.restore();
  }
});

test("HTTP error response posts ok:false with status and URL", async () => {
  const w = await loadWorker("http-error", {
    fetchImpl: async () => ({ ok: false, status: 404 }),
  });
  try {
    const messages = await w.send(1, "init", { wasmUrl: "http://127.0.0.1:4173/core.wasm" });
    assert.equal(messages[0].id, 1);
    assert.equal(messages[0].ok, false);
    assert.match(messages[0].error, /HTTP 404 fetching .*core\.wasm/);
  } finally {
    w.restore();
  }
});

test("fetch failure clears corePromise so a retry succeeds", async () => {
  let attempts = 0;
  const w = await loadWorker("retry", {
    fetchImpl: async (url) => {
      attempts++;
      if (attempts === 1) throw new Error("network down");
      return okResponse();
    },
  });
  try {
    const first = await w.send(1, "init", { wasmUrl: "http://127.0.0.1:4173/core.wasm" });
    assert.equal(first.length, 1);
    assert.equal(first[0].ok, false);
    assert.equal(first[0].error, "network down");
    assert.equal(attempts, 1, "failed attempt must actually hit fetch");

    // retry: the rejected corePromise was cleared, so a fresh fetch happens and succeeds
    const second = await w.send(2, "init", { wasmUrl: "http://127.0.0.1:4173/core.wasm" });
    assert.equal(second[1].ok, true);
    assert.equal(second[1].result.wasmBytes, WASM_BYTES.length);
    assert.ok(Number.isFinite(second[1].result.initMs) && second[1].result.initMs >= 0);
    assert.ok(second[1].result.arenaCapBytes > 0);
    assert.equal(attempts, 2, "retry must re-fetch rather than reuse the rejected promise");

    // the successful retry is cached: no third fetch
    const third = await w.send(3, "init", { wasmUrl: "http://127.0.0.1:4173/core.wasm" });
    assert.equal(third[2].ok, true);
    assert.equal(attempts, 2, "successful core must be cached after retry");
  } finally {
    w.restore();
  }
});

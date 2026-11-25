import test from "node:test";
import assert from "node:assert/strict";
import { CoreWorkerClient } from "../src/workers/client.ts";

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

class MockWorker {
  static instances = [];

  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.onmessage = null;
    this.onerror = null;
    this.posted = [];
    this.terminated = false;
    MockWorker.instances.push(this);
  }
  postMessage(msg) {
    this.posted.push(msg);
  }
  terminate() {
    this.terminated = true;
  }
  // test helpers
  respond(msg) {
    assert.ok(this.onmessage, "worker.onmessage must be registered");
    this.onmessage({ data: msg });
  }
  crash(ev) {
    assert.ok(this.onerror, "worker.onerror must be registered");
    this.onerror(ev);
  }
}

function setup({ locationHref = "http://127.0.0.1:4173/" } = {}) {
  MockWorker.instances = [];
  const restoreWorker = patchGlobal("Worker", MockWorker);
  const restoreWindow = patchGlobal("window", { location: { href: locationHref } });
  return {
    getWorker() {
      return MockWorker.instances[MockWorker.instances.length - 1];
    },
    restore() {
      restoreWorker();
      restoreWindow();
    },
  };
}

test("constructor spawns Worker with core.worker.ts URL and type: module", () => {
  const env = setup();
  try {
    new CoreWorkerClient();
    const worker = env.getWorker();
    assert.ok(worker.url instanceof URL, "Worker url should be a URL instance");
    assert.ok(worker.url.pathname.replace(/\\/g, "/").endsWith("/src/workers/core.worker.ts"));
    assert.deepEqual(worker.options, { type: "module" });
  } finally {
    env.restore();
  }
});

test("init() resolves ./core.wasm against window.location.href (root and nested)", async () => {
  const env = setup({ locationHref: "http://127.0.0.1:4173/" });
  try {
    const client = new CoreWorkerClient();
    const promise = client.init();
    const worker = env.getWorker();
    const msg = worker.posted[0];
    assert.equal(msg.op, "init");
    assert.equal(msg.payload.wasmUrl, "http://127.0.0.1:4173/core.wasm");
    worker.respond({ id: msg.id, ok: true, result: { wasmBytes: 1234, initMs: 1.5, arenaCapBytes: 4194304 } });
    const resolved = await promise;
    assert.deepEqual(resolved.result, { wasmBytes: 1234, initMs: 1.5, arenaCapBytes: 4194304 });
    assert.equal(resolved.elapsedMs, 0, "elapsedMs defaults to 0 when omitted");
  } finally {
    env.restore();
  }

  const env2 = setup({ locationHref: "http://127.0.0.1:4173/nested/sub/" });
  try {
    const client = new CoreWorkerClient();
    const promise = client.init();
    const worker = env2.getWorker();
    const msg = worker.posted[0];
    assert.equal(msg.payload.wasmUrl, "http://127.0.0.1:4173/nested/sub/core.wasm");
    worker.respond({ id: msg.id, ok: true, result: { wasmBytes: 1, initMs: 1, arenaCapBytes: 1 }, elapsedMs: 7 });
    const resolved = await promise;
    assert.equal(resolved.elapsedMs, 7);
  } finally {
    env2.restore();
  }
});

test("diff() posts expected payload (default contextLines=3 and explicit)", async () => {
  const env = setup();
  try {
    const client = new CoreWorkerClient();
    const p1 = client.diff("a", "b");
    const worker = env.getWorker();
    assert.equal(worker.posted[0].op, "diff");
    assert.deepEqual(worker.posted[0].payload, { oldText: "a", newText: "b", contextLines: 3 });
    worker.respond({ id: worker.posted[0].id, ok: true, result: { hunks: [] }, elapsedMs: 2 });
    const r1 = await p1;
    assert.equal(r1.elapsedMs, 2);

    const p2 = client.diff("a", "b", 7);
    assert.deepEqual(worker.posted[1].payload, { oldText: "a", newText: "b", contextLines: 7 });
    worker.respond({ id: worker.posted[1].id, ok: true, result: { hunks: [] }, elapsedMs: 5 });
    await p2;
  } finally {
    env.restore();
  }
});

test("stripAnsi(), fuzzyRank() and benchmark() post expected payloads", async () => {
  const env = setup();
  try {
    const client = new CoreWorkerClient();
    const ansi = client.stripAnsi("\x1b[32mhi\x1b[0m");
    assert.deepEqual(env.getWorker().posted[0], {
      id: env.getWorker().posted[0].id,
      op: "stripAnsi",
      payload: { text: "\x1b[32mhi\x1b[0m" },
    });
    env.getWorker().respond({ id: env.getWorker().posted[0].id, ok: true, result: { cleaned: "hi" }, elapsedMs: 1 });
    const ansiResult = await ansi;
    assert.deepEqual(ansiResult.result, { cleaned: "hi" });

    const fuzzy = client.fuzzyRank("q", ["one", "two"]);
    assert.equal(env.getWorker().posted[1].op, "fuzzyRank");
    assert.equal(env.getWorker().posted[1].payload.limit, 25, "default limit is 25");
    env.getWorker().respond({ id: env.getWorker().posted[1].id, ok: true, result: { hits: [] }, elapsedMs: 1 });
    await fuzzy;

    const explicitFuzzy = client.fuzzyRank("q", ["one"], 3);
    assert.equal(env.getWorker().posted[2].payload.limit, 3);
    env.getWorker().respond({ id: env.getWorker().posted[2].id, ok: true, result: { hits: [] }, elapsedMs: 1 });
    await explicitFuzzy;

    const bench = client.benchmark();
    assert.equal(env.getWorker().posted[3].op, "benchmark");
    assert.equal(env.getWorker().posted[3].payload, undefined);
    env.getWorker().respond({ id: env.getWorker().posted[3].id, ok: true, result: { cases: [] }, elapsedMs: 9 });
    const benchResult = await bench;
    assert.equal(benchResult.elapsedMs, 9);
  } finally {
    env.restore();
  }
});

test("concurrent out-of-order responses match by id", async () => {
  const env = setup();
  try {
    const client = new CoreWorkerClient();
    const p1 = client.diff("one", "two");
    const p2 = client.diff("three", "four");
    const worker = env.getWorker();
    const id1 = worker.posted[0].id;
    const id2 = worker.posted[1].id;
    worker.respond({ id: id2, ok: true, result: { hunks: ["second"] }, elapsedMs: 20 });
    worker.respond({ id: id1, ok: true, result: { hunks: ["first"] }, elapsedMs: 10 });
    const r2 = await p2;
    const r1 = await p1;
    assert.deepEqual(r1.result, { hunks: ["first"] });
    assert.deepEqual(r2.result, { hunks: ["second"] });
    assert.equal(r1.elapsedMs, 10);
    assert.equal(r2.elapsedMs, 20);
  } finally {
    env.restore();
  }
});

test("unknown id responses are ignored without throwing", async () => {
  const env = setup();
  try {
    const client = new CoreWorkerClient();
    const p = client.diff("a", "b");
    const worker = env.getWorker();
    const msg = worker.posted[0];
    worker.respond({ id: 999, ok: true, result: "stray" }); // unknown id: ignored
    worker.respond({ id: msg.id, ok: true, result: { hunks: [] } });
    const resolved = await p;
    assert.deepEqual(resolved.result, { hunks: [] });
  } finally {
    env.restore();
  }
});

test("ok:false rejects with message or fallback Worker error", async () => {
  const env = setup();
  try {
    const client = new CoreWorkerClient();
    const p1 = client.diff("a", "b");
    const worker = env.getWorker();
    worker.respond({ id: worker.posted[0].id, ok: false, error: "diff failed" });
    await assert.rejects(p1, /diff failed/);

    const p2 = client.diff("a", "b");
    worker.respond({ id: worker.posted[1].id, ok: false });
    await assert.rejects(p2, /Worker error/);
  } finally {
    env.restore();
  }
});

test("worker.onerror rejects all pending promises and clears pending map", async () => {
  const env = setup();
  try {
    const client = new CoreWorkerClient();
    const p1 = client.diff("a", "b");
    const p2 = client.fuzzyRank("q", ["one"]);
    const worker = env.getWorker();
    worker.crash({ message: "boom" });
    await assert.rejects(p1, /boom/);
    await assert.rejects(p2, /boom/);
    // pending map cleared: stale responses do not throw
    worker.respond({ id: worker.posted[0].id, ok: true, result: {} });
    worker.respond({ id: worker.posted[1].id, ok: true, result: {} });
  } finally {
    env.restore();
  }

  const env2 = setup();
  try {
    const client = new CoreWorkerClient();
    const p = client.diff("a", "b");
    env2.getWorker().crash({});
    await assert.rejects(p, /Web Worker crashed/);
  } finally {
    env2.restore();
  }
});

test("dispose() terminates the worker and clears pending requests", async () => {
  const env = setup();
  try {
    const client = new CoreWorkerClient();
    const p = client.diff("a", "b");
    void p; // pending; dispose never settles it
    const worker = env.getWorker();
    client.dispose();
    assert.equal(worker.terminated, true);
    // responses after dispose do not throw
    worker.respond({ id: worker.posted[0].id, ok: true, result: {} });
  } finally {
    env.restore();
  }
});

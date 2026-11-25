import test from "node:test";
import assert from "node:assert/strict";
import { openLocalStore } from "../src/storage/localStore.ts";

// -- global patching helpers ------------------------------------------------

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

function makeSnapshot(id, overrides = {}) {
  return {
    id,
    label: `snapshot ${id}`,
    savedAt: new Date(2024, 0, 1, 0, 0, 0, Number(id.replace(/\D/g, "") || 0) * 1000).toISOString(),
    tab: "diff",
    oldText: "old",
    newText: "new",
    ansiInput: "",
    fuzzyQuery: "",
    ...overrides,
  };
}

// -- in-memory FileSystemDirectoryHandle mock ---------------------------------

function makeMemoryDir({ failRemoveEntry = false } = {}) {
  const files = new Map();
  const dir = {
    async getFileHandle(name, opts) {
      if (!files.has(name)) {
        if (opts && opts.create) files.set(name, "");
        else throw new Error(`NotFound: ${name}`);
      }
      const current = name;
      return {
        async getFile() {
          return { text: async () => files.get(current) };
        },
        async createWritable() {
          return {
            async write(data) {
              files.set(current, String(data));
            },
            async close() {},
          };
        },
      };
    },
    async removeEntry(name) {
      if (failRemoveEntry) throw new Error("removeEntry failed");
      if (!files.has(name)) throw new Error(`NotFound: ${name}`);
      files.delete(name);
    },
  };
  return { dir, files };
}

// -- in-memory IndexedDB mock --------------------------------------------------

function makeIndexedDBMock({ failOpen = false, failTx = false } = {}) {
  const data = [];
  const createdStores = new Set();

  function getAllRequest(done) {
    const req = { onsuccess: null, onerror: null };
    queueMicrotask(() => {
      if (failTx) {
        req.error = new Error("transaction failed");
        req.onerror && req.onerror();
        return;
      }
      req.result = data.slice();
      req.onsuccess && req.onsuccess();
    });
    return req;
  }

  function makeTx(mode) {
    const tx = { oncomplete: null, onerror: null, error: null };
    tx.objectStore = () => ({
      getAll() {
        return getAllRequest();
      },
      put(value) {
        const req = { onsuccess: null, onerror: null };
        queueMicrotask(() => {
          if (failTx) {
            tx.error = new Error("transaction failed");
            tx.onerror && tx.onerror();
            return;
          }
          const idx = data.findIndex((x) => x.id === value.id);
          if (idx >= 0) data[idx] = { ...value };
          else data.push({ ...value });
          tx.oncomplete && tx.oncomplete();
        });
        return req;
      },
      delete(key) {
        const req = { onsuccess: null, onerror: null };
        queueMicrotask(() => {
          if (failTx) {
            tx.error = new Error("transaction failed");
            tx.onerror && tx.onerror();
            return;
          }
          const idx = data.findIndex((x) => x.id === key);
          if (idx >= 0) data.splice(idx, 1);
          tx.oncomplete && tx.oncomplete();
        });
        return req;
      },
    });
    return tx;
  }

  function makeDb() {
    return {
      objectStoreNames: { contains: (n) => createdStores.has(n) },
      createObjectStore: (n) => { createdStores.add(n); },
      transaction: (storeName, mode) => makeTx(mode),
    };
  }

  return {
    data,
    open(name, version) {
      const req = { onupgradeneeded: null, onsuccess: null, onerror: null, result: undefined, error: null };
      queueMicrotask(() => {
        if (failOpen) {
          req.error = new Error("open failed");
          req.onerror && req.onerror();
          return;
        }
        const db = makeDb();
        req.result = db;
        req.onupgradeneeded && req.onupgradeneeded();
        req.onsuccess && req.onsuccess();
      });
      return req;
    },
  };
}

// -- Memory adapter ------------------------------------------------------------

test("openLocalStore falls back to Memory when OPFS and IndexedDB are unavailable", async () => {
  const restoreNav = patchGlobal("navigator", {});
  const restoreIdb = patchGlobal("indexedDB", undefined);
  try {
    const store = await openLocalStore();
    assert.equal(store.backend, "Memory");
    assert.deepEqual(await store.list(), []);
  } finally {
    restoreNav();
    restoreIdb();
  }
});

test("MemoryAdapter: list() returns defensive copies and save() prepends, dedupes, caps at 20, remove() works", async () => {
  const restoreNav = patchGlobal("navigator", {});
  const restoreIdb = patchGlobal("indexedDB", undefined);
  try {
    const store = await openLocalStore();
    assert.equal(store.backend, "Memory");

    await store.save(makeSnapshot("a"));
    await store.save(makeSnapshot("b"));
    let list = await store.list();
    assert.deepEqual(list.map((s) => s.id), ["b", "a"], "newest first");

    const first = await store.list();
    first.push(makeSnapshot("bogus"));
    const second = await store.list();
    assert.equal(second.length, 2, "list() must not leak its internal array");
    assert.equal(first.length, 3, "the returned array was mutated, stored state untouched");

    // deduplicate by id, keeping the newest descriptor
    const dedup = await store.save(makeSnapshot("a", { label: "a-new" }));
    assert.equal(dedup.length, 2);
    assert.equal(dedup[0].id, "a");
    assert.equal(dedup[0].label, "a-new");

    // cap at MAX_SNAPSHOTS = 20
    for (let i = 0; i < 25; i++) await store.save(makeSnapshot(`item-${i}`));
    const capped = await store.list();
    assert.equal(capped.length, 20);
    assert.equal(capped[0].id, "item-24");

    // remove by id
    const removed = await store.remove("item-24");
    assert.equal(removed.some((s) => s.id === "item-24"), false);
    assert.equal(removed.length, 19);

    // remove unknown id: no throw, no change
    const unchanged = await store.remove("does-not-exist");
    assert.equal(unchanged.length, 19);
  } finally {
    restoreNav();
    restoreIdb();
  }
});

// -- OPFS adapter --------------------------------------------------------------

test("openLocalStore probes OPFS, cleans up probe, and selects OpfsAdapter", async () => {
  const { dir, files } = makeMemoryDir();
  const restoreNav = patchGlobal("navigator", {
    storage: { getDirectory: async () => dir },
  });
  const restoreIdb = patchGlobal("indexedDB", undefined);
  try {
    const store = await openLocalStore();
    assert.equal(store.backend, "OPFS");
    assert.equal(files.has(".pwa-kit-probe"), false, "probe file should be removed");
  } finally {
    restoreNav();
    restoreIdb();
  }
});

test("openLocalStore succeeds even when probe removeEntry rejects", async () => {
  const { dir } = makeMemoryDir({ failRemoveEntry: true });
  const restoreNav = patchGlobal("navigator", {
    storage: { getDirectory: async () => dir },
  });
  const restoreIdb = patchGlobal("indexedDB", undefined);
  try {
    const store = await openLocalStore();
    assert.equal(store.backend, "OPFS");
  } finally {
    restoreNav();
    restoreIdb();
  }
});

test("OpfsAdapter list(): missing file, corrupt JSON, and non-array JSON all yield []", async () => {
  const { dir, files } = makeMemoryDir();
  const restoreNav = patchGlobal("navigator", {
    storage: { getDirectory: async () => dir },
  });
  const restoreIdb = patchGlobal("indexedDB", undefined);
  try {
    const store = await openLocalStore();
    assert.deepEqual(await store.list(), [], "missing file -> empty list");

    files.set("pwa-kit-snapshots.json", "{not valid json");
    assert.deepEqual(await store.list(), [], "corrupt JSON -> empty list");

    files.set("pwa-kit-snapshots.json", JSON.stringify({ foo: "bar" }));
    assert.deepEqual(await store.list(), [], "non-array JSON -> empty list");
  } finally {
    restoreNav();
    restoreIdb();
  }
});

test("OpfsAdapter save() writes JSON, dedupes by id, caps at 20, remove() persists", async () => {
  const { dir, files } = makeMemoryDir();
  const restoreNav = patchGlobal("navigator", {
    storage: { getDirectory: async () => dir },
  });
  const restoreIdb = patchGlobal("indexedDB", undefined);
  try {
    const store = await openLocalStore();

    const saved = await store.save(makeSnapshot("a"));
    assert.equal(saved.length, 1);
    const persisted = JSON.parse(files.get("pwa-kit-snapshots.json"));
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].id, "a");

    // dedupe by id keeps newest descriptor
    await store.save(makeSnapshot("a", { label: "a-updated" }));
    const deduped = await store.list();
    assert.equal(deduped.length, 1);
    assert.equal(deduped[0].label, "a-updated");

    // cap at 20
    for (let i = 0; i < 25; i++) await store.save(makeSnapshot(`item-${i}`));
    const capped = await store.list();
    assert.equal(capped.length, 20);
    const persistedAfterCap = JSON.parse(files.get("pwa-kit-snapshots.json"));
    assert.equal(persistedAfterCap.length, 20);

    // remove persists to the file
    const afterRemove = await store.remove("item-24");
    assert.equal(afterRemove.some((s) => s.id === "item-24"), false);
    const persistedAfterRemove = JSON.parse(files.get("pwa-kit-snapshots.json"));
    assert.equal(persistedAfterRemove.some((s) => s.id === "item-24"), false);
  } finally {
    restoreNav();
    restoreIdb();
  }
});

// -- IndexedDB adapter ----------------------------------------------------------

test("openLocalStore falls back to IndexedDB when OPFS is absent", async () => {
  const idb = makeIndexedDBMock();
  const restoreNav = patchGlobal("navigator", {});
  const restoreIdb = patchGlobal("indexedDB", idb);
  try {
    const store = await openLocalStore();
    assert.equal(store.backend, "IndexedDB");
    await store.save(makeSnapshot("a", { savedAt: "2024-01-01T00:00:00.000Z" }));
    await store.save(makeSnapshot("b", { savedAt: "2024-03-01T00:00:00.000Z" }));
    await store.save(makeSnapshot("c", { savedAt: "2024-02-01T00:00:00.000Z" }));
    const list = await store.list();
    assert.deepEqual(list.map((s) => s.id), ["b", "c", "a"], "list must sort descending by savedAt");
  } finally {
    restoreNav();
    restoreIdb();
  }
});

test("IndexedDbAdapter save() persists and prunes stale items beyond 20", async () => {
  const idb = makeIndexedDBMock();
  const restoreNav = patchGlobal("navigator", {});
  const restoreIdb = patchGlobal("indexedDB", idb);
  try {
    const store = await openLocalStore();
    for (let i = 0; i < 21; i++) {
      const day = String(i + 1).padStart(2, "0");
      await store.save(makeSnapshot(`item-${i}`, { savedAt: `2024-01-${day}T00:00:00.000Z` }));
    }
    const list = await store.list();
    assert.equal(list.length, 20, "save() must prune beyond MAX_SNAPSHOTS");
    const ids = list.map((s) => s.id);
    assert.equal(ids.includes("item-20"), true, "newest item survives pruning");
    assert.equal(ids.includes("item-0"), false, "oldest item pruned");
    assert.equal(idb.data.length, 20, "underlying data is pruned too");
  } finally {
    restoreNav();
    restoreIdb();
  }
});

test("IndexedDbAdapter remove() deletes and returns updated list", async () => {
  const idb = makeIndexedDBMock();
  const restoreNav = patchGlobal("navigator", {});
  const restoreIdb = patchGlobal("indexedDB", idb);
  try {
    const store = await openLocalStore();
    await store.save(makeSnapshot("a"));
    await store.save(makeSnapshot("b"));
    const removed = await store.remove("a");
    assert.equal(removed.some((s) => s.id === "a"), false);
    assert.deepEqual(removed.map((s) => s.id), ["b"]);
  } finally {
    restoreNav();
    restoreIdb();
  }
});

test("openLocalStore falls back to Memory when IndexedDB open fails", async () => {
  const restoreNav = patchGlobal("navigator", {});
  const restoreIdb = patchGlobal("indexedDB", makeIndexedDBMock({ failOpen: true }));
  try {
    const store = await openLocalStore();
    assert.equal(store.backend, "Memory");
  } finally {
    restoreNav();
    restoreIdb();
  }
});

test("openLocalStore falls back to Memory when IndexedDB transaction fails", async () => {
  const restoreNav = patchGlobal("navigator", {});
  const restoreIdb = patchGlobal("indexedDB", makeIndexedDBMock({ failTx: true }));
  try {
    const store = await openLocalStore();
    assert.equal(store.backend, "Memory");
  } finally {
    restoreNav();
    restoreIdb();
  }
});

test("openLocalStore falls back to IndexedDB when OPFS throws or lacks createWritable", async () => {
  // OPFS getDirectory throws
  const restoreNavThrow = patchGlobal("navigator", {
    storage: { getDirectory: async () => { throw new Error("denied"); } },
  });
  const idbThrow = makeIndexedDBMock();
  const restoreIdbThrow = patchGlobal("indexedDB", idbThrow);
  try {
    const store = await openLocalStore();
    assert.equal(store.backend, "IndexedDB");
  } finally {
    restoreNavThrow();
    restoreIdbThrow();
  }

  // OPFS handle lacks createWritable
  const probe = { getFileHandle: async () => ({ createWritable: undefined }) };
  const restoreNavNoCw = patchGlobal("navigator", {
    storage: { getDirectory: async () => ({ getFileHandle: probe.getFileHandle }) },
  });
  const idbNoCw = makeIndexedDBMock();
  const restoreIdbNoCw = patchGlobal("indexedDB", idbNoCw);
  try {
    const store = await openLocalStore();
    assert.equal(store.backend, "IndexedDB");
  } finally {
    restoreNavNoCw();
    restoreIdbNoCw();
  }
});

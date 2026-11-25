import test from "node:test";
import assert from "node:assert/strict";
import { KernelRegistry, defaultKernelRegistry } from "../src/plugins/registry.ts";

function descriptor(id, overrides = {}) {
  return {
    id,
    label: `label-${id}`,
    summary: `summary-${id}`,
    exportName: `export-${id}`,
    ...overrides,
  };
}

test("KernelRegistry starts empty", () => {
  const registry = new KernelRegistry();
  assert.deepEqual(registry.list(), []);
  assert.equal(registry.list().length, 0);
});

test("register() is fluent and chainable", () => {
  const registry = new KernelRegistry();
  const returned = registry.register(descriptor("a"));
  assert.equal(returned, registry);
  const chained = registry.register(descriptor("b")).register(descriptor("c"));
  assert.equal(chained, registry);
  assert.equal(registry.list().length, 3);
});

test("register() preserves registration order", () => {
  const registry = new KernelRegistry();
  registry.register(descriptor("a"));
  registry.register(descriptor("b"));
  registry.register(descriptor("c"));
  assert.deepEqual(registry.list().map((p) => p.id), ["a", "b", "c"]);
});

test("register() ignores duplicate id while preserving the original descriptor", () => {
  const registry = new KernelRegistry();
  registry.register(descriptor("a", { label: "original" }));
  registry.register(descriptor("a", { label: "replacement" }));
  const list = registry.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].label, "original");
  assert.equal(list[0].exportName, "export-a");
});

test("defaultKernelRegistry contains diff, ansi and fuzzy with non-empty labels/summaries", () => {
  const list = defaultKernelRegistry.list();
  const ids = list.map((p) => p.id);
  assert.ok(ids.includes("diff"), "diff plugin missing");
  assert.ok(ids.includes("ansi"), "ansi plugin missing");
  assert.ok(ids.includes("fuzzy"), "fuzzy plugin missing");

  const byId = new Map(list.map((p) => [p.id, p]));
  assert.equal(byId.get("diff").exportName, "diff_lines");
  assert.equal(byId.get("ansi").exportName, "strip_ansi");
  assert.equal(byId.get("fuzzy").exportName, "fuzzy_score");

  for (const id of ["diff", "ansi", "fuzzy"]) {
    const plugin = byId.get(id);
    assert.ok(plugin.label.length > 0, `${id} label must be non-empty`);
    assert.ok(plugin.summary.length > 0, `${id} summary must be non-empty`);
  }
});

test("defaultKernelRegistry ignores duplicate id registration without mutating entries", () => {
  const before = JSON.parse(JSON.stringify(defaultKernelRegistry.list()));
  defaultKernelRegistry.register(descriptor("diff", { label: "replacement-label", summary: "replacement-summary", exportName: "replacement_export" }));
  const after = JSON.parse(JSON.stringify(defaultKernelRegistry.list()));
  assert.deepEqual(after, before);
});

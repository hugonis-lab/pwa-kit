import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { defaultKernelRegistry } from "./plugins/registry";
import { openLocalStore, type LocalStorageAdapter, type WorkspaceSnapshot } from "./storage/localStore";
import {
  CoreWorkerClient,
  type BenchmarkCase,
  type DiffLine,
  type DiffResult,
  type FuzzyHit,
  type WorkerInitInfo,
} from "./workers/client";

const SAMPLE_OLD = `export function computeBudget(items: number[]) {
  let total = 0;
  for (const x of items) {
    total += x;
  }
  return total;
}

export const MAX_FRAME_MS = 16;
export const WORKER_MODE = "main-thread";`;

const SAMPLE_NEW = `export function computeBudget(items: readonly number[]) {
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    total += items[i];
  }
  return Math.max(0, total);
}

export const MAX_FRAME_MS = 16;
export const WORKER_MODE = "dedicated-wasm-worker";
export const ARENA_BYTES = 8 * 1024 * 1024;`;

const SAMPLE_ANSI = `\x1b[32m[INFO]\x1b[0m \x1b[1;36mzig-core\x1b[0m instantiated in \x1b[33m0.42ms\x1b[0m (3.0 KB wasm)
\x1b]0;PWA Kit Worker Log\x07\x1b[38;5;214m[BENCH]\x1b[0m 1800x1800 guardrail completed in \x1b[1;32m2.0ms\x1b[0m
\x1b[31m[WARN]\x1b[0m OSC hyperlink \x1b]8;;https://example.org\x1b\\docs\x1b]8;;\x1b\\ stripped cleanly — UTF-8 ok`;

const SAMPLE_PATHS = [
  "wasm/zig-core/src/core.zig",
  "wasm/zig-core/bridge.mjs",
  "shell/src/workers/core.worker.ts",
  "shell/src/workers/client.ts",
  "shell/src/plugins/registry.ts",
  "shell/src/styles/tokens.css",
  "shell/src/styles/app.css",
  "shell/src/App.tsx",
  "shell/public/sw.js",
  "shell/public/manifest.webmanifest",
  "shell/vite.config.ts",
  "tests/zig-core.test.mjs",
];

function renderHighlightedText(line: DiffLine) {
  if (!line.highlight) return line.text;
  const [start, end] = line.highlight;
  const cls = line.type === "add" ? "hl-add" : "hl-del";
  return (
    <>
      {line.text.slice(0, start)}
      <span class={cls}>{line.text.slice(start, end)}</span>
      {line.text.slice(end)}
    </>
  );
}

export function App() {
  const kernels = defaultKernelRegistry.list();
  const [activeTab, setActiveTab] = createSignal(kernels[0].id);
  const [theme, setTheme] = createSignal<"dark" | "light">("dark");
  const [workerInfo, setWorkerInfo] = createSignal<WorkerInitInfo | null>(null);
  const [errorMsg, setErrorMsg] = createSignal<string | null>(null);
  const [lastOpMs, setLastOpMs] = createSignal<number | null>(null);
  const [swReady, setSwReady] = createSignal(false);

  // Diff kernel state
  const [oldText, setOldText] = createSignal(SAMPLE_OLD);
  const [newText, setNewText] = createSignal(SAMPLE_NEW);
  const [diffResult, setDiffResult] = createSignal<DiffResult | null>(null);

  // ANSI kernel state
  const [ansiInput, setAnsiInput] = createSignal(SAMPLE_ANSI);
  const [ansiClean, setAnsiClean] = createSignal("");

  // Fuzzy kernel state
  const [fuzzyQuery, setFuzzyQuery] = createSignal("worker");
  const [fuzzyHits, setFuzzyHits] = createSignal<FuzzyHit[]>([]);

  // Benchmark state
  const [benchCases, setBenchCases] = createSignal<BenchmarkCase[] | null>(null);
  const [benchRunning, setBenchRunning] = createSignal(false);

  // Local-first persistence state (OPFS -> IndexedDB -> Memory)
  const [storageBackend, setStorageBackend] = createSignal<string>("…");
  const [snapshots, setSnapshots] = createSignal<WorkspaceSnapshot[]>([]);

  let client: CoreWorkerClient | null = null;
  let store: LocalStorageAdapter | null = null;

  onMount(async () => {
    client = new CoreWorkerClient();
    openLocalStore()
      .then(async (adapter) => {
        store = adapter;
        setStorageBackend(adapter.backend);
        setSnapshots(await adapter.list());
      })
      .catch(() => {
        setStorageBackend("Memory");
      });
    try {
      const { result } = await client.init();
      setWorkerInfo(result);
      await runDiff(oldText(), newText());
      await runAnsi(ansiInput());
      await runFuzzy(fuzzyQuery());
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.ready.then(() => setSwReady(true)).catch(() => {});
    }
  });

  onCleanup(() => {
    client?.dispose();
  });

  createEffect(() => {
    document.documentElement.dataset.theme = theme();
  });

  async function runDiff(a: string, b: string) {
    if (!client) return;
    try {
      const { result, elapsedMs } = await client.diff(a, b, 3);
      setDiffResult(result);
      setLastOpMs(elapsedMs);
      setErrorMsg(null);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }

  async function runAnsi(raw: string) {
    if (!client) return;
    try {
      const { result, elapsedMs } = await client.stripAnsi(raw);
      setAnsiClean(result.cleaned);
      setLastOpMs(elapsedMs);
      setErrorMsg(null);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }

  async function runFuzzy(query: string) {
    if (!client) return;
    try {
      const { result, elapsedMs } = await client.fuzzyRank(query, SAMPLE_PATHS, 20);
      setFuzzyHits(result.hits);
      setLastOpMs(elapsedMs);
      setErrorMsg(null);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }

  async function runBenchmark() {
    if (!client || benchRunning()) return;
    setBenchRunning(true);
    try {
      const { result, elapsedMs } = await client.benchmark();
      setBenchCases(result.cases);
      setLastOpMs(elapsedMs);
      setErrorMsg(null);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBenchRunning(false);
    }
  }

  async function saveCurrentSnapshot() {
    if (!store) return;
    const now = new Date();
    const label = `${activeKernel().label} — ${now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
    const snap: WorkspaceSnapshot = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      label,
      savedAt: now.toISOString(),
      tab: activeTab(),
      oldText: oldText(),
      newText: newText(),
      ansiInput: ansiInput(),
      fuzzyQuery: fuzzyQuery(),
    };
    setSnapshots(await store.save(snap));
  }

  async function restoreSnapshot(snap: WorkspaceSnapshot) {
    setActiveTab(snap.tab);
    setOldText(snap.oldText);
    setNewText(snap.newText);
    setAnsiInput(snap.ansiInput);
    setFuzzyQuery(snap.fuzzyQuery);
    await Promise.all([runDiff(snap.oldText, snap.newText), runAnsi(snap.ansiInput), runFuzzy(snap.fuzzyQuery)]);
  }

  async function removeSnapshot(id: string) {
    if (!store) return;
    setSnapshots(await store.remove(id));
  }

  const activeKernel = () => kernels.find((k) => k.id === activeTab()) ?? kernels[0];

  return (
    <main class="app-shell">
      <header class="topbar">
        <div class="brand">
          <img class="brand-icon" src="./icon.svg" alt="PWA Kit mark" width="34" height="34" />
          <div>
            <h1 class="brand-title">PWA Kit</h1>
            <p class="brand-sub">Thin SolidJS Shell + Zig WASM Worker Core</p>
          </div>
        </div>
        <div class="topbar-actions">
          <span class={`status-pill ${workerInfo() ? "ready" : ""}`} role="status">
            <span class="status-dot" aria-hidden="true" />
            {workerInfo() ? "WASM Worker Ready" : "Booting Worker…"}
          </span>
          <span class="status-pill">
            {swReady() ? "Offline Shell Active" : "Local-First Shell"} · {storageBackend()}
          </span>
          <button
            type="button"
            class="btn"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            aria-label="Toggle color theme"
          >
            {theme() === "dark" ? "Light Theme" : "Dark Theme"}
          </button>
        </div>
      </header>

      <Show when={errorMsg()}>
        {(msg) => (
          <div class="banner-error" role="alert">
            Kernel error: {msg()}
          </div>
        )}
      </Show>

      <section class="metrics-strip" aria-label="Core runtime telemetry">
        <article class="metric-card">
          <span class="metric-label">WASM Kernel</span>
          <span class="metric-value">
            {workerInfo() ? `${(workerInfo()!.wasmBytes / 1024).toFixed(2)} KB` : "—"}
          </span>
          <span class="metric-note">wasm32-freestanding (-Oz)</span>
        </article>
        <article class="metric-card">
          <span class="metric-label">Cold Boot</span>
          <span class="metric-value">
            {workerInfo() ? `${workerInfo()!.initMs.toFixed(2)} ms` : "—"}
          </span>
          <span class="metric-note">Fetch + instantiate in Worker</span>
        </article>
        <article class="metric-card">
          <span class="metric-label">Last Kernel Op</span>
          <span class="metric-value">
            {lastOpMs() !== null ? `${lastOpMs()!.toFixed(2)} ms` : "—"}
          </span>
          <span class="metric-note">Zero main-thread blocking</span>
        </article>
        <article class="metric-card">
          <span class="metric-label">Scratch Arena</span>
          <span class="metric-value">
            {workerInfo() ? `${(workerInfo()!.arenaCapBytes / (1024 * 1024)).toFixed(0)} MiB` : "—"}
          </span>
          <span class="metric-note">Static BSS (0 bytes on disk)</span>
        </article>
      </section>

      <div class="tabs-bar">
        <div class="tab-list" role="tablist" aria-label="WASM Kernels">
          <For each={kernels}>
            {(kernel) => (
              <button
                type="button"
                role="tab"
                class="tab-btn"
                aria-selected={activeTab() === kernel.id}
                onClick={() => setActiveTab(kernel.id)}
              >
                {kernel.label}
              </button>
            )}
          </For>
        </div>
        <button
          type="button"
          class="btn btn-primary"
          disabled={!workerInfo() || benchRunning()}
          onClick={runBenchmark}
        >
          {benchRunning() ? "Running Benchmark…" : "Run WASM vs JS Benchmark"}
        </button>
      </div>

      <Show when={benchCases()}>
        {(cases) => (
          <section class="panel" aria-label="Benchmark results">
            <div class="panel-header">
              <div>
                <h2 class="panel-title">Off-Main-Thread Worker Benchmark</h2>
                <p class="panel-desc">Measured inside the dedicated Web Worker (lower is better).</p>
              </div>
            </div>
            <div class="bench-grid">
              <For each={cases()}>
                {(c) => (
                  <article class="bench-card">
                    <span class="bench-name">{c.name}</span>
                    <div class="bench-nums">
                      <span class="bench-wasm">{c.wasmMs.toFixed(2)} ms</span>
                      <span class="bench-js">JS {c.jsMs.toFixed(2)} ms</span>
                    </div>
                  </article>
                )}
              </For>
            </div>
          </section>
        )}
      </Show>

      <section class="panel" role="tabpanel" aria-label={activeKernel().label}>
        <div class="panel-header">
          <div>
            <h2 class="panel-title">{activeKernel().label}</h2>
            <p class="panel-desc">{activeKernel().summary}</p>
          </div>
          <span class="status-pill">export: {activeKernel().exportName}</span>
        </div>

        <Show when={activeTab() === "diff"}>
          <div class="split-editors">
            <label class="field">
              <span class="field-label">Original Source</span>
              <textarea
                class="code-input"
                value={oldText()}
                onInput={(e) => {
                  const val = e.currentTarget.value;
                  setOldText(val);
                  runDiff(val, newText());
                }}
              />
            </label>
            <label class="field">
              <span class="field-label">Modified Source</span>
              <textarea
                class="code-input"
                value={newText()}
                onInput={(e) => {
                  const val = e.currentTarget.value;
                  setNewText(val);
                  runDiff(oldText(), val);
                }}
              />
            </label>
          </div>

          <div class="output-box">
            <div class="output-meta">
              <span>
                Hunks: <strong>{diffResult()?.hunks.length ?? 0}</strong>
              </span>
              <span>
                <span class="stat-add">+{diffResult()?.added ?? 0}</span>{" "}
                <span class="stat-del">-{diffResult()?.removed ?? 0}</span>
              </span>
            </div>
            <Show
              when={(diffResult()?.hunks.length ?? 0) > 0}
              fallback={<div class="empty-state">Inputs are identical — zero diff hunks.</div>}
            >
              <div class="diff-scroll">
                <For each={diffResult()!.hunks}>
                  {(hunk) => (
                    <>
                      <div class="hunk-hdr">
                        @@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@
                      </div>
                      <For each={hunk.lines}>
                        {(line) => (
                          <div class={`diff-row ${line.type}`}>
                            <span class="diff-ln">{line.oldLine ?? ""}</span>
                            <span class="diff-ln">{line.newLine ?? ""}</span>
                            <span class="diff-sig">
                              {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
                            </span>
                            <span class="diff-code">{renderHighlightedText(line)}</span>
                          </div>
                        )}
                      </For>
                    </>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>

        <Show when={activeTab() === "ansi"}>
          <label class="field">
            <span class="field-label">Raw Terminal Stream (CSI / OSC / ESC)</span>
            <textarea
              class="code-input"
              value={ansiInput()}
              onInput={(e) => {
                const val = e.currentTarget.value;
                setAnsiInput(val);
                runAnsi(val);
              }}
            />
          </label>
          <div class="output-box">
            <div class="output-meta">
              <span>Stripped Output</span>
              <span>
                {ansiInput().length} → {ansiClean().length} chars
              </span>
            </div>
            <Show
              when={ansiClean().length > 0}
              fallback={<div class="empty-state">Enter ANSI log text above to strip escape codes.</div>}
            >
              <pre class="pre-output">{ansiClean()}</pre>
            </Show>
          </div>
        </Show>

        <Show when={activeTab() === "fuzzy"}>
          <label class="field">
            <span class="field-label">Query Project Files</span>
            <input
              type="search"
              class="text-input"
              placeholder="Type a subsequence (e.g. wrk, core, css)…"
              value={fuzzyQuery()}
              onInput={(e) => {
                const val = e.currentTarget.value;
                setFuzzyQuery(val);
                runFuzzy(val);
              }}
            />
          </label>
          <div class="output-box">
            <div class="output-meta">
              <span>Matched Files</span>
              <span>
                {fuzzyHits().length} / {SAMPLE_PATHS.length}
              </span>
            </div>
            <Show
              when={fuzzyHits().length > 0}
              fallback={<div class="empty-state">No file paths match “{fuzzyQuery()}”.</div>}
            >
              <ul class="rank-list">
                <For each={fuzzyHits()}>
                  {(hit) => (
                    <li class="rank-item">
                      <span>{hit.text}</span>
                      <span class="rank-score">{hit.score}</span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </div>
        </Show>
      </section>

      <section class="panel" aria-label="Local-first snapshots">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">Local-First Snapshots ({storageBackend()})</h2>
            <p class="panel-desc">Persisted on-device via OPFS / IndexedDB with zero cloud round-trips.</p>
          </div>
          <button type="button" class="btn" onClick={saveCurrentSnapshot}>
            Save Snapshot
          </button>
        </div>
        <Show
          when={snapshots().length > 0}
          fallback={
            <div class="empty-state">
              No local snapshots saved yet. Click “Save Snapshot” to persist the current workspace offline.
            </div>
          }
        >
          <ul class="snapshot-list">
            <For each={snapshots()}>
              {(snap) => (
                <li class="snapshot-row">
                  <div class="snapshot-info">
                    <span class="snapshot-label">{snap.label}</span>
                    <span class="snapshot-meta">
                      {snap.tab.toUpperCase()} · {new Date(snap.savedAt).toLocaleString()}
                    </span>
                  </div>
                  <div class="snapshot-actions">
                    <button type="button" class="btn" onClick={() => restoreSnapshot(snap)}>
                      Restore
                    </button>
                    <button type="button" class="btn" onClick={() => removeSnapshot(snap.id)}>
                      Delete
                    </button>
                  </div>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>
    </main>
  );
}

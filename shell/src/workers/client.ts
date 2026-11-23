export interface DiffLine {
  type: "ctx" | "add" | "del";
  oldLine: number | null;
  newLine: number | null;
  text: string;
  highlight?: [number, number];
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface DiffResult {
  hunks: DiffHunk[];
  added: number;
  removed: number;
  isNewFile: boolean;
  isDeletedFile: boolean;
  truncatedFallback: boolean;
}

export interface FuzzyHit {
  index: number;
  text: string;
  score: number;
}

export interface BenchmarkCase {
  name: string;
  wasmMs: number;
  jsMs: number;
}

export interface WorkerInitInfo {
  wasmBytes: number;
  initMs: number;
  arenaCapBytes: number;
}

interface PendingCall {
  resolve: (value: { result: unknown; elapsedMs: number }) => void;
  reject: (err: Error) => void;
}

export class CoreWorkerClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();

  constructor() {
    this.worker = new Worker(new URL("./core.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (ev: MessageEvent) => {
      const { id, ok, result, elapsedMs = 0, error } = ev.data;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (ok) entry.resolve({ result, elapsedMs });
      else entry.reject(new Error(error || "Worker error"));
    };
    this.worker.onerror = (ev) => {
      const err = new Error(ev.message || "Web Worker crashed");
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }

  private call<T>(op: string, payload?: Record<string, unknown>): Promise<{ result: T; elapsedMs: number }> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: { result: unknown; elapsedMs: number }) => void,
        reject,
      });
      this.worker.postMessage({ id, op, payload });
    });
  }

  init() {
    const wasmUrl = new URL("./core.wasm", window.location.href).href;
    return this.call<WorkerInitInfo>("init", { wasmUrl });
  }

  diff(oldText: string, newText: string, contextLines = 3) {
    return this.call<DiffResult>("diff", { oldText, newText, contextLines });
  }

  stripAnsi(text: string) {
    return this.call<{ cleaned: string }>("stripAnsi", { text });
  }

  fuzzyRank(query: string, items: string[], limit = 25) {
    return this.call<{ hits: FuzzyHit[] }>("fuzzyRank", { query, items, limit });
  }

  benchmark() {
    return this.call<{ cases: BenchmarkCase[] }>("benchmark");
  }

  dispose() {
    this.worker.terminate();
    this.pending.clear();
  }
}

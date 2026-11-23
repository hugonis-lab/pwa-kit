// Local-first persistence plugin: OPFS primary -> IndexedDB fallback -> Memory fallback.
// Zero external dependencies; safe across private browsing and restricted contexts.

export interface WorkspaceSnapshot {
  id: string;
  label: string;
  savedAt: string;
  tab: string;
  oldText: string;
  newText: string;
  ansiInput: string;
  fuzzyQuery: string;
}

export interface LocalStorageAdapter {
  readonly backend: "OPFS" | "IndexedDB" | "Memory";
  list(): Promise<WorkspaceSnapshot[]>;
  save(snapshot: WorkspaceSnapshot): Promise<WorkspaceSnapshot[]>;
  remove(id: string): Promise<WorkspaceSnapshot[]>;
}

const OPFS_FILE = "pwa-kit-snapshots.json";
const IDB_NAME = "pwa-kit-local";
const IDB_STORE = "snapshots";
const MAX_SNAPSHOTS = 20;

class OpfsAdapter implements LocalStorageAdapter {
  readonly backend = "OPFS" as const;
  constructor(private dir: FileSystemDirectoryHandle) {}

  private async readAll(): Promise<WorkspaceSnapshot[]> {
    try {
      const fh = await this.dir.getFileHandle(OPFS_FILE);
      const file = await fh.getFile();
      const raw = await file.text();
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private async writeAll(items: WorkspaceSnapshot[]): Promise<void> {
    const fh = await this.dir.getFileHandle(OPFS_FILE, { create: true });
    const writable = await fh.createWritable();
    await writable.write(JSON.stringify(items));
    await writable.close();
  }

  async list() {
    return this.readAll();
  }

  async save(snapshot: WorkspaceSnapshot) {
    const next = [snapshot, ...(await this.readAll()).filter((s) => s.id !== snapshot.id)].slice(0, MAX_SNAPSHOTS);
    await this.writeAll(next);
    return next;
  }

  async remove(id: string) {
    const next = (await this.readAll()).filter((s) => s.id !== id);
    await this.writeAll(next);
    return next;
  }
}

class IndexedDbAdapter implements LocalStorageAdapter {
  readonly backend = "IndexedDB" as const;
  private dbPromise: Promise<IDBDatabase>;

  constructor() {
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
    });
  }

  async list(): Promise<WorkspaceSnapshot[]> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).getAll();
      req.onsuccess = () => {
        const items = (req.result as WorkspaceSnapshot[]) || [];
        items.sort((a, b) => (b.savedAt > a.savedAt ? 1 : -1));
        resolve(items);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async save(snapshot: WorkspaceSnapshot): Promise<WorkspaceSnapshot[]> {
    const db = await this.dbPromise;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(snapshot);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    const all = await this.list();
    if (all.length > MAX_SNAPSHOTS) {
      for (const stale of all.slice(MAX_SNAPSHOTS)) {
        await this.remove(stale.id);
      }
      return all.slice(0, MAX_SNAPSHOTS);
    }
    return all;
  }

  async remove(id: string): Promise<WorkspaceSnapshot[]> {
    const db = await this.dbPromise;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return this.list();
  }
}

class MemoryAdapter implements LocalStorageAdapter {
  readonly backend = "Memory" as const;
  private items: WorkspaceSnapshot[] = [];

  async list() {
    return this.items.slice();
  }

  async save(snapshot: WorkspaceSnapshot) {
    this.items = [snapshot, ...this.items.filter((s) => s.id !== snapshot.id)].slice(0, MAX_SNAPSHOTS);
    return this.items.slice();
  }

  async remove(id: string) {
    this.items = this.items.filter((s) => s.id !== id);
    return this.items.slice();
  }
}

export async function openLocalStore(): Promise<LocalStorageAdapter> {
  // Prefer OPFS when createWritable is supported (Chrome/Edge/Firefox modern builds)
  if (typeof navigator !== "undefined" && navigator.storage && typeof navigator.storage.getDirectory === "function") {
    try {
      const root = await navigator.storage.getDirectory();
      const probe = await root.getFileHandle(".pwa-kit-probe", { create: true });
      if (typeof probe.createWritable === "function") {
        await root.removeEntry(".pwa-kit-probe").catch(() => {});
        return new OpfsAdapter(root);
      }
    } catch {
      // Fall through to IndexedDB
    }
  }
  if (typeof indexedDB !== "undefined") {
    try {
      const idb = new IndexedDbAdapter();
      await idb.list();
      return idb;
    } catch {
      // Fall through to Memory
    }
  }
  return new MemoryAdapter();
}

export const OP_EQUAL: 0;
export const OP_DEL: 1;
export const OP_ADD: 2;
export const OP_TRUNC: 3;

export interface DiffOp {
  op: number;
  count: number;
}

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

export interface ZigCore {
  instance: WebAssembly.Instance;
  exports: WebAssembly.Exports;
  arenaCapacity(): number;
  arenaUsed(): number;
  stripAnsi(input: string): string;
  fuzzyScore(query: string, target: string): number;
  fuzzyRank(query: string, items: string[], limit?: number): FuzzyHit[];
  diffOpcodes(oldText: string, newText: string, maxD?: number): { ops: DiffOp[]; truncatedFallback: boolean };
  computeUnifiedDiff(
    oldText: string,
    newText: string,
    opts?: { contextLines?: number; maxD?: number }
  ): DiffResult;
}

export function splitDiffLines(text: string): string[];
export function computeIntralineSpans(
  oldStr: string,
  newStr: string
): { oldSpan: [number, number]; newSpan: [number, number] } | null;
export function loadCore(
  wasmInput: ArrayBuffer | ArrayBufferView | WebAssembly.Module | Response | URL | string
): Promise<ZigCore>;

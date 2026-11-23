// Composable kernel plugin registry: add new WASM/Worker modules without modifying shell routing.
export interface KernelPluginDescriptor {
  id: string;
  label: string;
  summary: string;
  exportName: string;
}

export class KernelRegistry {
  private plugins: KernelPluginDescriptor[] = [];

  register(plugin: KernelPluginDescriptor): this {
    if (!this.plugins.some((p) => p.id === plugin.id)) {
      this.plugins.push(plugin);
    }
    return this;
  }

  list(): readonly KernelPluginDescriptor[] {
    return this.plugins;
  }
}

export const defaultKernelRegistry = new KernelRegistry()
  .register({
    id: "diff",
    label: "Unified Diff",
    summary: "FNV-1a hashed Myers O(ND) diff with prefix/suffix trim and guardrail.",
    exportName: "diff_lines",
  })
  .register({
    id: "ansi",
    label: "ANSI Strip",
    summary: "Single-pass CSI/OSC/ESC terminal escape stripper preserving UTF-8.",
    exportName: "strip_ansi",
  })
  .register({
    id: "fuzzy",
    label: "Fuzzy Rank",
    summary: "Case-insensitive boundary & consecutive-run subsequence scorer.",
    exportName: "fuzzy_score",
  });

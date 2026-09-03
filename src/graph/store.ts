/**
 * Snapshot persistence: versioned JSON files under .filura/, content-hashed
 * so any two snapshots can be diffed. "latest" is a convenience pointer.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolGraph } from "./types.js";
import type { ToolIR } from "../ir/types.js";

const DIR = ".filura";

export function contentHash(graph: ToolGraph): string {
  // Hash only content that describes the catalog, not build metadata.
  const canonical = JSON.stringify({ tools: graph.tools, edges: graph.edges });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

export class GraphStore {
  constructor(private readonly baseDir: string = process.cwd()) {}

  private get dir(): string {
    return join(this.baseDir, DIR);
  }

  async saveCatalog(tools: ToolIR[]): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const path = join(this.dir, "catalog.json");
    await writeFile(path, JSON.stringify({ tools }, null, 2));
    return path;
  }

  async loadCatalog(): Promise<ToolIR[]> {
    const raw = await readFile(join(this.dir, "catalog.json"), "utf8");
    return (JSON.parse(raw) as { tools: ToolIR[] }).tools;
  }

  /** Saves a snapshot as graph-<hash>.json and points latest.json at it. Returns the hash. */
  async saveGraph(graph: ToolGraph): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const hash = contentHash(graph);
    await writeFile(
      join(this.dir, `graph-${hash}.json`),
      JSON.stringify(graph, null, 2),
    );
    await writeFile(
      join(this.dir, "latest.json"),
      JSON.stringify({ hash }, null, 2),
    );
    return hash;
  }

  async loadGraph(ref = "latest"): Promise<ToolGraph> {
    let hash = ref;
    if (ref === "latest") {
      let pointer: { hash: string };
      try {
        pointer = JSON.parse(
          await readFile(join(this.dir, "latest.json"), "utf8"),
        ) as { hash: string };
      } catch {
        throw new Error(
          "No graph found. Build one first:\n" +
            "  filura ingest <files...>   # MCP dumps or OpenAPI specs\n" +
            "  filura build",
        );
      }
      hash = pointer.hash;
    }
    try {
      const raw = await readFile(join(this.dir, `graph-${hash}.json`), "utf8");
      return JSON.parse(raw) as ToolGraph;
    } catch {
      const available = await this.listGraphs();
      throw new Error(
        `No snapshot "${hash}". ` +
          (available.length > 0
            ? `Available: ${available.join(", ")}`
            : "Run `filura build` first."),
      );
    }
  }

  /** Snapshot hashes in deterministic lexical order. */
  async listGraphs(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return [];
    }
    return entries
      .filter((name) => name.startsWith("graph-") && name.endsWith(".json"))
      .map((name) => name.slice("graph-".length, -".json".length))
      .sort();
  }
}

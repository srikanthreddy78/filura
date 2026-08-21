/**
 * Redundancy detection: clusters of tools with near-identical signatures
 * (name tokens + input names + output names), typically the same
 * capability wrapped twice by different servers.
 */

import type { ToolGraph } from "../graph/types.js";
import type { ToolIR } from "../ir/types.js";
import { normalizedTokens } from "../match/structural.js";

function signature(tool: ToolIR): Set<string> {
  const tokens = new Set<string>();
  for (const token of normalizedTokens(tool.name)) tokens.add(`n:${token}`);
  for (const input of tool.inputs) {
    for (const token of normalizedTokens(input.name)) tokens.add(`i:${token}`);
  }
  for (const output of tool.outputs) {
    for (const token of normalizedTokens(output.name)) tokens.add(`o:${token}`);
  }
  return tokens;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

export interface RedundancyCluster {
  tools: string[];
  similarity: number;
}

export function findRedundantClusters(
  graph: ToolGraph,
  threshold = 0.7,
): RedundancyCluster[] {
  const tools = graph.tools;
  const signatures = tools.map(signature);

  // Union-find over pairwise similarity above the threshold.
  const parent = tools.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  };
  const union = (a: number, b: number): void => {
    parent[find(a)] = find(b);
  };

  const pairSimilarity = new Map<string, number>();
  for (let i = 0; i < tools.length; i++) {
    for (let j = i + 1; j < tools.length; j++) {
      const sim = jaccard(signatures[i]!, signatures[j]!);
      if (sim >= threshold) {
        union(i, j);
        pairSimilarity.set(`${i}-${j}`, sim);
      }
    }
  }

  const clusters = new Map<number, number[]>();
  for (let i = 0; i < tools.length; i++) {
    const root = find(i);
    const members = clusters.get(root) ?? [];
    members.push(i);
    clusters.set(root, members);
  }

  const result: RedundancyCluster[] = [];
  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    let minSim = 1;
    for (let a = 0; a < members.length; a++) {
      for (let b = a + 1; b < members.length; b++) {
        const key = `${members[a]}-${members[b]}`;
        const sim =
          pairSimilarity.get(key) ??
          jaccard(signatures[members[a]!]!, signatures[members[b]!]!);
        minSim = Math.min(minSim, sim);
      }
    }
    result.push({
      tools: members.map((i) => tools[i]!.id).sort(),
      similarity: Number(minSim.toFixed(3)),
    });
  }
  return result.sort((a, b) => b.similarity - a.similarity);
}

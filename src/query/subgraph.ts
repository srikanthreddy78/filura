/**
 * Subgraph retrieval — the core product claim.
 *
 * Given a goal, semantic match on tool descriptions seeds entry points,
 * then the graph is traversed BACKWARD along dependency edges: if a
 * selected tool has a required input fed by another tool's output, that
 * producer is pulled in too. The result is the transitive closure of
 * what's needed (within a budget), not top-k by similarity.
 */

import type { ToolGraph, Edge } from "../graph/types.js";
import type { EmbeddingProvider } from "../providers/embeddings/types.js";
import { cosine } from "../providers/embeddings/types.js";
import { LocalEmbeddingProvider } from "../providers/embeddings/local.js";
import { isAgentSuppliable } from "./reachability.js";

export interface SubgraphOptions {
  /** Maximum tools returned. Default 15. */
  maxTools?: number;
  /** Maximum dependency depth walked back from a seed. Default 3. */
  maxDepth?: number;
  /** Number of description-similarity seeds. Default 5. */
  seeds?: number;
  /** Minimum goal similarity for a seed to qualify. Default 0.15. */
  minSeedScore?: number;
  /**
   * Include edges that scored in the ambiguous band but were never
   * confirmed by an adjudicator. Default false: unconfirmed edges are a
   * build-time diagnostic, not something to hand an agent as fact. A
   * wrong composition hint costs more than a missing one.
   */
  includeAmbiguous?: boolean;
  embeddingProvider?: EmbeddingProvider;
}

export interface SelectedTool {
  id: string;
  /** Why this tool is in the set. */
  reason:
    | { kind: "seed"; score: number }
    | { kind: "dependency"; of: string; via: Edge; depth: number };
  priority: number;
}

export interface SubgraphResult {
  goal: string;
  tools: SelectedTool[];
  /** Edges fully inside the selected tool set. */
  edges: Edge[];
}

const DEPTH_DECAY = 0.75;

export async function querySubgraph(
  graph: ToolGraph,
  goal: string,
  options: SubgraphOptions = {},
): Promise<SubgraphResult> {
  const maxTools = options.maxTools ?? 15;
  const maxDepth = options.maxDepth ?? 3;
  const seedCount = options.seeds ?? 5;
  const minSeedScore = options.minSeedScore ?? 0.15;
  const includeAmbiguous = options.includeAmbiguous ?? false;
  const provider = options.embeddingProvider ?? new LocalEmbeddingProvider();
  const trusted = (edge: Edge): boolean =>
    includeAmbiguous || edge.provenance !== "ambiguous";

  // Seed by description similarity.
  const texts = graph.tools.map(
    (tool) => `${tool.name} ${tool.description}`.trim(),
  );
  const [goalVector, ...toolVectors] = await provider.embed([goal, ...texts]);
  const scored = graph.tools
    .map((tool, i) => ({ id: tool.id, score: cosine(goalVector!, toolVectors[i]!) }))
    .sort((a, b) => b.score - a.score);
  const seeds = scored
    .slice(0, Math.min(seedCount, maxTools))
    .filter((s) => s.score >= minSeedScore);

  // Index incoming edges per consumer tool — but only for inputs the
  // agent cannot supply itself. A required project_id needs a producer;
  // a required free-text title does not.
  const toolsById = new Map(graph.tools.map((tool) => [tool.id, tool]));
  const incoming = new Map<string, Edge[]>();
  for (const edge of graph.edges) {
    if (!trusted(edge)) continue;
    const consumer = toolsById.get(edge.to);
    const input = consumer?.inputs.find((f) => f.path === edge.toField);
    if (input && isAgentSuppliable(input)) continue;
    const list = incoming.get(edge.to) ?? [];
    list.push(edge);
    incoming.set(edge.to, list);
  }

  const selected = new Map<string, SelectedTool>();

  /**
   * Single best-first queue holding both seeds and dependencies, so they
   * compete for the same budget. A dependency that actually produces a
   * required input of a strong seed should outrank a weak seed that only
   * looked vaguely relevant — admitting all seeds up front would spend
   * the budget before any dependency got a chance.
   */
  interface Candidate {
    id: string;
    priority: number;
    depth: number;
    reason: SelectedTool["reason"];
  }
  const queue: Candidate[] = seeds.map((seed) => ({
    id: seed.id,
    priority: seed.score,
    depth: 0,
    reason: { kind: "seed", score: seed.score },
  }));

  while (queue.length > 0 && selected.size < maxTools) {
    queue.sort((a, b) => b.priority - a.priority);
    const current = queue.shift()!;

    const existing = selected.get(current.id);
    if (existing) {
      if (current.priority > existing.priority) existing.priority = current.priority;
      continue;
    }
    selected.set(current.id, {
      id: current.id,
      reason: current.reason,
      priority: current.priority,
    });
    if (current.depth >= maxDepth) continue;

    // Queue the best producer for each starving required input.
    const byInput = new Map<string, Edge[]>();
    for (const edge of incoming.get(current.id) ?? []) {
      const list = byInput.get(edge.toField) ?? [];
      list.push(edge);
      byInput.set(edge.toField, list);
    }
    for (const edges of byInput.values()) {
      edges.sort((a, b) => b.score - a.score);
      const edge = edges[0];
      if (!edge || selected.has(edge.from)) continue;
      queue.push({
        id: edge.from,
        priority: current.priority * edge.score * DEPTH_DECAY,
        depth: current.depth + 1,
        reason: {
          kind: "dependency",
          of: current.id,
          via: edge,
          depth: current.depth + 1,
        },
      });
    }
  }

  const ids = new Set(selected.keys());
  const edges = graph.edges.filter(
    (e) => trusted(e) && ids.has(e.from) && ids.has(e.to),
  );
  const tools = [...selected.values()].sort((a, b) => b.priority - a.priority);
  return { goal, tools, edges };
}

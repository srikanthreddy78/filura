/**
 * Filura serving layer. Sits in the agent's hot path, so the graph and
 * all tool-description embeddings are computed once at startup; a query
 * embeds only the goal string. Budget: p99 well under 200ms locally.
 */

import Fastify from "fastify";
import { z } from "zod";
import type { ToolGraph } from "./graph/types.js";
import { querySubgraph } from "./query/subgraph.js";
import type { EmbeddingProvider } from "./providers/embeddings/types.js";
import { LocalEmbeddingProvider } from "./providers/embeddings/local.js";

const SubgraphRequest = z.object({
  goal: z.string().min(1),
  maxTools: z.number().int().min(1).max(100).optional(),
  maxDepth: z.number().int().min(0).max(6).optional(),
  seeds: z.number().int().min(1).max(20).optional(),
  includeAmbiguous: z.boolean().optional(),
});

export interface ServerOptions {
  graph: ToolGraph;
  embeddingProvider?: EmbeddingProvider;
}

export function createServer(options: ServerOptions) {
  const app = Fastify({ logger: false });
  const provider = options.embeddingProvider ?? new LocalEmbeddingProvider();
  const graph = options.graph;
  const toolsById = new Map(graph.tools.map((tool) => [tool.id, tool]));

  app.get("/health", async () => ({
    status: "ok",
    tools: graph.tools.length,
    edges: graph.edges.length,
    builtAt: graph.builtAt,
  }));

  app.post("/subgraph", async (request, reply) => {
    const started = performance.now();
    const parsed = SubgraphRequest.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: parsed.error.issues };
    }
    const { goal, maxTools, maxDepth, seeds, includeAmbiguous } = parsed.data;
    const result = await querySubgraph(graph, goal, {
      maxTools,
      maxDepth,
      seeds,
      includeAmbiguous,
      embeddingProvider: provider,
    });
    const tools = result.tools.map((selected) => {
      const tool = toolsById.get(selected.id)!;
      return {
        id: tool.id,
        name: tool.name,
        description: tool.description,
        source: tool.source,
        inputs: tool.inputs,
        outputs: tool.outputs,
        reason: selected.reason,
      };
    });
    return {
      goal,
      tools,
      edges: result.edges,
      latencyMs: Number((performance.now() - started).toFixed(2)),
    };
  });

  return app;
}

export async function startServer(
  options: ServerOptions & { port?: number; host?: string },
): Promise<string> {
  const app = createServer(options);
  const address = await app.listen({
    port: options.port ?? 4114,
    host: options.host ?? "127.0.0.1",
  });
  return address;
}

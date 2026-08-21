/**
 * Filura as an MCP server — the runtime answer to the selection problem.
 *
 * Instead of loading 900 tool schemas into context, an agent connects to
 * this one server and calls `find_tools` with its goal. It gets back the
 * subgraph it actually needs: the relevant tools, their full schemas, and
 * the data flow between them ("call list_projects first, its projectId
 * feeds createIssue").
 *
 * The composition hints are the part a plain vector search cannot give,
 * and they're what stops the call → fail → read error → retry loop.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { ToolGraph } from "./graph/types.js";
import type { ToolIR } from "./ir/types.js";
import { querySubgraph } from "./query/subgraph.js";
import { findDeadTools } from "./query/reachability.js";
import type { EmbeddingProvider } from "./providers/embeddings/types.js";
import { LocalEmbeddingProvider } from "./providers/embeddings/local.js";

export interface McpServerOptions {
  graph: ToolGraph;
  embeddingProvider?: EmbeddingProvider;
}

function renderToolSchema(tool: ToolIR): string {
  const lines = [`### ${tool.id}`, tool.description];
  const required = tool.inputs.filter((f) => f.required);
  const optional = tool.inputs.filter((f) => !f.required);
  if (required.length > 0) {
    lines.push(
      `required inputs: ${required
        .map((f) => `${f.path} (${f.type}${f.enum ? ` one of ${f.enum.join("|")}` : ""})`)
        .join(", ")}`,
    );
  }
  if (optional.length > 0) {
    lines.push(
      `optional inputs: ${optional.map((f) => `${f.path} (${f.type})`).join(", ")}`,
    );
  }
  if (tool.outputs.length > 0) {
    lines.push(
      `outputs: ${tool.outputs.map((f) => `${f.path} (${f.type})`).join(", ")}`,
    );
  }
  return lines.filter(Boolean).join("\n");
}

/**
 * Orders tools so producers come before the tools they feed. Cycles are
 * broken arbitrarily — the ordering is advisory, not a plan.
 */
function suggestedOrder(ids: string[], graph: ToolGraph): string[] {
  const inSet = new Set(ids);
  const indegree = new Map(ids.map((id) => [id, 0]));
  const dependents = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!inSet.has(edge.from) || !inSet.has(edge.to) || edge.from === edge.to) {
      continue;
    }
    const list = dependents.get(edge.from) ?? [];
    if (!list.includes(edge.to)) {
      list.push(edge.to);
      dependents.set(edge.from, list);
      indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    }
  }
  const ready = ids.filter((id) => (indegree.get(id) ?? 0) === 0);
  const ordered: string[] = [];
  const seen = new Set<string>();
  while (ready.length > 0) {
    const current = ready.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    ordered.push(current);
    for (const next of dependents.get(current) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining <= 0 && !seen.has(next)) ready.push(next);
    }
  }
  // Anything left is in a cycle; append it in stable order.
  for (const id of ids) if (!seen.has(id)) ordered.push(id);
  return ordered;
}

export function createMcpServer(options: McpServerOptions): McpServer {
  const graph = options.graph;
  const provider = options.embeddingProvider ?? new LocalEmbeddingProvider();
  const toolsById = new Map(graph.tools.map((tool) => [tool.id, tool]));

  const server = new McpServer(
    { name: "filura", version: "0.1.0" },
    {
      instructions:
        `This workspace has ${graph.tools.length} tools across ` +
        `${new Set(graph.tools.map((t) => t.source.server)).size} servers. ` +
        "Their schemas are NOT loaded. Call find_tools with your goal to get " +
        "the tools you need plus the data flow between them (which tool's " +
        "output feeds which tool's required input), then call those tools on " +
        "their own servers.",
    },
  );

  server.registerTool(
    "find_tools",
    {
      title: "Find tools for a goal",
      description:
        "Given a goal, return the tools needed to accomplish it — including " +
        "the upstream tools that produce required parameters. Returns full " +
        "input/output schemas and the data flow between them, so you know " +
        "which tool to call first and where each required id comes from.",
      inputSchema: {
        goal: z
          .string()
          .describe("What you are trying to accomplish, in plain language."),
        max_tools: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Budget for how many tools to return. Default 12."),
      },
    },
    async ({ goal, max_tools }) => {
      const result = await querySubgraph(graph, goal, {
        maxTools: max_tools ?? 12,
        embeddingProvider: provider,
      });

      if (result.tools.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No tools in the catalog matched "${goal}".`,
            },
          ],
        };
      }

      const ids = result.tools.map((selected) => selected.id);
      const order = suggestedOrder(ids, graph);

      const sections = [
        `${result.tools.length} tools for: ${goal}`,
        "",
        "## Tools",
        ...order.map((id) => renderToolSchema(toolsById.get(id)!)),
      ];

      if (result.edges.length > 0) {
        sections.push(
          "",
          "## Data flow — where required inputs come from",
          ...result.edges.map(
            (edge) =>
              `${edge.to}.${edge.toField} ← call ${edge.from} first and use its ${edge.fromField}` +
              (edge.provenance === "structural"
                ? ""
                : ` (inferred, confidence ${edge.score.toFixed(2)} — verify)`),
          ),
          "",
          `Suggested call order: ${order.join(" → ")}`,
        );
      }

      return {
        content: [{ type: "text" as const, text: sections.join("\n") }],
      };
    },
  );

  server.registerTool(
    "describe_catalog",
    {
      title: "Describe the tool catalog",
      description:
        "Summarize what this workspace can do: which servers are connected, " +
        "how many tools each has, and which tools are unusable because " +
        "nothing produces their required inputs.",
      inputSchema: {},
    },
    async () => {
      const byServer = new Map<string, number>();
      for (const tool of graph.tools) {
        byServer.set(
          tool.source.server,
          (byServer.get(tool.source.server) ?? 0) + 1,
        );
      }
      const dead = findDeadTools(graph);
      const lines = [
        `${graph.tools.length} tools, ${graph.edges.length} known data-flow edges.`,
        "",
        "Servers:",
        ...[...byServer.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([server, count]) => `  ${server}: ${count} tools`),
      ];
      if (dead.length > 0) {
        lines.push(
          "",
          `Unusable without external input (${dead.length}):`,
          ...dead.map(
            (tool) =>
              `  ${tool.id} — needs ${tool.starvedInputs
                .map((input) => input.field)
                .join(", ")}, which no tool here produces`,
          ),
        );
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  return server;
}

export async function startMcpServer(options: McpServerOptions): Promise<void> {
  const server = createMcpServer(options);
  await server.connect(new StdioServerTransport());
}

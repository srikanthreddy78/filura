/**
 * Normalize MCP tool definitions (the shape returned by tools/list) into
 * ToolIR. Accepts both live SDK results and serialized JSON dumps.
 */

import { flattenSchema } from "./flatten.js";
import type { ToolIR } from "./types.js";

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: unknown;
  /** MCP 2025-06 spec: declared structured output schema. */
  outputSchema?: unknown;
}

export interface McpServerDump {
  server: string;
  detail?: string;
  tools: McpToolDefinition[];
}

export function normalizeMcpTools(dump: McpServerDump): ToolIR[] {
  return dump.tools.map((tool) => ({
    id: `${dump.server}.${tool.name}`,
    name: tool.name,
    description: tool.description ?? "",
    source: { kind: "mcp", server: dump.server, detail: dump.detail },
    inputs: flattenSchema(tool.inputSchema, {
      rootDocument: tool.inputSchema,
    }),
    outputs: flattenSchema(
      tool.outputSchema,
      { rootDocument: tool.outputSchema, forceRequired: true },
      "result",
    ),
  }));
}

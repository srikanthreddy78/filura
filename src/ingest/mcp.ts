/**
 * Live MCP ingestion: connect to a server over stdio or streamable HTTP,
 * call tools/list, and return a normalized server dump.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerDump, McpToolDefinition } from "../ir/normalize-mcp.js";

export interface McpConnection {
  /** Name to namespace this server's tools under. */
  server: string;
  /** stdio: command + args. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http: base URL of a streamable HTTP MCP endpoint. */
  url?: string;
}

export async function fetchMcpTools(
  connection: McpConnection,
): Promise<McpServerDump> {
  const client = new Client({ name: "filura", version: "0.1.0" });
  const transport = connection.url
    ? new StreamableHTTPClientTransport(new URL(connection.url))
    : new StdioClientTransport({
        command: connection.command ?? "",
        args: connection.args ?? [],
        env: { ...process.env, ...connection.env } as Record<string, string>,
      });

  await client.connect(transport);
  try {
    const tools: McpToolDefinition[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools({ cursor });
      for (const tool of page.tools) {
        tools.push({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: (tool as { outputSchema?: unknown }).outputSchema,
        });
      }
      cursor = page.nextCursor;
    } while (cursor);

    return {
      server: connection.server,
      detail: connection.url ?? `${connection.command} ${connection.args?.join(" ") ?? ""}`.trim(),
      tools,
    };
  } finally {
    await client.close();
  }
}

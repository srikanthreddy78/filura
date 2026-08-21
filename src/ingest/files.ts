/**
 * File-based ingestion: load MCP server dumps (the JSON shape Filura
 * writes, or a raw tools/list result) and OpenAPI 3.x specs, and
 * auto-detect which is which.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { normalizeMcpTools, type McpServerDump } from "../ir/normalize-mcp.js";
import { normalizeOpenApi } from "../ir/normalize-openapi.js";
import type { ToolIR } from "../ir/types.js";

function isOpenApi(doc: Record<string, unknown>): boolean {
  return typeof doc["openapi"] === "string" || typeof doc["swagger"] === "string";
}

function isMcpDump(doc: Record<string, unknown>): boolean {
  return Array.isArray(doc["tools"]);
}

export async function ingestFile(filePath: string): Promise<ToolIR[]> {
  const raw = await readFile(filePath, "utf8");
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${filePath}: not valid JSON (${(error as Error).message}). ` +
        "Filura ingests MCP tool dumps and OpenAPI 3.x specs as JSON.",
    );
  }
  if (doc === null || typeof doc !== "object") {
    throw new Error(`${filePath}: expected a JSON object at the top level.`);
  }
  const record = doc as Record<string, unknown>;

  if (isOpenApi(record)) {
    return normalizeOpenApi(record);
  }
  if (isMcpDump(record)) {
    const fallbackName = basename(filePath).replace(/\.[^.]+$/, "");
    const dump: McpServerDump = {
      server: (record["server"] as string) ?? fallbackName,
      detail: record["detail"] as string | undefined,
      tools: record["tools"] as McpServerDump["tools"],
    };
    return normalizeMcpTools(dump);
  }
  throw new Error(
    `${filePath}: unrecognized format — expected an OpenAPI spec ` +
      `(has "openapi") or an MCP dump (has "tools").`,
  );
}

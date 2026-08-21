/**
 * Reachability analysis: find "dead" tools — tools with a required,
 * identifier-shaped input that no output anywhere in the catalog can
 * produce. An agent can never successfully call these from catalog data
 * alone.
 *
 * Free-text inputs (title, query, message body...) are agent-suppliable
 * and don't starve a tool; only inputs that look like internal
 * identifiers do.
 */

import type { Field } from "../ir/types.js";
import type { ToolGraph } from "../graph/types.js";
import { splitIdentifier } from "../providers/embeddings/local.js";

const IDENTIFIER_SUFFIXES = new Set([
  "id",
  "key",
  "token",
  "sha",
  "ref",
  "handle",
  "slug",
  "code",
]);

const AGENT_SUPPLIABLE = new Set([
  "query",
  "text",
  "message",
  "body",
  "title",
  "name",
  "description",
  "content",
  "comment",
  "note",
  "summary",
  "subject",
  "q",
  "keyword",
  "term",
  "label",
  "reason",
  "email",
  "url",
  "path",
  "limit",
  "offset",
  "page",
  "cursor",
]);

export function isIdentifierInput(field: Field): boolean {
  if (field.enum && field.enum.length > 0) return false;
  if (field.format === "uuid") return true;
  const tokens = splitIdentifier(field.name);
  const last = tokens[tokens.length - 1];
  if (last && IDENTIFIER_SUFFIXES.has(last)) return true;
  return false;
}

export function isAgentSuppliable(field: Field): boolean {
  if (field.enum && field.enum.length > 0) return true;
  if (field.type === "boolean") return true;
  const tokens = splitIdentifier(field.name);
  return tokens.some((token) => AGENT_SUPPLIABLE.has(token)) && !isIdentifierInput(field);
}

export interface StarvedInput {
  field: string;
  type: string;
}

export interface DeadTool {
  id: string;
  starvedInputs: StarvedInput[];
}

export function findDeadTools(graph: ToolGraph): DeadTool[] {
  const fedInputs = new Set(
    graph.edges.map((edge) => `${edge.to} ${edge.toField}`),
  );
  const dead: DeadTool[] = [];
  for (const tool of graph.tools) {
    const starved: StarvedInput[] = [];
    for (const input of tool.inputs) {
      if (!input.required) continue;
      if (fedInputs.has(`${tool.id} ${input.path}`)) continue;
      if (isAgentSuppliable(input)) continue;
      if (!isIdentifierInput(input)) continue;
      starved.push({ field: input.path, type: input.type });
    }
    if (starved.length > 0) {
      dead.push({ id: tool.id, starvedInputs: starved });
    }
  }
  return dead;
}

/**
 * Filura intermediate representation (IR).
 *
 * Every ingested tool — whether from an MCP server's tools/list or an
 * OpenAPI operation — is normalized into a ToolIR. Edge inference operates
 * only on this IR, never on source-specific schema formats.
 */

/** Primitive-ish type buckets used for type-compatibility gating. */
export type FieldType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "null"
  | "unknown";

/** A single input parameter or output field, flattened to a dotted path. */
export interface Field {
  /**
   * Dotted path from the schema root, e.g. "project_id" or
   * "issue.assignee.id". Array elements are addressed as "items[].id".
   */
  path: string;
  /** Leaf name of the field (last path segment, without the "[]"). */
  name: string;
  type: FieldType;
  /** For arrays: the element type, when known. */
  itemType?: FieldType;
  required: boolean;
  description?: string;
  /** enum values, when declared. Used to boost/suppress match confidence. */
  enum?: (string | number)[];
  /** JSON Schema "format" (e.g. "uuid", "date-time"), when declared. */
  format?: string;
}

export type ToolSourceKind = "mcp" | "openapi";

export interface ToolSource {
  kind: ToolSourceKind;
  /** Server name / spec title the tool came from. */
  server: string;
  /** Origin detail: command/url for MCP, operationId + method+path for OpenAPI. */
  detail?: string;
}

export interface ToolIR {
  /** Globally unique: "<server>.<tool_name>". */
  id: string;
  name: string;
  description: string;
  source: ToolSource;
  inputs: Field[];
  outputs: Field[];
}

/** A named catalog of tools — the unit that gets graphed and snapshotted. */
export interface Catalog {
  tools: ToolIR[];
}

const NUMERIC: FieldType[] = ["number", "integer"];

/**
 * Whether an output of type `out` can plausibly satisfy an input of type
 * `inp`. Used as a cheap gate before any embedding or LLM work.
 */
export function typesCompatible(out: FieldType, inp: FieldType): boolean {
  if (out === "unknown" || inp === "unknown") return true;
  if (out === inp) return true;
  if (NUMERIC.includes(out) && NUMERIC.includes(inp)) return true;
  // A numeric or string id on one side is often declared as the other.
  if (
    (out === "string" && NUMERIC.includes(inp)) ||
    (NUMERIC.includes(out) && inp === "string")
  ) {
    return true;
  }
  return false;
}

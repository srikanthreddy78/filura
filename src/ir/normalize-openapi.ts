/**
 * Normalize an OpenAPI 3.x spec into ToolIR: one tool per operation.
 * Path/query/header params and requestBody properties become inputs;
 * the first 2xx JSON response becomes outputs.
 */

import { flattenSchema } from "./flatten.js";
import type { Field, ToolIR } from "./types.js";

type OpenApiDocument = {
  info?: { title?: string };
  paths?: Record<string, Record<string, unknown>>;
  components?: unknown;
  [key: string]: unknown;
};

type Operation = {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: Parameter[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: unknown }>;
  };
  responses?: Record<
    string,
    { content?: Record<string, { schema?: unknown }>; description?: string }
  >;
};

type Parameter = {
  name?: string;
  in?: string;
  required?: boolean;
  description?: string;
  schema?: { type?: string; format?: string; enum?: (string | number)[] };
  $ref?: string;
};

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

function paramToField(param: Parameter): Field | undefined {
  if (!param.name) return undefined;
  const rawType = param.schema?.type;
  const type =
    rawType === "string" ||
    rawType === "number" ||
    rawType === "integer" ||
    rawType === "boolean" ||
    rawType === "array" ||
    rawType === "object"
      ? rawType
      : "unknown";
  return {
    path: param.name,
    name: param.name,
    type,
    required: param.required ?? param.in === "path",
    description: param.description,
    enum: param.schema?.enum,
    format: param.schema?.format,
  };
}

function jsonContentSchema(
  content: Record<string, { schema?: unknown }> | undefined,
): unknown {
  if (!content) return undefined;
  for (const [mime, body] of Object.entries(content)) {
    if (mime.includes("json")) return body.schema;
  }
  return Object.values(content)[0]?.schema;
}

function resolveLocalRef<T>(node: T | { $ref?: string }, doc: unknown): T {
  const ref = (node as { $ref?: string }).$ref;
  if (!ref || !ref.startsWith("#/")) return node as T;
  let current: unknown = doc;
  for (const part of ref.slice(2).split("/")) {
    if (current === null || typeof current !== "object") return node as T;
    current = (current as Record<string, unknown>)[part];
  }
  return (current ?? node) as T;
}

function operationToolName(method: string, path: string, op: Operation): string {
  if (op.operationId) return op.operationId;
  const slug = path
    .replace(/[{}]/g, "")
    .split("/")
    .filter(Boolean)
    .join("_");
  return `${method}_${slug}`;
}

export function normalizeOpenApi(
  doc: OpenApiDocument,
  serverName?: string,
): ToolIR[] {
  const server =
    serverName ??
    (doc.info?.title ?? "openapi").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const tools: ToolIR[] = [];

  for (const [path, pathItem] of Object.entries(doc.paths ?? {})) {
    const sharedParams = (pathItem["parameters"] as Parameter[]) ?? [];
    for (const method of HTTP_METHODS) {
      const op = pathItem[method] as Operation | undefined;
      if (!op) continue;

      const inputs: Field[] = [];
      const allParams = [...sharedParams, ...(op.parameters ?? [])];
      for (const rawParam of allParams) {
        const param = resolveLocalRef<Parameter>(rawParam, doc);
        const field = paramToField(param);
        if (field) inputs.push(field);
      }

      const bodySchema = jsonContentSchema(op.requestBody?.content);
      if (bodySchema) {
        inputs.push(
          ...flattenSchema(bodySchema, { rootDocument: doc }, "body"),
        );
      }

      let outputs: Field[] = [];
      for (const [status, rawResponse] of Object.entries(op.responses ?? {})) {
        if (!status.startsWith("2")) continue;
        const response = resolveLocalRef(rawResponse, doc);
        const schema = jsonContentSchema(response.content);
        if (schema) {
          outputs = flattenSchema(
            schema,
            { rootDocument: doc, forceRequired: true },
            "result",
          );
          break;
        }
      }

      const name = operationToolName(method, path, op);
      tools.push({
        id: `${server}.${name}`,
        name,
        description: op.summary ?? op.description ?? "",
        source: {
          kind: "openapi",
          server,
          detail: `${method.toUpperCase()} ${path}`,
        },
        inputs,
        outputs,
      });
    }
  }
  return tools;
}

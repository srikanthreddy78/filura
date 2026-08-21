/**
 * Flattens a JSON Schema (draft-07-ish, as emitted by MCP servers and
 * OpenAPI 3.x components) into a list of IR Fields with dotted paths.
 *
 * Handles: local $ref resolution, nested objects, arrays of objects
 * (addressed as "path[].child"), required flags, enum, format, and
 * anyOf/oneOf/allOf (first-viable-branch strategy — good enough for
 * matching, which only needs plausible types, not validation).
 */

import type { Field, FieldType } from "./types.js";

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema | JsonSchema[];
  $ref?: string;
  enum?: (string | number)[];
  format?: string;
  description?: string;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  [key: string]: unknown;
};

const MAX_DEPTH = 6;

export interface FlattenOptions {
  /** Document root used to resolve local $refs ("#/..."). */
  rootDocument?: unknown;
  /** Treat every field as required regardless of declared flags. */
  forceRequired?: boolean;
}

function resolveRef(ref: string, root: unknown): JsonSchema | undefined {
  if (!ref.startsWith("#/") || root === undefined) return undefined;
  const parts = ref
    .slice(2)
    .split("/")
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let node: unknown = root;
  for (const part of parts) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node as JsonSchema | undefined;
}

function schemaType(schema: JsonSchema): FieldType {
  let t = schema.type;
  if (Array.isArray(t)) t = t.find((x) => x !== "null") ?? t[0];
  switch (t) {
    case "string":
    case "number":
    case "integer":
    case "boolean":
    case "object":
    case "array":
    case "null":
      return t;
    default:
      if (schema.properties) return "object";
      if (schema.items) return "array";
      if (schema.enum) {
        return typeof schema.enum[0] === "number" ? "number" : "string";
      }
      return "unknown";
  }
}

function deref(
  schema: JsonSchema,
  root: unknown,
  seen: Set<JsonSchema>,
): JsonSchema {
  let current = schema;
  // Follow $ref chains, guarding against cycles.
  while (current.$ref) {
    const resolved = resolveRef(current.$ref, root);
    if (!resolved || seen.has(resolved)) return { ...current, $ref: undefined };
    seen.add(resolved);
    current = resolved;
  }
  // Collapse composition keywords into a single viable schema.
  const branches = current.anyOf ?? current.oneOf;
  if (branches && branches.length > 0) {
    const branch =
      branches.find((b) => {
        const d = deref(b, root, new Set(seen));
        return schemaType(d) !== "null";
      }) ?? branches[0]!;
    current = { ...deref(branch, root, new Set(seen)) };
  }
  if (current.allOf && current.allOf.length > 0) {
    const merged: JsonSchema = { ...current, allOf: undefined };
    merged.properties = { ...(merged.properties ?? {}) };
    const required = new Set(merged.required ?? []);
    for (const part of current.allOf) {
      const d = deref(part, root, new Set(seen));
      Object.assign(merged.properties, d.properties ?? {});
      for (const r of d.required ?? []) required.add(r);
      if (!merged.type && d.type) merged.type = d.type;
    }
    merged.required = [...required];
    current = merged;
  }
  return current;
}

/**
 * Flatten `schema` into Fields. For an object schema, each property becomes
 * a field (recursing into nested objects/arrays). For a bare scalar schema,
 * a single field named `fallbackName` is produced.
 */
export function flattenSchema(
  schema: unknown,
  options: FlattenOptions = {},
  fallbackName = "value",
): Field[] {
  if (schema === null || typeof schema !== "object") return [];
  const fields: Field[] = [];
  const root = options.rootDocument ?? schema;

  const visit = (
    node: JsonSchema,
    path: string,
    name: string,
    required: boolean,
    depth: number,
  ): void => {
    if (depth > MAX_DEPTH) return;
    const resolved = deref(node, root, new Set());
    const type = schemaType(resolved);

    if (type === "object" && resolved.properties) {
      // Emit the object itself only at the top of a nested path — leaf
      // fields are what matching cares about.
      const requiredSet = new Set(resolved.required ?? []);
      for (const [propName, propSchema] of Object.entries(
        resolved.properties,
      )) {
        const childPath = path ? `${path}.${propName}` : propName;
        visit(
          propSchema,
          childPath,
          propName,
          required && (options.forceRequired || requiredSet.has(propName)),
          depth + 1,
        );
      }
      return;
    }

    if (type === "array") {
      const itemsSchema = Array.isArray(resolved.items)
        ? resolved.items[0]
        : resolved.items;
      if (itemsSchema) {
        const item = deref(itemsSchema, root, new Set());
        const itemType = schemaType(item);
        if (itemType === "object" && item.properties) {
          const requiredSet = new Set(item.required ?? []);
          for (const [propName, propSchema] of Object.entries(
            item.properties,
          )) {
            visit(
              propSchema,
              `${path}[].${propName}`,
              propName,
              required && (options.forceRequired || requiredSet.has(propName)),
              depth + 1,
            );
          }
          return;
        }
        fields.push({
          path,
          name,
          type: "array",
          itemType,
          required,
          description: resolved.description ?? item.description,
          enum: item.enum,
          format: item.format,
        });
        return;
      }
    }

    fields.push({
      path,
      name,
      type,
      required,
      description: resolved.description,
      enum: resolved.enum,
      format: resolved.format,
    });
  };

  const top = deref(schema as JsonSchema, root, new Set());
  if (schemaType(top) === "object" && top.properties) {
    const requiredSet = new Set(top.required ?? []);
    for (const [propName, propSchema] of Object.entries(top.properties)) {
      visit(
        propSchema,
        propName,
        propName,
        options.forceRequired || requiredSet.has(propName),
        1,
      );
    }
  } else {
    visit(top, fallbackName, fallbackName, true, 1);
  }
  return fields;
}

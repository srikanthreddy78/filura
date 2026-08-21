import { describe, expect, it } from "vitest";
import { flattenSchema } from "../src/ir/flatten.js";
import { normalizeMcpTools } from "../src/ir/normalize-mcp.js";
import { normalizeOpenApi } from "../src/ir/normalize-openapi.js";
import { ingestFile } from "../src/ingest/files.js";

describe("flattenSchema", () => {
  it("flattens nested objects to dotted paths with required flags", () => {
    const fields = flattenSchema({
      type: "object",
      properties: {
        issue: {
          type: "object",
          properties: {
            id: { type: "integer" },
            assignee: {
              type: "object",
              properties: { login: { type: "string" } },
              required: ["login"],
            },
          },
          required: ["id"],
        },
      },
      required: ["issue"],
    });
    const byPath = Object.fromEntries(fields.map((f) => [f.path, f]));
    expect(byPath["issue.id"]).toMatchObject({ type: "integer", required: true });
    expect(byPath["issue.assignee.login"]).toMatchObject({
      type: "string",
      required: false, // assignee itself is not required
    });
  });

  it("addresses array element fields as path[].child", () => {
    const fields = flattenSchema({
      type: "object",
      properties: {
        projects: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" } },
          },
        },
      },
    });
    expect(fields.map((f) => f.path)).toContain("projects[].id");
  });

  it("resolves local $refs, including through arrays", () => {
    const doc = {
      type: "object",
      properties: {
        customers: {
          type: "array",
          items: { $ref: "#/definitions/Customer" },
        },
      },
      definitions: {
        Customer: {
          type: "object",
          properties: { customer_id: { type: "string" } },
        },
      },
    };
    const fields = flattenSchema(doc, { rootDocument: doc });
    expect(fields.map((f) => f.path)).toContain("customers[].customer_id");
  });

  it("survives circular $refs without hanging", () => {
    const doc: Record<string, unknown> = {
      type: "object",
      properties: { node: { $ref: "#/definitions/Node" } },
      definitions: {
        Node: {
          type: "object",
          properties: {
            value: { type: "string" },
            next: { $ref: "#/definitions/Node" },
          },
        },
      },
    };
    const fields = flattenSchema(doc, { rootDocument: doc });
    expect(fields.map((f) => f.path)).toContain("node.value");
  });

  it("carries enum and format through", () => {
    const fields = flattenSchema({
      type: "object",
      properties: {
        state: { type: "string", enum: ["open", "closed"] },
        uid: { type: "string", format: "uuid" },
      },
    });
    const byPath = Object.fromEntries(fields.map((f) => [f.path, f]));
    expect(byPath["state"]?.enum).toEqual(["open", "closed"]);
    expect(byPath["uid"]?.format).toBe("uuid");
  });
});

describe("normalizeMcpTools", () => {
  it("namespaces ids and splits inputs/outputs", () => {
    const tools = normalizeMcpTools({
      server: "github",
      tools: [
        {
          name: "get_repo",
          description: "Get a repo",
          inputSchema: {
            type: "object",
            properties: { repo_id: { type: "integer" } },
            required: ["repo_id"],
          },
          outputSchema: {
            type: "object",
            properties: { full_name: { type: "string" } },
          },
        },
      ],
    });
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      id: "github.get_repo",
      source: { kind: "mcp", server: "github" },
    });
    expect(tools[0]!.inputs[0]).toMatchObject({ name: "repo_id", required: true });
    expect(tools[0]!.outputs[0]).toMatchObject({ name: "full_name" });
  });
});

describe("normalizeOpenApi", () => {
  it("turns operations into tools with path params and body inputs", async () => {
    const tools = await ingestFile("fixtures/acme-crm.json");
    const create = tools.find((t) => t.name === "createTicket");
    expect(create).toBeDefined();
    expect(create!.source).toMatchObject({ kind: "openapi", detail: "POST /customers/{customer_id}/tickets" });
    const inputPaths = create!.inputs.map((f) => `${f.path}:${f.required}`);
    expect(inputPaths).toContain("customer_id:true");
    expect(inputPaths).toContain("subject:true");
    expect(inputPaths).toContain("priority:false");
    expect(create!.outputs.map((f) => f.path)).toContain("ticket_id");
  });

  it("resolves component $refs in responses", () => {
    const tools = normalizeOpenApi({
      openapi: "3.0.0",
      info: { title: "T" },
      paths: {
        "/things": {
          get: {
            operationId: "listThings",
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        things: {
                          type: "array",
                          items: { $ref: "#/components/schemas/Thing" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Thing: {
            type: "object",
            properties: { thing_id: { type: "string" } },
          },
        },
      },
    });
    expect(tools[0]!.outputs.map((f) => f.path)).toContain("things[].thing_id");
  });
});

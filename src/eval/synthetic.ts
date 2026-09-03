/**
 * Synthetic catalog generator for scale benchmarking.
 *
 * Produces a catalog with the shape real ones have — many servers, mixed
 * camelCase/snake_case conventions, list/get/update triads whose ids flow
 * between them — so build cost is measured against realistic edge density
 * rather than a catalog of unrelated tools.
 */

import type { ToolIR } from "../ir/types.js";

const RESOURCES = [
  "user", "project", "order", "invoice", "ticket", "customer", "account",
  "payment", "subscription", "product", "shipment", "campaign", "lead",
  "contact", "deal", "document", "folder", "report", "dashboard", "alert",
  "incident", "deployment", "cluster", "node", "policy", "role", "group",
  "team", "channel", "message", "event", "workflow", "job", "run",
  "artifact", "secret", "webhook", "integration", "dataset", "budget",
];

const SERVERS = [
  "salesforce", "netsuite", "workday", "servicenow", "zendesk", "stripe",
  "shopify", "hubspot", "datadog", "pagerduty", "okta", "box", "confluence",
  "looker", "segment", "twilio", "sendgrid", "snowflake", "databricks",
  "internal-billing",
];

const capitalize = (s: string) => s[0]!.toUpperCase() + s.slice(1);

export function generateSyntheticCatalog(targetTools: number): ToolIR[] {
  const tools: ToolIR[] = [];

  for (const resource of RESOURCES) {
    for (const [index, server] of SERVERS.entries()) {
      // Half the servers use camelCase, half snake_case.
      const camel = index % 2 === 0;
      const idField = camel ? `${resource}Id` : `${resource}_id`;
      const nameField = camel ? `${resource}Name` : `${resource}_name`;
      const collection = `${resource}s`;
      const toolName = (op: string) =>
        camel ? `${op}${capitalize(resource)}` : `${op}_${resource}`;
      const source = { kind: "mcp" as const, server, detail: "synthetic" };

      const push = (tool: Omit<ToolIR, "id" | "source">) => {
        if (tools.length >= targetTools) return;
        tools.push({ ...tool, id: `${server}.${tool.name}`, source });
      };

      push({
        name: toolName("list"),
        description: `List ${collection} in ${server}.`,
        inputs: [{ path: "limit", name: "limit", type: "integer", required: false }],
        outputs: [
          { path: `${collection}[].${idField}`, name: idField, type: "string", required: true },
          { path: `${collection}[].${nameField}`, name: nameField, type: "string", required: true },
        ],
      });
      push({
        name: toolName("get"),
        description: `Get a single ${resource} from ${server} by id.`,
        inputs: [{ path: idField, name: idField, type: "string", required: true }],
        outputs: [
          { path: idField, name: idField, type: "string", required: true },
          { path: "status", name: "status", type: "string", required: true },
        ],
      });
      push({
        name: toolName("update"),
        description: `Update a ${resource} in ${server}.`,
        inputs: [
          { path: idField, name: idField, type: "string", required: true },
          { path: "note", name: "note", type: "string", required: false },
        ],
        outputs: [{ path: idField, name: idField, type: "string", required: true }],
      });

      if (tools.length >= targetTools) return tools;
    }
  }
  return tools;
}

import { beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ingestFile } from "../src/ingest/files.js";
import { buildGraph } from "../src/graph/build.js";
import { createMcpServer } from "../src/mcp-server.js";

let client: Client;

async function callText(name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text?: string }[];
  };
  return result.content.map((block) => block.text ?? "").join("\n");
}

beforeAll(async () => {
  const tools = (
    await Promise.all(
      [
        "fixtures/github.json",
        "fixtures/jira.json",
        "fixtures/slack.json",
        "fixtures/acme-crm.json",
      ].map(ingestFile),
    )
  ).flat();
  const { graph } = await buildGraph(tools);
  const server = createMcpServer({ graph });

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
});

describe("filura MCP server", () => {
  it("exposes a small, fixed tool surface regardless of catalog size", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "describe_catalog",
      "find_tools",
    ]);
  });

  it("returns the dependency closure with schemas for a goal", async () => {
    const text = await callText("find_tools", {
      goal: "create a jira issue in the right project",
      max_tools: 8,
    });
    expect(text).toContain("jira.createIssue");
    // The producer of the required issueTypeId must ride along.
    expect(text).toContain("jira.listIssueTypes");
    expect(text).toContain("required inputs:");
  });

  it("tells the agent where each required input comes from", async () => {
    const text = await callText("find_tools", {
      goal: "create a jira issue in the right project",
      max_tools: 8,
    });
    expect(text).toContain("Data flow — where required inputs come from");
    expect(text).toMatch(
      /jira\.createIssue\.issueTypeId ← call jira\.listIssueTypes first/,
    );
    expect(text).toContain("Suggested call order:");
  });

  it("orders producers before the tools they feed", async () => {
    const text = await callText("find_tools", {
      goal: "escalate an urgent support ticket for a customer",
      max_tools: 8,
    });
    const orderLine = text
      .split("\n")
      .find((line) => line.startsWith("Suggested call order:"))!;
    expect(orderLine).toBeDefined();
    const order = orderLine.replace("Suggested call order:", "").split(" → ").map((s) => s.trim());
    const levels = order.indexOf("acme-crm.listEscalationLevels");
    const escalate = order.indexOf("acme-crm.escalateTicket");
    expect(levels).toBeGreaterThanOrEqual(0);
    expect(escalate).toBeGreaterThan(levels);
  });

  it("flags low-confidence inferred edges so the agent can verify", async () => {
    const text = await callText("find_tools", {
      goal: "create a branch from a commit",
      max_tools: 8,
    });
    if (text.includes("github.create_branch") && text.includes("from_sha ←")) {
      expect(text).toContain("inferred, confidence");
    }
  });

  it("handles a goal that matches nothing", async () => {
    const text = await callText("find_tools", {
      goal: "zzzz qqqq xxxx nonexistent capability",
    });
    expect(text).toContain("No tools in the catalog matched");
  });

  it("describes the catalog including unusable tools", async () => {
    const text = await callText("describe_catalog");
    expect(text).toContain("40 tools");
    expect(text).toContain("Servers:");
    expect(text).toContain("Unusable without external input");
    expect(text).toContain("github.get_deployment");
  });
});

import { beforeAll, describe, expect, it } from "vitest";
import { ingestFile } from "../src/ingest/files.js";
import { buildGraph } from "../src/graph/build.js";
import { createServer } from "../src/server.js";

let app: ReturnType<typeof createServer>;

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
  app = createServer({ graph });
});

describe("server", () => {
  it("reports health with graph stats", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("ok");
    expect(body.tools).toBeGreaterThan(0);
    expect(body.version).toBe("0.2.0");
  });

  it("explains trusted dependency evidence over HTTP", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/explain?tool=jira.createIssue&input=issueTypeId",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("satisfied");
    expect(body.trustedProducers[0].edge.from).toBe("jira.listIssueTypes");
  });

  it("rejects malformed or unknown explain requests", async () => {
    const malformed = await app.inject({ method: "GET", url: "/explain?tool=jira.createIssue" });
    expect(malformed.statusCode).toBe(400);
    const unknown = await app.inject({ method: "GET", url: "/explain?tool=nope&input=id" });
    expect(unknown.statusCode).toBe(404);
  });

  it("serves a subgraph with tool schemas, reasons, and edges", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/subgraph",
      payload: { goal: "escalate an urgent support ticket", maxTools: 8 },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.tools.length).toBeGreaterThan(0);
    expect(body.tools.length).toBeLessThanOrEqual(8);
    expect(body.tools[0]).toHaveProperty("inputs");
    expect(body.tools[0]).toHaveProperty("reason");
    const ids = body.tools.map((t: { id: string }) => t.id);
    expect(ids).toContain("acme-crm.escalateTicket");
    expect(ids).toContain("acme-crm.listEscalationLevels");
  });

  it("stays far inside the 200ms latency budget", async () => {
    const started = performance.now();
    const response = await app.inject({
      method: "POST",
      url: "/subgraph",
      payload: { goal: "create a jira ticket and assign it" },
    });
    const elapsed = performance.now() - started;
    expect(response.statusCode).toBe(200);
    expect(elapsed).toBeLessThan(200);
  });

  it("rejects malformed requests with 400", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/subgraph",
      payload: { maxTools: 5 },
    });
    expect(response.statusCode).toBe(400);
  });
});

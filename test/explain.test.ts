import { beforeAll, describe, expect, it } from "vitest";
import { ingestFile } from "../src/ingest/files.js";
import { buildGraph } from "../src/graph/build.js";
import type { ToolGraph } from "../src/graph/types.js";
import { explainInput } from "../src/query/explain.js";

let graph: ToolGraph;

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
  graph = (await buildGraph(tools)).graph;
});

describe("dependency explanations", () => {
  it("shows trusted producers for a required identifier", () => {
    const explanation = explainInput(graph, "jira.createIssue", "issueTypeId");
    expect(explanation.status).toBe("satisfied");
    expect(explanation.trustedProducers).toHaveLength(1);
    expect(explanation.trustedProducers[0]!.edge.from).toBe("jira.listIssueTypes");
    expect(explanation.trustedProducers[0]!.edge.fromField).toBe(
      "issueTypes[].issueTypeId",
    );
    // A correct trusted producer can coexist with weaker candidates. The
    // important contract is that those remain visibly separate and never
    // change the input's trusted/satisfied status.
    expect(explanation.pendingCandidates.every((candidate) => candidate.trust === "pending")).toBe(true);
  });

  it("distinguishes an agent-suppliable input from a missing dependency", () => {
    const explanation = explainInput(graph, "jira.createIssue", "summary");
    expect(explanation.status).toBe("agent-suppliable");
    expect(explanation.guidance).toContain("provide this value directly");
  });

  it("reports a genuinely unresolved required identifier", () => {
    const explanation = explainInput(graph, "github.get_deployment", "deployment_id");
    expect(explanation.status).toBe("unresolved");
    expect(explanation.trustedProducers).toHaveLength(0);
    expect(explanation.guidance).toContain("No catalog producer");
  });

  it("keeps unadjudicated candidates separate from trusted producers", () => {
    const explanation = explainInput(graph, "github.create_branch", "from_sha");
    expect(explanation.trustedProducers).toHaveLength(0);
    expect(explanation.status).toBe("awaiting-adjudication");
    expect(explanation.pendingCandidates.length).toBeGreaterThan(0);
    expect(explanation.pendingCandidates.every((candidate) => candidate.trust === "pending")).toBe(true);
  });

  it("fails with an actionable error for unknown tools and fields", () => {
    expect(() => explainInput(graph, "does.not.exist", "id")).toThrow("Unknown tool");
    expect(() => explainInput(graph, "jira.createIssue", "not_a_field")).toThrow(
      "Available inputs",
    );
  });
});

import { beforeAll, describe, expect, it } from "vitest";
import { ingestFile } from "../src/ingest/files.js";
import { buildGraph } from "../src/graph/build.js";
import type { ToolGraph } from "../src/graph/types.js";
import type { ToolIR } from "../src/ir/types.js";
import { querySubgraph } from "../src/query/subgraph.js";
import { findDeadTools } from "../src/query/reachability.js";
import { findRedundantClusters } from "../src/query/redundancy.js";
import { diffGraphs } from "../src/query/diff.js";
import type { Adjudicator } from "../src/match/adjudicate.js";

let tools: ToolIR[];
let graph: ToolGraph;

beforeAll(async () => {
  const files = [
    "fixtures/github.json",
    "fixtures/jira.json",
    "fixtures/slack.json",
    "fixtures/acme-crm.json",
  ];
  tools = (await Promise.all(files.map(ingestFile))).flat();
  graph = (await buildGraph(tools)).graph;
});

function hasEdge(g: ToolGraph, from: string, to: string, toField: string): boolean {
  return g.edges.some((e) => e.from === from && e.to === to && e.toField === toField);
}

describe("edge inference", () => {
  it("finds the canonical composition edge: listProjects feeds createIssue.projectId", () => {
    expect(hasEdge(graph, "jira.listProjects", "jira.createIssue", "projectId")).toBe(true);
  });

  it("finds nested-array producers: searchUsers.users[].accountId feeds assignIssue.accountId", () => {
    expect(hasEdge(graph, "jira.searchUsers", "jira.assignIssue", "accountId")).toBe(true);
  });

  it("finds cross-format edges: OpenAPI getCustomer feeds createTicket.customer_id", () => {
    expect(hasEdge(graph, "acme-crm.getCustomer", "acme-crm.createTicket", "customer_id")).toBe(true);
  });

  it("promotes rare-suffix pairs into the ambiguous band (commit_sha → from_sha)", () => {
    const edge = graph.edges.find(
      (e) => e.from === "github.get_commit" && e.to === "github.create_branch" && e.toField === "from_sha",
    );
    expect(edge).toBeDefined();
    expect(edge!.provenance).toBe("ambiguous");
  });

  it("only ever creates edges into required inputs", () => {
    const toolsById = new Map(graph.tools.map((t) => [t.id, t]));
    for (const edge of graph.edges) {
      const input = toolsById.get(edge.to)!.inputs.find((f) => f.path === edge.toField);
      expect(input?.required, `${edge.to}.${edge.toField}`).toBe(true);
    }
  });

  it("prunes the LLM workload to a small fraction of candidates", async () => {
    const { stats } = await buildGraph(tools);
    expect(stats.prunedCandidates).toBeGreaterThan(0);
    // Ambiguous band (what would go to the LLM) must be well under 5% of
    // type-compatible candidates — the cost-control claim.
    expect(stats.byProvenance.ambiguous).toBeLessThan(stats.prunedCandidates * 0.05);
  });

  it("applies adjudicator verdicts: confirmed pairs stay, rejected pairs are dropped", async () => {
    const approveAll: Adjudicator = {
      name: "approve-all",
      adjudicate: async (pairs) => pairs.map((p) => ({ id: p.id, match: true })),
    };
    const rejectAll: Adjudicator = {
      name: "reject-all",
      adjudicate: async (pairs) => pairs.map((p) => ({ id: p.id, match: false })),
    };
    const approved = await buildGraph(tools, { adjudicator: approveAll });
    const rejected = await buildGraph(tools, { adjudicator: rejectAll });
    expect(approved.graph.edges.filter((e) => e.provenance === "adjudicated").length).toBeGreaterThan(0);
    expect(rejected.graph.edges.filter((e) => e.provenance === "adjudicated")).toHaveLength(0);
    expect(rejected.graph.edges.filter((e) => e.provenance === "ambiguous")).toHaveLength(0);
    expect(approved.graph.edges.length).toBeGreaterThan(rejected.graph.edges.length);
  });
});

describe("subgraph retrieval", () => {
  it("returns the dependency closure, not just top-k: createIssue pulls its producers", async () => {
    const result = await querySubgraph(graph, "create a jira issue in the right project", {
      maxTools: 10,
    });
    const ids = result.tools.map((t) => t.id);
    expect(ids).toContain("jira.createIssue");
    // issueTypeId and projectId producers must ride along.
    expect(ids).toContain("jira.listIssueTypes");
    expect(ids.some((id) => id === "jira.listProjects" || id === "jira.getProject")).toBe(true);
  });

  it("prefers a real dependency of a strong seed over a weakly-relevant seed", async () => {
    // At a tight budget, listIssueTypes (produces the required issueTypeId)
    // must beat tools that merely scored as loose description matches.
    const result = await querySubgraph(graph, "create a jira issue in the right project", {
      maxTools: 6,
    });
    const ids = result.tools.map((t) => t.id);
    expect(ids).toContain("jira.createIssue");
    expect(ids).toContain("jira.listIssueTypes");
    expect(ids).toContain("jira.getProject");
    // And the chain that makes them usable is present end to end.
    const edge = (to: string, toField: string, from: string) =>
      result.edges.some((e) => e.to === to && e.toField === toField && e.from === from);
    expect(edge("jira.createIssue", "issueTypeId", "jira.listIssueTypes")).toBe(true);
    expect(edge("jira.createIssue", "projectId", "jira.getProject")).toBe(true);
    expect(edge("jira.listIssueTypes", "projectId", "jira.getProject")).toBe(true);
  });

  it("does not pull producers for free-text inputs the agent supplies", async () => {
    const result = await querySubgraph(graph, "escalate an urgent support ticket", {
      maxTools: 10,
    });
    for (const selected of result.tools) {
      if (selected.reason.kind === "dependency") {
        expect(selected.reason.via.toField).not.toBe("subject");
        expect(selected.reason.via.toField).not.toBe("reason");
      }
    }
  });

  it("excludes unconfirmed ambiguous edges by default, opt-in to see them", async () => {
    const goal = "create a jira issue in the right project";
    const strict = await querySubgraph(graph, goal, { maxTools: 12 });
    expect(strict.edges.every((e) => e.provenance !== "ambiguous")).toBe(true);

    const loose = await querySubgraph(graph, goal, {
      maxTools: 12,
      includeAmbiguous: true,
    });
    expect(loose.edges.some((e) => e.provenance === "ambiguous")).toBe(true);
  });

  it("does not invent a producer for jira.createIssue.issueTypeId from an unrelated issue number", async () => {
    const result = await querySubgraph(graph, "create a jira issue in the right project", {
      maxTools: 12,
    });
    const bogus = result.edges.find(
      (e) => e.toField === "issueTypeId" && e.from === "github.create_issue",
    );
    expect(bogus).toBeUndefined();
  });

  it("respects the tool budget", async () => {
    const result = await querySubgraph(graph, "create a jira issue", { maxTools: 4 });
    expect(result.tools.length).toBeLessThanOrEqual(4);
  });

  it("returns only edges inside the selected set", async () => {
    const result = await querySubgraph(graph, "post a slack message", { maxTools: 6 });
    const ids = new Set(result.tools.map((t) => t.id));
    for (const edge of result.edges) {
      expect(ids.has(edge.from)).toBe(true);
      expect(ids.has(edge.to)).toBe(true);
    }
  });
});

describe("reachability", () => {
  it("flags exactly the planted dead tools", () => {
    const dead = findDeadTools(graph).map((d) => d.id).sort();
    expect(dead).toEqual([
      "acme-crm.getInvoice",
      "github.get_deployment",
      "jira.getAttachment",
      "slack.delete_scheduled_message",
    ]);
  });
});

describe("redundancy", () => {
  it("clusters the planted near-duplicate message tools", () => {
    const clusters = findRedundantClusters(graph);
    const flat = clusters.map((c) => c.tools);
    expect(flat).toContainEqual(["acme-crm.postMessage", "slack.post_message"]);
  });
});

describe("diff", () => {
  it("reports broken data flows and blast radius for the assignee rename", async () => {
    const v2Tools = [
      ...(await ingestFile("fixtures/v2/github.json")),
      ...(await ingestFile("fixtures/jira.json")),
      ...(await ingestFile("fixtures/slack.json")),
      ...(await ingestFile("fixtures/acme-crm.json")),
    ];
    const v2Graph = (await buildGraph(v2Tools)).graph;
    const diff = diffGraphs(graph, v2Graph);

    expect(diff.fieldChanges).toContainEqual({
      tool: "github.create_issue",
      kind: "input-removed",
      field: "assignee",
    });
    expect(diff.fieldChanges).toContainEqual({
      tool: "github.create_issue",
      kind: "input-added",
      field: "assignee_id",
    });

    const broken = diff.brokenEdges.filter((b) => b.edge.toField === "assignee");
    expect(broken.length).toBeGreaterThan(0);
    for (const b of broken) {
      expect(b.affectedDownstream).toContain("github.create_issue");
    }
  });

  it("is empty when diffing a graph against itself", () => {
    const diff = diffGraphs(graph, graph);
    expect(diff.brokenEdges).toHaveLength(0);
    expect(diff.addedEdges).toHaveLength(0);
    expect(diff.fieldChanges).toHaveLength(0);
  });
});

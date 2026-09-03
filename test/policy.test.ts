import { describe, expect, it } from "vitest";
import { ingestFile } from "../src/ingest/files.js";
import { buildGraph } from "../src/graph/build.js";
import { checkGraphChange } from "../src/policy/check.js";
import type { ToolGraph } from "../src/graph/types.js";

async function fixtureGraph(github = "fixtures/github.json"): Promise<ToolGraph> {
  const tools = (
    await Promise.all(
      [github, "fixtures/jira.json", "fixtures/slack.json", "fixtures/acme-crm.json"].map(
        ingestFile,
      ),
    )
  ).flat();
  return (await buildGraph(tools)).graph;
}

describe("release policy", () => {
  it("passes an identical graph", async () => {
    const graph = await fixtureGraph();
    const check = checkGraphChange(graph, graph);
    expect(check.passed).toBe(true);
    expect(check.findings).toEqual([]);
  });

  it("blocks the planted assignee rename and retains blast-radius evidence", async () => {
    const [before, after] = await Promise.all([
      fixtureGraph(),
      fixtureGraph("fixtures/v2/github.json"),
    ]);
    const check = checkGraphChange(before, after);
    expect(check.passed).toBe(false);
    expect(check.summary.breakingEdges).toBe(2);
    expect(check.findings.some((finding) => finding.code === "TRUSTED_FLOW_BROKEN")).toBe(
      true,
    );
    expect(check.findings.some((finding) => finding.code === "INPUT_REMOVED")).toBe(
      true,
    );
    expect(
      check.findings.some((finding) => finding.message.includes("github.add_issue_comment")),
    ).toBe(true);
  });

  it("blocks a newly required identifier with no catalog producer", async () => {
    const before = await fixtureGraph();
    const after = structuredClone(before);
    const tool = after.tools.find((candidate) => candidate.id === "jira.createIssue")!;
    tool.inputs.push({
      path: "external_case_id",
      name: "external_case_id",
      type: "string",
      required: true,
    });
    const check = checkGraphChange(before, after);
    expect(check.passed).toBe(false);
    expect(check.findings).toContainEqual(
      expect.objectContaining({
        code: "NEW_UNREACHABLE_INPUT",
        tool: "jira.createIssue",
        field: "external_case_id",
      }),
    );
  });
});

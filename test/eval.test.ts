import { beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { ingestFile } from "../src/ingest/files.js";
import { buildGraph } from "../src/graph/build.js";
import type { ToolGraph } from "../src/graph/types.js";
import { evaluateEdges } from "../src/eval/evaluate.js";
import { computeMetrics, type GroundTruth } from "../src/eval/types.js";
import { evaluateRetrieval, type RetrievalSpec } from "../src/eval/retrieval.js";

let graph: ToolGraph;
let truth: GroundTruth & { retrieval: RetrievalSpec };

beforeAll(async () => {
  truth = JSON.parse(await readFile("eval/ground-truth.json", "utf8"));
  const tools = (await Promise.all(truth.catalog.map(ingestFile))).flat();
  graph = (await buildGraph(tools)).graph;
});

describe("computeMetrics", () => {
  it("computes precision, recall, and F1", () => {
    const m = computeMetrics({ truePositives: 8, falsePositives: 2, falseNegatives: 2 });
    expect(m.precision).toBeCloseTo(0.8);
    expect(m.recall).toBeCloseTo(0.8);
    expect(m.f1).toBeCloseTo(0.8);
  });

  it("treats a no-prediction, no-expectation case as perfect rather than 0/0", () => {
    const m = computeMetrics({ truePositives: 0, falsePositives: 0, falseNegatives: 0 });
    expect(m.precision).toBe(1);
    expect(m.recall).toBe(1);
  });
});

describe("edge inference quality (regression floor)", () => {
  it("makes zero false positives in trusted mode", () => {
    const evaluation = evaluateEdges(graph, truth);
    expect(evaluation.falsePositives).toBe(0);
    expect(evaluation.precision).toBe(1);
  });

  it("holds recall at or above 0.85 in trusted mode", () => {
    const evaluation = evaluateEdges(graph, truth);
    expect(evaluation.recall).toBeGreaterThanOrEqual(0.85);
  });

  it("leaves every genuinely unreachable input starved", () => {
    const evaluation = evaluateEdges(graph, truth);
    expect(evaluation.deadInputsCorrect).toBe(evaluation.deadInputsTotal);
    expect(evaluation.deadInputsTotal).toBeGreaterThan(0);
  });

  it("trades precision for recall when the ambiguous band is included", () => {
    const strict = evaluateEdges(graph, truth, { includeAmbiguous: false });
    const loose = evaluateEdges(graph, truth, { includeAmbiguous: true });
    expect(loose.recall).toBeGreaterThan(strict.recall);
    expect(loose.precision).toBeLessThan(strict.precision);
    // The band is where adjudication pays off, so it must stay reachable.
    expect(loose.recall).toBeGreaterThanOrEqual(0.95);
  });

  it("does not grade itself: ground truth names producers the system misses", () => {
    const evaluation = evaluateEdges(graph, truth);
    expect(evaluation.falseNegatives).toBeGreaterThan(0);
  });
});

describe("retrieval quality (regression floor)", () => {
  it("solves at least 9 of 10 goals within an 8-tool budget", async () => {
    const evaluation = await evaluateRetrieval(graph, truth.retrieval);
    expect(evaluation.goalsSolved).toBeGreaterThanOrEqual(9);
    expect(evaluation.goalsTotal).toBe(10);
  });

  it("retrieves at least 85% of individually required tools", async () => {
    const evaluation = await evaluateRetrieval(graph, truth.retrieval);
    expect(evaluation.toolRecall).toBeGreaterThanOrEqual(0.85);
  });
});

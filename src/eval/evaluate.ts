/**
 * Measures edge-inference quality against hand-labeled ground truth.
 *
 * Scope: only inputs listed in the ground truth are judged. Those are the
 * identifier-shaped required inputs where "does this output carry that
 * value" has an objective answer. Free-text inputs an agent supplies
 * itself (title, summary, jql, ...) are deliberately excluded — grading
 * them would measure taste, not correctness.
 */

import type { Edge, ToolGraph } from "../graph/types.js";
import {
  computeMetrics,
  type EdgeEvaluation,
  type GroundTruth,
  type MissedEdge,
  type SpuriousEdge,
} from "./types.js";

function edgeInput(edge: Edge): string {
  return `${edge.to}.${edge.toField}`;
}

function edgeProducer(edge: Edge): string {
  return `${edge.from}.${edge.fromField}`;
}

export interface EvaluateOptions {
  /** Judge unconfirmed ambiguous-band edges too. Default false, matching query behavior. */
  includeAmbiguous?: boolean;
}

export function evaluateEdges(
  graph: ToolGraph,
  truth: GroundTruth,
  options: EvaluateOptions = {},
): EdgeEvaluation {
  const includeAmbiguous = options.includeAmbiguous ?? false;
  const inScope = new Map(truth.expectations.map((e) => [e.input, new Set(e.producers)]));

  const actual = new Map<string, Edge[]>();
  for (const edge of graph.edges) {
    if (!includeAmbiguous && edge.provenance === "ambiguous") continue;
    const input = edgeInput(edge);
    if (!inScope.has(input)) continue; // out of evaluation scope
    const list = actual.get(input) ?? [];
    list.push(edge);
    actual.set(input, list);
  }

  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let deadInputsCorrect = 0;
  let deadInputsTotal = 0;
  const missed: MissedEdge[] = [];
  const spurious: SpuriousEdge[] = [];

  for (const expectation of truth.expectations) {
    const expected = new Set(expectation.producers);
    const found = actual.get(expectation.input) ?? [];
    const foundProducers = new Set(found.map(edgeProducer));

    if (expected.size === 0) {
      deadInputsTotal++;
      if (found.length === 0) deadInputsCorrect++;
    }

    for (const producer of expected) {
      if (foundProducers.has(producer)) {
        truePositives++;
      } else {
        falseNegatives++;
        missed.push({ input: expectation.input, producer });
      }
    }
    for (const edge of found) {
      const producer = edgeProducer(edge);
      if (!expected.has(producer)) {
        falsePositives++;
        spurious.push({
          input: expectation.input,
          producer,
          provenance: edge.provenance,
          score: Number(edge.score.toFixed(2)),
        });
      }
    }
  }

  return {
    ...computeMetrics({ truePositives, falsePositives, falseNegatives }),
    deadInputsCorrect,
    deadInputsTotal,
    missed,
    spurious,
  };
}

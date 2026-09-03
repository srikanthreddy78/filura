/**
 * Measures whether subgraph retrieval returns the dependency closure a
 * goal actually needs — not merely the most similar-sounding tools.
 *
 * A goal counts as solved only when every `required` tool is present and
 * each `anyOf` group contributes at least one tool. That is a stricter
 * bar than top-k similarity: it fails whenever a producer of a required
 * input is missing, which is the whole claim the product rests on.
 */

import type { ToolGraph } from "../graph/types.js";
import { querySubgraph } from "../query/subgraph.js";
import type { EmbeddingProvider } from "../providers/embeddings/types.js";

export interface RetrievalGoal {
  goal: string;
  required: string[];
  anyOf: string[][];
}

export interface RetrievalSpec {
  maxTools: number;
  goals: RetrievalGoal[];
}

export interface GoalResult {
  goal: string;
  solved: boolean;
  retrieved: string[];
  missingRequired: string[];
  unsatisfiedGroups: string[][];
}

export interface RetrievalEvaluation {
  goalsSolved: number;
  goalsTotal: number;
  /** Fraction of individually required tools that were retrieved. */
  toolRecall: number;
  results: GoalResult[];
}

export async function evaluateRetrieval(
  graph: ToolGraph,
  spec: RetrievalSpec,
  embeddingProvider?: EmbeddingProvider,
): Promise<RetrievalEvaluation> {
  const results: GoalResult[] = [];
  let requiredHit = 0;
  let requiredTotal = 0;

  for (const goal of spec.goals) {
    const result = await querySubgraph(graph, goal.goal, {
      maxTools: spec.maxTools,
      embeddingProvider,
    });
    const retrieved = new Set(result.tools.map((tool) => tool.id));

    const missingRequired = goal.required.filter((id) => !retrieved.has(id));
    requiredTotal += goal.required.length;
    requiredHit += goal.required.length - missingRequired.length;

    const unsatisfiedGroups = goal.anyOf.filter(
      (group) => !group.some((id) => retrieved.has(id)),
    );

    results.push({
      goal: goal.goal,
      solved: missingRequired.length === 0 && unsatisfiedGroups.length === 0,
      retrieved: [...retrieved],
      missingRequired,
      unsatisfiedGroups,
    });
  }

  return {
    goalsSolved: results.filter((r) => r.solved).length,
    goalsTotal: results.length,
    toolRecall: requiredTotal === 0 ? 1 : requiredHit / requiredTotal,
    results,
  };
}

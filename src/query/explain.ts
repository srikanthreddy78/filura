/**
 * Dependency explainability.
 *
 * A graph edge is useful only when an operator can answer two questions:
 * "why is this here?" and "is it safe to use?"  This module turns the
 * internal edge list into a stable, client-facing explanation for one
 * tool input. It deliberately shows ambiguous candidates separately from
 * trusted producers; callers never have to infer safety from a score.
 */

import type { Edge, ToolGraph } from "../graph/types.js";
import type { Field, ToolIR } from "../ir/types.js";
import { isAgentSuppliable } from "./reachability.js";

export type DependencyStatus =
  | "agent-suppliable"
  | "satisfied"
  | "awaiting-adjudication"
  | "unresolved";

export interface ExplainedProducer {
  edge: Edge;
  /** `trusted` means this edge is eligible for normal retrieval. */
  trust: "trusted" | "pending";
  tool: Pick<ToolIR, "id" | "name" | "description" | "source">;
}

export interface InputExplanation {
  tool: Pick<ToolIR, "id" | "name" | "description" | "source">;
  input: Field;
  /** The operational state of this input in the current graph snapshot. */
  status: DependencyStatus;
  /** High-confidence producers used by default retrieval. */
  trustedProducers: ExplainedProducer[];
  /** Candidates withheld until an LLM or human reviewer confirms them. */
  pendingCandidates: ExplainedProducer[];
  guidance: string;
}

function summarizeTool(tool: ToolIR): Pick<ToolIR, "id" | "name" | "description" | "source"> {
  return {
    id: tool.id,
    name: tool.name,
    description: tool.description,
    source: tool.source,
  };
}

function byConfidence(a: ExplainedProducer, b: ExplainedProducer): number {
  return b.edge.score - a.edge.score || a.edge.from.localeCompare(b.edge.from);
}

export function explainInput(
  graph: ToolGraph,
  toolId: string,
  inputPath: string,
): InputExplanation {
  const tools = new Map(graph.tools.map((tool) => [tool.id, tool]));
  const tool = tools.get(toolId);
  if (!tool) {
    throw new Error(`Unknown tool "${toolId}". Use \`filura inspect\` to view the catalog.`);
  }
  const input = tool.inputs.find((field) => field.path === inputPath);
  if (!input) {
    const available = tool.inputs.map((field) => field.path).join(", ") || "(none)";
    throw new Error(
      `Unknown input "${inputPath}" on ${toolId}. Available inputs: ${available}`,
    );
  }

  const trustedProducers: ExplainedProducer[] = [];
  const pendingCandidates: ExplainedProducer[] = [];
  for (const edge of graph.edges) {
    if (edge.to !== toolId || edge.toField !== inputPath) continue;
    const producer = tools.get(edge.from);
    if (!producer) continue; // Defensive: tolerate a manually-edited snapshot.
    const explained: ExplainedProducer = {
      edge,
      trust: edge.provenance === "ambiguous" ? "pending" : "trusted",
      tool: summarizeTool(producer),
    };
    (explained.trust === "trusted" ? trustedProducers : pendingCandidates).push(
      explained,
    );
  }
  trustedProducers.sort(byConfidence);
  pendingCandidates.sort(byConfidence);

  let status: DependencyStatus;
  let guidance: string;
  if (isAgentSuppliable(input)) {
    status = "agent-suppliable";
    guidance =
      "An agent or user can provide this value directly; no upstream producer is required.";
  } else if (trustedProducers.length > 0) {
    status = "satisfied";
    guidance =
      "Use a trusted producer above. Structural, high-confidence semantic, and adjudicated edges are eligible for normal retrieval.";
  } else if (pendingCandidates.length > 0) {
    status = "awaiting-adjudication";
    guidance =
      "Potential producers exist, but they are excluded from agent guidance until an LLM or human review confirms the data flow.";
  } else {
    status = "unresolved";
    guidance =
      "No catalog producer satisfies this required input. Provide it externally or add the missing capability to the catalog.";
  }

  return {
    tool: summarizeTool(tool),
    input,
    status,
    trustedProducers,
    pendingCandidates,
    guidance,
  };
}

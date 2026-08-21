/**
 * Snapshot diff — the change-safety story. Compares graph N with N+1 and
 * reports broken edges plus the downstream blast radius: every tool whose
 * data flow transitively depended on a broken edge.
 */

import type { Edge, ToolGraph } from "../graph/types.js";

function edgeKey(edge: Edge): string {
  return `${edge.from}|${edge.fromField}|${edge.to}|${edge.toField}`;
}

export interface FieldChange {
  tool: string;
  kind: "input-removed" | "input-added" | "output-removed" | "output-added";
  field: string;
}

export interface BrokenEdge {
  edge: Edge;
  /** Tools downstream of the broken consumer — the blast radius. */
  affectedDownstream: string[];
}

export interface GraphDiff {
  addedTools: string[];
  removedTools: string[];
  fieldChanges: FieldChange[];
  brokenEdges: BrokenEdge[];
  addedEdges: Edge[];
}

/** Forward closure: every tool reachable from `start` along edges. */
function downstreamOf(graph: ToolGraph, start: string): string[] {
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge.to);
    outgoing.set(edge.from, list);
  }
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of outgoing.get(current) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  seen.delete(start);
  return [...seen].sort();
}

export function diffGraphs(before: ToolGraph, after: ToolGraph): GraphDiff {
  const beforeTools = new Map(before.tools.map((tool) => [tool.id, tool]));
  const afterTools = new Map(after.tools.map((tool) => [tool.id, tool]));

  const addedTools = [...afterTools.keys()]
    .filter((id) => !beforeTools.has(id))
    .sort();
  const removedTools = [...beforeTools.keys()]
    .filter((id) => !afterTools.has(id))
    .sort();

  const fieldChanges: FieldChange[] = [];
  for (const [id, beforeTool] of beforeTools) {
    const afterTool = afterTools.get(id);
    if (!afterTool) continue;
    const beforeInputs = new Set(beforeTool.inputs.map((f) => f.path));
    const afterInputs = new Set(afterTool.inputs.map((f) => f.path));
    const beforeOutputs = new Set(beforeTool.outputs.map((f) => f.path));
    const afterOutputs = new Set(afterTool.outputs.map((f) => f.path));
    for (const path of beforeInputs) {
      if (!afterInputs.has(path)) {
        fieldChanges.push({ tool: id, kind: "input-removed", field: path });
      }
    }
    for (const path of afterInputs) {
      if (!beforeInputs.has(path)) {
        fieldChanges.push({ tool: id, kind: "input-added", field: path });
      }
    }
    for (const path of beforeOutputs) {
      if (!afterOutputs.has(path)) {
        fieldChanges.push({ tool: id, kind: "output-removed", field: path });
      }
    }
    for (const path of afterOutputs) {
      if (!beforeOutputs.has(path)) {
        fieldChanges.push({ tool: id, kind: "output-added", field: path });
      }
    }
  }

  const beforeEdges = new Map(before.edges.map((edge) => [edgeKey(edge), edge]));
  const afterEdges = new Map(after.edges.map((edge) => [edgeKey(edge), edge]));

  const brokenEdges: BrokenEdge[] = [];
  for (const [key, edge] of beforeEdges) {
    if (afterEdges.has(key)) continue;
    brokenEdges.push({
      edge,
      // Blast radius from the OLD graph: the consumer plus everything that
      // was downstream of it when the edge still existed.
      affectedDownstream: [edge.to, ...downstreamOf(before, edge.to)],
    });
  }

  const addedEdges = [...afterEdges.entries()]
    .filter(([key]) => !beforeEdges.has(key))
    .map(([, edge]) => edge);

  return { addedTools, removedTools, fieldChanges, brokenEdges, addedEdges };
}

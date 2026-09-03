/**
 * CI policy for graph changes.
 *
 * `diff` is an investigation tool: it reports everything. This module is
 * stricter and deterministic: it decides whether a proposed catalog can
 * ship. It only gates on trusted edges so an unavailable adjudicator cannot
 * make a pull request fail spuriously.
 */

import type { BrokenEdge, FieldChange, GraphDiff } from "../query/diff.js";
import { diffGraphs } from "../query/diff.js";
import { findDeadTools, type DeadTool } from "../query/reachability.js";
import type { ToolGraph } from "../graph/types.js";

export type CheckSeverity = "error" | "warning";

export interface CheckFinding {
  severity: CheckSeverity;
  code:
    | "TOOL_REMOVED"
    | "OUTPUT_REMOVED"
    | "TRUSTED_FLOW_BROKEN"
    | "NEW_UNREACHABLE_INPUT"
    | "INPUT_REMOVED";
  message: string;
  tool?: string;
  field?: string;
  edge?: BrokenEdge["edge"];
}

export interface GraphCheck {
  passed: boolean;
  summary: {
    errors: number;
    warnings: number;
    breakingEdges: number;
    newDeadInputs: number;
  };
  findings: CheckFinding[];
  diff: GraphDiff;
}

function deadInputKeys(dead: DeadTool[]): Set<string> {
  return new Set(
    dead.flatMap((tool) =>
      tool.starvedInputs.map((input) => `${tool.id}\u0000${input.field}`),
    ),
  );
}

function trusted(edge: BrokenEdge["edge"]): boolean {
  return edge.provenance !== "ambiguous";
}

function fieldFinding(change: FieldChange): CheckFinding | undefined {
  if (change.kind === "output-removed") {
    return {
      severity: "error",
      code: "OUTPUT_REMOVED",
      message: `${change.tool} removed output "${change.field}". Existing workflows may depend on it.`,
      tool: change.tool,
      field: change.field,
    };
  }
  if (change.kind === "input-removed") {
    // Removing an input does not always stop an agent from calling a tool,
    // but a client that still sends it can break. Make it visible without
    // blocking release by default.
    return {
      severity: "warning",
      code: "INPUT_REMOVED",
      message: `${change.tool} removed input "${change.field}". Review callers that may still send it.`,
      tool: change.tool,
      field: change.field,
    };
  }
  return undefined;
}

/** Check a proposed graph against an approved baseline. */
export function checkGraphChange(before: ToolGraph, after: ToolGraph): GraphCheck {
  const diff = diffGraphs(before, after);
  const findings: CheckFinding[] = [];

  for (const tool of diff.removedTools) {
    findings.push({
      severity: "error",
      code: "TOOL_REMOVED",
      message: `${tool} was removed from the catalog.`,
      tool,
    });
  }
  for (const change of diff.fieldChanges) {
    const finding = fieldFinding(change);
    if (finding) findings.push(finding);
  }
  for (const broken of diff.brokenEdges) {
    if (!trusted(broken.edge)) continue;
    findings.push({
      severity: "error",
      code: "TRUSTED_FLOW_BROKEN",
      message:
        `${broken.edge.from}.${broken.edge.fromField} no longer satisfies ` +
        `${broken.edge.to}.${broken.edge.toField}. ` +
        `Blast radius: ${broken.affectedDownstream.join(", ") || "none"}.`,
      tool: broken.edge.to,
      field: broken.edge.toField,
      edge: broken.edge,
    });
  }

  const beforeDead = deadInputKeys(findDeadTools(before));
  const afterDead = findDeadTools(after);
  let newDeadInputs = 0;
  for (const tool of afterDead) {
    for (const input of tool.starvedInputs) {
      const key = `${tool.id}\u0000${input.field}`;
      if (beforeDead.has(key)) continue;
      newDeadInputs++;
      findings.push({
        severity: "error",
        code: "NEW_UNREACHABLE_INPUT",
        message:
          `${tool.id}.${input.field} is now required but no catalog output ` +
          "can produce it.",
        tool: tool.id,
        field: input.field,
      });
    }
  }

  findings.sort(
    (a, b) =>
      (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1) ||
      a.code.localeCompare(b.code) ||
      (a.tool ?? "").localeCompare(b.tool ?? ""),
  );
  const errors = findings.filter((finding) => finding.severity === "error").length;
  const warnings = findings.length - errors;
  return {
    passed: errors === 0,
    summary: {
      errors,
      warnings,
      breakingEdges: findings.filter((f) => f.code === "TRUSTED_FLOW_BROKEN").length,
      newDeadInputs,
    },
    findings,
    diff,
  };
}

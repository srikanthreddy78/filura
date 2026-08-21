import type { ToolIR } from "../ir/types.js";

export type EdgeProvenance =
  | "structural" // pass 1: exact / normalized name+type match
  | "semantic" // pass 2: embedding similarity above the confident threshold
  | "adjudicated" // pass 3: LLM confirmed an ambiguous-band pair
  | "ambiguous"; // pass 3 unavailable: kept with low confidence, flagged

export interface Edge {
  /** Producing tool id. */
  from: string;
  /** Output field path on the producing tool. */
  fromField: string;
  /** Consuming tool id. */
  to: string;
  /** Required input field path on the consuming tool. */
  toField: string;
  /** 0..1 confidence. Structural matches score highest. */
  score: number;
  provenance: EdgeProvenance;
}

export interface ToolGraph {
  version: 1;
  builtAt: string;
  /** Which embedding provider produced pass-2 scores. */
  embeddingProvider: string;
  /** Whether pass 3 ran with a live adjudicator. */
  adjudicated: boolean;
  tools: ToolIR[];
  edges: Edge[];
}

export interface GraphStats {
  tools: number;
  edges: number;
  byProvenance: Record<EdgeProvenance, number>;
  /** Ordered candidate pairs considered before pruning. */
  orderedPairs: number;
  /** Field pairs that survived type-compatibility pruning. */
  prunedCandidates: number;
  /** Pairs sent to the LLM adjudicator. */
  adjudicatedPairs: number;
}

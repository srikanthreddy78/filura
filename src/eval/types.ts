/**
 * Evaluation harness types.
 *
 * Ground truth is hand-labeled from the fixture schemas, never recorded
 * from Filura's own output — a self-recorded baseline would make every
 * metric trivially 1.0 and measure nothing.
 */

export interface Expectation {
  /** "<toolId>.<inputPath>" — a required input that needs an upstream producer. */
  input: string;
  /** Every "<toolId>.<outputPath>" that genuinely carries this value. Empty = correctly unreachable. */
  producers: string[];
  note?: string;
}

export interface GroundTruth {
  catalog: string[];
  expectations: Expectation[];
}

export interface ConfusionCounts {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
}

export interface Metrics extends ConfusionCounts {
  precision: number;
  recall: number;
  f1: number;
}

export interface MissedEdge {
  input: string;
  producer: string;
}

export interface SpuriousEdge {
  input: string;
  producer: string;
  provenance: string;
  score: number;
}

export interface EdgeEvaluation extends Metrics {
  /** Inputs labeled as having no valid producer that the system correctly left starved. */
  deadInputsCorrect: number;
  deadInputsTotal: number;
  missed: MissedEdge[];
  spurious: SpuriousEdge[];
}

export function computeMetrics(counts: ConfusionCounts): Metrics {
  const { truePositives: tp, falsePositives: fp, falseNegatives: fn } = counts;
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { ...counts, precision, recall, f1 };
}

/**
 * Pass 3 — LLM adjudication of the ambiguous band.
 *
 * Only pairs whose embedding similarity falls between the thresholds
 * reach this pass, so the call volume is a small fraction of the
 * candidate space. Verdicts are batched, structured, and cached by the
 * caller via edge provenance.
 */

export interface CandidatePair {
  /** Stable id used to correlate the verdict, e.g. "3" (index-based). */
  id: string;
  fromTool: string;
  fromToolDescription: string;
  fromField: string;
  fromFieldDescription: string;
  toTool: string;
  toToolDescription: string;
  toField: string;
  toFieldDescription: string;
  similarity: number;
}

export interface Verdict {
  id: string;
  match: boolean;
}

export interface Adjudicator {
  readonly name: string;
  adjudicate(pairs: CandidatePair[]): Promise<Verdict[]>;
}

export function renderPairForPrompt(pair: CandidatePair): string {
  return [
    `pair ${pair.id}:`,
    `  producer: tool "${pair.fromTool}" (${pair.fromToolDescription.slice(0, 100)})`,
    `    output field: "${pair.fromField}" ${pair.fromFieldDescription ? `— ${pair.fromFieldDescription.slice(0, 80)}` : ""}`,
    `  consumer: tool "${pair.toTool}" (${pair.toToolDescription.slice(0, 100)})`,
    `    required input: "${pair.toField}" ${pair.toFieldDescription ? `— ${pair.toFieldDescription.slice(0, 80)}` : ""}`,
  ].join("\n");
}

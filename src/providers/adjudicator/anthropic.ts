/**
 * Anthropic-backed adjudicator for ambiguous-band field pairs.
 * Batched, structured JSON output, temperature 0. Uses plain fetch to
 * keep the dependency surface small.
 */

import {
  renderPairForPrompt,
  type Adjudicator,
  type CandidatePair,
  type Verdict,
} from "../../match/adjudicate.js";

const BATCH_SIZE = 40;

const SYSTEM_PROMPT = `You judge data-flow compatibility between AI agent tools.
For each pair, decide whether the producer tool's OUTPUT field would, in a real
workflow, carry the same value that the consumer tool's REQUIRED INPUT expects.
Match only when the values are the same kind of identifier or datum (e.g. a
project id feeding a project_id input). Do not match fields that merely sound
similar but carry different things (e.g. a user's display name vs a user id,
a channel id vs a message id).
Respond with ONLY a JSON array: [{"id": "<pair id>", "match": true|false}, ...],
one entry per pair, no prose.`;

export class AnthropicAdjudicator implements Adjudicator {
  readonly name = "anthropic";

  constructor(
    private readonly apiKey: string,
    private readonly model = "claude-haiku-4-5-20251001",
  ) {}

  async adjudicate(pairs: CandidatePair[]): Promise<Verdict[]> {
    const verdicts: Verdict[] = [];
    for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
      const batch = pairs.slice(i, i + BATCH_SIZE);
      verdicts.push(...(await this.adjudicateBatch(batch)));
    }
    return verdicts;
  }

  private async adjudicateBatch(batch: CandidatePair[]): Promise<Verdict[]> {
    const userPrompt = batch.map(renderPairForPrompt).join("\n\n");
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 4096,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });
    if (!response.ok) {
      throw new Error(
        `Anthropic API returned ${response.status}: ${await response.text()}`,
      );
    }
    const result = (await response.json()) as {
      content: { type: string; text?: string }[];
    };
    const text = result.content.find((block) => block.type === "text")?.text ?? "";
    return parseVerdicts(text, batch);
  }
}

/** Tolerant parse: extracts the first JSON array; unknown ids are dropped, missing ids default to no-match. */
export function parseVerdicts(
  text: string,
  batch: CandidatePair[],
): Verdict[] {
  const validIds = new Set(batch.map((pair) => pair.id));
  const match = text.match(/\[[\s\S]*\]/);
  const verdicts = new Map<string, boolean>();
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as { id?: unknown; match?: unknown }[];
      for (const entry of parsed) {
        if (typeof entry.id === "string" && validIds.has(entry.id)) {
          verdicts.set(entry.id, entry.match === true);
        }
      }
    } catch {
      // fall through to default-deny below
    }
  }
  return batch.map((pair) => ({
    id: pair.id,
    match: verdicts.get(pair.id) ?? false,
  }));
}

/**
 * Deterministic, offline lexical embedder.
 *
 * Splits identifiers (camelCase / snake_case / kebab-case), normalizes
 * common aliases (identifier→id, num→number, ...), then hashes word
 * unigrams and character trigrams into a fixed-dimension vector.
 *
 * This is not a semantic model — it exists so Filura works with zero
 * API keys and zero network. `userId` / `user_id` / `UserIdentifier`
 * land close together because they share normalized word tokens;
 * genuinely different names stay apart. A hosted embedding provider
 * strictly improves recall on top of this.
 */

import type { EmbeddingProvider } from "./types.js";

const DIM = 512;

const ALIASES: Record<string, string> = {
  identifier: "id",
  ident: "id",
  uid: "id",
  guid: "id",
  uuid: "id",
  num: "number",
  no: "number",
  qty: "quantity",
  amt: "amount",
  desc: "description",
  msg: "message",
  usr: "user",
  acct: "account",
  org: "organization",
  repo: "repository",
  proj: "project",
  addr: "address",
  ts: "timestamp",
  dt: "date",
};

export function splitIdentifier(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase())
    .map((token) => ALIASES[token] ?? token);
}

/** FNV-1a — stable across runs and platforms. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function addFeature(vector: number[], feature: string, weight: number): void {
  const hash = fnv1a(feature);
  const index = hash % DIM;
  // Second hash bit decides sign, which reduces collision bias.
  const sign = (hash >>> 16) & 1 ? 1 : -1;
  vector[index]! += sign * weight;
}

export function localEmbed(text: string): number[] {
  const vector = new Array<number>(DIM).fill(0);
  const words = splitIdentifier(text);
  for (const word of words) {
    addFeature(vector, `w:${word}`, 3);
    const padded = `^${word}$`;
    for (let i = 0; i + 3 <= padded.length; i++) {
      addFeature(vector, `t:${padded.slice(i, i + 3)}`, 1);
    }
  }
  // Word bigrams capture ordering ("user id" vs "id user" barely differ,
  // but "created at" vs "created by" do).
  for (let i = 0; i + 1 < words.length; i++) {
    addFeature(vector, `b:${words[i]} ${words[i + 1]}`, 2);
  }
  let norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  if (norm === 0) norm = 1;
  return vector.map((x) => x / norm);
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = "local-lexical";

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(localEmbed);
  }
}

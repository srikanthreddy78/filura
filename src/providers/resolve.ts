/**
 * Provider resolution from environment. Zero-config default is fully
 * offline; API keys upgrade precision when present.
 */

import { LocalEmbeddingProvider } from "./embeddings/local.js";
import {
  OpenAiEmbeddingProvider,
  VoyageEmbeddingProvider,
} from "./embeddings/hosted.js";
import type { EmbeddingProvider } from "./embeddings/types.js";
import { AnthropicAdjudicator } from "./adjudicator/anthropic.js";
import type { Adjudicator } from "../match/adjudicate.js";

export function resolveEmbeddingProvider(
  requested?: string,
): EmbeddingProvider {
  const choice = requested ?? process.env["FILURA_EMBEDDINGS"] ?? "local";
  switch (choice) {
    case "voyage": {
      const key = process.env["VOYAGE_API_KEY"];
      if (!key) throw new Error("FILURA_EMBEDDINGS=voyage requires VOYAGE_API_KEY");
      return new VoyageEmbeddingProvider(key);
    }
    case "openai": {
      const key = process.env["OPENAI_API_KEY"];
      if (!key) throw new Error("FILURA_EMBEDDINGS=openai requires OPENAI_API_KEY");
      return new OpenAiEmbeddingProvider(key);
    }
    case "local":
      return new LocalEmbeddingProvider();
    default:
      throw new Error(`Unknown embedding provider "${choice}" (local|voyage|openai)`);
  }
}

export function resolveAdjudicator(disabled = false): Adjudicator | undefined {
  if (disabled) return undefined;
  const key = process.env["ANTHROPIC_API_KEY"];
  if (!key) return undefined;
  return new AnthropicAdjudicator(
    key,
    process.env["FILURA_ADJUDICATOR_MODEL"] ?? undefined,
  );
}

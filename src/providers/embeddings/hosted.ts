/**
 * Hosted embedding providers (Voyage, OpenAI) over plain fetch.
 * Selected when the matching config asks for them and the API key env
 * var is set; otherwise the pipeline falls back to the local embedder.
 */

import type { EmbeddingProvider } from "./types.js";

function l2Normalize(vector: number[]): number[] {
  let norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  if (norm === 0) norm = 1;
  return vector.map((x) => x / norm);
}

async function postJson(
  url: string,
  apiKey: string,
  body: unknown,
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      `Embedding API ${url} returned ${response.status}: ${await response.text()}`,
    );
  }
  return response.json();
}

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly name = "voyage";
  constructor(
    private readonly apiKey: string,
    private readonly model = "voyage-3-lite",
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const result = (await postJson("https://api.voyageai.com/v1/embeddings", this.apiKey, {
      model: this.model,
      input: texts,
    })) as { data: { embedding: number[]; index: number }[] };
    return result.data
      .sort((a, b) => a.index - b.index)
      .map((d) => l2Normalize(d.embedding));
  }
}

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai";
  constructor(
    private readonly apiKey: string,
    private readonly model = "text-embedding-3-small",
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const result = (await postJson("https://api.openai.com/v1/embeddings", this.apiKey, {
      model: this.model,
      input: texts,
    })) as { data: { embedding: number[]; index: number }[] };
    return result.data
      .sort((a, b) => a.index - b.index)
      .map((d) => l2Normalize(d.embedding));
  }
}

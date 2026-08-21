// Filura public library surface.

export * from "./ir/types.js";
export { flattenSchema } from "./ir/flatten.js";
export { normalizeMcpTools } from "./ir/normalize-mcp.js";
export type { McpServerDump, McpToolDefinition } from "./ir/normalize-mcp.js";
export { normalizeOpenApi } from "./ir/normalize-openapi.js";
export { ingestFile } from "./ingest/files.js";
export { fetchMcpTools } from "./ingest/mcp.js";
export type { McpConnection } from "./ingest/mcp.js";

export * from "./graph/types.js";
export { buildGraph } from "./graph/build.js";
export type { BuildOptions, BuildResult } from "./graph/build.js";
export { GraphStore, contentHash } from "./graph/store.js";

export { createServer, startServer } from "./server.js";
export { createMcpServer, startMcpServer } from "./mcp-server.js";

export { querySubgraph } from "./query/subgraph.js";
export type { SubgraphOptions, SubgraphResult } from "./query/subgraph.js";
export { findDeadTools } from "./query/reachability.js";
export { findRedundantClusters } from "./query/redundancy.js";
export { diffGraphs } from "./query/diff.js";
export type { GraphDiff } from "./query/diff.js";

export { LocalEmbeddingProvider } from "./providers/embeddings/local.js";
export {
  OpenAiEmbeddingProvider,
  VoyageEmbeddingProvider,
} from "./providers/embeddings/hosted.js";
export type { EmbeddingProvider } from "./providers/embeddings/types.js";
export { AnthropicAdjudicator } from "./providers/adjudicator/anthropic.js";
export type { Adjudicator } from "./match/adjudicate.js";

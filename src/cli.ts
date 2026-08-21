#!/usr/bin/env node
/**
 * filura — the tool-graph CLI.
 *
 *   filura ingest <files...>        normalize MCP dumps / OpenAPI specs into the catalog
 *   filura ingest-mcp <name> -- cmd connect to a live MCP server and ingest its tools
 *   filura build                    run edge inference, snapshot the graph
 *   filura query "<goal>"           retrieve the subgraph for a goal
 *   filura inspect                  dead tools, redundancy clusters, stats
 *   filura diff <hashA> <hashB>     blast radius between two snapshots
 *   filura serve                    HTTP API (POST /subgraph)
 */

import { Command } from "commander";
import { ingestFile } from "./ingest/files.js";
import { fetchMcpTools } from "./ingest/mcp.js";
import { normalizeMcpTools } from "./ir/normalize-mcp.js";
import type { ToolIR } from "./ir/types.js";
import { buildGraph } from "./graph/build.js";
import { GraphStore } from "./graph/store.js";
import { querySubgraph } from "./query/subgraph.js";
import { findDeadTools } from "./query/reachability.js";
import { findRedundantClusters } from "./query/redundancy.js";
import { diffGraphs } from "./query/diff.js";
import {
  resolveAdjudicator,
  resolveEmbeddingProvider,
} from "./providers/resolve.js";
import { startServer } from "./server.js";
import { startMcpServer } from "./mcp-server.js";

const program = new Command();
program
  .name("filura")
  .description(
    "A directed tool graph for AI agents: selection, composition, change safety.",
  )
  .version("0.1.0");

program
  .command("ingest")
  .description("Ingest MCP tool dumps and/or OpenAPI specs into the catalog")
  .argument("<files...>", "JSON files (MCP dump or OpenAPI 3.x)")
  .option("--append", "add to the existing catalog instead of replacing it")
  .action(async (files: string[], options: { append?: boolean }) => {
    const store = new GraphStore();
    const tools: ToolIR[] = options.append ? await store.loadCatalog().catch(() => []) : [];
    const known = new Set(tools.map((tool) => tool.id));
    for (const file of files) {
      const ingested = await ingestFile(file);
      for (const tool of ingested) {
        if (known.has(tool.id)) continue;
        known.add(tool.id);
        tools.push(tool);
      }
      console.log(`  ${file}: ${ingested.length} tools`);
    }
    const path = await store.saveCatalog(tools);
    console.log(`Catalog: ${tools.length} tools → ${path}`);
  });

program
  .command("ingest-mcp")
  .description("Connect to a live MCP server and ingest its tools")
  .argument("<name>", "namespace for this server's tools")
  .option("--url <url>", "streamable HTTP endpoint")
  .option("--command <command>", "stdio server command")
  .option("--args <args>", "stdio server arguments (space separated)")
  .option("--append", "add to the existing catalog instead of replacing it")
  .action(
    async (
      name: string,
      options: { url?: string; command?: string; args?: string; append?: boolean },
    ) => {
      if (!options.url && !options.command) {
        console.error("Provide --url or --command");
        process.exitCode = 1;
        return;
      }
      const dump = await fetchMcpTools({
        server: name,
        url: options.url,
        command: options.command,
        args: options.args?.split(/\s+/).filter(Boolean),
      });
      const tools = normalizeMcpTools(dump);
      const store = new GraphStore();
      const existing: ToolIR[] = options.append
        ? await store.loadCatalog().catch(() => [])
        : [];
      const known = new Set(existing.map((tool) => tool.id));
      for (const tool of tools) {
        if (!known.has(tool.id)) existing.push(tool);
      }
      const path = await store.saveCatalog(existing);
      console.log(`${name}: ${tools.length} tools → ${path}`);
    },
  );

program
  .command("build")
  .description("Run edge inference over the catalog and snapshot the graph")
  .option("--embeddings <provider>", "local | voyage | openai")
  .option("--no-adjudicate", "skip LLM adjudication even if a key is present")
  .action(async (options: { embeddings?: string; adjudicate: boolean }) => {
    const store = new GraphStore();
    const tools = await store.loadCatalog();
    const embeddingProvider = resolveEmbeddingProvider(options.embeddings);
    const adjudicator = resolveAdjudicator(!options.adjudicate);

    const started = performance.now();
    const { graph, stats } = await buildGraph(tools, {
      embeddingProvider,
      adjudicator,
    });
    const elapsed = ((performance.now() - started) / 1000).toFixed(2);
    const hash = await store.saveGraph(graph);

    console.log(`Graph ${hash} built in ${elapsed}s`);
    console.log(`  tools: ${stats.tools}`);
    console.log(`  ordered tool pairs: ${stats.orderedPairs}`);
    console.log(`  field candidates after type pruning: ${stats.prunedCandidates}`);
    console.log(`  edges: ${stats.edges}`);
    console.log(`    structural:  ${stats.byProvenance.structural}`);
    console.log(`    semantic:    ${stats.byProvenance.semantic}`);
    console.log(`    adjudicated: ${stats.byProvenance.adjudicated} (LLM calls for ${stats.adjudicatedPairs} pairs)`);
    console.log(`    ambiguous:   ${stats.byProvenance.ambiguous}${stats.byProvenance.ambiguous > 0 ? "  ← unconfirmed, excluded from queries; set ANTHROPIC_API_KEY to adjudicate" : ""}`);
    console.log(`  embeddings: ${graph.embeddingProvider}`);
  });

program
  .command("query")
  .description("Retrieve the tool subgraph for a goal")
  .argument("<goal>", "what the agent needs to accomplish")
  .option("--max-tools <n>", "budget", "15")
  .option("--max-depth <n>", "dependency depth", "3")
  .option(
    "--include-ambiguous",
    "include unconfirmed ambiguous-band edges (noisy; excluded by default)",
  )
  .option("--json", "raw JSON output")
  .action(
    async (
      goal: string,
      options: {
        maxTools: string;
        maxDepth: string;
        includeAmbiguous?: boolean;
        json?: boolean;
      },
    ) => {
      const store = new GraphStore();
      const graph = await store.loadGraph();
      const result = await querySubgraph(graph, goal, {
        maxTools: Number(options.maxTools),
        maxDepth: Number(options.maxDepth),
        includeAmbiguous: options.includeAmbiguous,
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`Goal: ${goal}`);
      console.log(`Selected ${result.tools.length} tools:\n`);
      for (const selected of result.tools) {
        if (selected.reason.kind === "seed") {
          console.log(
            `  ${selected.id}  (seed, relevance ${selected.reason.score.toFixed(2)})`,
          );
        } else {
          const via = selected.reason.via;
          console.log(
            `  ${selected.id}  (feeds ${via.to} ← ${via.toField} via ${via.fromField}, ${via.provenance})`,
          );
        }
      }
      if (result.edges.length > 0) {
        console.log(`\nData flow inside the set:`);
        for (const edge of result.edges) {
          console.log(
            `  ${edge.from}.${edge.fromField} → ${edge.to}.${edge.toField}  [${edge.provenance} ${edge.score.toFixed(2)}]`,
          );
        }
      }
    },
  );

program
  .command("inspect")
  .description("Catalog health: dead tools, redundancy clusters, stats")
  .option("--dead", "only dead tools")
  .option("--redundant", "only redundancy clusters")
  .action(async (options: { dead?: boolean; redundant?: boolean }) => {
    const store = new GraphStore();
    const graph = await store.loadGraph();
    const showAll = !options.dead && !options.redundant;

    if (showAll || options.dead) {
      const dead = findDeadTools(graph);
      console.log(`Dead tools (${dead.length}) — required identifier inputs nothing in the catalog produces:`);
      for (const tool of dead) {
        for (const input of tool.starvedInputs) {
          console.log(`  ${tool.id} — no producer for required "${input.field}" (${input.type})`);
        }
      }
    }
    if (showAll || options.redundant) {
      const clusters = findRedundantClusters(graph);
      console.log(`\nRedundancy clusters (${clusters.length}) — near-identical signatures:`);
      for (const cluster of clusters) {
        console.log(`  [similarity ≥ ${cluster.similarity}] ${cluster.tools.join(", ")}`);
      }
    }
    if (showAll) {
      console.log(`\nSnapshot: ${graph.tools.length} tools, ${graph.edges.length} edges, built ${graph.builtAt}`);
      console.log(`Snapshots on disk: ${(await store.listGraphs()).join(", ")}`);
    }
  });

program
  .command("diff")
  .description("Blast radius between two graph snapshots")
  .argument("<before>", "snapshot hash (or 'latest')")
  .argument("<after>", "snapshot hash (or 'latest')")
  .action(async (before: string, after: string) => {
    const store = new GraphStore();
    const [graphBefore, graphAfter] = await Promise.all([
      store.loadGraph(before),
      store.loadGraph(after),
    ]);
    const diff = diffGraphs(graphBefore, graphAfter);

    if (diff.addedTools.length > 0) console.log(`Added tools: ${diff.addedTools.join(", ")}`);
    if (diff.removedTools.length > 0) console.log(`Removed tools: ${diff.removedTools.join(", ")}`);
    if (diff.fieldChanges.length > 0) {
      console.log("Field changes:");
      for (const change of diff.fieldChanges) {
        console.log(`  ${change.tool}: ${change.kind} "${change.field}"`);
      }
    }
    if (diff.brokenEdges.length > 0) {
      console.log(`\nBROKEN data flows (${diff.brokenEdges.length}):`);
      for (const broken of diff.brokenEdges) {
        const edge = broken.edge;
        console.log(
          `  ${edge.from}.${edge.fromField} → ${edge.to}.${edge.toField}  [was ${edge.provenance} ${edge.score.toFixed(2)}]`,
        );
        console.log(`    blast radius: ${broken.affectedDownstream.join(", ")}`);
      }
    } else {
      console.log("\nNo broken data flows.");
    }
    if (diff.addedEdges.length > 0) {
      console.log(`\nNew data flows (${diff.addedEdges.length}):`);
      for (const edge of diff.addedEdges) {
        console.log(`  ${edge.from}.${edge.fromField} → ${edge.to}.${edge.toField}`);
      }
    }
  });

program
  .command("serve")
  .description("Serve the graph over HTTP (POST /subgraph, GET /health)")
  .option("--port <port>", "port", "4114")
  .action(async (options: { port: string }) => {
    const store = new GraphStore();
    const graph = await store.loadGraph();
    const address = await startServer({ graph, port: Number(options.port) });
    console.log(`filura serving ${graph.tools.length} tools, ${graph.edges.length} edges at ${address}`);
    console.log(`  POST ${address}/subgraph  {"goal": "...", "maxTools": 15}`);
  });

program
  .command("mcp")
  .description(
    "Run Filura as an MCP server over stdio: agents call find_tools instead of loading every schema",
  )
  .action(async () => {
    const store = new GraphStore();
    const graph = await store.loadGraph();
    // stdout is the MCP transport — never log to it here.
    await startMcpServer({ graph });
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error((error as Error).message);
  process.exit(1);
});
